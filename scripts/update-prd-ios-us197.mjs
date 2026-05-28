// Mark US-197 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-197": {
    passes: true,
    notes:
      "Done 2026-05-28. App Store submission pipeline wired with every committable artifact in the repo; what remains is operational (run screenshots on a Mac, fill the real demo-account creds, transcribe privacy answers + age rating into App Store Connect). App icon: the existing 1024x1024 GradeThread mark (public/logo_icon_1024.png) copied into ios/GradeThread/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png and Contents.json now references it by filename (slot was previously empty — Apple rejects buildless icons). ios/GradeThread/PrivacyInfo.xcprivacy is the real Apple-required on-device privacy manifest: NSPrivacyTracking=false, no tracking domains, NSPrivacyCollectedDataTypes for email+name+purchase-history+photos (linked to identity, not tracking, App Functionality) + crash data (Sentry, not linked) + product interaction (PostHog, not linked, Analytics), and NSPrivacyAccessedAPITypes declaring UserDefaults (CA92.1) + file timestamp (C617.1) required-reason APIs. Picked up automatically by the GradeThread source glob (XcodeGen routes .xcprivacy to the resources phase). fastlane scaffolding under ios/: Gemfile pins fastlane ~>2.220; fastlane/Appfile reads apple_id/team_id from env so no personal Apple ID is committed; fastlane/Fastfile has lanes generate_project (xcodegen), screenshots (capture_screenshots), upload_metadata (deliver metadata-only), and release (deliver metadata+screenshots+submit), all authed via app_store_connect_api_key built from the same ASC API-key env vars CI already exports for the binary upload — no Apple ID password / 2FA; fastlane/Snapfile targets the three required device sizes (6.7\" iPhone 15 Pro Max, 6.1\" iPhone 15, 12.9\" iPad Pro), en-US, status-bar override, pointed at a dedicated GradeThreadScreenshots scheme; fastlane/Deliverfile sets skip_binary_upload (altool already did it), precheck-before-submit at :error, phased_release, and export-compliance=false matching Info.plist. Marketing copy in fastlane/metadata/en-US: name 'FlipDesk by GradeThread' (23 chars), subtitle, 170-char promotional_text, a full <4000-char description, keywords (94 chars, under the 100 cap), release_notes, support/marketing/privacy URLs; app-level copyright + primary(BUSINESS)/secondary(SHOPPING) categories; review_information/ with contact name+email (support@pearson-media.com), phone placeholder, and demo_user/demo_password placeholders (REVIEW_DEMO_*_PLACEHOLDER — operator fills real seeded-sandbox creds before submit) + a thorough notes.txt walking App Review through sign-in, the eBay sandbox connection, AI review-before-save, permissions, and the commercial-activity note. fastlane/metadata/PRIVACY_LABELS.md is the source-of-truth mapping the operator transcribes into App Store Connect's web App Privacy form (per-data-type linked/tracking/purpose + per-SDK disclosure for Supabase/Sentry/PostHog/eBay) plus age-rating guidance (expect 17+ for commercial selling) and the required-reason API list kept in lock-step with the manifest. Screenshot UI test: new GradeThreadUITests target (bundle.ui-testing, com.gradethread.app.uitests) with the vendored fastlane SnapshotHelper.swift + ScreenshotUITests.testCaptureScreenshots that setupSnapshot + launches with -uiTestScreenshots and captures 01_Welcome always, then walks Inventory/ItemCanvas/Sales/Marketplaces guarded by existence checks so it passes whether or not a demo-seed path is present (full in-app screenshots need the demo dataset). The UI test is deliberately kept OUT of the GradeThread scheme's test action (so PR/unit CI stays fast) and runs only via a dedicated top-level GradeThreadScreenshots scheme that the Snapfile points at. CI: .github/workflows/ios-release.yml submit_to_app_store step replaced the exit-0 checkpoint with bundle install + bundle exec fastlane release; runs only on workflow_dispatch with the flag set so tag pushes never auto-submit. ios/RELEASE.md Phase 10 updated with the pre-first-submit checklist (real demo creds, capture+commit screenshots or upload manually, transcribe privacy labels, complete age rating) and the fastlane-integration line removed from the 'doesn't cover yet' section. Operational remainder (not code): screenshots must be captured on a Mac/simulator, the demo account must be seeded in the real sandbox, and the App Privacy + age-rating answers entered in the ASC web UI.",
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
