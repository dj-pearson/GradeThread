// Mark US-195 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-195": {
    passes: true,
    notes:
      "Done 2026-05-27. ios/GradeThread/Haptics/HapticFeedback.swift centralises every feedback site behind a typed enum: light (tab changes / chip taps), medium (photo capture / tangible-action commits), success (publish, save, sync completed with new sales), warning (offline-save banner, sync timed out, blockers), error (publish failed, sync connection flagged, status guard rejected an item edit). Camera capture in PhotoIntakeView upgraded from light → medium impact + plays the standard iOS shutter sound via AudioServicesPlaySystemSound(1108) — mandatory in JP/KR locales, harmless elsewhere. AppRouter.haptic() kept as a one-line alias forwarding to HapticFeedback.light() so the existing tab-bar call sites continue working without per-call audit. Success haptics wired at: DetailsIntakeView.handleSavedSuccessfully, ItemCanvasView.save happy path, PublishDialog.runPush .pushed branch. Warning haptics at: DetailsIntakeView.handleSavedOffline (offline-save is a different signal than full success), PublishDialog .blockers branch, EbaySyncStore .timedOut. Error haptics at: ItemCanvasView.save catch + status-guard fail, PublishDialog .noOfferId / .failed / unexpected-response, EbaySync .connectionFlagged / .failed (mirror routed at both MarketplacesView and InventoryListView sync entrypoints). Pull-to-refresh + swipe gestures were already in place from US-174/US-180/US-186; SwiftUI's default keyboard avoidance covers the manual intake form. UILaunchScreen in project.yml uses AccentColor (now driven by the high-contrast brand-navy variant from US-192's asset catalog) so cold-launch shows a brand-navy solid before SwiftUI takes over — no flash of unstyled content. Brand-mark image layer in the launch screen is a polish follow-up when a logo PNG is provisioned. Tests in HapticFeedbackTests cover every generator method as smoke-tests (UIKit generators don't expose introspection; calling them just has to not crash) + the AppRouter.haptic forwarding alias.",
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
