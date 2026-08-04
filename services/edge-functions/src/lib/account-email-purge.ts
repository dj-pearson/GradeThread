// US-2005: erase the PII that the ON DELETE CASCADE cannot reach.
//
// Account deletion relies on the cascade rooted at auth.users, which reaches
// only tables with an FK to users. A whole class of tables is keyed by EMAIL
// instead — including email_deliveries, which stores the full rendered `html`
// of every critical message we ever sent someone. The endpoint returned
// {deleted:true} while the address and those bodies stayed queryable forever.
//
// ── WHY THIS IS A MODULE AND NOT A BLOCK IN THE HANDLER (US-2005 AC3) ────────
// AC3 asks for a test asserting that after deletion NO row anywhere matches the
// address. That was recorded as needing a live database, because the purge ran
// inline against the service-role client with no seam. The PLAN and the
// SEQUENCE are the parts that can be wrong; the client is not. Splitting them
// makes the AC's actual property — "nothing addressable survives" — assertable
// against a fake store, which is the assertion that matters, because the bug
// class here is additive: someone adds a table keyed by email.
//
// ⚠ ORDERING IS LOAD-BEARING and belongs to the caller: this must run BEFORE
// auth.admin.deleteUser. After the cascade, users.email is gone and there is
// nothing left to key the purge on.

/** How a table gives up an address. */
export type PurgeMode = "delete" | "anonymize";

export interface EmailPurgeTarget {
  table: string;
  /** These tables do NOT agree on what the address column is called. */
  column: string;
  mode: PurgeMode;
  /** For `anonymize`: the columns to null out. */
  clear?: readonly string[];
  /** Why this table is handled the way it is — read by the guard test. */
  reason: string;
}

/**
 * Every table that stores an address and is NOT reached by the cascade.
 *
 * Column names are VERIFIED against the migrations rather than guessed. A wrong
 * name fails with PostgREST 42703, which this code logs and moves past — so it
 * would look exactly like a successful purge.
 */
export const EMAIL_PURGE_PLAN: readonly EmailPurgeTarget[] = [
  {
    table: "email_deliveries",
    column: "recipient",
    mode: "delete",
    reason: "carries `html` — the full rendered body of every email we sent",
  },
  {
    table: "marketing_send_log",
    column: "recipient",
    mode: "delete",
    reason: "per-send marketing record keyed by address",
  },
  {
    table: "email_journey_step_sends",
    column: "recipient",
    mode: "delete",
    reason: "drip-journey step record keyed by address",
  },
  {
    table: "newsletter_issue_recipients",
    column: "email",
    mode: "delete",
    reason: "no FK to users at all, so the cascade never sees it",
  },
  {
    table: "waitlist_entries",
    column: "email",
    mode: "delete",
    reason:
      "email is NOT NULL + UNIQUE, so nulling would fail and leave the PII in " +
      "place; a deleted account has no waitlist position to hold",
  },
  {
    table: "email_subscribers",
    column: "email",
    mode: "delete",
    reason:
      "email is NOT NULL + UNIQUE, same as waitlist_entries. Unsubscribe " +
      "protection does NOT live here — that is email_suppressions",
  },
  {
    table: "email_consent_audit",
    column: "email",
    mode: "anonymize",
    clear: ["email", "ip"],
    reason:
      "both identifying columns are nullable, and the row proves WHEN a " +
      "consent action happened — a record that outlives the subject once the " +
      "identifiers are gone",
  },
];

/**
 * DELIBERATELY NOT PURGED.
 *
 * A suppression list must survive erasure. Forgetting a bounced or complained
 * address means it starts receiving mail again — harming the very person the
 * erasure protects. Both CAN-SPAM and GDPR treat suppression as legitimate
 * -interest retention; it stores the address for that purpose only.
 */
export const PURGE_EXEMPT_TABLES: readonly string[] = ["email_suppressions"];

export interface EmailPurgeIO {
  del: (table: string, column: string, value: string) => Promise<{ error: { message: string } | null }>;
  anonymize: (
    table: string,
    column: string,
    value: string,
    clear: readonly string[],
  ) => Promise<{ error: { message: string } | null }>;
  report: (message: string) => void;
}

export interface EmailPurgeResult {
  /** Tables the purge acted on successfully. */
  purged: string[];
  /** Tables whose write failed — logged, never thrown. */
  failed: string[];
}

/**
 * Run the plan for one address.
 *
 * Never throws and never short-circuits: erasure is best-effort per table, and
 * one failure must not abandon the rest. A failure that stopped the loop would
 * leave MORE PII behind than a failure that is logged and stepped over, and the
 * caller has already committed to deleting the account.
 */
export async function purgeEmailKeyedPii(
  email: string,
  io: EmailPurgeIO,
  plan: readonly EmailPurgeTarget[] = EMAIL_PURGE_PLAN,
): Promise<EmailPurgeResult> {
  const address = email.trim().toLowerCase();
  const purged: string[] = [];
  const failed: string[] = [];
  if (!address) return { purged, failed };

  for (const t of plan) {
    try {
      const { error } = t.mode === "delete"
        ? await io.del(t.table, t.column, address)
        : await io.anonymize(t.table, t.column, address, t.clear ?? [t.column]);
      if (error) {
        failed.push(t.table);
        io.report(`[account/delete] purge failed for ${t.table}.${t.column}: ${error.message}`);
      } else {
        purged.push(t.table);
      }
    } catch (err) {
      failed.push(t.table);
      io.report(
        `[account/delete] purge threw for ${t.table}.${t.column}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  return { purged, failed };
}
