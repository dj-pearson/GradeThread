// US-3044: the gate for the next AutoLister cost cut.
//
// Prints, for the drafts generated BEFORE and AFTER a boundary (default the
// 2026-09-02 change), how often each tracked specific was filled, the median
// recommended-aspect coverage the admin report would show for the same drafts,
// and what each draft cost in tokens and dollars. Two tables the operator
// pastes into the story note; the next cut (US-3045) is argued from them.
//
// READ-ONLY. It writes nothing, so it is safe against prod, which is the only
// place a meaningful answer lives - a local stack has no drafts.
//
//   deno run --allow-net --allow-env services/edge-functions/scripts/aspect-fill-report.ts \
//     [--boundary 2026-09-02T00:00:00Z] [--window 200] [--json]
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY: listings and
// ai_enrichment_log are tenant-scoped, so an anon read returns [] whether the
// tables are empty or full, which is the one answer this script must not give.
//
// TWO COST NUMBERS, ON PURPOSE. ai_enrichment_log.cost_usd is estimateCost,
// which prices every input token at full rate - including the cache READ
// tokens of the aspect tool schema, which Anthropic bills at a tenth. The
// first prod run (2026-09-02) read $0.11 median per draft off that column, and
// it is comparable only with itself. ai_usage_events is the ledger the limiter
// writes per call with the cache multipliers applied (computeCostUsd); that is
// the bill. Both are printed, the ledger per feature, so a cut in image tokens
// shows up where it is paid.
//
// WHAT "BEFORE" AND "AFTER" MEAN. The last `window` drafts created before the
// boundary and the first `window` created at or after it, by listings.created_at.
// The enrichment rows are split the same way on their own created_at and keep
// only rows that carry suggested_fields.listing_gen (a generation), with the
// platform_variants rows (the kit pass) reported separately - they did not
// exist before the boundary.

import { createClient } from "@supabase/supabase-js";
import {
  type CoverageRow,
  median,
  summarizeCoverage,
} from "../src/routes/admin-listing-coverage.ts";
import {
  aspectFillStats,
  aspectFillStatsByCategory,
  type FillDraftRow,
  leastMoved,
  renderFillTable,
} from "../src/lib/aspect-fill-report.ts";

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  Deno.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

function arg(name: string, fallback: string): string {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? (Deno.args[i + 1] ?? fallback) : fallback;
}
const BOUNDARY = arg("--boundary", "2026-09-02T00:00:00Z");
const WINDOW = Math.min(
  1000,
  Math.max(1, Number(arg("--window", "200")) || 200),
);
const asJson = Deno.args.includes("--json");

type DraftRow = FillDraftRow & {
  created_at: string;
  ai_prompt_version: string | null;
};

async function drafts(side: "before" | "after"): Promise<DraftRow[]> {
  let q = db
    .from("listings")
    .select(
      "platform_category_id, item_specifics_override, aspect_coverage, created_at, ai_prompt_version",
    )
    .not("aspect_coverage", "is", null)
    .eq("platform", "ebay");
  q = side === "before"
    ? q.lt("created_at", BOUNDARY).order("created_at", { ascending: false })
    : q.gte("created_at", BOUNDARY).order("created_at", { ascending: true });
  const { data, error } = await q.limit(WINDOW);
  if (error) {
    console.error(
      `[fill-report] listings (${side}) read failed: ${error.message}`,
    );
    Deno.exit(1);
  }
  return (data ?? []) as DraftRow[];
}

interface SpendRow {
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | string;
  suggested_fields: Record<string, unknown> | null;
  created_at: string;
}

async function spend(side: "before" | "after"): Promise<SpendRow[]> {
  let q = db
    .from("ai_enrichment_log")
    .select("tokens_in, tokens_out, cost_usd, suggested_fields, created_at");
  q = side === "before"
    ? q.lt("created_at", BOUNDARY).order("created_at", { ascending: false })
    : q.gte("created_at", BOUNDARY).order("created_at", { ascending: true });
  // Over-read: the log also holds grading, photo-QA and extract rows, and the
  // split below keeps only generation and kit rows.
  const { data, error } = await q.limit(WINDOW * 4);
  if (error) {
    console.error(
      `[fill-report] ai_enrichment_log (${side}) read failed: ${error.message}`,
    );
    Deno.exit(1);
  }
  return (data ?? []) as SpendRow[];
}

/** The per-call ledger, the features the AutoLister item passes are tagged with. */
const LEDGER_FEATURES = [
  "autolister",
  // US-3047: the refine pass, split out of catalog_extract. A window that
  // straddles the split shows refine spend under BOTH slugs; catalog_extract
  // after it is the one-item extract path only.
  "autolister_refine",
  "catalog_extract",
  // US-3047: the role pass now runs INSIDE generation for a tag-less item, so
  // it is a per-draft cost. Caveat when reading perDraftUsd: the standalone
  // intake endpoint (/autolister/classify-photos) bills the same slug, so a
  // window that also covers an intake session overstates the draft's share.
  "photo_roles",
  "tag_ocr",
  "size_estimate",
  "measure_extract",
] as const;

interface LedgerRow {
  feature: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number | null;
  cost_usd: number | string;
  created_at: string;
}

async function ledger(side: "before" | "after"): Promise<LedgerRow[]> {
  let q = db
    .from("ai_usage_events")
    .select(
      "feature, input_tokens, output_tokens, cache_read_tokens, cost_usd, created_at",
    )
    .in("feature", [...LEDGER_FEATURES]);
  q = side === "before"
    ? q.lt("created_at", BOUNDARY).order("created_at", { ascending: false })
    : q.gte("created_at", BOUNDARY).order("created_at", { ascending: true });
  // Up to five calls per draft.
  const { data, error } = await q.limit(WINDOW * 5);
  if (error) {
    // The ledger is newer than the enrichment log; a missing table or column
    // must not take the fill tables down with it.
    console.error(
      `[fill-report] ai_usage_events (${side}) read failed: ${error.message}`,
    );
    return [];
  }
  return (data ?? []) as LedgerRow[];
}

function summarizeLedger(rows: LedgerRow[]) {
  const byFeature: Record<
    string,
    {
      calls: number;
      medianCostUsd: number | null;
      totalCostUsd: number;
      medianCacheRead: number | null;
    }
  > = {};
  for (const f of LEDGER_FEATURES) {
    const mine = rows.filter((r) => r.feature === f);
    if (mine.length === 0) continue;
    const cost = mine.map((r) => Number(r.cost_usd) || 0);
    byFeature[f] = {
      calls: mine.length,
      medianCostUsd: median(cost),
      totalCostUsd: cost.reduce((a, b) => a + b, 0),
      medianCacheRead: median(
        mine.map((r) => Number(r.cache_read_tokens) || 0),
      ),
    };
  }
  const generations = byFeature.autolister?.calls ?? 0;
  const total = Object.values(byFeature).reduce(
    (a, b) => a + b.totalCostUsd,
    0,
  );
  return {
    byFeature,
    // The bill per draft: every tagged call in the window over the number of
    // generation calls. Approximate across the window edge, exact in the middle.
    perDraftUsd: generations > 0 ? total / generations : null,
  };
}

function summarizeSpend(rows: SpendRow[]) {
  const n = rows.length;
  const cost = rows.map((r) => Number(r.cost_usd) || 0);
  return {
    n,
    medianTokensIn: median(rows.map((r) => r.tokens_in)),
    medianTokensOut: median(rows.map((r) => r.tokens_out)),
    medianCostUsd: median(cost),
    totalCostUsd: cost.reduce((a, b) => a + b, 0),
  };
}

function money(v: number | null): string {
  return v == null ? "-" : `$${v.toFixed(4)}`;
}

async function side(name: "before" | "after") {
  const rows = await drafts(name);
  const log = await spend(name);
  const bill = summarizeLedger(await ledger(name));
  const gen = log.filter((r) =>
    r.suggested_fields && "listing_gen" in r.suggested_fields
  )
    .slice(0, WINDOW);
  const kit = log.filter((r) =>
    r.suggested_fields && "platform_variants" in r.suggested_fields
  )
    .slice(0, WINDOW);
  const coverage = summarizeCoverage(rows as CoverageRow[], WINDOW);
  const versions = new Map<string, number>();
  for (const r of rows) {
    const v = r.ai_prompt_version ?? "(none)";
    versions.set(v, (versions.get(v) ?? 0) + 1);
  }
  return {
    name,
    drafts: rows.length,
    from: rows.length ? rows[rows.length - 1]!.created_at : null,
    to: rows.length ? rows[0]!.created_at : null,
    promptVersions: Object.fromEntries(versions),
    fill: aspectFillStats(rows),
    byCategory: aspectFillStatsByCategory(rows),
    medianRecommended: coverage.medianRecommended,
    medianRequired: coverage.medianRequired,
    draftsBlocked: coverage.draftsBlocked,
    generation: summarizeSpend(gen),
    kit: summarizeSpend(kit),
    ledger: bill,
  };
}

const before = await side("before");
const after = await side("after");
const least = leastMoved(before.fill, after.fill);

if (asJson) {
  console.log(
    JSON.stringify(
      { boundary: BOUNDARY, window: WINDOW, before, after, least },
      null,
      2,
    ),
  );
  Deno.exit(0);
}

for (const s of [before, after]) {
  console.log(`\n## ${s.name.toUpperCase()} ${BOUNDARY} - ${s.drafts} drafts`);
  console.log(
    `prompt versions: ${
      JSON.stringify(s.promptVersions)
    } · median recommended coverage: ${
      s.medianRecommended == null
        ? "-"
        : `${Math.round(s.medianRecommended * 100)}%`
    } · median required: ${
      s.medianRequired == null ? "-" : `${Math.round(s.medianRequired * 100)}%`
    } · blocked: ${s.draftsBlocked}`,
  );
  console.log("");
  console.log(renderFillTable(s.fill));
  console.log("");
  console.log(
    `generation spend (n=${s.generation.n}): median tokens in ${
      s.generation.medianTokensIn ?? "-"
    }, ` +
      `out ${s.generation.medianTokensOut ?? "-"}, median cost ${
        money(s.generation.medianCostUsd)
      }, ` +
      `total ${money(s.generation.totalCostUsd)}`,
  );
  console.log(
    `kit spend (n=${s.kit.n}): median cost ${
      money(s.kit.medianCostUsd)
    }, total ${money(s.kit.totalCostUsd)}`,
  );
  console.log(
    `ledger (ai_usage_events, cache multipliers applied): per draft ${
      money(s.ledger.perDraftUsd)
    }` +
      Object.entries(s.ledger.byFeature)
        .map(([f, v]) =>
          `; ${f} n=${v.calls} median ${money(v.medianCostUsd)} (cache read ${
            v.medianCacheRead ?? "-"
          } tok)`
        )
        .join(""),
  );
  for (const c of s.byCategory.slice(0, 8)) {
    console.log(`\n### category ${c.categoryId} (${c.drafts} drafts)`);
    console.log(renderFillTable(c.stats));
  }
}

console.log("");
if (least) {
  console.log(
    `Least moved: ${least.aspect} (${Math.round(least.before * 100)}% -> ${
      Math.round(least.after * 100)
    }% of exposed). Go find out why before US-3045.`,
  );
} else {
  console.log("Least moved: not enough exposed drafts on both sides to say.");
}
