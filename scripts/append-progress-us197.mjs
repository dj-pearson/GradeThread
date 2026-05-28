import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const FILE = path.join(ROOT, "progress.txt");

let text = fs.readFileSync(FILE, "utf8");
text = text.replace(
  /- iOS app \(US-168 → US-199\): 30\/32[^\n]*/,
  "- iOS app (US-168 → US-199): 31/32 — through US-188 + US-191/192/195/198 + US-196 TestFlight + US-199 + US-193 iPad + US-189 Share Extension + US-190 Widgets + US-197 App Store submission. US-194 remaining (held — conflicts with pricing rework)"
);

const note = `

## Session Notes (2026-05-28) — iOS App Store submission (US-197)
Every committable submission artifact landed; remainder is operational
(screenshots on a Mac, real demo creds, ASC web-form privacy + rating).

What landed:
- App icon: existing 1024 mark copied into AppIcon.appiconset +
  Contents.json references it by filename (slot was empty before).
- ios/GradeThread/PrivacyInfo.xcprivacy — real Apple privacy manifest:
  email/name/purchases/photos linked, crash + product-interaction not
  linked, no tracking; UserDefaults (CA92.1) + file timestamp (C617.1)
  required-reason APIs. Picked up by the source glob.
- fastlane scaffolding (ios/Gemfile + ios/fastlane/{Appfile,Fastfile,
  Snapfile,Deliverfile}). Lanes: generate_project, screenshots,
  upload_metadata, release. Auth via the ASC API key CI already has —
  no Apple ID password.
- Marketing copy in fastlane/metadata/en-US: name 'FlipDesk by
  GradeThread', subtitle, promo text, <4000-char description,
  keywords (94 chars), release notes, support/marketing/privacy URLs.
  App-level copyright + BUSINESS/SHOPPING categories. review_information
  with contact + demo_user/demo_password PLACEHOLDERS + thorough
  reviewer notes.txt.
- fastlane/metadata/PRIVACY_LABELS.md — the data-type + per-SDK mapping
  the operator transcribes into App Store Connect's web App Privacy
  form, plus age-rating guidance (expect 17+) and the required-reason
  list kept in sync with the manifest.
- Screenshot UI test: new GradeThreadUITests target (bundle.ui-testing)
  + vendored SnapshotHelper + ScreenshotUITests. Captures 01_Welcome
  always, walks Inventory/Canvas/Sales/Marketplaces guarded by
  existence checks. Kept OUT of the GradeThread scheme's test action
  (unit CI stays fast) — runs via a dedicated GradeThreadScreenshots
  scheme the Snapfile points at.
- CI: ios-release.yml submit_to_app_store step now runs
  'bundle exec fastlane release' (was an exit-0 checkpoint). Only on
  workflow_dispatch with the flag set; tag pushes never auto-submit.
- RELEASE.md Phase 10 rewritten with the pre-first-submit checklist.

Operational remainder before first submit (not code):
- Capture + commit screenshots on a Mac/simulator (or upload manually).
- Seed the demo account in the real eBay sandbox + fill demo creds.
- Enter App Privacy answers + complete the age-rating questionnaire
  in the App Store Connect web UI.
`;

fs.writeFileSync(FILE, text + note);
console.log(`updated header + appended ${note.length} chars`);
