// GradeThread unified extension — outbound funnel attribution (US-1753 AC3).
//
// THE BUG THIS EXISTS FOR.
//
// The site closes the attribution loop already: main.tsx captures utm params on
// landing, utm-attribution-sync.ts POSTs them once the visitor authenticates,
// and the admin analytics channel table groups signups by
// utm_source/medium/campaign. So a TAGGED extension link is measured end to end
// — and an UNTAGGED one is indistinguishable from someone typing the domain in.
//
// The tags were hand-written per call site, and one link had none: "Watch on
// GradeThread", the highest-intent click in the overlay. Every account it
// created was filed as direct traffic. Nothing failed; the number was just
// quietly wrong, which is the only way this class of bug ever presents.
//
// So two halves here:
//   1. UNIT — the helper's contract (always a source, never clobber a server's
//      medium, never touch a third party's URL, carry the version cohort).
//   2. SOURCE GUARD — no shipped file may hand-build a gradethread.com link.
//      That is what keeps the next link from shipping untagged, and it is the
//      half a unit test alone cannot give.
//
// Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

// The repo's package.json is `"type": "module"`, so a bare require() of a shipped
// .js file loads it as ESM and hands back an empty namespace. Every guard here
// loads the file the way the BROWSER does instead — as a classic script against a
// `self` — which is also the only way to see what it publishes on that global.
function loadIntoSelf(rel) {
  const selfObj = {};
  const src = fs.readFileSync(path.join(dir, rel), "utf8");
  // eslint-disable-next-line no-new-func
  new Function("self", "module", src)(selfObj, { exports: {} });
  return selfObj;
}

const ATTR = loadIntoSelf("attribution.js").GT_ATTRIBUTION;
assert.ok(ATTR, "attribution.js must publish self.GT_ATTRIBUTION");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

// ── 1. the helper's contract ───────────────────────────────────────────────

function params(url) {
  return new URL(url).searchParams;
}

// Every link carries the source, whatever else it carries.
{
  const u = params(ATTR.siteUrl("/pricing", "popup"));
  assert.strictEqual(u.get("utm_source"), "extension");
  assert.strictEqual(u.get("utm_medium"), "popup");
}

// A path is accepted with or without the leading slash, and an already-absolute
// site URL passes straight through — no call site should have to think about it.
for (const p of ["/pricing", "pricing", "https://gradethread.com/pricing"]) {
  assert.strictEqual(
    new URL(ATTR.siteUrl(p, "popup")).pathname,
    "/pricing",
    `siteUrl(${JSON.stringify(p)}) must resolve to /pricing`,
  );
}

// The campaign is what separates the INSTALL funnel from ordinary usage clicks.
{
  const u = params(ATTR.siteUrl("/connect-extension", "onboarding", {
    campaign: ATTR.INSTALL_CAMPAIGN,
  }));
  assert.strictEqual(u.get("utm_campaign"), "install");
}

// Functional params are the request, not the attribution — they are always set,
// and they survive alongside the tags.
{
  const u = params(ATTR.siteUrl("/buyer/alerts", "overlay", {
    campaign: "watch",
    params: { watch: "https://www.ebay.com/itm/1?x=1" },
  }));
  assert.strictEqual(u.get("watch"), "https://www.ebay.com/itm/1?x=1");
  assert.strictEqual(u.get("utm_source"), "extension");
  assert.strictEqual(u.get("utm_medium"), "overlay");
}

// A SERVER-BUILT deep link keeps the medium the server chose. public-grading.ts
// tags /tools/grade-checker with second-opinion and /signup with gate; those
// describe an intent the client does not have, and overwriting them would make
// the two surfaces indistinguishable in the channel report.
{
  const server = "https://gradethread.com/signup?utm_source=extension&utm_medium=gate";
  const u = params(ATTR.decorate(server, "overlay"));
  assert.strictEqual(u.get("utm_medium"), "gate", "decorate() must not clobber an existing medium");
}

// A THIRD PARTY's URL is returned untouched. The overlay renders marketplace
// links through the same code path; tagging one would rewrite someone else's
// URL, and dropping it would break the link.
for (const foreign of ["https://www.ebay.com/itm/123", "https://gradethread.com.evil.test/x", ""]) {
  assert.strictEqual(
    ATTR.decorate(foreign, "overlay"),
    foreign,
    `decorate() must return a non-site URL unchanged: ${JSON.stringify(foreign)}`,
  );
}
assert.ok(!ATTR.isSiteUrl("http://gradethread.com/x"), "plain http is not our site URL");
assert.ok(ATTR.isSiteUrl("https://www.gradethread.com/x"), "subdomains are ours");

// ── 2. no shipped file may hand-build a site link ──────────────────────────
//
// The allowlist is deliberately tiny and per-file. Adding an entry is a decision
// to keep a link outside the tagger, which is exactly the decision that should
// need a diff someone reads.
const ALLOWED = {
  // Owns the origin; every other file goes through it.
  "attribution.js": [/^https:\/\/gradethread\.com$/],
  // The remotely-updatable selector config. A data fetch, not a user-facing
  // link — there is no funnel to attribute and a utm param on it would only
  // fragment the CDN cache.
  "background.js": [/^https:\/\/gradethread\.com\/extension\/marketplace-selectors\.json$/],
  "research/selectors.js": [/^https:\/\/gradethread\.com\/extension\/marketplace-selectors\.json$/],
};

// Files the browser actually loads (the store zip ships more, but only these can
// contain a link). Mirrors package-extensions.mjs's exclusions: no test/, no md.
function shippedSources(abs, rel = "") {
  const out = [];
  for (const entry of fs.readdirSync(abs)) {
    const p = path.join(abs, entry);
    const r = rel ? `${rel}/${entry}` : entry;
    if (fs.statSync(p).isDirectory()) {
      if (entry === "test" || entry === "node_modules" || entry.startsWith(".")) continue;
      out.push(...shippedSources(p, r));
    } else if (/\.(js|html)$/.test(entry)) {
      out.push({ rel: r, abs: p });
    }
  }
  return out;
}

// A STRING LITERAL or an href holding a gradethread.com URL. Prose in a comment
// mentions the domain constantly and is not a link, so the opening quote is what
// separates the two.
const LITERAL_RE = /["'`](https:\/\/gradethread\.com[^"'`\s]*)["'`]/g;
const HREF_RE = /href\s*=\s*"(https:\/\/gradethread\.com[^"]*)"/g;

const offenders = [];
for (const f of shippedSources(dir)) {
  const src = fs.readFileSync(f.abs, "utf8");
  const allowed = ALLOWED[f.rel] || [];
  for (const re of [LITERAL_RE, HREF_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const url = m[1];
      if (allowed.some((a) => a.test(url))) continue;
      offenders.push(`${f.rel}: ${url}`);
    }
  }
}
assert.deepStrictEqual(
  offenders,
  [],
  "these gradethread.com links are hand-built instead of going through " +
    "GT_ATTRIBUTION.siteUrl()/decorate(), so they reach the site with no funnel tags " +
    "and their signups are recorded as direct traffic:\n  " + offenders.join("\n  "),
);

// ── 3. the helper reaches every world that links out ───────────────────────
//
// attribution.js is a classic script, so it only exists in a world that loads
// it. Miss one and `self.GT_ATTRIBUTION` is undefined at the call site — a
// TypeError that takes the whole popup or overlay down, not a missing tag.
const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
const importScriptsCall = /importScripts\(([^)]*)\)/s.exec(bg);
assert.ok(
  importScriptsCall && /"attribution\.js"/.test(importScriptsCall[1]),
  "background.js must importScripts attribution.js (the Chrome service-worker path)",
);
assert.ok(
  (manifest.background.scripts || []).includes("attribution.js"),
  "manifest background.scripts must list attribution.js — Firefox has no importScripts " +
    "(background-deps.test.cjs enforces the ORDER; this asserts it is there at all)",
);

const research = (manifest.content_scripts || []).find(
  (c) => Array.isArray(c.js) && c.js.includes("research/marketplace.js"),
);
assert.ok(research, "the research content-script entry must exist");
assert.ok(
  research.js.indexOf("attribution.js") === 0,
  "attribution.js must be FIRST in the research content-script js list — marketplace.js " +
    "reads self.GT_ATTRIBUTION at load, and a classic script that runs later is too late",
);

for (const page of ["popup.html", "onboarding.html"]) {
  const html = fs.readFileSync(path.join(dir, page), "utf8");
  assert.ok(
    /<script src="attribution\.js"><\/script>/.test(html),
    `${page} links out to gradethread.com, so it must load attribution.js`,
  );
}

// ── 4. the install half of the funnel ──────────────────────────────────────
//
// Store dashboards report installs; utm_campaign=install is what lets a SIGNUP
// be joined back to one. The join has to happen on a link the user chose to
// click, because the alternative — shipping the per-install id to the server —
// is an identifier we deliberately do not send (see attribution.js's privacy
// note and the SUBMISSION.md disclosures it keeps true).
assert.ok(
  /getURL\("onboarding\.html"\)\s*\+\s*"\?first_run=1"/.test(bg),
  "background.js must open the first-run onboarding tab with ?first_run=1 — that flag " +
    "is the only thing distinguishing an install-triggered visit from a reopen, and " +
    "without it every reopen would be counted as a fresh install",
);
const onboarding = fs.readFileSync(path.join(dir, "onboarding.js"), "utf8");
assert.ok(
  /first_run/.test(onboarding) && /INSTALL_CAMPAIGN/.test(onboarding),
  "onboarding.js must gate the install campaign on ?first_run=1",
);
assert.ok(
  /installedAt/.test(bg) && /installVersion/.test(bg),
  "background.js must record the install locally (installedAt/installVersion) on " +
    "onInstalled — the local cohort marker the funnel is read against",
);

// The version cohort. Two store releases are two cohorts, and without this every
// signup from the extension collapses into one undated bucket.
assert.ok(
  /utm_content/.test(fs.readFileSync(path.join(dir, "attribution.js"), "utf8")),
  "attribution.js must carry the extension version as utm_content",
);
assert.ok(
  typeof manifest.version === "string" && /^\d+\.\d+\.\d+$/.test(manifest.version),
  "the manifest version is the cohort key, so it must be a real semver",
);

console.log(
  `attribution.test.cjs: helper contract holds; ${shippedSources(dir).length} shipped ` +
    `source files carry no hand-built gradethread.com link; install campaign wired ` +
    `(v${manifest.version} cohort)`,
);
