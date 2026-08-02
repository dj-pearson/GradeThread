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
// shrink. Enumerating and justifying all 31 existing sites in one pass would
// have meant 31 rushed judgements, and a rushed justification is worse than an
// honest "not yet looked at" — so the list below is explicitly a debt register,
// not an approval list. Same shape as KNOWN_UNREACHABLE_CRONS in
// cron-registry-drift_test.ts.
//
// What it buys today: a new unbounded read fails the build. What it does not
// buy: any claim that the 31 below are fine.

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
  /\.limit\(|\.single\(\)|\.maybeSingle\(\)|\.gte\(|\.lte\(|\.range\(|count:\s*["']exact["']|\.eq\(\s*["'](user_id|owner_user_id|submission_id|inventory_item_id|sale_id|item_id|garment_id|listing_id|id)["']|\.in\(/;

/**
 * Reads that predate this guard, as `file:table`. NOT approved — untriaged.
 * Removing an entry (by bounding the read) is the win; adding one is the thing
 * this test exists to stop.
 */
const KNOWN_UNBOUNDED: readonly string[] = [
  "lib/affiliate-payout.ts:affiliate_commissions",
  "lib/agent-tools.ts:marketplace_connections",
  "lib/cert-integrity-backfill.ts:grade_reports",
  "lib/depop-client.ts:marketplace_connections",
  "lib/etsy-client.ts:marketplace_connections",
  "lib/peer-norm.ts:grade_reports",
  "lib/pending-delists.ts:listings",
  "lib/support-tools.ts:sales",
  "lib/whatnot-client.ts:marketplace_connections",
  "routes/admin-agents.ts:agent_proposals",
  "routes/admin-grading.ts:grade_reports",
  "routes/admin-growth.ts:campaign_recipients",
  "routes/admin-marketplace-connections.ts:marketplace_connections",
  "routes/admin-marketplace-pipeline.ts:listings",
  "routes/admin-ops.ts:listings",
  "routes/content-public.ts:grade_reports",
  "routes/content-public.ts:listings",
  "routes/flipdesk-automations.ts:listings",
  "routes/flipdesk-ebay.ts:listings",
  "routes/flipdesk-ebay.ts:marketplace_connections",
  "routes/flipdesk-listings.ts:listings",
  "routes/flipdesk-webhooks.ts:listings",
  "routes/grade.ts:grade_reports",
  "routes/jobs-thumbnail-backfill.ts:item_photos",
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
        const window = src.slice(i, i + 500);
        const isWrite = /\.(insert|update|upsert|delete)\(/.test(
          window.slice(0, 120),
        );
        if (!isWrite && window.includes(".select(")) {
          if (!BOUND.test(window.slice(0, 400))) found.add(`${rel}:${table}`);
        }
        i = src.indexOf(needle, i + 1);
      }
    }
  }
  return [...found].sort();
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

Deno.test("US-2317: the scan actually finds reads (not passing vacuously)", async () => {
  // Without this, a change to the call shape would make both tests above pass
  // by matching nothing — the failure mode US-2383 found in the web guards.
  const all = await unboundedReads();
  assert(
    all.length > 10,
    `the scan found only ${all.length} reads — it has probably stopped matching`,
  );
});
