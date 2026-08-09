// US-2116 AC4: strengthen the evidence behind an email-signup clickwrap.
//
// ── THE GAP ─────────────────────────────────────────────────────────────────
// The highest-volume consent path carries the weakest proof. An email signup's
// `legal_acceptances` row is written by handle_new_user (00142:119-127), a
// Postgres trigger on auth.users. A trigger has no HTTP request, so it has no
// IP and no user-agent, and the versions and timestamp it does record come out
// of raw_user_meta_data — i.e. from the browser. Every other path
// (oauth_clickwrap, reacceptance) goes through POST /api/legal/accept, where
// the edge observes the IP and user-agent itself.
//
// ── WHAT THIS DOES NOT DO, AND WHY THAT IS THE POINT ────────────────────────
// It does NOT write a signup-time IP onto that row, because we do not have one.
// The obvious shortcut — pass ip/user_agent through signUp()'s options.data so
// the trigger can read them — is refused: those are CLIENT-SUPPLIED and
// trivially forged, and a forged IP in a consent record is worse than an
// absent one. It looks authoritative in the exact setting where the record's
// only value is that it can be trusted.
//
// The second, subtler shortcut is to call /api/legal/accept from the first
// authenticated session. That is refused too, for a different reason: /accept
// stamps the CURRENT published versions. Email signup defers the session until
// the confirmation link is clicked, which can be days later, so a version bump
// in between would silently record the user as having accepted a document they
// never saw. It also writes the users.*_accepted_version columns the gate
// reads, which would clear a re-acceptance prompt nobody answered.
//
// ── WHAT IT DOES INSTEAD ────────────────────────────────────────────────────
// It appends a SECOND, separately-named row: `signup_clickwrap_confirmed`.
// That row says what the server can actually attest to — at this time, from
// this IP and this user-agent, the holder of this account was authenticated,
// and the signup clickwrap being corroborated was for these versions. The
// versions are COPIED from the trigger row rather than resolved fresh, so the
// pair can never disagree about what was accepted.
//
// So a signup ends with two rows: the trigger's (guaranteed, weak) and this one
// (best-effort, strong). That is the right outcome rather than a defect — you
// always have a record, and usually a provable one — and the two are told apart
// by their `method`, not by a reader guessing from a null IP.
//
// ── NOT EXPLORED HERE, AND NAMED SO IT IS NOT LOST ──────────────────────────
// GoTrue writes its own row to auth.audit_log_entries on signup, which carries
// the REAL signup IP, server-observed. If that row is reachable and its write
// ordering against handle_new_user is provable, it would satisfy AC4 literally
// rather than by corroboration. It is not used here because neither fact can be
// established without a running GoTrue, and the `db` verify lane starts Postgres
// alone. Worth checking on a full local stack before anyone builds more on top
// of this.

/** The trigger's method value (00142:125). */
export const SIGNUP_CLICKWRAP_METHOD = "signup_clickwrap";
/** This module's method value. Deliberately NOT the same string. */
export const SIGNUP_CONFIRMED_METHOD = "signup_clickwrap_confirmed";

/** Only the columns the decision reads. */
export type AcceptanceRow = {
  method: string | null;
  tos_version: string | null;
  privacy_version: string | null;
  accepted_at: string | null;
};

export type EvidenceDecision =
  | {
    action: "insert";
    tosVersion: string;
    privacyVersion: string;
    /** When the clickwrap itself was recorded, for the response only. */
    signupAcceptedAt: string | null;
  }
  | { action: "skip"; reason: "already_confirmed" }
  | { action: "refuse"; reason: "no_signup_clickwrap" };

/**
 * Decide what to record for a caller, given their full acceptance history.
 *
 * Pure so the rules are testable without a database — the same split
 * radar-scan-events uses, and the reason this file imports nothing.
 */
export function decideSignupConsentEvidence(
  rows: readonly AcceptanceRow[],
): EvidenceDecision {
  // Idempotency lives HERE, on the server, not on a client flag. The client
  // calls this on sign-in, and a flag in user_metadata can be stale, cleared or
  // simply raced by two tabs. legal_acceptances is append-only, so a lost race
  // is not a retry — it is a duplicate row in an audit table forever.
  if (rows.some((r) => r.method === SIGNUP_CONFIRMED_METHOD)) {
    return { action: "skip", reason: "already_confirmed" };
  }

  // Earliest first: there should be exactly one clickwrap row, but if a future
  // path ever appends another, the SIGNUP is the first one. Rows with no
  // timestamp sort last rather than being dropped.
  const clickwraps = rows
    .filter((r) => r.method === SIGNUP_CLICKWRAP_METHOD)
    .sort((a, b) => (a.accepted_at ?? "￿").localeCompare(b.accepted_at ?? "￿"));

  const signup = clickwraps[0];
  // No clickwrap means an OAuth signup (the trigger only writes the row when
  // the clickwrap metadata is present) or a user who predates 00142. Either
  // way there is no acceptance here to corroborate, and inventing one is the
  // precise failure this module exists to avoid. OAuth consent is captured by
  // the legal gate through /accept, which already records IP and user-agent.
  if (!signup) return { action: "refuse", reason: "no_signup_clickwrap" };

  // NOT NULL in the schema, so this is belt-and-braces against a hand-written
  // row — but a blank version would produce a confirmation that names no
  // document, which is a record that reads as evidence and carries none.
  const tosVersion = signup.tos_version ?? "";
  const privacyVersion = signup.privacy_version ?? "";
  if (!tosVersion || !privacyVersion) {
    return { action: "refuse", reason: "no_signup_clickwrap" };
  }

  return {
    action: "insert",
    tosVersion,
    privacyVersion,
    signupAcceptedAt: signup.accepted_at,
  };
}
