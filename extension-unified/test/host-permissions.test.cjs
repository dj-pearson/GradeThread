// GradeThread unified extension — Firefox opt-in host permissions (US-1881 AC3).
//
// THE BUG THIS EXISTS FOR.
//
// Chrome grants `host_permissions` at install with no prompt. Firefox's MV3
// withholds them until the person opts in. So the identical package, on the
// identical manifest, produces two completely different installs — and the
// Firefox one is SILENT: content scripts never inject, no promise rejects, no
// console line appears, and the shopper concludes our extension is broken.
//
// Nothing we already run can see this. Every guard in this repo executes the
// Chrome path, where the probe answers "granted" forever. That is precisely why
// the checks below drive the helper with a STUB extension API rather than a real
// browser: the ungranted state is unreachable here otherwise, and an ungranted
// state nothing can reach is one nothing can test.
//
// Four things are pinned:
//   1. UNIT — the probe's fail-open contract and the request's fail-closed one.
//   2. PATTERN — a match pattern can only ever be built from a bare hostname.
//   3. MANIFEST — the bridge origins here are the same origins gt-bridge.js is
//      declared on, so a manifest edit cannot silently orphan the sign-in ask.
//   4. SOURCE GUARD — no shipped file may call permissions.request() directly.
//      Chrome THROWS on a request for a non-optional permission, so an
//      unconditional request breaks the browser it was not needed on; routing
//      every call through the helper is what keeps the probe-first order true.
//
// Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

// The repo's package.json is `"type": "module"`, so a bare require() of a shipped
// .js file loads it as ESM and hands back an empty namespace. Load it the way the
// BROWSER does — as a classic script against a `self`.
function loadIntoSelf(rel) {
  const selfObj = {};
  const src = fs.readFileSync(path.join(dir, rel), "utf8");
  // eslint-disable-next-line no-new-func
  new Function("self", "module", src)(selfObj, { exports: {} });
  return selfObj;
}

const PERMS = loadIntoSelf("host-permissions.js").GT_HOST_PERMS;
assert.ok(PERMS, "host-permissions.js must publish self.GT_HOST_PERMS");

/** A stub extension API whose permissions answers are scripted per test. */
function stubApi({ contains, request, reload } = {}) {
  const calls = { contains: [], request: [], reload: [] };
  const api = { calls };
  if (contains || request) {
    api.permissions = {
      contains: (arg) => {
        calls.contains.push(arg);
        return contains ? contains(arg) : Promise.resolve(true);
      },
      request: (arg) => {
        calls.request.push(arg);
        return request ? request(arg) : Promise.resolve(true);
      },
    };
  }
  if (reload) {
    api.tabs = {
      reload: (id) => {
        calls.reload.push(id);
        return reload(id);
      },
    };
  }
  return api;
}

async function main() {
  // ── 1. originPattern: a hostname, and nothing else ────────────────────────
  assert.equal(PERMS.originPattern("www.ebay.com"), "https://www.ebay.com/*");
  assert.equal(PERMS.originPattern("  Poshmark.COM "), "https://poshmark.com/*");
  // `*.ebay.com` in the manifest covers the bare apex too, so a host with no
  // subdomain is a legitimate ask rather than something to widen.
  assert.equal(PERMS.originPattern("ebay.com"), "https://ebay.com/*");

  for (const bad of [
    "",
    "   ",
    null,
    undefined,
    42,
    "localhost", // no dot — not a site we ship on
    "https://www.ebay.com/", // a URL, not a host
    "www.ebay.com:8080", // a port would make the pattern invalid
    "*.ebay.com", // never build a wildcard out of a live tab's host
    "user@ebay.com",
    "ebay.com/itm/123",
  ]) {
    assert.equal(
      PERMS.originPattern(bad),
      null,
      `originPattern must refuse ${JSON.stringify(bad)}`,
    );
  }

  // ── 2. the probe FAILS OPEN, five ways ────────────────────────────────────
  // A false negative shows a Chrome user a permission banner for access they
  // already have. That is a scary, wrong prompt on a surface that works, so
  // every unanswerable case resolves to "granted".
  assert.equal(await PERMS.hasHostAccess(undefined, "www.ebay.com"), true, "no api");
  assert.equal(await PERMS.hasHostAccess({}, "www.ebay.com"), true, "no permissions API");
  assert.equal(
    await PERMS.hasHostAccess(
      stubApi({ contains: () => { throw new Error("boom"); } }),
      "www.ebay.com",
    ),
    true,
    "a throwing contains() must read as granted",
  );
  assert.equal(
    await PERMS.hasHostAccess(
      stubApi({ contains: () => Promise.reject(new Error("boom")) }),
      "www.ebay.com",
    ),
    true,
    "a rejecting contains() must read as granted",
  );
  assert.equal(
    await PERMS.hasHostAccess(
      stubApi({ contains: () => Promise.resolve(undefined) }),
      "www.ebay.com",
    ),
    true,
    "an answer we do not understand is not a no",
  );
  // An unusable host is not a refusal either — there is nothing to ask for.
  assert.equal(
    await PERMS.hasHostAccess(stubApi({ contains: () => Promise.resolve(false) }), "nope"),
    true,
  );

  // ── 3. …but a real "no" is reported, with the right origin ────────────────
  const denied = stubApi({ contains: () => Promise.resolve(false) });
  assert.equal(await PERMS.hasHostAccess(denied, "www.ebay.com"), false);
  assert.deepEqual(denied.calls.contains, [{ origins: ["https://www.ebay.com/*"] }]);

  const granted = stubApi({ contains: () => Promise.resolve(true) });
  assert.equal(await PERMS.hasHostAccess(granted, "www.poshmark.com"), true);

  // ── 4. the request FAILS CLOSED ───────────────────────────────────────────
  // The mirror image of the probe: only an explicit grant is a grant. Treating a
  // failed request as success would hide the banner and leave the site dead.
  const ok = stubApi({ contains: () => Promise.resolve(false), request: () => Promise.resolve(true) });
  assert.equal(await PERMS.requestHostAccess(ok, "www.grailed.com"), true);
  assert.deepEqual(ok.calls.request, [{ origins: ["https://www.grailed.com/*"] }]);

  for (const [label, request] of [
    ["a refusal", () => Promise.resolve(false)],
    ["a non-boolean", () => Promise.resolve("yes")],
    ["a rejection", () => Promise.reject(new Error("no"))],
    ["a throw", () => { throw new Error("no"); }],
  ]) {
    assert.equal(
      await PERMS.requestHostAccess(stubApi({ request }), "www.mercari.com"),
      false,
      `${label} must not read as granted`,
    );
  }
  assert.equal(await PERMS.requestHostAccess(stubApi({ request: () => Promise.resolve(true) }), "!!"), false);

  // ── 5. the bridge origins ARE the manifest's bridge origins ───────────────
  // gt-bridge.js is how sign-in and every seller call reach the extension on
  // Firefox (no externally_connectable). If the manifest's content-script match
  // list moves and this constant does not, the popup asks for a permission that
  // grants nothing and the sign-in still hangs — with the ask on screen, which
  // is worse than no ask at all.
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const bridgeEntry = (manifest.content_scripts || []).find((cs) =>
    (cs.js || []).includes("gt-bridge.js"),
  );
  assert.ok(bridgeEntry, "manifest must declare gt-bridge.js as a content script");
  assert.deepEqual(
    [...PERMS.SITE_ORIGINS].sort(),
    [...bridgeEntry.matches].sort(),
    "SITE_ORIGINS must match the gt-bridge.js content-script matches exactly",
  );

  // ── 6. the grant has to reach the open tab ────────────────────────────────
  // Firefox injects a newly-permitted content script on the NEXT navigation only.
  const tabApi = stubApi({ reload: () => Promise.resolve() });
  assert.equal(await PERMS.reloadTab(tabApi, 7), true);
  assert.deepEqual(tabApi.calls.reload, [7]);
  assert.equal(await PERMS.reloadTab(tabApi, null), false, "no tab id ⇒ nothing to reload");
  assert.equal(await PERMS.reloadTab({}, 7), false, "no tabs API ⇒ no crash");
  assert.equal(
    await PERMS.reloadTab(stubApi({ reload: () => Promise.reject(new Error("gone")) }), 7),
    false,
  );

  // ── 7. SOURCE GUARD — probe before you request ────────────────────────────
  // permissions.request() on Chrome throws for anything not in
  // optional_permissions, so a direct call in a shipped file breaks the browser
  // that never needed it. The helper is the only place allowed to make one.
  const shipped = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "test" || e.name === "icons" || e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) shipped.push(p);
    }
  })(dir);
  assert.ok(shipped.length > 10, "the shipped-file walk found nothing — the guard is inert");

  // Comments are stripped first: every file in this flow explains the rule in
  // prose, and a guard that fires on the sentence declaring the rule is a guard
  // somebody deletes. Only whole-line `//` goes, so a `//` inside a URL survives.
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");

  const offenders = shipped
    .filter((p) => path.basename(p) !== "host-permissions.js")
    .filter((p) => /permissions\s*\.\s*request\s*\(/.test(stripComments(fs.readFileSync(p, "utf8"))))
    .map((p) => path.relative(dir, p));
  assert.deepEqual(
    offenders,
    [],
    "call PERMS.requestHostAccess/requestSiteAccess instead of permissions.request() — " +
      "Chrome throws on a request for a non-optional permission",
  );

  // ── 8. the popup actually loads the helper, before it reads it ────────────
  // A missing <script> makes self.GT_HOST_PERMS undefined, and every call site
  // guards on that — so the whole Firefox flow would degrade to the silence it
  // was built to remove, with nothing going red.
  const html = fs.readFileSync(path.join(dir, "popup.html"), "utf8");
  const helperAt = html.indexOf('src="host-permissions.js"');
  const popupAt = html.indexOf('src="popup.js"');
  assert.ok(helperAt > -1, "popup.html must load host-permissions.js");
  assert.ok(popupAt > -1 && helperAt < popupAt, "host-permissions.js must load before popup.js");

  // …and every element the flow writes into exists in the markup.
  for (const id of ["hostPermWrap", "hostPermText", "hostPermBtn", "sitePermHint"]) {
    assert.ok(html.includes(`id="${id}"`), `popup.html is missing #${id}`);
  }
  const popupSrc = fs.readFileSync(path.join(dir, "popup.js"), "utf8");
  for (const id of ["hostPermWrap", "hostPermText", "hostPermBtn", "sitePermHint"]) {
    assert.ok(popupSrc.includes(id), `popup.js never uses #${id}`);
  }

  console.log("host-permissions.test.cjs: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
