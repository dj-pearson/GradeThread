// Mark US-174 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-174": {
    passes: true,
    notes:
      "Done 2026-05-27. ios/GradeThread/Capture/PhotoLibraryPicker.swift wraps PHPickerViewController via UIViewControllerRepresentable; configured with selectionLimit=8, filter=.images, preferredAssetRepresentationMode=.current (skips the slow PHAsset → JPEG transcode step since PhotoCompressor re-encodes anyway). PHPickerResult.loadImage() async helper materialises each pick as UIImage. PhotoStagingTray.swift is a sheet that auto-dismisses when the tray empties; per-photo Menu offers the visible empty slots plus the next-hidden defect slot if any remain, so the user can park a defect-only library import without bouncing back to the camera. Discard action drops the photo. PhotoIntakeView gains a circular 'photo.on.rectangle' Library button on the left of the shutter row (haptic on tap, ProgressView while a pick batch ingests, disabled during ingest). Imported images run through PhotoCompressor (same 2048px / 0.8 JPEG pipeline as the camera flow) so library + camera shots end up indistinguishable on the wire. Mixed flow naturally supported: nothing closes the camera between picks. PHPicker is the right tool — runs out-of-process, doesn't trip the 'Allow access to all photos?' prompt. NSPhotoLibraryUsageDescription was already set in Info.plist from the US-168 scaffold (Apple doesn't strictly require it for PHPicker, but keeping it costs nothing and avoids surprises). Tests in PhotoIntakeTests.swift exercise PhotoIntakeStore.setPhoto(for:) at every angle the staging tray hits — direct slot targeting without cursor advance, mixed-source ordering independence, and reveal-then-set for defect slots.",
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
