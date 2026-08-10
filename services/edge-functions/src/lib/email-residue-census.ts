// US-2434: how much pre-US-2005 email-keyed PII is left, and — the part that
// matters more — whose.
//
// ══ THE STORY'S PREMISE IS FALSE, AND ACTING ON IT WOULD BE AN INCIDENT ══
//
// US-2434 AC1 says to "establish the population from the deletion log rather
// than guessing: which deletions predate the purge, and whether their addresses
// are still present". That cannot be done. Three facts, each verified against
// the schema rather than assumed:
//
//   1. account_deletion_log HOLDS NO ADDRESS, deliberately. Migration 00064 says
//      so in its own header: the stored id is "opaque, no-longer-resolvable …
//      it cannot be joined back to any PII". That was the right call for a
//      compliance record and it is exactly what makes this backfill impossible.
//      The log answers "was account X erased on date Y". It cannot answer "which
//      address was that".
//
//   2. email_deliveries — the worst table, the one holding the full rendered
//      html — HAS NO user_id COLUMN AT ALL (00095). There is nothing to join,
//      not even a severed link.
//
//   3. Every other planned table that has a user link severs it with ON DELETE
//      SET NULL (marketing_send_log.owner_user_id, email_subscribers.user_id,
//      waitlist_entries.user_id) or has none of its own
//      (email_journey_step_sends). So a NULL user link means "account deleted"
//      OR "never had an account" and NOTHING distinguishes them.
//
// The tempting proxy — "an address in a planned table with no live account is a
// deleted user" — is not merely imprecise, it is mostly WRONG. waitlist_entries
// and email_subscribers exist for people who never had an account; that is
// their entire purpose. Running EMAIL_PURGE_PLAN over that set would delete the
// marketing list and the waitlist, for people who never asked to be forgotten,
// on the theory that they might be someone else. AC1's own warning — "a
// backfill whose blast radius was never measured is how a cleanup becomes an
// incident" — is the correct instinct pointed at the wrong risk: the danger is
// not the size of the set, it is that the set is the wrong people.
//
// ══ SO THIS MODULE COUNTS. IT HAS NO DELETE PATH, ON PURPOSE ══
//
// It classifies into two buckets and refuses to invent a third:
//
//   live_account    the address belongs to an account that still exists. Not
//                   residue. Nothing to do.
//   unattributable  everything else. Contains erased subjects AND ordinary
//                   leads, mixed, with no column that separates them.
//
// There is no `deleted_account` bucket because there is no way to populate one
// honestly, and a bucket named after a group it cannot actually identify is how
// a census becomes a work list.
//
// ══ WHAT ACTUALLY REDUCES THE RESIDUE ══
//
// Two things, neither of them this module:
//
//   • TIME. US-2021 already put email_deliveries on a retention sweep: `sent`
//     rows are deleted after 90 days and `dead_letter` bodies stripped after
//     180. The largest reservoir the story names is therefore draining on its
//     own — IF the data-retention cron is actually scheduled in production,
//     which is an operator fact this checkout cannot see (see US-2002 for the
//     same class of gap). censusNotes() reports the last run so the two are
//     never confused.
//
//   • A REQUEST. When a subject writes in, the address is known, and
//     purgeEmailKeyedPii already erases it — same plan, no drift, which is what
//     AC2 asks for. scripts/purge-email-subject.ts is that path.
//
// This module never returns or logs an address. Its output is meant to be
// pasted into a ticket, and a census that leaks the addresses it counted would
// create the exposure it was written to measure.

import { EMAIL_PURGE_PLAN, type EmailPurgeTarget } from "./account-email-purge.ts";

/** What we can honestly say about one address found in a planned table. */
export type ResidueClass = "live_account" | "unattributable";

export interface TableCensus {
  table: string;
  column: string;
  /** Distinct addresses present in this table. */
  distinct: number;
  /** …of which belong to an account that still exists. */
  liveAccount: number;
  /** …of which cannot be attributed to anyone. NOT a deletion count. */
  unattributable: number;
  /**
   * True when unattributable addresses are the EXPECTED steady state for this
   * table rather than a signal. A waitlist exists for people with no account.
   */
  leadsExpected: boolean;
  /** Why the table is on the plan at all — carried through from the plan. */
  reason: string;
}

export interface ResidueCensus {
  perTable: TableCensus[];
  /** Distinct addresses across all planned tables. */
  distinctOverall: number;
  /** …unattributable across all planned tables. */
  unattributableOverall: number;
}

/**
 * Tables whose unattributable rows are overwhelmingly ordinary leads.
 *
 * Named so a reader cannot mistake a large number here for a large erasure
 * backlog. Both tables are signup lists for people who have no account by
 * definition; a high count is the marketing list working.
 */
export const LEAD_BEARING_TABLES: readonly string[] = [
  "waitlist_entries",
  "email_subscribers",
];

/** Normalize the way every write path and purgeEmailKeyedPii already do. */
export function normalizeAddress(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

export function classifyAddress(
  address: string,
  liveAccounts: ReadonlySet<string>,
): ResidueClass {
  return liveAccounts.has(normalizeAddress(address)) ? "live_account" : "unattributable";
}

/**
 * Build the census from addresses already read out of each table.
 *
 * Takes raw address lists rather than doing its own IO so the classification —
 * the part that can be wrong — is testable without a database. Duplicates are
 * collapsed here rather than by the caller, because "distinct addresses" is the
 * number a regulator-facing answer is about; row counts would overstate the
 * number of PEOPLE by however chatty our email was.
 */
export function buildResidueCensus(
  addressesByTable: Readonly<Record<string, readonly string[]>>,
  liveAccounts: ReadonlySet<string>,
  plan: readonly EmailPurgeTarget[] = EMAIL_PURGE_PLAN,
): ResidueCensus {
  const perTable: TableCensus[] = [];
  const allDistinct = new Set<string>();
  const allUnattributable = new Set<string>();

  for (const target of plan) {
    const seen = new Set<string>();
    for (const raw of addressesByTable[target.table] ?? []) {
      const address = normalizeAddress(raw);
      if (address) seen.add(address);
    }
    let liveAccount = 0;
    for (const address of seen) {
      allDistinct.add(address);
      if (classifyAddress(address, liveAccounts) === "live_account") liveAccount++;
      else allUnattributable.add(address);
    }
    perTable.push({
      table: target.table,
      column: target.column,
      distinct: seen.size,
      liveAccount,
      unattributable: seen.size - liveAccount,
      leadsExpected: LEAD_BEARING_TABLES.includes(target.table),
      reason: target.reason,
    });
  }

  return {
    perTable,
    distinctOverall: allDistinct.size,
    unattributableOverall: allUnattributable.size,
  };
}

export interface CensusContext {
  /** Rows in account_deletion_log. Deliberately NOT joinable to the above. */
  deletionsLogged: number;
  /** ISO timestamp of the most recent data-retention cron run, or null. */
  retentionSweepLastRunAt: string | null;
}

/**
 * The sentences that must travel with the numbers.
 *
 * Returned as data rather than printed, so the script, a test and any future
 * admin surface all say the same thing. A count of "unattributable" addresses
 * handed over without these lines WILL be read as a deletion backlog — that
 * reading is the whole risk, and it is not the reader's fault if nothing on the
 * page says otherwise.
 */
export function censusNotes(census: ResidueCensus, ctx: CensusContext): string[] {
  const notes: string[] = [
    "UNATTRIBUTABLE IS NOT A DELETION BACKLOG. It is every address we cannot " +
      "tie to a live account, which mixes erased subjects with ordinary leads. " +
      "No column separates them: account_deletion_log stores no address (00064, " +
      "by design) and email_deliveries has no user_id at all (00095).",
    `account_deletion_log holds ${ctx.deletionsLogged} deletion(s). That number ` +
      "cannot be subtracted from, matched against, or reconciled with the counts " +
      "above. Two true numbers about the same subject that do not join.",
    "DO NOT run EMAIL_PURGE_PLAN over the unattributable set. Most of it is the " +
      "waitlist and the newsletter list — people who never had an account and " +
      "never asked to be forgotten.",
  ];

  const leadHeavy = census.perTable
    .filter((t) => t.leadsExpected && t.unattributable > 0)
    .map((t) => `${t.table} (${t.unattributable})`);
  if (leadHeavy.length > 0) {
    notes.push(
      `Expected-lead tables carrying most of that count: ${leadHeavy.join(", ")}. ` +
        "A high number here is the signup list working, not a backlog.",
    );
  }

  notes.push(
    ctx.retentionSweepLastRunAt
      ? `The US-2021 retention sweep last ran ${ctx.retentionSweepLastRunAt}. It ` +
        "deletes sent email_deliveries after 90 days and strips dead-letter " +
        "bodies after 180, so the largest reservoir here drains on its own."
      : "NO data-retention cron run found. The US-2021 sweep is what bounds " +
        "email_deliveries, and if it is not scheduled the html bodies are not " +
        "expiring at all — check that before reading any count above as stable.",
  );

  notes.push(
    "The available remedy is per-request, not bulk: when a subject writes in, " +
      "their address is known and scripts/purge-email-subject.ts runs the same " +
      "EMAIL_PURGE_PLAN for it.",
  );

  return notes;
}

/** Render the census for an operator. Never includes an address. */
export function formatCensus(census: ResidueCensus, ctx: CensusContext): string {
  const lines = [
    "Email-keyed PII census (US-2434) — READ ONLY, nothing was changed.",
    "",
    "table                        column     distinct  live  unattributable",
  ];
  for (const t of census.perTable) {
    lines.push(
      `${t.table.padEnd(28)} ${t.column.padEnd(10)} ${String(t.distinct).padStart(8)} ` +
        `${String(t.liveAccount).padStart(5)} ${String(t.unattributable).padStart(15)}` +
        (t.leadsExpected ? "  (leads expected)" : ""),
    );
  }
  lines.push(
    "",
    `distinct addresses overall: ${census.distinctOverall}`,
    `unattributable overall:     ${census.unattributableOverall}`,
    "",
  );
  for (const note of censusNotes(census, ctx)) lines.push(`* ${note}`);
  return lines.join("\n");
}
