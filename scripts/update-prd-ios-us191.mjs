// Mark US-191 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-191": {
    passes: true,
    notes:
      "Done 2026-05-27. ios/GradeThread/Telemetry/Telemetry.swift is the facade everything routes through. Sentry + PostHog SPM packages added to project.yml; xcconfig + Info.plist surface SENTRY_DSN / POSTHOG_API_KEY / POSTHOG_HOST (defaulting to us.i.posthog.com). AppConfig grew sentryDSN / postHogAPIKey / postHogHost accessors — empty xcconfig values come through as nil so the SDK init paths bail out silently rather than crashing on a missing DSN. Telemetry.bootstrap() at AppDelegate launch is idempotent — Sentry.start with tracesSampleRate=0.2 + environment matching the build config (DEBUG → 'development', RELEASE → 'production', same string PushService uses for APNs); PostHog.setup with captureApplicationLifecycleEvents + captureScreenViews so we don't have to instrument every screen push manually. Three rules baked into the facade: Sentry is always on when DSN is configured (crashes are errors, not analytics), PostHog respects the opt-in toggle (every event/identify call no-ops when Telemetry.isAnalyticsEnabled is false), missing DSN/key disables silently. setUser stamps Sentry user.userId = auth.uid (no email per the AC's 'no PII' clause) and PostHog.identify when analytics-enabled. clearUser fires from AuthStore on every sign-out so the next user's funnel doesn't blend with the previous one's. Key events wired: app_open from ContentView.task; intake_completed from DetailsIntakeView (online + offline variants both fire with an 'online' bool prop); ai_extract_used from AIExtractView.applySelected with fields_accepted / measurements_accepted / live_text_fallback counts; ebay_synced from EbaySyncService with listings_total / sales_total / listings_delta / sales_delta; listing_published from PublishDialog.runPush success with listing_id; sale_recorded from BackgroundRefreshService.detectNewSalesAndNotify when the persisted lastSaleSeenId delta is positive. Breadcrumbs added at eBay sync start/fail and publish start/success so post-mortem Sentry views carry the context the AC asks for. SettingsPlaceholder gains an 'Analytics' Section with the opt-in Toggle and an explicit footer that crashes still report when analytics is off. TelemetryTests in PushNotificationTests' sibling file verify the opt-in toggle defaults ON, persists to UserDefaults, round-trips across reads, every TelemetryEvent string is pinned to the AC value (rename = PostHog dashboard data split), and the event/breadcrumb/clearUser paths no-op cleanly when the SDK never initialized. Sign in with Apple was wired in US-170 — this story is the crash-reporting + analytics piece the AC bundled alongside.",
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
