// Mark US-186 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-186": {
    passes: true,
    notes:
      "Done 2026-05-27. ios/GradeThread/Marketplaces/Reconciliation/ holds the full surface. ReconciliationTypes.swift carries OrphanEbayListing (Codable mirror of flipdesk_ebay_listings + a displayTitle/suggestedTitle fallback when the eBay row didn't capture one), ReconciliationOutcome (orphanId + kind: .created(itemId) / .linked(itemId) / .ignored / .failed), and ReconciliationBulkResult.summary covering all-succeeded / singular / all-failed / partial-success copy. ReconciliationService.swift fetches unmatched orphans, creates a new inventory_items row (title + sku + target_price + status=listed) and flips match_status=matched + matched_item_id, links to an existing item via matched_item_id only, and marks ignored — each returns a typed ReconciliationOutcome. createAll iterates with per-row failure aggregation. ReconciliationStore @MainActor @Observable holds the phase (loading / ready(orphans) / failed) and lastBulkResult for the toast; runAction performs optimistic removal during the network call and restores the row on .failed so the user can retry. ReconciliationView is the main list: 'unmatched listings' header + 'Create all (N)' brand-navy button at the top, then a List with .swipeActions — leading edge → Create item (per AC), trailing edge → Ignore (destructive) + Link (blue). Empty state when zero orphans; failure surface when the fetch errors. Tap a swipe action: Create opens CreateItemFromListingSheet (pre-filled title + SKU + target price from the orphan, user can edit, Create button); Link opens LinkItemSheet (@Query LocalInventoryItem with .searchable, tap any row to link); Ignore fires the service directly. CreateItemFromListingSheet posts .inventoryPullRequested on success so the inventory list picks up the new row. LinkItemSheet reuses InventoryFilter.filter from US-180 so search rules stay identical to the inventory list. MarketplacesView surfaces an orange-tinted 'Reconciliation' NavigationLink card with the orphan count badge — only rendered when count > 0, refreshed via a lightweight count query on appear + pull-to-refresh. Tests in ReconciliationTests cover OrphanEbayListing decoding with all snake-case fields + every nullable, displayTitle fallback (nil title and empty-string title both fall back to 'Listing {ebay_item_id}'), ReconciliationOutcome.isSuccess across cases, ReconciliationBulkResult.summary across all four branches (all succeeded / singular / all failed / partial), ReconciliationStore initial loading phase, runAction removes-on-success and restores-on-failure with the message surfaced. Tab-bar badge for the orphan count on the Marketplaces tab is deferred — the in-view card badge covers the same need without restructuring MainShell.",
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
