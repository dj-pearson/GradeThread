// Refetch every cached eBay category aspect payload from the Taxonomy API.
//
//   deno run --allow-net --allow-env --allow-read scripts/refresh-ebay-aspect-cache.ts [--dry]
//
// Why: eBay's standardized size enforcement (by site, 2026-08-31 to
// 2026-10-20) closed the Size / Size Type lists category by category, and a
// cached payload can be up to a week old (30 days before 2026-09-01). Run this
// once after deploying the size-enforcement change, and again on each site's
// enforcement date, so no seller's first publish of the day is the refetch.
//
// Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and the eBay app credentials
// the edge uses (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET, EBAY_MARKETPLACE_ID).
// Prints one line per category and which size aspects changed mode or
// values. --dry lists the categories and exits without fetching.

import { supabaseAdmin } from "../src/lib/supabase.ts";
import {
  getCategoryAspects,
  getCategoryTreeId,
  getMarketplaceId,
} from "../src/lib/ebay-client.ts";

interface Row {
  category_id: string;
  category_name: string | null;
  aspects: { aspects?: Array<{ localizedAspectName?: string; aspectConstraint?: { aspectMode?: string }; aspectValues?: Array<{ localizedValue?: string }> }> } | null;
  fetched_at: string;
}

function sizeSummary(payload: Row["aspects"]): Record<string, { mode: string; values: number }> {
  const out: Record<string, { mode: string; values: number }> = {};
  for (const a of payload?.aspects ?? []) {
    const name = a.localizedAspectName ?? "";
    if (!name.toLowerCase().includes("size")) continue;
    out[name] = { mode: a.aspectConstraint?.aspectMode ?? "?", values: (a.aspectValues ?? []).length };
  }
  return out;
}

const dry = Deno.args.includes("--dry");
const { data, error } = await supabaseAdmin
  .from("ebay_category_aspects")
  .select("category_id, category_name, aspects, fetched_at")
  .eq("marketplace_id", getMarketplaceId())
  .eq("category_tree_id", getCategoryTreeId())
  .order("fetched_at", { ascending: true });
if (error) {
  console.error("could not list the cache:", error.message);
  Deno.exit(1);
}
const rows = (data ?? []) as Row[];
console.log(`${rows.length} cached categories on ${getMarketplaceId()} (tree ${getCategoryTreeId()})`);
let changed = 0;
for (const row of rows) {
  const before = sizeSummary(row.aspects);
  if (dry) {
    console.log(`${row.category_id}  ${row.category_name ?? ""}  ${JSON.stringify(before)}  fetched ${row.fetched_at}`);
    continue;
  }
  try {
    const fresh = await getCategoryAspects(row.category_id, { fresh: true });
    const after = sizeSummary(fresh.aspects as Row["aspects"]);
    const diff = Object.keys({ ...before, ...after }).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    if (diff.length > 0) changed++;
    console.log(
      `${row.category_id}  ${row.category_name ?? ""}  ` +
        (diff.length > 0
          ? `CHANGED ${diff.map((k) => `${k}: ${JSON.stringify(before[k])} -> ${JSON.stringify(after[k])}`).join("; ")}`
          : "unchanged"),
    );
  } catch (e) {
    console.log(`${row.category_id}  ${row.category_name ?? ""}  FAILED ${e instanceof Error ? e.message : String(e)}`);
  }
}
if (!dry) console.log(`${changed} of ${rows.length} categories changed a size aspect`);
