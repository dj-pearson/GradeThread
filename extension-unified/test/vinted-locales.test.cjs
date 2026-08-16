// GradeThread unified extension — Vinted locale coverage guard (US-2479).
//
// Vinted runs the same app on ~20 country domains, and three separate lists have
// to agree about which of them we support:
//
//   1. `locales` in lister/selectors.js — where we will OPEN a new-listing form.
//   2. `hosts`   in lister/selectors.js — whose listing URLs lister-guard will
//      accept for a DELIST.
//   3. manifest.json — where the content script is actually injected, and which
//      hosts the extension is permitted on at all.
//
// A locale in (1) but not (2) is the expensive asymmetry: the seller lists to
// vinted.fr, the item sells on eBay, and the delist is refused by the guard —
// leaving a live listing for an item that no longer exists. A locale in (1) or
// (2) but not (3) is worse in a quieter way: the extension has no permission
// there, so nothing runs and nothing reports why.
//
// The rule US-2479 AC2 states is that an uncovered locale reports the
// manual-listing message rather than guessing. That only holds if "covered"
// means the same thing in all three places.
//
// Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

function loadSelectors() {
  const src = fs.readFileSync(path.join(dir, "lister", "selectors.js"), "utf8");
  const scope = {};
   
  new Function("self", `${src}; return self.GT_LISTER_SELECTORS;`)(scope);
  return scope.GT_LISTER_SELECTORS;
}

const selectors = loadSelectors();
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

const vinted = selectors.vinted;
assert.ok(vinted, "lister/selectors.js must declare a vinted platform (US-2479)");
assert.ok(vinted.locales, "vinted must declare a `locales` map — it is the only multi-domain channel");

const localeKeys = Object.keys(vinted.locales).sort();
const hosts = (vinted.hosts || []).slice().sort();

// ── 1 ⇄ 2: listable ⇔ delistable ───────────────────────────────────────────
assert.deepStrictEqual(
  localeKeys,
  hosts,
  "vinted `locales` and `hosts` must cover exactly the same domains. A domain " +
    "we will list to but not delist from leaves a live listing after the item " +
    "sells elsewhere, which is the double sale cross-listing-sale.ts exists to " +
    "prevent.\n" +
    `  locales only: ${localeKeys.filter((k) => !hosts.includes(k)).join(", ") || "none"}\n` +
    `  hosts only:   ${hosts.filter((h) => !localeKeys.includes(h)).join(", ") || "none"}`,
);

// ── 1 ⇄ 3: every covered locale has a content script and host permission ───
const listerEntry = (manifest.content_scripts || []).find(
  (c) => Array.isArray(c.js) && c.js.includes("lister/vinted.js"),
);
assert.ok(
  listerEntry,
  "manifest.json has no content_scripts entry injecting lister/vinted.js — the " +
    "selectors would never run",
);

const scriptHosts = new Set(
  (listerEntry.matches || []).map((m) =>
    m.replace(/^https:\/\//, "").replace(/^\*\./, "").replace(/\/\*$/, ""),
  ),
);
const permittedHosts = new Set(
  (manifest.host_permissions || []).map((m) =>
    m.replace(/^https:\/\//, "").replace(/^\*\./, "").replace(/\/\*$/, ""),
  ),
);

for (const locale of localeKeys) {
  assert.ok(
    scriptHosts.has(locale),
    `vinted locale "${locale}" is covered in selectors.js but lister/vinted.js is ` +
      `not injected there — the job would open a tab that nothing is listening on.`,
  );
  assert.ok(
    permittedHosts.has(locale),
    `vinted locale "${locale}" is covered in selectors.js but is not in ` +
      `host_permissions — the extension has no access to it at all.`,
  );
}

// ── every new-listing URL is https and on its own locale's domain ──────────
// The guard resolves a locale KEY to one of these URLs and navigates to it, so a
// URL pointing at the wrong domain would send a seller to a Vinted their account
// does not exist on — and a non-https one would defeat the guard's own check.
for (const [locale, url] of Object.entries(vinted.locales)) {
  assert.ok(/^https:\/\//.test(url), `vinted locale "${locale}" has a non-https URL: ${url}`);
  const host = new URL(url).host.toLowerCase();
  assert.ok(
    host === locale || host.endsWith("." + locale),
    `vinted locale "${locale}" points at ${host}, a different domain.`,
  );
}

console.log(
  `✓ vinted-locales: ${localeKeys.length} locales agree across selectors ` +
    `locales/hosts, the content script matches and host_permissions`,
);
