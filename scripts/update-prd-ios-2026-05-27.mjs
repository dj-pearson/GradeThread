// Mark US-168 passed (Xcode project scaffold + CI/CD pipeline).
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-168": {
    passes: true,
    notes:
      "Done 2026-05-27. ios/ directory uses XcodeGen as source of truth (project.yml) — .xcodeproj is generated, not checked in. App scaffold: GradeThread/App.swift (SwiftUI @main), ContentView.swift (4-tab shell: Inventory / Add / Sales / Settings) tinted brand navy, Info.plist with camera + photo-library usage strings, Assets.xcassets with AppIcon + AccentColor (brand navy #0F3460). Unit test target wired with one smoke test. GitHub Actions: .github/workflows/ios-ci.yml (xcodegen → xcodebuild test on iPhone 15 simulator, macos-14 runner, Xcode 15.4) and .github/workflows/ios-release.yml (ephemeral signing keychain, archive → export .ipa → TestFlight upload via altool, optional App Store submission gate). Required GitHub secrets and one-time App Store Connect setup documented in ios/README.md. iOS 16+, Swift 5.9, iPhone+iPad device family.",
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
