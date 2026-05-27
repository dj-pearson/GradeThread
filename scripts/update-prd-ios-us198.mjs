// Mark US-198 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-198": {
    passes: true,
    notes:
      "Done 2026-05-27. Phase 2 of US-172 — sale + listing edits now stream into the SwiftData cache as they happen instead of waiting for the next pull. ios/GradeThread/Persistence/RealtimeService.swift owns a per-user Postgres-change channel on inventory_items (filter .eq('user_id', userId)), routed through supabase-swift's channel.postgresChange(AnyAction.self, ...) AsyncStream. Each insert/update yields the row dict back through JSONEncoder so SyncEngine can decode against its existing RemoteInventoryItem shape — single source of truth for the wire schema between polled pulls (US-180) and realtime upserts. Deletes carry only the primary key in oldRecord; the service extracts the id string and forwards to SyncEngine.applyRealtimeInventoryDelete. SyncEngine grew applyRealtimeInventoryUpsert(record: Data) and applyRealtimeInventoryDelete(id:) — both reuse the @MainActor ModelContext pattern + ConflictPolicy (server wins on listing_price/status/grade, client wins on user-edited fields when hasLocalChanges is set). RemoteInventoryItem + RemoteItemPhoto promoted from private to internal so the realtime path can reach them. Garbage payloads log + drop instead of crashing the listen loop. ContentView lifecycle: opens the channel on .signedIn AND scenePhase → .active (covers cold start + app foreground); pauses on .background to save battery + cellular data; tears down on .signedOut so the next user's channel doesn't inherit the previous one's subscription. RealtimeService.isEnabled is UserDefaults-backed (com.gradethread.app.realtime.enabled, defaults ON); flipping off immediately calls stop() so the channel drops. supabase-swift handles the heartbeat + automatic reconnect — channel.statusChange surfaces .subscribing / .subscribed / .unsubscribed / @unknown which RealtimeService maps to a UI-friendly Phase enum (.idle / .subscribing / .subscribed / .reconnecting / .disabled). ContentView.applyRealtimeStatusToBanner mirrors .reconnecting into SyncStatusStore.Phase.reconnecting so the existing SyncStatusBar renders the chip ('Reconnecting…' with an orange ProgressView) — same banner, no second status surface. The banner only flips into .reconnecting from .idle; an active sync / pending / offline banner wins because those signals are more user-actionable. SettingsPlaceholder gains a 'Live updates' section (RealtimeToggleSection) with the toggle + a footer explaining the battery trade-off. Tests in RealtimeTests cover SyncStatusStore.Phase.reconnecting pin, applyRealtimeInventoryUpsert insert path, update path with title + status flipping through ConflictPolicy, applyRealtimeInventoryDelete row removal, and garbage-JSON resilience (no crash, no orphan row). The supabase-swift channel + status streams aren't hermetically testable without spinning up a real Realtime socket — first TestFlight build is the live verification.",
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
