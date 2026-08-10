// US-2117 AC1: which version of the auto-renewal disclosure a subscriber was
// shown, recorded onto their agreement row.
//
// THIS FILE IS A MIRROR, AND THE MIRROR IS DELIBERATELY THIN. The wording and
// its archive live in ONE place — src/lib/auto-renewal-copy.ts, in the web
// bundle that actually renders it. Duplicating the sentences here would create
// exactly the drift US-1995 documents: two copies, each with its own green test
// suite, silently disagreeing. All the edge needs is the set of version ids it
// can resolve, so that is all it holds.
//
// src/lib/__tests__/disclosure-version.test.ts (web) reads THIS FILE as text and
// fails if a version in the web archive is missing here. That direction is the
// one that matters: the copy changes on the web side, and the edge has to learn
// about it in the same commit.
//
// ── WHY THE CLIENT REPORTS THIS AND THE SERVER DOES NOT DERIVE IT ──
//
// Only the browser knows which build rendered the disclosure. The edge deploys
// separately from the frontend, so an edge-derived version would be a guess
// during any skew window — and a compliance record containing a plausible guess
// is the failure agreed-terms.ts refuses everywhere else.
//
// The honest consequence, written down because it limits what the field proves:
// disclosure_version is CLIENT-REPORTED. A determined user could report an older
// known version. What the server independently vouches for is the material
// terms — amount, interval, trial — which come from the Stripe subscription
// object, not from the client. The version is a pointer to wording, and it is
// worth having for the overwhelmingly common case of an honest client; it is not
// evidence against an adversarial one, and it must not be described as such.

/**
 * Version ids that resolve to an archived disclosure.
 *
 * MUST match the keys of DISCLOSURE_ARCHIVE in src/lib/auto-renewal-copy.ts.
 * Append when the web copy is versioned; never remove — a past agreement row
 * points here.
 */
export const KNOWN_DISCLOSURE_VERSIONS: ReadonlySet<string> = new Set([
  "2026-08-09",
]);

/**
 * Accept a client-reported disclosure version, or null.
 *
 * REFUSES an unknown id rather than storing it. A version we cannot resolve is a
 * pointer to nothing: it would sit on an immutable compliance record looking
 * like provenance while proving less than an empty column, which at least reads
 * as "we did not capture this". Same rule as extractAgreedTerms declining to
 * write a guessed amount.
 */
export function normalizeDisclosureVersion(
  raw: unknown,
): { version: string | null; rejected: string | null } {
  if (typeof raw !== "string") return { version: null, rejected: null };
  const trimmed = raw.trim();
  if (!trimmed) return { version: null, rejected: null };
  if (KNOWN_DISCLOSURE_VERSIONS.has(trimmed)) {
    return { version: trimmed, rejected: null };
  }
  // Cap what gets reported — this string came off a request body, and an
  // unbounded value would land in a log line and a Sentry title.
  return { version: null, rejected: trimmed.slice(0, 64) };
}

/**
 * Bound a client-reported version before it is handed to Stripe as metadata.
 *
 * NOT validation — that happens ONCE, at the write site in agreed-terms.ts,
 * because that is where the value's fate is actually decided. Rejecting here as
 * well would make the write-site branch unreachable through the normal path, and
 * a guard nothing can reach is a guard nothing proves. This only stops an
 * unbounded or odd-charactered string from being stored on a Stripe object.
 */
export function sanitizeReportedDisclosureVersion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, 64);
  if (!trimmed) return null;
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : null;
}
