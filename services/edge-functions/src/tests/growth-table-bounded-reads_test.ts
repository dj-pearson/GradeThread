// US-2317 AC4: no NEW unbounded read on a growth table.
//
// The frontend has this contract already — src/lib/paged-read.ts plus
// src/test/row-cap-contract.test.ts, written for US-2169 after PostgREST's
// silent truncation shipped twice. The edge has neither, and it runs on the
// service-role client, so its reads are subject to exactly the same clip with
// exactly the same symptom: a short array, `error: null`, and no way for the
// caller to tell "the server truncated you" from "that is all the rows".
//
// This is the smaller, landable half of that contract: a BASELINE that can only
// shrink. The list below is a debt register, not an approval list — the nine
// entries are untriaged, and removing one by bounding its read is the win. Same
// shape as KNOWN_UNREACHABLE_CRONS in cron-registry-drift_test.ts.
//
// What it buys today: a new unbounded read fails the build. What it does not
// buy: any claim that the nine below are fine.
//
// ON THAT NUMBER — it took four passes to get right, and the wrong ones were
// wrong in instructive ways. 169 when only a row cap or a date window counted
// as a bound, which ignored that a read scoped to ONE owner is bounded by that
// seller's data. 31 once owner keys counted. 25 once a JOIN-qualified owner key
// (`inventory_items.user_id`) counted. 9 once the scan stopped using a fixed
// character window and cut each query chain at the next `.from(` — a 400-char
// window missed filters that sit after a long commented `.select(`, and
// widening it to 1200 made chains in a `Promise.all` array borrow the next
// query's `.lt()`, which silently APPROVES an unbounded read. Both directions
// matter, but they are not symmetric: a false positive gets the guard deleted,
// a false negative means nobody ever finds out.

import { assert, assertEquals } from "@std/assert";

const SRC = new URL("../", import.meta.url);

/**
 * Tables that grow with USAGE. Operator/config tables (agents, pricing_plans,
 * system_settings, brand knowledge) are excluded on purpose — they are bounded
 * by configuration, and policing them would produce noise that gets the guard
 * deleted.
 */
const GROWTH_TABLES = [
  "items_full",
  "inventory_items",
  "listings",
  "sales",
  "submissions",
  "item_photos",
  "submission_images",
  "grade_reports",
  "public_grade_reports",
  "garments",
  "garment_events",
  "saved_searches",
  "email_deliveries",
  "cron_runs",
  "ops_events",
  "admin_audit_log",
  "referral_events",
  "affiliate_commissions",
  "affiliate_payouts",
  "consignor_payouts",
  "buyer_notification_log",
  "marketplace_connections",
  "campaign_recipients",
  "north_star_weekly_log",
  "agent_runs",
  "agent_proposals",
  "ai_usage_events",
] as const;

/**
 * What counts as bounded.
 *
 * A per-owner or per-parent key is a real bound: a read scoped to one seller's
 * items is bounded by that seller's data, which is the natural unit. It is the
 * reads with NO row cap, NO time window and NO key — the ones that scan a table
 * across every tenant — that grow without limit.
 */
const BOUND =
  /\.limit\(|\.single\(\)|\.maybeSingle\(\)|\.gte\(|\.lte\(|\.range\(|count:\s*["']exact["']|head:\s*true|\bhead\b\s*\)|\.eq\(\s*["'][\w.]*(user_id|owner_user_id|submission_id|inventory_item_id|sale_id|item_id|garment_id|listing_id|id)["']|\.in\(/;

/**
 * The text of ONE query chain, starting at `.from(`.
 *
 * Cut at the NEXT `.from(` rather than at a fixed character count. A fixed
 * window is wrong in both directions and I hit both while building this: at 400
 * chars it missed the `.eq("inventory_items.user_id", …)` that sits after a long
 * commented `.select(`, flagging six healthy tenant-scoped reads; widened to
 * 1200 it started reaching into the NEXT query in a Promise.all array and
 * borrowing its `.lt()`, which would silently approve an unbounded read. A
 * false negative in a guard is worse than a false positive, because nobody ever
 * finds out.
 */
function queryChain(src: string, at: number): string {
  const next = src.indexOf('.from("', at + 1);
  const end = next === -1 ? src.length : next;
  // Still bounded, so a file-final chain cannot swallow the rest of the file.
  return src.slice(at, Math.min(end, at + 1500));
}

/**
 * Reads that predate this guard, as `file:table`. NOT approved — untriaged.
 * Removing an entry (by bounding the read) is the win; adding one is the thing
 * this test exists to stop.
 */
const KNOWN_UNBOUNDED: readonly string[] = [
  // US-2387 worked this down 31 → 9 → 3. What is left is one read, counted
  // three times because it is three tables in one `Promise.all`, and it is now
  // TRIAGED rather than merely outstanding.
  //
  // GET /admin-dashboard/summary loads every submission, every grade report and
  // every sale, then computes the KPIs and the 30-day charts in JS — and
  // returns the raw rows to the client, where PlatformAnalytics builds a
  // signup→submit→pay funnel, plan cohorts and a top-users-by-submissions
  // table from them.
  //
  // A `.limit()` here would be ACTIVELY HARMFUL, which is why it has not been
  // applied. The KPIs are all-time aggregates: average grade, dispute rate,
  // AI-accuracy percentage. Computed over an arbitrary first slice they do not
  // fail — they come back plausible. An admin reads "average grade 7.8" and has
  // no way to tell it was measured on a fraction of the corpus. That is the
  // same confident-wrong-number shape US-2386 removed from the grading path,
  // and adding a cap here to clear a register entry would be installing it.
  //
  // (Worth stating plainly: this read is ALREADY silently truncated if prod
  // enforces db-max-rows. Capping it does not create the bug, it just makes us
  // the author of it. The fix is not a bound.)
  //
  // The real fix is to stop counting rows in JS: exact `count: "exact",
  // head: true` queries for every count-shaped KPI (which is all of them except
  // the average), date-scoped reads for the 30-day charts since the window IS
  // the definition, and an aggregate RPC for the average. The row-level
  // analytics the client builds needs its own answer, because those genuinely
  // need rows. That is a redesign of the admin analytics data path, not a bound
  // — filed separately rather than smuggled into this register.
  "routes/admin-dashboard.ts:grade_reports",
  "routes/admin-dashboard.ts:sales",
  "routes/admin-dashboard.ts:submissions",
];

async function walk(dir: URL, out: string[] = []): Promise<string[]> {
  for await (const e of Deno.readDir(dir)) {
    const child = new URL(`${e.name}${e.isDirectory ? "/" : ""}`, dir);
    if (e.isDirectory) await walk(child, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith("_test.ts")) {
      out.push(child.href);
    }
  }
  return out;
}

/** Every unbounded growth-table READ, as `file:table` (deduped). */
async function unboundedReads(): Promise<string[]> {
  return (await scanGrowthReads()).unbounded;
}

/** Every growth-table read, and which of them carry no bound. */
async function scanGrowthReads(): Promise<
  { total: number; unbounded: string[] }
> {
  let total = 0;
  const found = new Set<string>();
  for (const href of await walk(SRC)) {
    // Skip this guard's own directory — it quotes the shapes it scans for.
    if (href.includes("/tests/")) continue;
    const src = await Deno.readTextFile(new URL(href));
    const rel = href.slice(SRC.href.length);
    for (const table of GROWTH_TABLES) {
      const needle = `.from("${table}")`;
      let i = src.indexOf(needle);
      while (i !== -1) {
        const chain = queryChain(src, i);
        const isWrite = /\.(insert|update|upsert|delete)\(/.test(
          chain.slice(0, 120),
        );
        if (!isWrite && chain.includes(".select(")) {
          total++;
          if (!BOUND.test(chain)) found.add(`${rel}:${table}`);
        }
        i = src.indexOf(needle, i + 1);
      }
    }
  }
  return { total, unbounded: [...found].sort() };
}

Deno.test("US-2317: no NEW unbounded read on a growth table", async () => {
  const actual = await unboundedReads();
  const known = new Set(KNOWN_UNBOUNDED);
  const added = actual.filter((r) => !known.has(r));
  assertEquals(
    added,
    [],
    "A read on a table that grows with usage, with no row cap, no time window " +
      "and no owner/parent key. PostgREST clips silently — supabase-js does not " +
      "surface Content-Range, so an over-cap read returns a SHORT array with " +
      "error: null and renders as if it were complete. Add a .limit() WITH an " +
      ".order() (a cap with no order does not bound the work, it randomises " +
      "which rows survive), or scope it to an owner.",
  );
});

Deno.test("US-2317: the known-unbounded list only shrinks", async () => {
  const actual = new Set(await unboundedReads());
  const fixed = KNOWN_UNBOUNDED.filter((r) => !actual.has(r));
  assertEquals(
    fixed,
    [],
    "These reads are now bounded — delete them from KNOWN_UNBOUNDED so the " +
      "register keeps meaning something. A stale debt list is how a fixed thing " +
      "goes on looking broken and a broken thing goes on looking known.",
  );
});

Deno.test("US-2317: the scan actually sees the codebase (not passing vacuously)", async () => {
  // Counts EVERY growth-table read, not just the unbounded ones.
  //
  // The first version of this asserted on the unbounded count, which is exactly
  // backwards: that number is SUPPOSED to fall to zero as the register is
  // worked, so the check would have started failing the moment the story
  // succeeded. Total reads is the invariant — it only changes when the scan
  // stops matching the call shape, which is the failure being guarded against
  // (the vacuous pass US-2383 found in the web guards).
  const { total } = await scanGrowthReads();
  assert(
    total > 300,
    `the scan saw only ${total} growth-table reads — it has probably stopped ` +
      "matching the .from(...).select(...) shape",
  );
});
