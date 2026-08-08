// US-2433: erase a data subject who never had an account.
//
// US-2005 completed erasure for the ACCOUNT HOLDER, and its guard is sound for
// that question. This is a different question. Two tables hold identifying data
// about someone who is NOT the account holder:
//
//   guarantee_claims  — the BUYER who filed a claim (claimant_email NOT NULL,
//                       claimant_name, order_reference)
//   consignors        — the CONSIGNOR who handed a seller items to sell
//                       (name NOT NULL, contact_email, contact_phone)
//
// Both cascade from the SELLER (ON DELETE CASCADE on seller_user_id / user_id),
// so today they are erased if and only if that seller deletes their account.
// The buyer and the consignor have no lever at all: no account to delete, no
// endpoint to call. Erasure was modelled as an account action, and a data
// subject request is not an account action.
//
// ── INTAKE IS NOT DECIDED HERE (US-2433 AC1) ────────────────────────────────
// This module is the PROCEDURE, and it is the same procedure whichever intake
// wins — an operator runbook or a verified-email self-serve flow both end in
// exactly these writes. What it deliberately does NOT contain is a route.
//
// The reason matters: an endpoint that erases rows on an unverified email claim
// is a deletion oracle. Anyone could POST a stranger's address and destroy the
// audit record of a payout decision made against them. So if self-serve is ever
// chosen, the VERIFICATION step is the work, and this module is what it calls
// once verification passes. Until that is decided, callers are operator tools.
//
// ── WHY ANONYMIZE AND NOT DELETE (AC3) ──────────────────────────────────────
// Both tables are load-bearing for someone OTHER than the subject:
//
//   guarantee_claims is the audit record of a money decision, and two tables
//   hang off it with ON DELETE CASCADE — claim_accuracy_signals (00302), which
//   feeds grading calibration, and guarantee_remedies (00319), which records a
//   refund that actually happened. Deleting the claim destroys the evidence
//   that we paid, which is not the subject's to erase and is the seller's to
//   rely on. Same call email_consent_audit already got in US-2005.
//
//   consignors is the seller's own business record — split percentages, and
//   inventory_items.consignor_id points at it (ON DELETE SET NULL by 00107, on
//   purpose, so sale history survives). Deleting the row silently detaches the
//   seller's items from their consignment history to serve a third party.
//
// ── THE SHAPE US-2005's MODULE COULD NOT EXPRESS ────────────────────────────
// EMAIL_PURGE_PLAN has two modes, delete and anonymize-by-nulling. Neither one
// works here, and that is a schema fact rather than a preference:
//
//   claimant_email is NOT NULL      → nulling FAILS (23502) and leaves the PII
//                                     exactly where it was.
//   consignors.name is NOT NULL     → same, AND it carries UNIQUE(user_id,
//     *and* UNIQUE(user_id, name)     name), so redacting two of one seller's
//                                     consignors to the same constant collides
//                                     (23505) and the second one silently keeps
//                                     its real name.
//
// So there are three operations, not two: null a nullable column, overwrite a
// NOT NULL one with a constant, and overwrite a NOT NULL + UNIQUE one with a
// constant made unique by the row's own id. The last is why this runs per row
// rather than as one filtered UPDATE.

/** A subject who has rights over rows they do not own. */
export type ThirdPartySubjectKind = "claim_buyer" | "consignor";

export interface ThirdPartyPurgeTarget {
  kind: ThirdPartySubjectKind;
  table: string;
  /** How the subject's rows are found. */
  matchColumn: string;
  /** Nullable identifying columns → NULL. */
  nulls: readonly string[];
  /** NOT NULL identifying columns → this constant. */
  redact: Readonly<Record<string, string>>;
  /**
   * NOT NULL *and* UNIQUE identifying columns → the constant plus a slice of
   * the row id, so two redacted rows under one owner cannot collide.
   */
  redactUnique: Readonly<Record<string, string>>;
  /**
   * Columns this plan KNOWINGLY leaves alone, and why. Not a TODO list and not
   * an oversight — see RESIDUAL_FREE_TEXT below.
   */
  residual: readonly string[];
  reason: string;
}

/** The value written over a NOT NULL identifying column. Not a real address. */
export const REDACTED_EMAIL = "redacted@erased.invalid";

export const THIRD_PARTY_PURGE_PLAN: readonly ThirdPartyPurgeTarget[] = [
  {
    kind: "claim_buyer",
    table: "guarantee_claims",
    matchColumn: "claimant_email",
    nulls: ["claimant_name", "order_reference"],
    redact: { claimant_email: REDACTED_EMAIL },
    redactUnique: {},
    residual: ["reason", "evidence_urls"],
    reason:
      "audit record of a payout decision; claim_accuracy_signals and " +
      "guarantee_remedies cascade from it, so the row survives without its " +
      "identifiers rather than being deleted",
  },
  {
    kind: "consignor",
    table: "consignors",
    // Matched by row id, not by address: contact_email is nullable, so a
    // consignor identified by name alone has no address to key on and would be
    // unreachable by an email-keyed purge — which is the whole failure mode
    // this story is about, one level down.
    matchColumn: "id",
    nulls: ["contact_email", "contact_phone"],
    redact: {},
    redactUnique: { name: "Redacted consignor" },
    residual: ["notes"],
    reason:
      "the seller's own business record — split percentages, and " +
      "inventory_items.consignor_id points at it ON DELETE SET NULL so sale " +
      "history survives; deleting it would detach another party's records",
  },
];

/**
 * Free-text and URL columns that MAY carry an identifier the subject wrote
 * themselves, and which this plan does not touch.
 *
 * Stated rather than omitted, because a purge that quietly leaves a column
 * behind reads as complete. AC2 names three columns on guarantee_claims and
 * three on consignors; `reason`, `evidence_urls` and `notes` are outside that
 * list and redacting them is not a free improvement:
 *
 *   guarantee_claims.reason is NOT NULL and IS the claim — "materially not as
 *   graded, here is how". Blanking it turns a payout audit record into a row
 *   that says money moved for no stated cause.
 *   evidence_urls point at buyer-hosted photos, which may embed a name in the
 *   path but are also the evidence the decision rested on.
 *   consignors.notes is the seller's working note about their own consignor.
 *
 * Whether a subject request should also scrub these is an owner call about how
 * much audit substance an erasure may destroy. It is NOT a code gap to be
 * closed by whoever reads this next.
 */
export const RESIDUAL_FREE_TEXT: readonly string[] = [
  "guarantee_claims.reason",
  "guarantee_claims.evidence_urls",
  "consignors.notes",
];

export interface ThirdPartyPurgeIO {
  /** Rows belonging to the subject. Must return the id of each. */
  findRows: (
    table: string,
    column: string,
    value: string,
  ) => Promise<{ rows: Array<{ id: string }>; error: { message: string } | null }>;
  /** Patch ONE row by id. Per-row because a unique tombstone needs the id. */
  update: (
    table: string,
    id: string,
    patch: Record<string, string | null>,
  ) => Promise<{ error: { message: string } | null }>;
  report: (message: string) => void;
}

export interface ThirdPartyPurgeResult {
  /** Row ids successfully anonymized, per table. */
  anonymized: Record<string, string[]>;
  /** Row ids whose write failed — logged, never thrown. */
  failed: Record<string, string[]>;
  /** True when the subject matched no rows at all. */
  notFound: boolean;
}

/**
 * The patch for one row. Exported because it is the part that can be wrong —
 * a missed column here is PII that survives a purge someone was told succeeded.
 */
export function redactionPatch(
  target: ThirdPartyPurgeTarget,
  rowId: string,
): Record<string, string | null> {
  const patch: Record<string, string | null> = {};
  for (const col of target.nulls) patch[col] = null;
  for (const [col, value] of Object.entries(target.redact)) patch[col] = value;
  for (const [col, value] of Object.entries(target.redactUnique)) {
    // The id slice is what stops UNIQUE(user_id, name) rejecting a seller's
    // second redacted consignor. Short enough to stay readable in the picker,
    // long enough that a collision within one owner is not a real risk.
    patch[col] = `${value} ${rowId.slice(0, 8)}`;
  }
  return patch;
}

/**
 * Erase one third-party subject.
 *
 * Scoped by `kind` so a caller cannot accidentally run the consignor plan
 * against an email or vice versa — the two match on different columns, and a
 * mismatched pair would silently match nothing and report success.
 *
 * Never throws. Per-row failures are recorded and stepped over, for the same
 * reason US-2005 gave: abandoning the loop leaves MORE of the subject's data
 * behind than logging and continuing.
 */
export async function purgeThirdPartySubject(
  kind: ThirdPartySubjectKind,
  matchValue: string,
  io: ThirdPartyPurgeIO,
  plan: readonly ThirdPartyPurgeTarget[] = THIRD_PARTY_PURGE_PLAN,
): Promise<ThirdPartyPurgeResult> {
  const anonymized: Record<string, string[]> = {};
  const failed: Record<string, string[]> = {};
  let matched = 0;

  const value = kind === "claim_buyer" ? matchValue.trim().toLowerCase() : matchValue.trim();
  if (!value) return { anonymized, failed, notFound: true };

  for (const target of plan) {
    if (target.kind !== kind) continue;
    anonymized[target.table] ??= [];
    failed[target.table] ??= [];

    let rows: Array<{ id: string }>;
    try {
      const found = await io.findRows(target.table, target.matchColumn, value);
      if (found.error) {
        io.report(
          `[third-party-purge] lookup failed for ${target.table}.${target.matchColumn}: ${found.error.message}`,
        );
        continue;
      }
      rows = found.rows;
    } catch (err) {
      io.report(
        `[third-party-purge] lookup threw for ${target.table}.${target.matchColumn}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      continue;
    }

    matched += rows.length;
    for (const row of rows) {
      try {
        const { error } = await io.update(target.table, row.id, redactionPatch(target, row.id));
        if (error) {
          failed[target.table].push(row.id);
          io.report(
            `[third-party-purge] ${target.table}/${row.id} failed: ${error.message}`,
          );
        } else {
          anonymized[target.table].push(row.id);
        }
      } catch (err) {
        failed[target.table].push(row.id);
        io.report(
          `[third-party-purge] ${target.table}/${row.id} threw: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  return { anonymized, failed, notFound: matched === 0 };
}
