// Mark US-199 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-199": {
    passes: true,
    notes:
      "Done 2026-05-27. Post-launch feedback loop in place: native review prompt, in-app feedback channel, PostHog feature-flag wrapper, and dashboard list for the operator to wire up. ios/GradeThread/Telemetry/ReviewPromptService.swift gates SKStoreReviewController.requestReview() behind the AC's exact triple — ≥3 listings published AND ≥14 days since install AND ≥365 days since last ask. Three counters live in UserDefaults so they survive launches without server roundtrips. PublishDialog.runPush .pushed branch calls recordPublish() + maybePrompt() so the prompt fires at the user's canonical 'I got value' moment rather than arbitrary tab opens. _setForTesting / _resetForTesting hooks let unit tests inject the persisted state without waiting 14 real days; production code path is untouched. ios/GradeThread/Feedback/FeedbackSheet.swift is the modal in Settings — multi-line TextEditor (2000-char soft cap), context auto-collected (app version + iOS version + UIDevice's utsname machine id e.g. 'iPhone15,3'), POST /api/notifications/feedback with the user's auth token. Settings → Account section now carries a 'Send feedback' button next to 'Sign out'. supabase/migrations/00038_feedback_messages.sql creates the table (message + source + app_version + os_version + device_model + breadcrumbs jsonb + status enum + timestamps) with per-user RLS for SELECT/INSERT and admin policies for triage. Edge route POST /api/notifications/feedback in services/edge-functions/src/routes/notifications.ts inserts the row + logs a structured entry for the operator's tail; actual support@pearson-media.com email send is a one-line addition once the email lib's sendFeedbackEmail helper lands. Auth middleware wired in main.ts. ios/GradeThread/Telemetry/FeatureFlag.swift is the A/B test wrapper — three flags pinned to server-side rawValues (photo_first_by_default / bulk_price_drop_multistep / show_confidence_bars) with per-case defaults so a fresh launch or PostHog outage lands on a known cohort. UserDefaults override pattern lets QA + UI tests pin flags to known states regardless of what PostHog says. PostHog dashboards the operator needs to create (documented in progress.txt — they live in the PostHog web UI, not the repo): D1/D7/D30 retention (cohorts by signup week), intake → publish funnel, AI extract acceptance rate (count fields_accepted / suggestions returned), eBay sync success rate (ebay_synced count / sync_attempted count), crash-free sessions (Sentry → PostHog session-replay join). Tests in PostLaunchTests cover every ReviewPromptService gate branch (fresh install fail, too-new fail, too-few-listings fail, all-gates-met pass, recently-asked fail, asked-over-a-year-ago pass, recordPublish counter), FeatureFlag default values per case, override-wins-over-default, clear-override-reverts-to-default, and raw-value pinning so renames trip the test.",
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
