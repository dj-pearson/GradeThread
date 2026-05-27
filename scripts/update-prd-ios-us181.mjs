// Mark US-181 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-181": {
    passes: true,
    notes:
      "Done 2026-05-27. ios/GradeThread/Inventory/ItemCanvas/ replaces the inventory list's placeholder destination with a real edit surface. ItemDraft is an Equatable value-type snapshot of the inventory_items columns the canvas writes (title/brand/sku/size/color/material/conditionNotes/status/category/targetPriceText/acquiredPriceText); init(from:) builds one from a LocalInventoryItem with prices boxed as strings so the user can type freely. StatusGuard enforces the web's resolveStatus equivalent: terminal states (sold/shipped/completed/returned/archived) can only transition to other terminal states, blocking the silent regress-back-to-cataloged class of bug. ItemCanvasState @MainActor @Observable owns the original snapshot + the live draft + the savePhase (.idle/.saving/.failed(message)); isDirty compares draft to original; isSavable requires a non-whitespace title; canTransition routes through StatusGuard; acceptDraftAsOriginal snapshots the saved values so subsequent edits compute dirty against the just-saved baseline. ItemCanvasView is a SwiftUI Form with sections for Item identity, Pricing (decimal-keypad text fields with currency symbol prefix), Photos (read-only thumbnail strip via per-item @Query against LocalItemPhoto — sort_order ascending, photo_type chip overlaid on each thumbnail), Measurements (parses LocalInventoryItem.measurementsJSON; full editor is a later pass), Comps placeholder, Notes (multi-line TextField), Status picker with footer warning when the picked status would regress. Save toolbar button posts a .update().eq('id', value:) via supabase-swift with a Codable subset payload (nilifies empty strings to preserve Postgres NULL semantics), then applies the same changes optimistically to the LocalInventoryItem so the list view reflects the edit before the next sync pull. Failure flips savePhase to .failed and surfaces the message inline. Back-button intercepts the swipe-to-dismiss when isDirty via .interactiveDismissDisabled + a confirmationDialog ('Discard your changes?'). SyncEngine extended: pullRemote now returns every photo (was: just the primary), and merge() upserts each into LocalItemPhoto + prunes stale rows whose server-side photo disappeared — keeps the canvas's photo strip in sync after web-side edits. InventoryListView's NavigationLink now pushes ItemCanvasView directly. Tests in ItemCanvasTests cover ItemDraft.init(from:) field-by-field, Equatable detecting changes on title / targetPrice / multiple fields, StatusGuard forward / regression / same-state / terminal-to-terminal, ItemCanvasState initial-not-dirty, whitespace title blocks save, acceptDraftAsOriginal resets dirty, discardChanges restores draft, canTransition routes through guard, parsedPrices nil-on-empty.",
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
