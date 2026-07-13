// GradeThread unified extension — bundled ⇄ hosted config sync guard (US-1879).
//
// The unified extension's bundled adapter config (research/selectors.js
// GT_CC_CONFIG) and the hosted, remotely-fetched copy
// (public/extension/marketplace-selectors.json) must not drift — a selector fixed
// in one but not the other ships a half-broken adapter, and a version bump in one
// alone breaks the US-1879 downgrade gate. This fails the build unless the two
// agree on `version`, `lastVerified`, and the whole `adapters` map. Same pattern
// as extension-condition/test/config-sync.test.cjs. Zero-dependency: throws on
// mismatch.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");

function loadBundledConfig() {
  const src = fs.readFileSync(
    path.join(root, "extension-unified", "research", "selectors.js"),
    "utf8",
  );
  const selfObj = {};
  // eslint-disable-next-line no-new-func
  new Function("self", src)(selfObj);
  assert.ok(selfObj.GT_CC_CONFIG, "research/selectors.js must assign self.GT_CC_CONFIG");
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

assert.equal(
  hosted.version,
  bundled.version,
  `version drift: research/selectors.js is ${bundled.version} but marketplace-selectors.json is ${hosted.version} — bump BOTH`,
);
assert.equal(
  hosted.lastVerified,
  bundled.lastVerified,
  `lastVerified drift: research/selectors.js=${bundled.lastVerified} json=${hosted.lastVerified} — update BOTH`,
);
assert.deepStrictEqual(
  hosted.adapters,
  bundled.adapters,
  "adapters differ between research/selectors.js and marketplace-selectors.json — fix BOTH files identically",
);

const n = Object.keys(bundled.adapters).length;
console.log(
  `config-sync.test.cjs (unified): bundled ⇄ hosted config in sync (v${bundled.version}, ${n} adapters)`,
);
