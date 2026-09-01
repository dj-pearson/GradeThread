/**
 * US-3042: how long eBay-derived data lives here.
 *
 * WHAT WAS WRONG. One TTL existed in the whole eBay integration — category
 * aspects, 30 days. Everything else derived from eBay was kept forever by
 * default, not by decision: style codes mined from other sellers' public
 * listings, the search-term reports eBay hands a seller, and (as of this story)
 * our own call counters. "Forever, because nobody wrote a cron" is not a
 * retention policy, and it is the answer an eBay compliance review gets if it
 * asks.
 *
 * THE POLICY IS DATA, ON PURPOSE. Each rule below is a row rather than a
 * hand-written DELETE, so the privacy page and this sweep cannot drift apart:
 * ebay-retention_test.ts asserts every rule here is described on
 * src/pages/legal/privacy.tsx. A rule with no published description fails the
 * build, because an unpublished retention policy is the same as none.
 *
 * THE MEASURE IS last_seen_at, NOT created_at. An observation re-confirmed by
 * the market last week is current data that happens to have an old row. Ageing
 * on creation would throw away exactly the records that are still true.
 *
 * TWO SHAPES OF RULE, and the difference matters:
 *
 *   delete  the row goes
 *   clear   the row stays, specific columns are nulled
 *
 * `clear` is what style-code evidence needs. The mapping "this code means this
 * product" is derived reference knowledge and is ours to keep; the URL pointing
 * at one seller's individual eBay listing is a reference to their item, and it
 * points at a dead listing within a few months anyway. Nulling it removes the
 * item-level reference without destroying the knowledge, which is the honest
 * split rather than the convenient one.
 */

import { supabaseAdmin } from "./supabase.ts";

export interface RetentionRule {
  table: string;
  /**
   * Timestamp column the age is measured from. Also the ORDER for the capped
   * mutation — see the note on ORDER_COLUMN below, which is not a style choice.
   */
  ageColumn: string;
  maxAgeDays: number;
  /** 'delete' drops the row; 'clear' nulls `columns` and keeps it. */
  action: "delete" | "clear";
  /** For action 'clear': the columns nulled. */
  columns?: string[];
  /** One line, in plain words, matching what the privacy page tells users. */
  rationale: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const EBAY_RETENTION_RULES: readonly RetentionRule[] = [
  {
    // The pointer to one seller's individual listing. Within 90 days that
    // listing has almost always ended, so the URL is a reference to their item
    // and nothing else.
    table: "style_code_observations",
    ageColumn: "last_seen_at",
    maxAgeDays: 90,
    action: "clear",
    columns: ["evidence_url"],
    rationale:
      "Links to individual eBay listings used as evidence for a style code are " +
      "removed after 90 days; the style-code knowledge itself is kept.",
  },
  {
    // A code nobody has re-confirmed in eighteen months is not knowledge any
    // more, it is a guess with a timestamp.
    table: "style_code_observations",
    ageColumn: "last_seen_at",
    maxAgeDays: 540,
    action: "delete",
    rationale:
      "Style-code observations that have not been seen again in 18 months are deleted.",
  },
  {
    // The seller's own Promoted Listings reports. 400 days keeps a full
    // year-over-year comparison and no more.
    table: "ebay_search_terms",
    ageColumn: "last_seen_at",
    maxAgeDays: 400,
    action: "delete",
    rationale:
      "eBay search-term report data is kept for 400 days so a seller can compare " +
      "against the same season last year, then deleted.",
  },
  {
    // Our own operational telemetry. Bounded so the sweep cannot be the thing
    // that grows without limit.
    table: "ebay_rate_limit_snapshots",
    ageColumn: "captured_at",
    maxAgeDays: 180,
    action: "delete",
    rationale: "eBay API quota snapshots are kept for 180 days.",
  },
  {
    table: "ebay_api_call_daily",
    ageColumn: "day",
    maxAgeDays: 730,
    action: "delete",
    rationale: "Daily eBay API call counts are kept for two years.",
  },
];

/** The cutoff a rule applies at. Pure, so the arithmetic is tested directly. */
export function cutoffFor(rule: RetentionRule, now: Date = new Date()): string {
  const cutoff = new Date(now.getTime() - rule.maxAgeDays * DAY_MS);
  // A DATE column compares against a plain date; a timestamptz wants the full
  // ISO string. Sending an ISO timestamp to a DATE column silently truncates in
  // Postgres, which would shift the boundary by up to a day.
  return rule.ageColumn === "day"
    ? cutoff.toISOString().slice(0, 10)
    : cutoff.toISOString();
}

export interface RetentionOutcome {
  table: string;
  action: "delete" | "clear";
  maxAgeDays: number;
  rows: number;
  error?: string;
}

/**
 * How many rows one rule may touch per run. Deliberately capped: an
 * unbounded DELETE over a table that has never been swept would take a long
 * lock the first time it ran.
 */
const BATCH_LIMIT = 50_000;

/**
 * ⚠ THE `.order()` ON BOTH CHAINS BELOW IS LOAD-BEARING. A `limit` on a
 * MUTATION without an explicit `order` makes PostgREST answer PGRST109 /
 * HTTP 400, so the sweep would fail on EVERY run while type-checking, linting
 * and building perfectly. mutation-qualifier-guard_test.ts caught exactly that
 * here; jobs-trial-expiry.ts shipped without it and downgraded no expired trial
 * for months.
 *
 * It is written INLINE in each chain rather than through a helper on purpose.
 * A helper reads fine and hides the qualifier from both the reader and that
 * guard, which slices a chain at its first semicolon — so wrapping this would
 * pass the test while reintroducing the bug the moment someone refactored.
 *
 * Ordering by the AGE column is the right order and not merely a legal one:
 * oldest first means a capped run removes the oldest rows, so repeated runs
 * converge on the policy. Any other order deletes an arbitrary 50,000 and can
 * leave older rows behind forever.
 */

/**
 * Apply every rule. Never throws: one failing table must not stop the others,
 * because a sweep that aborts halfway leaves a policy half-applied and reports
 * success for the tables it never reached.
 */
export async function sweepEbayRetention(
  now: Date = new Date(),
  rules: readonly RetentionRule[] = EBAY_RETENTION_RULES,
): Promise<RetentionOutcome[]> {
  const out: RetentionOutcome[] = [];
  for (const rule of rules) {
    const cutoff = cutoffFor(rule, now);
    const base = { table: rule.table, action: rule.action, maxAgeDays: rule.maxAgeDays };
    try {
      if (rule.action === "delete") {
        const { data, error } = await supabaseAdmin
          .from(rule.table)
          .delete()
          .lt(rule.ageColumn, cutoff)
          // Select the key back so the reported row count is what was actually
          // removed. `ebay_api_call_daily` has a composite key and no `id`, so
          // this asks for the age column, which every table here has.
          .select(rule.ageColumn)
          .order(rule.ageColumn, { ascending: true })
          .limit(BATCH_LIMIT);
        if (error) throw new Error(error.message);
        out.push({ ...base, rows: (data ?? []).length });
      } else {
        const patch: Record<string, null> = {};
        for (const col of rule.columns ?? []) patch[col] = null;
        // `.not(col, "is", null)` keeps the sweep from rewriting rows that were
        // already cleared on a previous run, so the reported count is the work
        // actually done rather than the size of the table.
        const first = rule.columns?.[0];
        let q = supabaseAdmin
          .from(rule.table)
          .update(patch)
          .lt(rule.ageColumn, cutoff);
        if (first) q = q.not(first, "is", null);
        const { data, error } = await q
          .select(rule.ageColumn)
          .order(rule.ageColumn, { ascending: true })
          .limit(BATCH_LIMIT);
        if (error) throw new Error(error.message);
        out.push({ ...base, rows: (data ?? []).length });
      }
    } catch (err) {
      out.push({
        ...base,
        rows: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
