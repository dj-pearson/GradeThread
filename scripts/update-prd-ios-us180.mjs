// Mark US-180 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-180": {
    passes: true,
    notes:
      "Done 2026-05-27. ios/GradeThread/Inventory/ holds the triage surface. InventoryStage enum maps the canonical inventory_items.status values to the stage tabs (To list / Drafts / Active / Sold / Shipped / Returned + All), mirroring the web TO_LIST_STATUSES / LISTED_STATUSES groupings; each stage carries a label + SF Symbol + empty-state title/subtitle. SortOption (newest / oldest / bestROI / highestComp / SKU) exposes isOrdered(a,b) so the same comparator drives the in-memory sort and the tests. SKU sort uses naturalCompare so 'S-2' sorts before 'S-10' just like the web. InventoryFilter.apply runs stage → search → sort in cheapest-cut-first order; search matches title/brand/SKU (style/container will land when SyncEngine pulls those columns). InventoryRow renders thumbnail (AsyncImage with brand-tinted fallback) + title + brand·size + price (listing → target → cost fallback, locale-aware via CurrencyFormatter) + status badge. InventoryListView wraps the whole thing: horizontally-scrolling tab chip row with per-stage counts above the list, .searchable in the navigation drawer, sort menu in the trailing toolbar, .refreshable hooked through NotificationCenter (.inventoryPullRequested → ContentView → syncEngine.sync()) so the engine handle doesn't need to be threaded through the environment. SyncEngine.pull() is no longer a stub: fetches inventory_items + item_photos via supabase-swift, builds a primary-photo-per-item map (first by sort_order), then merges into LocalInventoryItem applying ConflictPolicy field-by-field (title/brand/SKU/notes/measurements/target_price client-wins-if-dirty, status/grade/cost server-wins). Measurements are JSON-serialized for the local store and round-trip cleanly. The detail-view tap routes to ItemCanvasPlaceholder for now — full US-181 canvas lands next. Tests in InventoryFilterTests cover stage status mappings (all known statuses present in .all, drafts/active/etc. exclusive), naturalCompare numeric runs + case-insensitive + empty strings, isOrdered for newest / bestROI (with missing-cost handling) / SKU natural, search substring matching on title/brand/SKU, whitespace-only search returning all, and the apply() pipeline composition.",
  },
};

const prd = JSON.parse(fs.readFileSync(PRD, "utf8"));
let touched = 0;
for (const story of prd.userStories) {
  const u = updates[story.id];
  if (!u) continue;
  story.passes = u.passes;
  story.notes = u.notes;
  touched++;
}

fs.writeFileSync(PRD, JSON.stringify(prd, null, 2) + "\n", "utf8");
console.log(`Updated ${touched} stories in prd.json`);
