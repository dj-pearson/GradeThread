// Mark US-188 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-188": {
    passes: true,
    notes:
      "Done 2026-05-27. ios/GradeThread/Background/ owns the BGAppRefreshTask lifecycle. Info.plist gains UIBackgroundModes ['fetch', 'processing'] + BGTaskSchedulerPermittedIdentifiers ['com.gradethread.app.refresh'] — iOS rejects any identifier not pre-declared here. BackgroundRefreshService.swift is the @MainActor BGTask owner: register() runs at AppDelegate launch (must be synchronous or iOS warns), scheduleNext() submits a BGAppRefreshTaskRequest with earliestBeginDate = now + 30min (iOS treats as a hint; real cadence is system heuristic). The handler re-queues before doing work (so a crash mid-run doesn't lose the slot), posts .inventoryPullRequested to route through the existing ContentView → SyncEngine.sync() path, sleeps ~8s for the engine to start, then calls detectNewSalesAndNotify. expirationHandler cancels the work cleanly so we don't get throttled. The 'Refresh in background' toggle is UserDefaults-backed (com.gradethread.app.bgRefresh.enabled, defaults to ON per AC); setting it false cancels the pending task request. iOS-level Background App Refresh override is respected — when disabled system-side, BGTaskScheduler.submit silently fails and we log to console. NewSaleNotifier.swift wraps UNUserNotificationCenter for the 'N new eBay sale(s)' local notification with body like '$42.50 just landed.' or 'Latest at $X, plus N more.', categoryIdentifier='sale.created' so US-187's deep-link handler can route on tap. Requests permission lazily (caller fire-and-forget). detectNewSalesAndNotify uses UserDefaults-persisted lastSaleSeenId — first-ever run records the most recent id without notifying (avoids blasting a new user with 'N new sales' from the initial sync), subsequent runs count rows since lastSeen and fire. AppDelegate registers the task at launch + applicationDidEnterBackground schedules the next slot. ContentView gains a 60s debounce on scenePhase → .active so rapid app switches don't hammer the server (Settings tap-Sales-tap-Settings would otherwise pull thrice). SettingsPlaceholder gains the 'Refresh in background' Toggle with explanatory footer; binding writes through BackgroundRefreshService.isEnabled which scheduleNext() / cancels appropriately. Tests in BackgroundRefreshTests cover isEnabled default-ON when UserDefaults key missing, write-through persistence, cross-instance state sharing (Settings and AppDelegate construct different instances; UserDefaults keeps them in sync), and refreshIdentifier matches the Info.plist value (renames force the plist update alongside the Swift change).",
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
