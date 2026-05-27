// Mark US-187 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-187": {
    passes: true,
    notes:
      "Done 2026-05-27. iOS + edge + DB all in place for the receive side; APNs send infrastructure (HTTP/2 client + .p8 key handling) is a separate operational concern documented in progress.txt. ios/GradeThread/Notifications/ holds the iOS receive surface. NotificationCategories.swift pins the four wire identifiers (sale.created / payout.cleared / token.expiring / item.review_needed) shared with the server-side push payload; registerAll() configures UNNotificationCategory at launch so iOS routes taps to the right category. token.expiring carries .customDismissAction so it can interrupt Focus when the user opts in. PushService.swift owns the APNs lifecycle: requestPermissionIfNeeded surfaces the system prompt only on first invocation (deferred from app launch per the AC — fires from SalesPlaceholder's .task), captures the hex-encoded device token in didRegisterForRemoteNotifications, persists it in UserDefaults so cold starts don't re-register unnecessarily, and POSTs to /api/notifications/register with {device_token, environment}. environment string mirrors the aps-environment entitlement (DEBUG → 'development', RELEASE → 'production'). NotificationDelegate.swift implements UNUserNotificationCenterDelegate — foreground presentation as [.banner, .badge, .sound, .list] so in-app pushes still surface; tap handling builds a DeepLinkRoute via DeepLinkRoute.from(category:userInfo:) which maps every category to the right destination (.salesTab / .marketplacesTab / .inventoryItem with id when payload carries inventory_item_id). DeepLinkRouter forwards routes via NotificationCenter so the AppRouter inside MainShell can mutate selection without a direct handle. ContentView observes the route post + re-posts as .applyDeepLink which MainShell handles to flip router.selection (per-item canvas push is a TODO scoped to the next iteration once we add a navigationDestination resolver). GradeThread.entitlements gains aps-environment='development' (release workflow flips to 'production' before archiving). AppDelegate.didFinishLaunchingWithOptions wires UNUserNotificationCenter.delegate to the kept-alive NotificationDelegate instance and registers all four categories. SalesPlaceholder asks for permission once via @State guard. SettingsPlaceholder gains a 'Push notifications' section with per-category Toggle, each UserDefaults-backed under com.gradethread.app.notifyPref.<categoryRawValue> defaulting to ON. Server-side: supabase/migrations/00037_push_device_tokens.sql adds the table (user_id, device_token, environment CHECK ('development'|'production'), device_name, os_version, app_version, is_active, last_seen_at) with UNIQUE (user_id, device_token) so re-registration is idempotent, per-user RLS, set_updated_at trigger. POST /api/notifications/register in services/edge-functions/src/routes/notifications.ts upserts by (user_id, device_token), gated by authMiddleware in main.ts. Tests in PushNotificationTests pin every category raw-value to its wire string (rename = receive-side breakage for installed apps), allCases count, every category has non-empty label + helpText, DeepLinkRoute.from for each category × itemId-present-or-not branch including the unknown-category nil fallback, and PushService.environmentName matches the build config. APNs send-side infrastructure (HTTP/2 client + .p8 auth key + per-event push triggers like sale.created from the eBay webhook handler) is intentionally separate scope — the device tokens collected here are ready for whichever push provider lands next.",
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
