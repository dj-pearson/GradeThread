// US-3054: the screenshot harness stays complete and honest, as source.
//
// The render itself needs a browser (scripts/extension-screenshots.mjs); this
// zero-dep half pins what CI can check without one: the plan covers every
// surface and state the story names, the stub fails on a message it does not
// know, the baseline exists and lists exactly the plan, and TESTING.md says
// when to run it.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");
const repo = path.resolve(dir, "..");
const script = fs.readFileSync(path.join(repo, "scripts", "extension-screenshots.mjs"), "utf8");
const stub = fs.readFileSync(path.join(repo, "scripts", "lib", "extension-stub.mjs"), "utf8");

// ── 1. the plan: three states, two schemes, three tabs, three pages ─────────
assert.ok(/STATES = \["anon", "buyer", "seller"\]/.test(script), "three fixture states");
for (const tag of ["system-light", "system-dark", "forced-light", "forced-dark"]) {
  assert.ok(script.includes('tag: "' + tag + '"'), "the plan renders the " + tag + " variant (US-3055)");
}
assert.ok(/POPUP_TABS = \["Reads", "Selling", "Settings"\]/.test(script), "all three popup tabs");
for (const page of ["onboarding.html", "options.html", "compare.html"]) {
  assert.ok(script.includes('["' + page + '"'), "the plan renders " + page);
}
assert.ok(/page\.clock\.setFixedTime\(FROZEN_NOW\)/.test(script), "the clock is frozen, or every relative time drifts the hash");
assert.ok(/fixture\(item\.state, FROZEN_NOW\)/.test(script), "the fixture is built against the same frozen instant");
assert.ok(script.includes('"dist-ext", "screenshots"'), "renders land in dist-ext/screenshots/");
assert.ok(/--check/.test(script) && /--update/.test(script), "check and update modes exist");
assert.ok(/base\.chromium !== version/.test(script) && /process\.exit\(2\)/.test(script),
  "a different Chromium build is reported as incomparable (exit 2), not as drift");

// ── 2. the stub answers every message the popup sends, and no more ──────────
const popupJs = fs.readFileSync(path.join(dir, "popup.js"), "utf8");
const sent = new Set([...popupJs.matchAll(/type: "(GT_[A-Z_]+)"/g)].map((m) => m[1]));
// Messages the popup sends to a TAB (tabs.sendMessage) are answered by the
// content script, which the stub represents with a null reply — not by the worker.
const tabMessages = new Set(["GT_SYNC_RUN", "GT_LISTER_PROBE", "GT_LISTER_WATCH", "GT_CC_FLIP_CONTEXT"]);
for (const type of sent) {
  if (tabMessages.has(type)) continue;
  assert.ok(stub.includes(type + ":"), "extension-stub.mjs does not answer " + type + " — add it, or the harness renders a hole");
}
assert.ok(/throw new Error\("extension-stub: unknown message/.test(stub), "an unknown message must throw, never answer ok");

// ── 3. the baseline exists and matches the plan ─────────────────────────────
const baselinePath = path.join(dir, "test", "fixtures", "screenshot-baseline.json");
assert.ok(fs.existsSync(baselinePath), "test/fixtures/screenshot-baseline.json must be committed (run --update)");
const base = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
assert.ok(typeof base.chromium === "string" && base.chromium, "the baseline records the Chromium build it was made with");
const expected = [];
const TAGS = ["system-light", "system-dark", "forced-light", "forced-dark"];
for (const s of ["anon", "buyer", "seller"]) for (const c of TAGS) for (const t of ["reads", "selling", "settings"]) expected.push("popup-" + s + "-" + c + "-" + t);
for (const p of ["onboarding", "options", "compare"]) for (const c of TAGS) expected.push(p + "-" + c);
assert.deepStrictEqual(Object.keys(base.hashes).sort(), expected.sort(), "the baseline lists exactly the plan's renders");
for (const [k, v] of Object.entries(base.hashes)) assert.ok(/^[0-9a-f]{64}$/.test(v), k + " carries a sha256");

// ── 4. documented as the step before a store upload ─────────────────────────
const testing = fs.readFileSync(path.join(dir, "TESTING.md"), "utf8");
assert.ok(testing.includes("node scripts/extension-screenshots.mjs --check"), "TESTING.md must document --check");
assert.ok(/store upload|upload/i.test(testing.slice(testing.indexOf("extension-screenshots"))), "TESTING.md must tie the check to the store upload");

console.log("screenshot-harness.test.cjs: plan covers 3 states x 4 theme variants x (3 tabs + 3 pages), stub answers every popup message and throws on unknown, baseline matches the plan, documented");
