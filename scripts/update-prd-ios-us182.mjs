// Mark US-182 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-182": {
    passes: true,
    notes:
      "Done 2026-05-27. ios/GradeThread/Inventory/ gains the bulk-action surface. BulkSelectionStore @MainActor @Observable holds isEditing + selected Set<String>; toggleEditing wipes the selection on disable so a stray long-press doesn't leak between sessions. BulkAction enum covers createDraft / markShipped / endListing / dropPrice(percent:) / aiEnrich / exportCSV with label / systemImage / isDestructive (only endListing) / confirmationTitle(count:) for singular-vs-plural copy. BulkAction.actions(for:) returns the stage-appropriate set mirroring the web's listings.tsx bottom-bar predicate (To list → createDraft+aiEnrich+exportCSV; Drafts → exportCSV; Active → dropPrice+endListing+exportCSV; Sold → markShipped+exportCSV; Shipped/Returned → exportCSV; All → exportCSV only to guard mixed-status selections from destructive ops). BulkActionExecutor performs status-change actions (createDraft / markShipped) via supabase-swift's .from('inventory_items').update(...).in('id', values:) with optimistic local apply so the list re-filters before the next sync; endListing / dropPrice / aiEnrich return a 'Wires up in US-183/185 (eBay connect)' / 'Wires up in a focused AI-batch pass' failure summary so the UX is honest about what works today. BulkActionResult.summary handles all-succeeded / all-failed / partial-success with correct singular/plural copy. BulkActionBar floating bottom bar shows the selected count badge + horizontal scroll of action chips (destructive ones in brand-red) + cancel X. InventoryListView wires it all: 'Select' / 'Done' toolbar button toggles editing; List(selection:) binding feeds BulkSelectionStore.selected; .environment(\\.editMode, ...) drives the iOS-native checkbox column + drag-two-fingers multi-select; .safeAreaInset(.bottom) hosts BulkActionBar when selection.count > 0; tap → confirmationDialog → execute → alert toast with the result summary → selection cleared + .inventoryPullRequested fired for any ripple effects from items_full recomputation. Tests in BulkActionTests cover the stage→actions mapping (toList / active / sold / all / shipped/returned), isDestructive, confirmationTitle singular/plural + percent interpolation, drop-percent id uniqueness, BulkActionResult.summary across all paths, and BulkSelectionStore lifecycle (toggle clears selection, toggle membership, clear).",
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
