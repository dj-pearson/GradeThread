// GradeThread sold-sync — reach and passivity guards (US-2698).
//
// TWO PROMISES ARE ASSERTED HERE, and both are the kind that decay quietly.
//
// 1. REACH. The sync content script runs on the seller's own Sold page and
//    their own closet, and nowhere else. The Lister's Poshmark entry matches
//    the WHOLE domain, so it would be the easy and wrong thing to hang sync off
//    that and gate at runtime: a runtime gate that regresses runs the reader on
//    a stranger's listing page, and nothing visible happens when it does.
//
// 2. PASSIVITY. Nothing in sync/ opens a tab, navigates, or runs on a timer.
//    The scheduled background poll is US-2701, a separate feature with its own
//    consent clickwrap. If poll code lands in this directory it inherits the
//    passive read's consent, which the seller never gave for automated traffic.

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

const SEL = loadGlobal("sync/selectors.js", "GT_SYNC_SELECTORS");

// ── 1. The content-script entry exists and is NARROW ───────────────────────

const cs = (manifest.content_scripts || []).find(
  (c) => Array.isArray(c.js) && c.js.includes("sync/content.js"),
);
assert.ok(cs, "manifest has no sold-sync content_scripts entry (sync/content.js)");

assert.deepStrictEqual(
  cs.js,
  ["sync/selectors.js", "sync/observe.js", "sync/content.js"],
  "sync content script load order matters — selectors and observe must be on the page first",
);

// Every match must be scoped to a PATH. A whole-domain match here would put the
// reader on every Poshmark page including other sellers' listings.
for (const m of cs.matches) {
  const afterHost = String(m).replace(/^https:\/\/[^/]+/, "");
  assert.ok(
    afterHost !== "/*" && afterHost.length > 2,
    `sync content script matches "${m}", which is the whole domain. It must be ` +
      `scoped to the seller's own Sold page and closet.`,
  );
  assert.ok(
    /^\/(order\/sales|closet\/)/.test(afterHost),
    `sync content script matches an unexpected path: ${m}`,
  );
}

// ── 2. Reach is covered by host_permissions and by the adapter's own hosts ──

const hostPerms = manifest.host_permissions || [];
for (const m of cs.matches) {
  const host = String(m).replace(/^https:\/\//, "").replace(/\/.*$/, "");
  const bare = host.replace(/^\*\./, "");
  const covered = hostPerms.some((h) => {
    const permHost = String(h).replace(/^https:\/\//, "").replace(/\/.*$/, "");
    return permHost === host || permHost === `*.${bare}` || permHost === bare;
  });
  assert.ok(
    covered,
    `sync match ${m} has no host_permissions entry. On Firefox the script would ` +
      `never be granted, and the only available reading is that sync is broken.`,
  );
}

// The adapter's declared hosts must be the same set the manifest reaches, or the
// runtime host check and the injection disagree about where sync runs.
const manifestHosts = new Set(
  cs.matches.map((m) => String(m).replace(/^https:\/\/(\*\.)?/, "").replace(/\/.*$/, "")),
);
for (const platform of Object.keys(SEL)) {
  for (const h of SEL[platform].hosts || []) {
    assert.ok(
      manifestHosts.has(h),
      `sync/selectors.js ${platform} declares host "${h}" that no manifest match reaches.`,
    );
  }
}

// ── 3. Passivity: nothing in sync/ navigates or polls ──────────────────────

const syncFiles = fs
  .readdirSync(path.join(dir, "sync"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => path.join("sync", f));

assert.ok(syncFiles.length >= 3, "expected the sync directory to hold at least three modules");

// Regexes, not substrings. The first version of this list banned the literal
// "location.href =", which matched `if (location.href === lastHref)` -- a
// COMPARISON, and the one line in content.js that makes an SPA navigation
// detectable at all. A guard that fires on correct code is a guard someone
// weakens, so the assignment cases are anchored to a single `=`.
//
// The second version was worse and is the reason this comment is long. It was
// written through a shell heredoc, where \b in the patterns became a literal
// BACKSPACE byte (0x08) rather than a word boundary. The file looked correct in
// every editor, the suite went green, and the whole passivity guard matched
// nothing at all -- a tabs.create dropped into sync/ sailed straight through.
// Sabotage-check this list after touching it, and keep it free of \b.
const BANNED = [
  [/tabs\.create/, "opens a tab"],
  [/tabs\.update/, "navigates a tab"],
  [/location\.assign\s*\(/, "navigates"],
  [/location\.replace\s*\(/, "navigates"],
  [/location\.href\s*=(?!=)/, "assigns to location.href"],
  [/window\.open\s*\(/, "opens a window"],
  [/setInterval\s*\(/, "polls"],
  [/alarms\.create/, "schedules"],
];

// SELF-CHECK: every pattern must match the thing it claims to ban.
//
// This exists because the 0x08 version above passed its own suite. A pattern
// list that nothing exercises is indistinguishable from an empty one, and the
// failure is invisible in an editor and green in CI — which is the whole of why
// it survived. Cheap to run, and it fails the moment a regex stops meaning what
// it looks like it means.
const BANNED_SAMPLES = [
  "ext.tabs.create({})",
  "ext.tabs.update(id, {})",
  "location.assign(url)",
  "location.replace(url)",
  "location.href = url",
  "window.open(url)",
  "setInterval(fn, 1000)",
  "ext.alarms.create('x', {})",
];
BANNED.forEach(([pattern], i) => {
  assert.ok(
    pattern.test(BANNED_SAMPLES[i]),
    `BANNED[${i}] (${pattern}) does not match its own sample "${BANNED_SAMPLES[i]}". ` +
      `Check the regex literal for invisible characters.`,
  );
});
// And the comparison that is NOT an assignment stays allowed, or the guard
// fires on the one line that makes SPA navigation detectable.
assert.ok(
  !BANNED.find(([p]) => p.source.includes("href"))[0].test("if (location.href === lastHref) return;"),
  "the location.href guard fires on a comparison — content.js cannot detect SPA navigation without one",
);

for (const rel of syncFiles) {
  const raw = fs.readFileSync(path.join(dir, rel), "utf8");
  // Strip comments first: these files EXPLAIN what they refuse to do, and a
  // guard that its own documentation fails is a guard people delete.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

  for (const [pattern, what] of BANNED) {
    assert.ok(
      !pattern.test(code),
      `${rel} ${what} (${pattern}). Sold-sync is a PASSIVE harvest — it reads pages ` +
        `the seller opened. The scheduled poll is US-2701 and carries its own consent.`,
    );
  }
}

// ── 4. A disabled adapter must not read ────────────────────────────────────
//
// The selectors ship unverified. The content script has to check that, or an
// unverified adapter reads a page it has never been tested against and reports
// whatever it finds as fact.

{
  const src = fs.readFileSync(path.join(dir, "sync/content.js"), "utf8");
  assert.ok(
    /cfg\.enabled/.test(src),
    "sync/content.js never checks cfg.enabled, so unverified selectors would run against a live page",
  );
}

// ── 5. The closet read must establish whose closet it is ───────────────────
//
// /closet/{handle} matches every seller. Reading a stranger's closet would post
// their listings to our server and make the seller's own listings look absent.

for (const platform of Object.keys(SEL)) {
  const closet = SEL[platform].closet;
  if (!closet) continue;
  assert.ok(
    closet.ownClosetTell,
    `sync/selectors.js ${platform}.closet has no ownClosetTell — the match pattern alone cannot tell whose closet it is.`,
  );
  assert.ok(
    (closet.required || []).includes("ownClosetTell"),
    `sync/selectors.js ${platform}.closet must REQUIRE ownClosetTell, or a probe passes on a stranger's closet.`,
  );
}

console.log("sync-manifest.test.cjs: reach is narrow, sync/ is passive, unverified adapters do not read");
