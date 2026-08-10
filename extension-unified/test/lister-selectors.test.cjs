// GradeThread unified extension — lister selector invariants (US-2477..US-2480).
//
// Thin wrapper so the checks in scripts/verify-lister-selectors.mjs run in the
// same lane as every other extension guard (scripts/test-extensions.mjs, wired
// into verify:web and CI). The logic lives in the script rather than here
// because the script is ALSO the thing a human runs by hand:
//
//   node scripts/verify-lister-selectors.mjs --checklist mercari
//
// prints the verification checklist for a platform. Duplicating the invariants
// into a test file would mean the checklist and the gate could disagree, which
// is precisely the failure mode they exist to prevent.
//
// What it enforces, in one line each:
//   • `enabled: true` requires a real `lastVerified` date and a non-draft version
//   • a delist probe never requires a post-interaction selector (US-1875)
//   • `hosts` is non-empty (an empty one silently disables auto-delist)
//   • `liveListingUrlPattern` exists and cannot match the create page itself
//   • every locale in a `locales` map is also a delistable host

const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const script = path.join(root, "scripts", "verify-lister-selectors.mjs");

const r = spawnSync(process.execPath, [script], { encoding: "utf8" });

if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);

assert.strictEqual(
  r.status,
  0,
  "verify-lister-selectors reported a problem — see the output above. A flow " +
    "that fails these cannot be trusted to fill a seller's real listing form.",
);
