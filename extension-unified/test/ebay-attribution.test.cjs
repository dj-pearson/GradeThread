// US-3112: prove every extension surface that shows eBay data carries eBay's
// attribution and non-endorsement notice.
//
// THE DECAY THIS EXISTS TO STOP. The web app got this right in US-3033 and then
// drifted anyway: the notice lives in one component, that component is used on
// exactly two surfaces, and nothing anywhere failed when the extension shipped
// three more surfaces showing eBay listing titles, prices and images with no
// notice at all. Nobody removed it. It was simply never added, and no test
// could tell the difference between "this surface needs no notice" and "this
// surface was forgotten".
//
// So the list of surfaces is written down HERE, by name. Adding a surface that
// renders marketplace rows means adding it to SURFACES, and a surface that
// stops wiring up the notice fails the build. That is a deliberate speed bump,
// because the alternative is the failure mode above: silent, invisible, and
// discovered by eBay rather than by us.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
// Normalised for the same reason ebay-no-scrape.test.cjs is: a Windows checkout
// hands these files CRLF, and an assertion matching a bare newline then fails
// for a reason unrelated to what it is guarding.
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

// The repo root declares "type": "module", so every .js file under the
// extension is ESM to node and cannot be require()d — which is why the sibling
// suites assert against source text. We want the real functions, not a regex
// over them, so the module is evaluated in a sandbox that gives its UMD shim
// the `self` a browser would. This exercises the shipped file, not a copy.
const vm = require("node:vm");

function loadShimmed(rel, globalName) {
  const sandbox = { self: {}, module: { exports: {} }, console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read(rel), sandbox, { filename: rel });
  const api = sandbox.self[globalName] || sandbox.module.exports;
  assert.ok(
    api && typeof api.noticeFor === "function",
    `${rel} must expose self.${globalName} when loaded as a classic script`,
  );
  return api;
}

const NOTICE = loadShimmed("research/marketplace-notice.js", "GT_MP_NOTICE");

// ── the wording ──────────────────────────────────────────────────────────────

// the eBay notice names eBay as the source and denies endorsement
(function () {
  const text = NOTICE.noticeFor("ebay");
  assert.ok(text, "eBay must have a notice");
  // Both halves are required by eBay, and each has been dropped independently
  // in drafts of this sentence, so both are asserted independently.
  assert.match(text, /from eBay/, "must say the data came from eBay");
  assert.match(text, /trademark of eBay Inc/, "must carry the trademark line");
  assert.match(
    text,
    /not\s+endorsed or certified by eBay Inc/,
    "must carry the non-endorsement line",
  );
})();


// the extension wording matches the web component word for word
(function () {
  // The extension ships as a zip and cannot import from src/, so the sentence is
  // duplicated on purpose. This is the join: one company, one sentence, whether
  // the reader meets us in the app or over the top of an eBay listing.
  const web = read("../src/components/marketplace/ebay-attribution.tsx");
  const jsx = web
    .slice(web.indexOf("return ("))
    .replace(/\{[^{}]*\}/g, " ") // JSX expressions: {" "}, {what}, className={...}
    .replace(/<[^>]+>/g, " ") // tags
    .replace(/\s+/g, " ")
    .trim();
  for (const phrase of [
    "from eBay, retrieved through the eBay API",
    "eBay is a trademark of eBay Inc",
    "uses the eBay API but is not endorsed or certified by eBay Inc",
  ]) {
    assert.ok(
      jsx.includes(phrase),
      `web component must contain "${phrase}" (found: ${jsx.slice(0, 220)})`,
    );
    assert.ok(
      NOTICE.noticeFor("ebay").includes(phrase),
      `extension notice must contain "${phrase}"`,
    );
  }
})();


// US-3042: the notice for page-read data drops the API claim and keeps the rest
(function () {
  // A required sentence is still a factual claim. The compare tray holds rows
  // pinned before the eBay read moved server-side, whose title, price and
  // thumbnail WERE read off eBay's page — printing "retrieved through the eBay
  // API" over those turns a compliance notice into a false statement.
  const api = NOTICE.noticeFor("ebay");
  const page = NOTICE.pageNoticeFor("ebay");
  assert.ok(page, "eBay must have a page-sourced notice too");
  assert.match(api, /retrieved through the eBay API/);
  assert.ok(
    !/retrieved through the eBay API/.test(page),
    "the page-sourced notice must not claim the data came through the API",
  );
  // Everything eBay actually requires is in BOTH.
  for (const required of [
    /from eBay/,
    /trademark of eBay Inc/,
    /not\s+endorsed or certified by eBay Inc/,
  ]) {
    assert.match(api, required);
    assert.match(page, required);
  }
  // Scoped to eBay like the other one — a Vinted row gets neither.
  for (const key of ["poshmark", "vinted", "", "nope"]) {
    assert.strictEqual(NOTICE.pageNoticeFor(key), null);
  }
})();


// a row's stored source picks the wording, and an unstamped row gets neither claim
(function () {
  const rows = [
    { marketplace: "ebay", source: "ebay-api" },
    { marketplace: "ebay", source: "ebay-api" },
    { marketplace: "poshmark", source: "page" },
  ];
  const apiOnly = NOTICE.noticesForEntries(rows);
  assert.strictEqual(apiOnly.length, 1, "deduped to one notice");
  assert.match(apiOnly[0], /retrieved through the eBay API/);

  // A legacy row (no source recorded) must NOT inherit the API claim.
  const legacy = NOTICE.noticesForEntries([{ marketplace: "ebay" }]);
  assert.strictEqual(legacy.length, 1, "a legacy eBay row still needs attribution");
  assert.ok(
    !/retrieved through the eBay API/.test(legacy[0]),
    "an unstamped row must not claim the API — that is the whole point of the stamp",
  );
  assert.match(legacy[0], /not\s+endorsed or certified by eBay Inc/);

  // A mixed table carries both sentences rather than picking the flattering one.
  const mixed = NOTICE.noticesForEntries([
    { marketplace: "ebay", source: "ebay-api" },
    { marketplace: "ebay", source: "page" },
  ]);
  assert.strictEqual(mixed.length, 2, "two provenances, two sentences");

  assert.strictEqual(NOTICE.noticesForEntries([]).length, 0);
  assert.strictEqual(NOTICE.noticesForEntries(null).length, 0);
  assert.strictEqual(NOTICE.noticesForEntries([null, undefined]).length, 0);
})();


// ── scope ────────────────────────────────────────────────────────────────────

// marketplaces without a notice get null, not a generic sentence
(function () {
  // Stamping eBay's non-endorsement notice on a Vinted page is worse than none:
  // it is factually wrong and reads as boilerplate nobody checked.
  for (const key of ["poshmark", "grailed", "mercari", "depop", "vinted", ""]) {
    assert.strictEqual(NOTICE.noticeFor(key), null, `${key} must have no notice`);
  }
  assert.strictEqual(NOTICE.noticeFor(undefined), null);
  assert.strictEqual(NOTICE.noticeFor(null), null);
})();


// the marketplace key is matched case-insensitively
(function () {
  // Tray entries were written by older versions and by three different call
  // sites; a stored "eBay" must not silently lose the notice.
  assert.ok(NOTICE.noticeFor("eBay"));
  assert.ok(NOTICE.noticeFor(" EBAY "));
})();


// a mixed table carries eBay's notice once, and only when eBay is on it
(function () {
  const mixed = NOTICE.noticesForMarketplaces(["poshmark", "ebay", "ebay", "vinted"]);
  assert.strictEqual(mixed.length, 1, "deduped to one notice");
  assert.match(mixed[0], /eBay Inc/);

  // Length, not deepStrictEqual: the module runs in a vm realm, so the arrays it
  // returns have that realm's Array prototype and never compare deep-strict-equal
  // to one built out here. The realm is the point (it is how we load the shipped
  // file), so the assertion adapts rather than the module.
  assert.strictEqual(
    NOTICE.noticesForMarketplaces(["poshmark", "vinted"]).length,
    0,
    "no eBay row means no eBay notice",
  );
  assert.strictEqual(NOTICE.noticesForMarketplaces([]).length, 0);
  assert.strictEqual(NOTICE.noticesForMarketplaces(null).length, 0);
})();


// ── the surfaces ─────────────────────────────────────────────────────────────

const SURFACES = [
  {
    file: "research/marketplace.js",
    what: "the in-page overlay, drawn inside eBay's own listing page",
    // The CALL, not the name. See codeOnly below for why the distinction is the
    // whole value of this check.
    call: "GT_MP_NOTICE.appendNotice(",
  },
  {
    file: "compare.js",
    what: "the compare table, which renders pinned listing titles and prices",
    // US-3042: the ROW-aware call. noticesForMarketplaces() keys on the
    // marketplace alone, which prints the API sentence over a row whose fields
    // were read off eBay's page.
    call: "GT_MP_NOTICE.noticesForEntries(",
  },
  {
    file: "popup.js",
    what: "the read history, which prints the listing title of every past read",
    // US-3042: the third surface, and the one that was missed. It shows eBay
    // listing titles (and, in the By seller view, eBay seller handles) with no
    // notice at all, which is exactly the gap the header above describes.
    call: "GT_MP_NOTICE.noticesForEntries(",
  },
];

/**
 * Comments about the notice are not the notice.
 *
 * This check used to match /GT_MP_NOTICE/ against the whole file, which two
 * kinds of broken code satisfy: a surface whose render call was deleted but
 * whose explaining comment stayed (and the comment right above each call names
 * the module, because that is what a good comment does), and a surface that
 * reads the global into a variable and never calls it. Both leave the shopper
 * looking at eBay's listing data with no notice on it, which is the one outcome
 * this file exists to prevent.
 *
 * Blocks first, THEN line comments: inside a block comment the continuation
 * lines start with plain prose, so dropping lines by prefix leaves the interior
 * behind.
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => {
      const i = line.search(/(^|[^:])\/\//);
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

// A floor. An empty SURFACES list would make the loop below a no-op and read
// exactly like every surface passing.
assert.ok(
  SURFACES.length >= 3,
  "SURFACES must name at least the overlay, the compare view and the read history",
);

for (const surface of SURFACES) {
  // ${surface.file} wires up the attribution notice
(function () {
    const code = codeOnly(read(surface.file));
    assert.ok(
      code.includes(surface.call),
      `${surface.file} shows eBay data (${surface.what}) and must CALL ` +
        `self.${surface.call}...). A mention in a comment, or reading the ` +
        `global without calling it, renders no notice.`,
    );
  })();

}

// every surface that loads the notice module also uses it
(function () {
  // The other direction: a file can be added to the manifest and then never
  // call the thing it loaded, which looks compliant from the manifest alone.
  const manifest = JSON.parse(read("manifest.json"));
  const loaded = new Set();
  for (const cs of manifest.content_scripts || []) {
    if ((cs.js || []).includes("research/marketplace-notice.js")) {
      for (const js of cs.js) loaded.add(js);
    }
  }
  assert.ok(
    loaded.has("research/marketplace.js"),
    "the eBay content script must load the notice module",
  );
})();


// the notice module loads BEFORE the surfaces that read it
(function () {
  // Classic scripts, no imports: order in the manifest is the dependency graph.
  // Loading it after marketplace.js leaves self.GT_MP_NOTICE undefined at render
  // and the notice silently never appears.
  const manifest = JSON.parse(read("manifest.json"));
  for (const cs of manifest.content_scripts || []) {
    const js = cs.js || [];
    const notice = js.indexOf("research/marketplace-notice.js");
    const surface = js.indexOf("research/marketplace.js");
    if (notice === -1 || surface === -1) continue;
    assert.ok(
      notice < surface,
      "marketplace-notice.js must load before marketplace.js",
    );
  }
})();


// compare.html loads the notice module and has somewhere to put it
(function () {
  const html = read("compare.html");
  assert.match(html, /research\/marketplace-notice\.js/);
  assert.match(html, /id="attribution"/);
  const noticeAt = html.indexOf("research/marketplace-notice.js");
  const compareAt = html.indexOf("src=\"compare.js\"");
  assert.ok(
    noticeAt !== -1 && compareAt !== -1 && noticeAt < compareAt,
    "the notice module must load before compare.js reads it",
  );
})();


// popup.html does the same for the read history (US-3042)
(function () {
  // Classic scripts, no imports: order is the dependency graph here too. Loading
  // the module after popup.js leaves self.GT_MP_NOTICE undefined at paint and
  // the notice silently never appears — which is how this surface came to show
  // eBay titles with nothing on them in the first place.
  const html = read("popup.html");
  assert.match(html, /research\/marketplace-notice\.js/);
  assert.match(html, /id="attribution"/);
  const noticeAt = html.indexOf("research/marketplace-notice.js");
  const popupAt = html.indexOf("src=\"popup.js\"");
  assert.ok(
    noticeAt !== -1 && popupAt !== -1 && noticeAt < popupAt,
    "the notice module must load before popup.js reads it",
  );
})();


// a stored read records where its printed fields came from (US-3042)
(function () {
  // The popup's wording is chosen off this. saveRead is the ONE place every
  // completed read passes through, so an unstamped row here would reach the
  // history and take whichever sentence the default happened to be.
  const bg = codeOnly(read("background.js"));
  assert.ok(
    /source:\s*\["ebay-api",\s*"page"\]\.indexOf\(read\.source\)/.test(bg),
    "saveRead must store the read's source, allowlisted",
  );
  assert.ok(
    /:\s*"unknown"/.test(bg),
    "an unrecognised source must fall back to unknown, not to the API claim",
  );
})();


console.log(
  "ebay-attribution.test.cjs: eBay notice wording matches the web component, " +
  "scoped to eBay only, two wordings chosen by each row's stored source, " +
  "deduped across a mixed table, and wired into the overlay, the compare view " +
  "and the popup's read history in the right load order",
);
