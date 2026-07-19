// US-2020 — legacy ⇄ unified selector parity guard.
//
// WHY THIS EXISTS, and why it is not just tidiness.
//
// Three MV3 extensions ship today: extension/ (Lister, seller), extension-condition/
// (Condition Check, buyer) and extension-unified/ (both, role-gated). The founder
// decision of 2026-07-09 deprecated the first two in favour of the third, and
// US-1872 AC5 owns deleting them — but only "once the unified extension reaches
// parity", and parity is not reached (US-1880/1881/1882/1883 are open). So all
// three are still packaged for the stores by scripts/package-extensions.mjs, and
// every fix has to be applied by hand in two places.
//
// That hand-sync ALREADY FAILED ONCE, silently, in the most expensive way:
//
//   US-1875 AC1 fixed the Poshmark delist probe in the unified extension. The
//   flow required BOTH `menu` and `remove` before any interaction, but `remove`
//   lives inside the overflow menu and does not exist until `menu` is clicked —
//   which runDelistFlow does AFTER the probe. So the probe could never be
//   satisfied and every auto-delist bailed out, reporting "Poshmark's page
//   changed" — blaming the marketplace for our own bug, which is why nobody
//   chased it. The fix landed in extension-unified only. The legacy Lister kept
//   shipping the broken probe for four days.
//
// A drift guard is the cheap half of the fix. The expensive half — deleting the
// legacy folders — is US-1872 AC5 and is correctly gated on parity. Until then,
// this fails the build the moment the two copies disagree on a selector contract,
// so the next divergence is loud instead of silent.
//
// SCOPE, deliberately narrow: this compares the delist PROBE CONTRACT, not the
// files. The two trees legitimately differ (the unified copy carries `verify`
// blocks the legacy runtime does not implement, and their layouts differ), so a
// whole-file diff would be permanently red and would be switched off — which is
// how guards die. What must never diverge is which selectors are required BEFORE
// any interaction, because getting that wrong disables the flow entirely and
// reports it as someone else's fault.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..", "..");

/** Evaluate a selectors.js that assigns to a bare global, and return that global. */
function loadSelectors(relPath, globalName) {
  const src = fs.readFileSync(path.join(root, relPath), "utf8");
  // Content scripts run against a browser global; the files assign to `self`
  // and/or a bare global, so provide both rather than editing shipped source
  // to suit a test.
  const ctx = {};
  ctx.self = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${src}\n;globalThis.__out = typeof ${globalName} !== "undefined" ? ${globalName} : null;`, ctx);
  const out = ctx.__out;
  assert.ok(out, `${relPath}: expected ${globalName} to be defined`);
  return out;
}

const legacy = loadSelectors("extension/selectors.js", "GT_LISTER_SELECTORS");
const unified = loadSelectors("extension-unified/lister/selectors.js", "GT_LISTER_SELECTORS");

const PLATFORMS = ["poshmark", "mercari", "grailed"];

// ── 1. The same platforms exist on both sides ───────────────────────────────
for (const p of PLATFORMS) {
  assert.ok(legacy[p], `extension/selectors.js is missing platform ${p}`);
  assert.ok(unified[p], `extension-unified/lister/selectors.js is missing platform ${p}`);
}

// ── 2. The delist probe contract matches — THE REGRESSION THIS GUARD EXISTS FOR ──
for (const p of PLATFORMS) {
  const a = legacy[p].delist;
  const b = unified[p].delist;
  assert.ok(a && b, `${p}: both copies must declare a delist flow`);
  // Compared as JSON, not deepStrictEqual: the two selector trees are evaluated
  // in separate vm realms, so their Array prototypes differ and a strict deep
  // compare fails on identical CONTENT ("actual: ['menu'], expected: ['menu']").
  assert.strictEqual(
    JSON.stringify(a.required),
    JSON.stringify(b.required),
    `${p}: delist \`required\` has DRIFTED between the legacy Lister and the ` +
      `unified extension (legacy=${JSON.stringify(a.required)}, ` +
      `unified=${JSON.stringify(b.required)}). This is the US-1875 bug class: a ` +
      `selector that only exists after an interaction must NOT be required by the ` +
      `pre-interaction probe, or the whole flow silently degrades to "list manually" ` +
      `and blames the marketplace. Fix both copies, or delete the legacy folder ` +
      `(US-1872 AC5).`,
  );
}

// ── 3. No probe requires a selector that only exists post-interaction ────────
// The invariant itself, asserted independently of parity — so a change applied
// consistently to BOTH copies still cannot reintroduce the bug.
for (const [label, tree] of [["legacy", legacy], ["unified", unified]]) {
  for (const p of PLATFORMS) {
    const d = tree[p].delist;
    assert.ok(
      !Array.from(d.required).includes("remove"),
      `${label}/${p}: delist.required includes "remove", which does not exist ` +
        `until the overflow menu is clicked — the probe runs BEFORE that click, so ` +
        `this makes the flow unsatisfiable on every run (US-1875 AC1).`,
    );
    assert.ok(
      Array.from(d.required).includes("menu"),
      `${label}/${p}: delist.required must include "menu" — it is the one control ` +
        `that does exist pre-interaction, and probing nothing would mean guessing.`,
    );
  }
}

console.log("✓ legacy-parity: delist probe contracts agree and none require a post-interaction selector");
