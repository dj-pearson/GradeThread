// Mark US-169 passed (Supabase Swift SDK + edge API client).
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-169": {
    passes: true,
    notes:
      "Done 2026-05-27. SPM dependency on supabase-community/supabase-swift pinned to 2.x declared in ios/project.yml. ios/GradeThread/Config/{Debug,Release}.xcconfig hold SUPABASE_URL / SUPABASE_ANON_KEY / EDGE_API_URL (placeholders — set real values before shipping or override in CI). Info.plist surfaces them via $(VAR) substitution. ios/GradeThread/Networking/AppConfig.swift reads them at runtime, fatalError-ing if a key is missing or still the placeholder. SupabaseShared.swift exposes a single shared SupabaseClient + a safe currentAccessToken() that returns nil when no session. EdgeAPI.swift is an actor wrapping URLSession with getJSON / postJSON / deleteJSON; auto-attaches the Supabase access token to every request, encodes/decodes via snake_case + ISO8601 to match the edge service. EdgeAPIError enum maps HTTP statuses + parses the edge service's { error, detail } shape into typed cases. Hermetic tests in EdgeAPITests.swift exercise happy path (auth header, body encoding, nil-token-omits-header) + every error mapping (401/429/400/500/network) via a custom URLProtocol mock — no real network calls. Compilation verified in CI (xcodebuild test on macOS runner).",
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
