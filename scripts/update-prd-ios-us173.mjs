// Mark US-173 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-173": {
    passes: true,
    notes:
      "Done 2026-05-27. ios/GradeThread/Capture/ holds the full capture surface. PhotoSlotType enum covers the four required slots (front/back/tag/detail) plus three optional defect slots; serverPhotoType maps each slot back to the wire enum the web's item_photos uses (defects all collapse to 'defect' with slot order preserved separately via sort_order). PhotoIntakeStore (@MainActor @Observable) holds the photo dict + activeSlot + defectSlotsVisible; recordCapture auto-advances to nextEmptySlot. CameraSession wraps AVCaptureSession + AVCapturePhotoOutput on a private serial queue (per Apple guidance — touching session config from the main thread can stutter UI startup); permission flow handles authorized / notDetermined → request / denied paths. CameraPreview is a UIViewRepresentable hosting AVCaptureVideoPreviewLayer as its root CALayer so it sizes itself with the SwiftUI container. PhotoIntakeView renders the preview full-bleed with: top-left X (with exit-confirmation dialog when photos exist), an active-slot hint line, a horizontal slot strip (tap to focus or open preview, long-press to delete), a 'plus' tile that reveals one more defect slot up to three, and a large shutter button that haptics on tap. PhotoCompressor: aspect-preserving resize to 2048px max long edge, JPEG 0.8 quality, 160px thumbnail in one pass; stripExifPreservingOrientation() for the library-import path keeps only the orientation tag. PhotoPreview is a fullScreenCover for retake/delete on filled slots. Library button placeholder sits in the capture-row layout — wires up in US-174. Tests cover PhotoCompressor (resize math, small-image short-circuit, output size budget), PhotoIntakeStore (cursor advance, defect reveal cap, hidden-slot guard, clearPhoto re-focus), and PhotoSlotType (required set, defect→defect collapse). PhotoIntakeView is reachable via the Add tab → 'Photo-first (Snap & Catalog)' route in ContentView.swift.",
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
