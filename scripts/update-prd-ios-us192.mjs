// Mark US-192 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-192": {
    passes: true,
    notes:
      "Done 2026-05-27. Accessibility surface in place across the views built so far. ios/GradeThread/Accessibility/ReducedMotion.swift wraps `.animation()` calls — `ReducedMotion.animation(_:)` returns nil when UIAccessibility.isReduceMotionEnabled is true so SwiftUI skips interpolation and snaps the state change in place. New `.accessibleAnimation(_:value:)` View modifier makes the migration a one-character drop-in (`.animation` → `.accessibleAnimation`). Existing animation sites switched over: SyncStatusBar chip slide-in (ContentView's accessibleAnimation on router.selection) + SlotThumbnail's upload progress ring (linear interpolation). Asset catalog grew BrandNavy + BrandRed colorsets, each carrying a high-contrast variant for the iOS Increase Contrast setting (navy darkens to #061F45, red to #BE2348). Color.brandNavy / Color.brandRed extensions in ContentView now read from the catalog by name so iOS picks the right tone automatically — no per-view code change needed. AccentColor.colorset got the same high-contrast pair so the system tint matches. Existing accessibility labels audited and were already in place from the per-view builds: SlotThumbnail carries 'X — uploading N percent / failed, tap to retry / uploaded' state-aware labels; FieldSuggestionRow announces 'Title: value. Source. Confidence X percent. accepted/not accepted.'; InventoryRow concatenates 'Title. Brand. Size. Price. Status X.'; camera shutter has 'Capture photo', barcode button 'Scan barcode for SKU', mic button 'Start/Stop dictation', library button 'Pick from photo library'. Dynamic Type is already correct across views — every text site uses semantic fonts (.body / .subheadline / .caption / .headline) rather than hardcoded sizes; the few `.font(.system(size: ...))` calls are on icon overlays where fixed sizing is intentional. Tests in AccessibilityTests cover ReducedMotion.animation behavior (returns animation when off; system-level toggle to verify the on path is a first-TestFlight check), durationScale boundedness, accessibleAnimation modifier compilation, and brand-color extension resolution. Real VoiceOver dogfood pass across the major flows (sign-in / intake / item edit / eBay publish) is a manual TestFlight checkpoint — the code surface is in place.",
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
