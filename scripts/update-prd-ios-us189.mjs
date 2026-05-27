// Mark US-189 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-189": {
    passes: true,
    notes:
      "Done 2026-05-27. Share Extension landed end-to-end so users can send 1-8 images from Photos.app (or any share sheet that vends public.image) straight into a FlipDesk intake. ios/ShareExtension/ is its own XcodeGen target: type app-extension, bundle id com.gradethread.app.share-extension, signed under the same team as the host. ios/ShareExtension/Info.plist pins NSExtensionPointIdentifier=com.apple.share-services with NSExtensionPrincipalClass=$(PRODUCT_MODULE_NAME).ShareViewController and NSExtensionActivationRule={NSExtensionActivationSupportsImageWithMaxCount=8} so the extension only appears in the share sheet for image payloads and caps at 8 (matches PhotoIntakeStore's slot count). ios/ShareExtension/ShareExtension.entitlements + ios/GradeThread/GradeThread.entitlements both carry com.apple.security.application-groups=[group.com.gradethread.app] — the App Group is the handoff channel. ShareViewController loads image attachments via NSItemProvider.loadItem(forTypeIdentifier: UTType.image.identifier) handling UIImage / URL / Data variants, then hosts a SwiftUI ShareIntakeView via UIHostingController. ShareIntakeView shows a scroll list of thumbnails with a slot picker per image (Front / Back / Tag / Detail / Defect 1-3), defaulting each image to the next required slot then spilling into defects — mirrors the PhotosDropHandler sequencing in the main app so muscle memory transfers. Tapping 'Add' JPEG-encodes each image at 0.8 quality and hands them to IntakeInbox.writeBatch, then completeRequest(returningItems: nil) returns to the source app. ios/Shared/IntakeInbox.swift is the cross-target staging module — both the extension and the main app compile it because ios/project.yml lists Shared/ under both targets' sources. Batches land in <appGroup>/intake-inbox/<uuid>/ with per-photo JPEGs + a sibling manifest.json (id, createdAt ISO-8601, photos:[{filename, slot, bytes}]). Decoder pendingBatches() walks the inbox directory, ignores subdirs without a manifest (corrupted writes don't crash future launches), and sorts by createdAt asc so a multi-share session is processed in the user's order. ios/GradeThread/ShareInbox/ShareInboxConsumer.swift is the main-app-only bridge: pulls IntakeInbox.materializePhotos, maps PhotoSlotType.rawValue strings back to typed cases (unknown slots are dropped), builds 240x240 thumbnails matching PhotoLibraryPicker, and returns a DrainedBatch with [PhotoSlotType: PhotoCapture] ready to seed PhotoIntakeView.init(initialPhotos:). First-write-wins per slot preserves share-side ordering when the same slot's assigned twice. MainShell drains the inbox on .task + every scenePhase=.active transition, presents PhotoIntakeView in a fullScreenCover (DrainedBatch conforms to Identifiable via batch.id so SwiftUI binds without an extra optional flag), and tail-recurses after the cover dismisses to walk the next pending batch. Empty drains (every photo failed to decode) are consumed immediately + the recursion continues. Telemetry event 'share_extension_intake_opened' stamps every present so PostHog can measure share-sheet → intake conversion. 'Sign in first' fallback comes for free because MainShell only mounts when authStore.phase = .signedIn — the inbox just queues until the user signs in and the App Group container becomes readable. Tests in ShareInboxTests cover: round-trip write→read preserves slots + order, multi-batch read sorts by createdAt ascending, materializePhotos decodes JPEGs back to non-zero UIImages, manifest-missing siblings are skipped (so a corrupted write doesn't 404 the rest), consumer maps known raw values to typed PhotoSlotType + drops unknowns, and ShareIntakeView.allSlots stays in lock-step with PhotoSlotType.allCases (a rename trips the test). ios/project.yml gains the ShareExtension target declaration with embed: true on the GradeThread target's dependencies so the extension bundles into the host app on every CI build.",
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
