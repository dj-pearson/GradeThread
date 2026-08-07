// US-1872 AC5 — the legacy-folder retirement gate, enforced.
//
// AC5 says the two legacy extension folders are deleted "once the unified
// extension reaches parity". For a year that condition lived only as prose,
// repeated verbatim in five files, and it rotted in all five at once: each said
// "parity is not reached (US-1880/1881/1882/1883 are open)" long after US-1883
// shipped and after the Firefox + postMessage-bridge work (US-1881/1882) landed.
// Nothing went red, because a sentence has no compiler. The next reader inherits
// a gate naming four stories, most of them done, and has to re-derive the whole
// question — which is exactly what happened.
//
// scripts/lib/extension-retirement-gate.cjs replaces that with a computed value,
// and this file enforces it. Three things are checked, and the third is the one
// nobody writes:
//
//   1. PARITY HOLDS. The unified extension must do everything both legacy
//      folders do — every permission, every host, every page a content script
//      reaches, every source file, every icon size. This is the US-2020 drift
//      guard generalised: legacy must never gain something unified lacks.
//
//   2. WHILE THE GATE IS SHUT, THE LEGACY FOLDERS STAY AND KEEP SHIPPING. The
//      legacy store listings are still the only distribution GradeThread has.
//      Deleting the folders early would leave installed users on a build we can
//      no longer fix, so both folders must exist AND still be packaged.
//
//   3. ONCE THE GATE OPENS, THE FOLDERS MUST BE GONE. Guards normally check
//      that work has not happened prematurely. This one also checks the
//      opposite: flip LEGACY_STORE_LISTINGS_RETIRED to true, forget to delete,
//      and the build fails. Without that, "satisfied" is just another sentence
//      nobody acts on, and the three-extensions tax quietly becomes permanent.
//
// Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const gateModulePath = path.join(root, "scripts", "lib", "extension-retirement-gate.cjs");
const {
  LEGACY_EXTENSIONS,
  UNIFIED_DIR,
  checkCodeParity,
  covers,
  retirementGate,
} = require(gateModulePath);

const gate = retirementGate(root);

// ── 0. the checker is actually checking something ───────────────────────────
//
// A parity checker that resolves nothing passes forever. The repo has already
// named this failure mode once (firefox-version-floor.test.cjs), so assert the
// inputs before trusting the verdict.
assert.ok(
  LEGACY_EXTENSIONS.length === 2,
  "the gate must know about both legacy extensions (extension/ + extension-condition/)",
);
assert.ok(
  covers("https://*.ebay.com/*", "https://*.ebay.com/itm/*"),
  "match-pattern coverage is broken: a whole-host pattern must cover a path-scoped one",
);
assert.ok(
  !covers("https://*.ebay.com/itm/*", "https://*.ebay.com/*"),
  "match-pattern coverage is too permissive: a path-scoped pattern must NOT cover " +
    "the whole host, or a real reach regression would certify as parity",
);
assert.ok(
  !covers("https://*.poshmark.com/*", "https://*.mercari.com/*"),
  "match-pattern coverage is too permissive across hosts",
);

// ── 1. parity holds ─────────────────────────────────────────────────────────
const parity = checkCodeParity(root);
assert.ok(
  parity.ok,
  `The unified extension has FALLEN BEHIND the legacy folders:\n` +
    parity.gaps.map((g) => `  • ${g}`).join("\n") +
    `\n\nEvery fix goes to ${UNIFIED_DIR}/ (US-2020). A capability that exists only ` +
    `in a deprecated folder is one the replacement can never inherit, and it blocks ` +
    `US-1872 AC5 outright — the folders cannot be deleted while they still do ` +
    `something the unified extension does not.`,
);

// ── 2 / 3. the gate's two states, against what is actually on disk ──────────
const legacyOnDisk = LEGACY_EXTENSIONS.filter((e) =>
  fs.existsSync(path.join(root, e.dir, "manifest.json")),
).map((e) => e.dir);

(async () => {
  const { pathToFileURL } = require("node:url");
  const pkgPath = path.resolve(root, "scripts", "package-extensions.mjs");
  const { EXTENSIONS } = await import(pathToFileURL(pkgPath).href);
  const packaged = EXTENSIONS.map((e) => e.dir);

  assert.ok(
    packaged.includes(UNIFIED_DIR),
    `package-extensions.mjs must always ship ${UNIFIED_DIR}/ — it is the replacement`,
  );

  if (gate.satisfied) {
    // The gate is OPEN. Deletion is now required, not optional.
    assert.deepStrictEqual(
      legacyOnDisk,
      [],
      `US-1872 AC5 IS NOW DUE. The retirement gate is satisfied — parity holds and ` +
        `LEGACY_STORE_LISTINGS_RETIRED is true — but ${legacyOnDisk.join(" and ")} ` +
        `still exist. Delete them, drop their entries from package-extensions.mjs, ` +
        `remove extension-unified/test/legacy-parity.test.cjs (it exists only to make ` +
        `the overlap survivable, not permanent), and point the READMEs at ` +
        `${UNIFIED_DIR}/ alone.`,
    );
    for (const e of LEGACY_EXTENSIONS) {
      assert.ok(
        !packaged.includes(e.dir),
        `package-extensions.mjs still builds a store zip from ${e.dir}, whose listing ` +
          `("${e.storeName}") has been retired. Drop the entry.`,
      );
    }
  } else {
    // The gate is SHUT. Both folders must remain and must keep shipping, because
    // real users are still installing them from live store listings.
    assert.deepStrictEqual(
      legacyOnDisk.sort(),
      LEGACY_EXTENSIONS.map((e) => e.dir).sort(),
      `A legacy extension folder has been deleted while the retirement gate is still ` +
        `SHUT:\n${gate.blockers.map((b) => `  • [${b.id}] ${b.why}`).join("\n")}\n\n` +
        `Its store listing is live and users have it installed; with the folder gone ` +
        `they cannot be shipped a fix. Restore it, or close the blocker first.`,
    );
    for (const e of LEGACY_EXTENSIONS) {
      assert.ok(
        packaged.includes(e.dir),
        `package-extensions.mjs no longer builds a store zip from ${e.dir}, but its ` +
          `listing ("${e.storeName}") is still live. An extension we cannot rebuild is ` +
          `one we cannot patch.`,
      );
    }
  }

  // ── 4. the prose must not restate the gate ────────────────────────────────
  //
  // This is the actual lesson. Five files each carried their own copy of the
  // gate condition and all five went stale together. They may describe it, but
  // they must POINT at the computed one, and they must not re-list the story
  // ids — that list is what went wrong, and it is wrong again the moment any
  // of those stories lands.
  const PROSE = [
    "extension/README.md",
    "extension-condition/README.md",
    "extension-unified/README.md",
    "scripts/package-extensions.mjs",
    "extension-unified/test/legacy-parity.test.cjs",
  ].filter((rel) => fs.existsSync(path.join(root, rel)));

  // A RUN of three or more slash-joined story ids. Two adjacent ids is ordinary
  // attribution ("Cross-browser (US-1881 / US-1882)") and stays legal; a run of
  // three is a checklist, and a checklist of story ids is precisely the framing
  // that rotted — "US-1880/1881/1882/1883 are open", repeated in five files.
  const STALE_LIST = /US-\d{3,4}(?:\s*\/\s*(?:US-)?\d{3,4}){2,}/;
  for (const rel of PROSE) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    assert.ok(
      src.includes("extension-retirement-gate"),
      `${rel} discusses the legacy folders but does not point at ` +
        `scripts/lib/extension-retirement-gate.cjs. The gate is computed in exactly ` +
        `one place now; a second description of it is a second thing to keep true.`,
    );
    const stale = STALE_LIST.exec(src);
    assert.ok(
      !stale,
      `${rel} states the retirement gate as a list of open story ids ` +
        `(matched ${JSON.stringify(stale && stale[0])}). That framing is what ` +
        `rotted: it named US-1883 as open for weeks after it shipped, and none of the ` +
        `stories in it were ever parity blockers — they make the unified extension ` +
        `BETTER than the legacy ones, which is a different thing. Describe the two ` +
        `real conditions (computed parity, retired store listings) and link the module.`,
    );
  }

  console.log(
    `✓ legacy-retirement-gate: parity holds (${LEGACY_EXTENSIONS.length} legacy folders ` +
      `fully superseded by ${UNIFIED_DIR}/); gate ${gate.satisfied ? "OPEN — deletion due" : "SHUT"}` +
      (gate.satisfied ? "" : ` on ${gate.blockers.map((b) => b.id).join(", ")}`),
  );
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
