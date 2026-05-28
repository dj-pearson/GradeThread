// Mark US-190 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-190": {
    passes: true,
    notes:
      "Done 2026-05-28. Home-screen widget shipped via WidgetKit in a new app-extension target. ios/GradeThreadWidget/ is its own XcodeGen target (bundle id com.gradethread.app.widget, NSExtensionPointIdentifier=com.apple.widgetkit-extension) embedded in the host app via dependencies.target embed:true. Because widgets run in a separate process with no access to the main app's SwiftData store, the app publishes a tiny rollup to the shared App Group container (group.com.gradethread.app, reused from US-189's IntakeInbox entitlement) and the widget reads it back — no network, no DB, instant render. ios/Shared/WidgetSnapshot.swift is the cross-target Codable model (generatedAt, isSignedIn, activeListings, soldTodayCount, soldTodayGross, pendingPayoutCount, pendingPayoutNet) with WidgetSnapshotStore handling atomic JSON write/read keyed to the App Group; write() returns false (not throws) when the container's unavailable so unit tests + unsigned builds degrade gracefully. signedOut() + placeholder factories give the widget distinct copy for the no-auth case vs a real seller with a quiet day vs the gallery preview. ios/GradeThread/Widgets/WidgetSnapshotPublisher.swift owns the rollup: compute(listings:sales:now:isSignedIn:calendar:) is a pure, unit-testable function (active = listings where status==active; soldToday buckets sales by Calendar.startOfDay against now; pendingPayout = sales with nil/empty payoutReference, netting platformFees out of salePrice and flooring at zero so bad fee data can't drag the total negative); publish(container:isSignedIn:) is the thin SwiftData-fetch + WidgetSnapshotStore.write + WidgetCenter.reloadAllTimelines wrapper. SyncEngine.pull() calls publishWidgetSnapshot() after each successful merge so the widget tracks the latest sync; ContentView's sign-out branch calls publishSignedOut() so the widget stops showing the previous user's numbers the instant they log out. The widget itself (GradeThreadWidget.swift) is a @main WidgetBundle with one StaticConfiguration SnapshotWidget supporting .systemSmall + .systemMedium. SnapshotProvider.getTimeline reads the App Group snapshot (falls back to signedOut() when none written) and sets a .after(+30min) refresh policy as a backstop — the app's reloadAllTimelines is the primary refresh trigger, the timer just keeps the 'Updated Xm ago' footnote honest if the app hasn't run. Small family shows sold-today + payout-waiting stacked; medium shows active / sold-today / payout in a three-column row with dividers. Signed-out state swaps to a 'Sign in to see today's sales and payout' prompt. Brand navy/red are inlined as Color literals since the widget target doesn't include the main app's asset catalog. containerBackground(.fill.tertiary, for: .widget) satisfies the iOS 17 widget background requirement. Tests in WidgetSnapshotTests cover every compute() branch (signed-out short-circuit, active-only listing count, startOfDay bucketing with a boundary sale, paid-vs-pending payout split, empty-string payoutReference counts as pending, fee>price floors at zero, empty-but-signed-in is all-zeros not signedOut) plus the Codable round-trip and the signedOut factory. project.yml gains the GradeThreadWidget target + Shared/ on its sources so it compiles WidgetSnapshot.",
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
