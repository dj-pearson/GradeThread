// Mark US-175 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-175": {
    passes: true,
    notes:
      "Done 2026-05-27. ios/GradeThread/Upload/ holds the full upload pipeline. PhotoUploadTask is a value-type state model (phase: queued/uploading(progress)/uploaded(publicURL)/failed(error)/cancelled, retryCount, sessionTaskId). PhotoUploadStore is @MainActor @Observable; views observe it directly to render slot-level progress. PhotoUploadService is @MainActor and owns the background URLSession (identifier com.gradethread.app.photo-uploads, sessionSendsLaunchEvents=true). Each schedule(...) writes the JPEG to a temp file (background URLSession requires file-based uploads, not in-memory bodies), then dispatches an uploadTask with Authorization: Bearer + apikey + x-upsert headers matching the web client. Concurrency cap of 3 via startNextIfPossible(): the store's allTasks is scanned for queued entries and as many as the cap permits get promoted. Per-task delegate callbacks bounce from URLSession's queue to MainActor via Task { @MainActor }, then look up the upload UUID through a service-owned sessionTaskIdToUploadId map (no shared mutable state on the delegate). On success, the post-upload phase inserts an item_photos row via supabase-swift with photo_type/storage_path/sort_order columns identical to the web. AppDelegate.swift adopts UIApplicationDelegate (via @MainActor) and surfaces application(_:handleEventsForBackgroundURLSession:completionHandler:) which the service holds and invokes from urlSessionDidFinishEvents — completing the background-wake roundtrip the system expects. cancelAll() drops every in-flight task + clears the store + sweeps temp files; ContentView.onChange(of: authStore.phase) wires it to .signedOut so the next user's session starts clean. Network failures push the upload into LocalPendingMutation (kind=.uploadPhoto, payload carries inventory_item_id + user_id + slot + storage_path + local_file_url) so the SyncEngine can pick it back up on connectivity-restored. SlotThumbnail now overlays a ring-style progress indicator while uploading and a red 'Retry' surface on failure (tap-to-retry routes through PhotoIntakeView.retryUpload). PhotoIntakeView's Done button generates a draft item UUID for storage anchoring and calls service.enqueueAll(); review screen handoff is a TODO scoped to US-176/US-178. Tests in PhotoUploadTests.swift cover task phase transitions, store lookup (slot × item), pending vs terminal filtering, activeCount, retry counter, reset, and the concurrency-cap math at the store layer (URLSession plumbing isn't unit-testable in a hermetic environment — real verification happens once a TestFlight build runs).",
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
