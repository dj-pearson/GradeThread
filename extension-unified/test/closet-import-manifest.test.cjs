// GradeThread closet import — reach, passivity and wiring guards (US-9201).
//
// Same three promises sync-manifest.test.cjs asserts for sold-sync, because
// the closet reader inherits its posture:
//
// 1. REACH. The content script runs on the seller's own closet / listing-list
//    and listing pages, and nowhere else. A whole-domain match would put a
//    reader on every page of the marketplace.
// 2. PASSIVITY. Nothing in closet-import/ opens a tab, navigates, or runs on a
//    timer. The read happens when the background asks, and the background asks
//    because the seller pressed a button on gradethread.com.
// 3. WIRING. The background accepts GT_CLOSET_IMPORT from the web, loads the
//    selectors it needs to find the tab, and finds that tab with tabs.query
//    (a read) rather than tabs.create.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

function loadGlobal(rel, name) {
  const src = fs.readFileSync(path.join(dir, rel), "utf8");
  const scope = {};
  return new Function("self", `${src}; return self.${name};`)(scope);
}

const SEL = loadGlobal("closet-import/selectors.js", "GT_CLOSET_IMPORT_SELECTORS");

// ── 1. The content-script entry exists and is NARROW ───────────────────────

const cs = (manifest.content_scripts || []).find(
  (c) => Array.isArray(c.js) && c.js.includes("closet-import/content.js"),
);
assert.ok(cs, "manifest has no closet-import content_scripts entry (closet-import/content.js)");
assert.deepStrictEqual(
  cs.js,
  ["closet-import/selectors.js", "closet-import/extract.js", "closet-import/content.js"],
  "closet-import load order matters: selectors and extract must be on the page first",
);

for (const m of cs.matches) {
  const afterHost = String(m).replace(/^https:\/\/[^/]+/, "");
  assert.ok(
    afterHost !== "/*" && afterHost.length > 2,
    `closet-import content script matches "${m}", which is the whole domain. It must be ` +
      `scoped to the seller's own closet and listing pages.`,
  );
  const host = String(m).replace(/^https:\/\/(\*\.)?/, "").replace(/\/.*$/, "");
  const adapter = Object.values(SEL).find((a) => (a.hosts || []).includes(host));
  assert.ok(adapter, `closet-import content script matches ${m} but no adapter declares host ${host}.`);

  const stem = afterHost.replace(/^\//, "").replace(/\*+$/, "").replace(/\/+$/, "");
  const patterns = [adapter.closet, adapter.detail]
    .filter(Boolean)
    .map((f) => String(f.urlPattern || "").replace(/\\/g, "").replace(/\(\?:us\/\)\?/, ""));
  assert.ok(
    patterns.some((p) => p.includes(stem.replace(/^us\//, ""))),
    `closet-import content script matches ${m}, but no ${host} adapter flow reads a path ` +
      `containing "${stem}". Either the flow is missing or the match is reach we cannot ` +
      `justify to a store reviewer.`,
  );
}

// ── 2. Reach is covered by host_permissions, and adapters reach nothing more ─

const hostPerms = manifest.host_permissions || [];
for (const m of cs.matches) {
  const host = String(m).replace(/^https:\/\//, "").replace(/\/.*$/, "");
  const bare = host.replace(/^\*\./, "");
  const covered = hostPerms.some((h) => {
    const permHost = String(h).replace(/^https:\/\//, "").replace(/\/.*$/, "");
    return permHost === host || permHost === `*.${bare}` || permHost === bare;
  });
  assert.ok(covered, `closet-import match ${m} has no host_permissions entry.`);
}
const manifestHosts = new Set(
  cs.matches.map((m) => String(m).replace(/^https:\/\/(\*\.)?/, "").replace(/\/.*$/, "")),
);
for (const platform of Object.keys(SEL)) {
  for (const h of SEL[platform].hosts || []) {
    assert.ok(manifestHosts.has(h), `closet-import/selectors.js ${platform} declares host "${h}" that no manifest match reaches.`);
  }
  // Every adapter that is enabled names both flows and the owner tells, or the
  // reader has no way to refuse a stranger's closet.
  const a = SEL[platform];
  assert.ok(a.closet && a.closet.urlPattern && a.closet.ownClosetTell && a.closet.tile, `${platform}: closet flow incomplete`);
  assert.ok(a.detail && a.detail.urlPattern && a.detail.ownListingTell && a.detail.title, `${platform}: detail flow incomplete`);
  assert.ok(a.urlUpgrade && a.urlUpgrade.pattern, `${platform}: no photo URL-upgrade rule; thumbnails would pass as photos`);
  assert.strictEqual(a.verified, false, `${platform}: verified must stay false until a human runs vault/10-ops/extension-adapter-verification.md`);
}

// ── 3. Passivity: nothing in closet-import/ navigates or polls ─────────────

const files = fs
  .readdirSync(path.join(dir, "closet-import"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => path.join("closet-import", f));
assert.strictEqual(files.length, 3, "expected exactly selectors, extract and content in closet-import/");

// Regexes anchored the way sync-manifest.test.cjs explains: a single `=` for
// the assignment cases, and no \b anywhere.
const BANNED = [
  [/tabs\.create/, "opens a tab"],
  [/tabs\.update/, "navigates a tab"],
  [/location\.assign\s*\(/, "navigates"],
  [/location\.replace\s*\(/, "navigates"],
  [/location\.href\s*=(?!=)/, "assigns to location.href"],
  [/window\.open\s*\(/, "opens a window"],
  [/setInterval\s*\(/, "polls"],
  [/alarms\.create/, "schedules"],
  [/MutationObserver/, "re-reads on its own; the closet reader reads on request only"],
  [/fetch\s*\(/, "posts from the page; only the background talks to the server"],
];
const BANNED_SAMPLES = [
  "ext.tabs.create({})",
  "ext.tabs.update(id, {})",
  "location.assign(url)",
  "location.replace(url)",
  "location.href = url",
  "window.open(url)",
  "setInterval(fn, 1000)",
  "ext.alarms.create('x', {})",
  "new MutationObserver(fn)",
  "fetch(url)",
];
BANNED.forEach(([pattern], i) => {
  assert.ok(pattern.test(BANNED_SAMPLES[i]), `BANNED[${i}] (${pattern}) does not match its own sample.`);
});

for (const rel of files) {
  const raw = fs.readFileSync(path.join(dir, rel), "utf8");
  const code = raw
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
  for (const [pattern, what] of BANNED) {
    assert.ok(!pattern.test(code), `${rel} ${what} (${pattern}). The closet import reads a page the seller opened, when asked.`);
  }
}

// ── 4. Background wiring ───────────────────────────────────────────────────

const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
const externalBlock = /const EXTERNAL_TYPES = new Set\(\[([\s\S]*?)\]\);/.exec(bg);
assert.ok(externalBlock, "background.js must declare EXTERNAL_TYPES");
assert.ok(
  /"GT_CLOSET_IMPORT"/.test(externalBlock[1]),
  "GT_CLOSET_IMPORT must be an EXTERNAL_TYPES entry, or the web page's button reaches nothing",
);
assert.ok(/async function runClosetImport\(/.test(bg), "background.js must implement runClosetImport");
assert.ok(
  (manifest.background.scripts || []).includes("closet-import/selectors.js"),
  "background.scripts must list closet-import/selectors.js (Firefox has no importScripts)",
);
const importCall = /importScripts\(([^)]*)\)/s.exec(bg);
assert.ok(importCall && /closet-import\/selectors\.js/.test(importCall[1]), "importScripts must load closet-import/selectors.js");

// The background finds the tab; it never makes one. Scope the check to the
// closet-import function so the scheduled poll's own tabs.create (a separate,
// separately-consented feature) does not trip it.
const fnStart = bg.indexOf("async function runClosetImport(");
const fnEnd = bg.indexOf("async function postSyncObservations(");
assert.ok(fnStart !== -1 && fnEnd > fnStart, "runClosetImport must sit before postSyncObservations");
const fnSrc = bg.slice(fnStart, fnEnd);
assert.ok(/tabs\.query\(/.test(fnSrc), "runClosetImport must locate the closet tab with tabs.query");
for (const [pattern, what] of BANNED.slice(0, 8)) {
  assert.ok(!pattern.test(fnSrc), `runClosetImport ${what} (${pattern}); the seller opens their own closet`);
}
assert.ok(/GT_CLOSET_IMPORT_READ/.test(fnSrc), "runClosetImport must ask the content script to read");
assert.ok(/CLOSET_IMPORT_ENDPOINT/.test(fnSrc), "runClosetImport must post to the closet-import endpoint");
assert.ok(/sellerAllowed\(\)/.test(fnSrc), "runClosetImport must run the seller gate before reading anything");

// ── 5. The store submission discloses the script ──────────────────────────

const doc = fs.readFileSync(path.join(dir, "SUBMISSION.md"), "utf8");
assert.ok(/closet-import\/content\.js/.test(doc), "SUBMISSION.md must disclose the closet-import content script");
assert.ok(/Import my closet/.test(doc), "SUBMISSION.md must say the read happens on the seller's button press");

console.log(
  `closet-import-manifest.test.cjs: ${cs.matches.length} narrow matches, ` +
    `${files.length} passive files, background wired and disclosed`,
);
