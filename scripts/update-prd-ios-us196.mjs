// Mark US-196 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-196": {
    passes: true,
    notes:
      "Done 2026-05-27. .github/workflows/ios-release.yml extended so every push to main touching ios/** auto-archives + uploads to TestFlight. Build number derived from GITHUB_RUN_NUMBER so each upload is monotonic across the repo lifetime without manual bumping. Three triggers: push to main → auto beta; ios-v* tag → version bump (tag annotation becomes the release-notes body); workflow_dispatch → manual cut with optional submit_to_app_store flag. Auto release-notes step pulls commits between the previous ios-v* tag and HEAD (`git log $PREV..HEAD -- ios/`); the workflow_dispatch input wins when non-empty; tag pushes use the annotation. Notes surface in $GITHUB_STEP_SUMMARY for paste-in to App Store Connect's 'What to test' — the full API path (POST /v1/betaBuildLocalizations) needs the resolved BUILD ID which only exists 5–10 min after upload-processing finishes, so polling for it in CI is fragile; switch to fastlane pilot when you want full automation. ios/README.md updated: workflow table reflects the new push-to-main trigger; new sections cover (a) cutting a release across all three paths, (b) App Store Connect TestFlight tester-group setup (Internal vs Beta + beta-review timing), (c) crash report forwarding via both TestFlight's built-in collector and the Sentry DSN that US-191 wired in production builds, with a note on the dSYM upload follow-up. fetch-depth: 0 added to the checkout step so the release-notes diff against the previous tag actually has history to walk. Code signing still flows through the App Store Connect API key + ephemeral keychain setup from US-168; no manual provisioning profile dance.",
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
