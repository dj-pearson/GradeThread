// GradeThread Condition Check — bundled ⇄ hosted config sync guard (US-1879).
//
// The README's "fix BOTH files" rule was unenforced: the bundled adapter config
// (extension-condition/selectors.js GT_CC_CONFIG) and the hosted, remotely-fetched
// copy (public/extension/marketplace-selectors.json) could silently drift — a
// selector fixed in one but not the other ships a half-broken adapter, and a
// version bump in one alone breaks the US-1879 downgrade gate. This guard fails
// the build unless the two agree on `version` + the whole `adapters` map. Same
// pattern as the PUBLIC_ROUTES / prerender sync guard. Run in verify:web.
//
// Zero-dependency node script (matches image-utils.test.cjs): throws on mismatch.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");

// Parse the bundled config out of selectors.js WITHOUT importing it (it assigns
// to `self` and declares a top-level const). Run the file body in a Function with
// an injected `self`, then read what it exported.
function loadBundledConfig() {
  const src = fs.readFileSync(
    path.join(root, "extension-condition", "selectors.js"),
    "utf8",
  );
  const selfObj = {};
   
  new Function("self", src)(selfObj);
  assert.ok(selfObj.GT_CC_CONFIG, "selectors.js must assign self.GT_CC_CONFIG");
  return selfObj.GT_CC_CONFIG;
}

function loadHostedConfig() {
  const json = fs.readFileSync(
    path.join(root, "public", "extension", "marketplace-selectors.json"),
    "utf8",
  );
  return JSON.parse(json);
}

const bundled = loadBundledConfig();
const hosted = loadHostedConfig();

// Versions must match — a mismatch means someone bumped one file and forgot the
// other (and the downgrade gate would misfire on the difference).
assert.equal(
  hosted.version,
  bundled.version,
  `version drift: selectors.js is ${bundled.version} but marketplace-selectors.json is ${hosted.version} — bump BOTH`,
);
assert.equal(
  hosted.lastVerified,
  bundled.lastVerified,
  `lastVerified drift: selectors.js=${bundled.lastVerified} json=${hosted.lastVerified} — update BOTH`,
);

// The adapter maps must be byte-for-byte equivalent (order-independent). This is
// the crux: a selector fixed in one file but not the other is the exact silent
// failure this guard prevents.
assert.deepStrictEqual(
  hosted.adapters,
  bundled.adapters,
  "adapters differ between selectors.js and marketplace-selectors.json — fix BOTH files identically",
);

const n = Object.keys(bundled.adapters).length;
console.log(
  `config-sync.test.cjs: bundled ⇄ hosted config in sync (v${bundled.version}, ${n} adapters)`,
);
