import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const FILE = path.join(ROOT, "progress.txt");

// Bump the iOS counter header line.
let text = fs.readFileSync(FILE, "utf8");
text = text.replace(
  /- iOS app \(US-168 → US-199\): 29\/32[^\n]*/,
  "- iOS app (US-168 → US-199): 30/32 — through US-188 + US-191/192/195/198 + US-196 TestFlight + US-199 post-launch + US-193 iPad split-view + US-189 Share Extension + US-190 Widgets. US-194/197 remaining"
);

const note = `

## Session Notes (2026-05-28) — iOS Widgets (US-190)
Home-screen widget showing today's selling snapshot + pending payout.

What landed:
- ios/GradeThreadWidget/ is its own WidgetKit app-extension target.
  Bundle id com.gradethread.app.widget. project.yml declares it and
  the GradeThread target embeds it via dependencies.target embed:true.
- Widgets run in a separate process with no SwiftData access, so the
  app publishes a rollup to the shared App Group container
  (group.com.gradethread.app, reused from US-189) and the widget
  reads it back — no network, no DB.
- ios/Shared/WidgetSnapshot.swift is the Codable cross-target model +
  WidgetSnapshotStore (atomic App Group JSON write/read). write()
  returns false rather than throwing when the container's missing so
  unit tests + unsigned builds degrade gracefully.
- ios/GradeThread/Widgets/WidgetSnapshotPublisher.swift: compute()
  is pure + unit-tested (active listings, sold-today by startOfDay,
  pending payout = sales w/o payoutReference netting fees, floored at
  zero); publish() fetches from SwiftData + writes + reloads timelines.
- SyncEngine.pull() republishes after each merge; ContentView's
  sign-out path publishes the signed-out placeholder so the widget
  stops showing the previous user's numbers.
- GradeThreadWidget.swift: @main WidgetBundle, StaticConfiguration,
  TimelineProvider reads the snapshot with a +30min backstop refresh
  (app reloads are the primary trigger). Small family = sold-today +
  payout stacked; medium = active / sold-today / payout row. Signed-
  out swaps to a sign-in prompt. Brand colors inlined as literals
  (widget target has no asset catalog).

Tests in WidgetSnapshotTests:
- signed-out short-circuit; active-only listing count
- sold-today startOfDay bucketing incl. boundary sale
- paid-vs-pending payout split; empty-string payoutReference = pending
- fee>price floors net at zero; empty-but-signed-in is all-zeros
- Codable round-trip; signedOut factory
`;

fs.writeFileSync(FILE, text + note);
console.log(`updated header + appended ${note.length} chars`);
