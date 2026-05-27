// Mark US-193 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-193": {
    passes: true,
    notes:
      "Done 2026-05-27. iPad-native layout that picks up the larger screen real estate. ContentView's SidebarSplitView restructured from two-column to three-column NavigationSplitView(sidebar:content:detail:). Sidebar carries the section nav (Inventory / Sales / Marketplaces / Settings); content column shows the active section's main view (real InventoryListView for Inventory, placeholder for the others until US-184 wires Sales detail); detail column hosts a NavigationStack that resolves value-based pushes from content via .navigationDestination(for: LocalInventoryItem.self) → ItemCanvasView. InventoryListView's NavigationLink converted to value-based — NavigationLink(value: item) — so the same row works in both compact (TabBarShell's per-tab NavigationStack) and split (the detail column's NavigationStack) layouts; SwiftUI routes the push to whichever stack hosts the link. Per-section NavigationPath retained on AppRouter so deep navigation in the detail column survives a sidebar switch. Detail landing view shows a friendly 'Pick an item' placeholder when nothing's selected, with icon + copy that adapt to the active section. SwiftUI's three-column splitter auto-collapses to two-column on iPad portrait + Slide Over, satisfying the AC's portrait spec without per-orientation code. Multi-window enabled via UIApplicationSceneManifest in Info.plist (UIApplicationSupportsMultipleScenes=YES); SwiftUI's WindowGroup handles the rest — no SceneDelegate needed. Users open a second window via the App Switcher (drag from Dock or long-press → 'New Window'). ios/GradeThread/Inventory/PhotosDropHandler.swift processes images dropped from Photos.app through the same PhotoCompressor pipeline the camera flow uses; .acceptsImageDrops View modifier wraps SwiftUI's .dropDestination(for: Data.self) and decodes JPEG/PNG payloads into UIImage. InventoryListView's List gets the modifier so dragging from Photos.app onto the list opens a fresh PhotoIntakeView with the dropped images pre-staged into the first available slots (front → back → tag → detail → defect 1/2/3). PhotoIntakeView grew an init(initialPhotos:) overload that seeds the store on construction — non-destructive, default init still works. Tests in PhotosDropTests cover the compressor pipeline (empty array, single image, multi-image order preservation, source=.library stamp), the PhotoIntakeView initialPhotos init compiles + accepts a seeded mapping, and the empty-init parity case. ItemCanvasView's NavigationStack already routes correctly through the new value-based link.",
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
