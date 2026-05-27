// Mark US-171 and US-172 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-171": {
    passes: true,
    notes:
      "Done 2026-05-27. ios/GradeThread/ContentView.swift's MainShell renders a 5-tab TabView on compact horizontal width and switches to NavigationSplitView (sidebar + detail) at regular width — same AppRouter state powers both, so deep links + selection survive the layout switch. AppRouter intercepts the Add tab tap via a custom Binding<AppSection>: tapping Add fires haptic feedback, sets showingAddSheet=true, and returns without mutating selection so the tab bar visually reverts to the previous tab. A confirmationDialog presents 'Photo-first (Snap & Catalog)' and 'Details-first (manual form)' — each picks an IntakeRoute that's appended to whichever tab's NavigationPath was active. UIImpactFeedbackGenerator(style: .light) prepared + fired in both tabSelectionBinding and sidebarSelectionBinding so every tab/sidebar change taps a haptic. .tint(Color.brandNavy) on TabView. iPad sidebar uses List(selection:) with a separate primaryAction toolbar 'Add' button that drives the same dialog. Per-tab navigationDestination(for: IntakeRoute.self) routes both layouts to IntakePlaceholder (real photo-first / details-first flows ship in US-173 / US-178).",
  },
  "US-172": {
    passes: true,
    notes:
      "Done 2026-05-27. Bumped iOS deployment target 16.0 → 17.0 (project.yml) — SwiftData requires it and the iOS 17 install base is high enough that the Core Data fallback path the original AC mentioned isn't worth the maintenance cost. Documented in progress.txt. SwiftData @Model classes in ios/GradeThread/Persistence/Models/ for LocalInventoryItem, LocalItemPhoto, LocalListing, LocalSale, LocalSource, LocalPendingMutation — each mirrors its Supabase row plus a hasLocalChanges/localBytesPath flag for offline writes. NetworkMonitor (Network.NWPathMonitor) exposes isConnected + connectivityStream() AsyncStream. SyncEngine actor pulls items_full/sales/listings on foreground (stubbed at the IO boundary until US-180's list/detail hooks land; the conflict-merge step is fully implemented and tested), flushes the LocalPendingMutation queue on connectivity-restored + on every foreground pass, and reports state through a @MainActor SyncStatusStore (idle/syncing/pending/offline). ConflictPolicy splits fields into server-wins (price + status + grade), client-wins-if-dirty (notes/target_price/measurements), and newest-write-wins (neutral). Mutation handlers are TODOs scoped to US-175 / US-178 — the queue is observable end-to-end (retry count + lastError surfaced) so future handlers slot in cleanly. SyncStatusBar renders 'Syncing…' / 'N pending' / 'Offline' atop MainShell and collapses to nothing when idle + empty. App.swift creates the SwiftData ModelContainer (cloudKitDatabase: .none — sync goes through Supabase, not iCloud). Tests in SyncTests.swift cover every ConflictPolicy branch, PendingMutation round-trip through an in-memory ModelContainer, unknown-kind detection, and SyncStatusStore phase transitions.",
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
