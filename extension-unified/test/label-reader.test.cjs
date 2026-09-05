// research/label-reader.js + its worker half — the care-label reader (US-3070).
//
// Two rules, and every case here belongs to one:
//
//   1. IT READS THE IMAGE THE PERSON POINTED AT, AND NOTHING ELSE. The
//      context-menu event's `srcUrl` is the whole input. No page URL, no page
//      text, no markup — on a marketplace that keeps US-3042's no-scrape rule
//      intact, and everywhere else it is the least the feature can ask for.
//   2. IT KEEPS NOTHING. The server persists no image (US-9033) and the client
//      matches: no storage.local, no cache. A care label carries a SIZE, which
//      is a fact about a body.
//
// Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function load(rel, global) {
  const src = fs.readFileSync(path.resolve(root, rel), "utf8");
  const selfObj = {};
  new Function("self", src)(selfObj);
  assert.ok(selfObj[global], `${rel} must assign self.${global}`);
  return selfObj[global];
}

const LR = load("research/label-reader.js", "GT_LABEL_READER");
const BG = fs.readFileSync(path.resolve(root, "background.js"), "utf8");

// ── the answer ─────────────────────────────────────────────────────────────

(function aReadableAnswerRenders() {
  const out = LR.readAnswer({
    rn: "RN 12345",
    brand: "Patagonia",
    size: "M",
    fiberContent: "100% cotton",
    styleCode: "25528",
    disclaimer: "Read from one photo by AI.",
  });
  assert.strictEqual(out.state, "ok");
  assert.strictEqual(out.fields.brand, "Patagonia");
  assert.strictEqual(LR.copyableRows(out).length, 5);
})();

(function aReadWithNothingOnItSaysSoRatherThanShowingFiveBlanks() {
  // The endpoint returns null for any field below its confidence floor, so an
  // unreadable photo comes back as five nulls. A table of dashes tells the
  // person less than one sentence does.
  const out = LR.readAnswer({
    rn: null, brand: null, size: null, fiberContent: null, styleCode: null,
  });
  assert.strictEqual(out.state, "empty");
  assert.deepStrictEqual(LR.copyableRows(out), []);
})();

(function refusalsAreAnswersAndCarryTheirOwnSentence() {
  // AC3. Rendered as themselves, never retried: a rate limit that retries
  // itself is one the person cannot see and cannot wait out.
  const limited = LR.readAnswer({
    code: "rate_limited",
    error: "You've reached the free tag-reader limit for now. Try again later.",
  });
  assert.strictEqual(limited.state, "rate_limited");
  assert.ok(limited.message.includes("Try again later"));

  const busy = LR.readAnswer({ code: "at_capacity", error: "Busy right now." });
  assert.strictEqual(busy.state, "at_capacity");

  // A plain error is its own state, distinct from both.
  assert.strictEqual(
    LR.readAnswer({ error: "Couldn't read that tag." }).state,
    "error",
  );
})();

(function nothingIsRenderedFromNothing() {
  for (const body of [null, undefined, "", 42, "not json"]) {
    assert.strictEqual(LR.readAnswer(body), null, JSON.stringify(body));
  }
  assert.deepStrictEqual(LR.copyableRows(null), []);
})();

// ── the url it will read ───────────────────────────────────────────────────

(function onlyBytesTheWorkerCanActuallyFetch() {
  assert.strictEqual(LR.isReadableImageUrl("https://cdn.example/tag.jpg"), true);
  assert.strictEqual(LR.isReadableImageUrl("http://cdn.example/tag.png"), true);
  assert.strictEqual(LR.isReadableImageUrl("data:image/jpeg;base64,AAAA"), true);

  // ⚠ blob: BELONGS TO THE PAGE'S ORIGIN and the service worker cannot read it.
  // Accepting one would produce a fetch that fails for a reason nobody could
  // diagnose from the card.
  assert.strictEqual(LR.isReadableImageUrl("blob:https://x/abc"), false);
  for (const bad of ["", null, undefined, 42, "javascript:alert(1)", "file:///etc/passwd", "data:text/html,x"]) {
    assert.strictEqual(LR.isReadableImageUrl(bad), false, String(bad));
  }
})();

// ── the RN link ────────────────────────────────────────────────────────────

(function theRnLinkCarriesDigitsOnly() {
  // The label prints "RN# 12345"; the lookup page wants the number.
  assert.strictEqual(LR.rnLookupPath({ rn: "RN 12345" }), "/tools/rn-lookup?rn=12345");
  assert.strictEqual(LR.rnLookupPath({ rn: "RN# 00123" }), "/tools/rn-lookup?rn=00123");
  // No number on the label is the common case and gets no link.
  for (const fields of [{ rn: null }, { rn: "" }, { rn: "no digits here" }, null]) {
    assert.strictEqual(LR.rnLookupPath(fields), null, JSON.stringify(fields));
  }
})();

// ── the worker half ────────────────────────────────────────────────────────

(function bothMenuItemsRegisterAndAreDistinguished() {
  assert.ok(BG.includes('const LABEL_MENU_ID = "gt-read-label"'), "no second menu id");
  assert.ok(BG.includes('id: LABEL_MENU_ID'), "the second item is never created");
  assert.ok(
    BG.includes("info.menuItemId === LABEL_MENU_ID"),
    "the click handler does not distinguish the two items",
  );
  // context-menu.test.cjs owns the idempotence half (US-3113's duplicate-id
  // warning); this only asserts the two exist and are told apart.
})();

(function theSizeCheckHappensBeforeTheUpload() {
  // ⚠ AC6's own case. The server refuses over 8MB anyway, but an 11MB press
  // photo uploaded and THEN refused costs the person the entire upload to be
  // told something we knew before it started.
  assert.strictEqual(LR.MAX_BYTES, 8 * 1024 * 1024, "the cap drifted from the server's");
  const fn = BG.slice(
    BG.indexOf("async function readLabelFromImage"),
    BG.indexOf("function blobToDataUri"),
  );
  assert.ok(fn.length > 200, "readLabelFromImage not found where expected");
  const sizeCheck = fn.indexOf("blob.size > LR.MAX_BYTES");
  const post = fn.indexOf("TAG_READ_ENDPOINT");
  assert.ok(sizeCheck > -1, "no client-side size check");
  assert.ok(post > -1, "the read never posts");
  assert.ok(sizeCheck < post, "the size check runs AFTER the upload starts");
})();

(function theWorkerSendsTheImageAndNotThePage() {
  const fn = BG.slice(
    BG.indexOf("async function readLabelFromImage"),
    BG.indexOf("function blobToDataUri"),
  );
  // The body is the image and nothing else. A page URL, a title or a referrer
  // added here would be the scrape this feature exists without.
  assert.ok(
    /body: JSON\.stringify\(\{ image: dataUri \}\)/.test(fn),
    "the request body carries more than the image",
  );
  for (const forbidden of ["pageUrl", "info.pageUrl", "tab.url", "document.title", "referrer"]) {
    assert.ok(!fn.includes(forbidden), `the request carries ${forbidden}`);
  }

  // JSON with a data URI, NOT multipart — US-3070's AC1 says multipart and the
  // endpoint's prepareGradeCheckImage takes `{ image: "data:..." }`.
  assert.ok(!/FormData/.test(fn), "the read posts multipart; the endpoint takes JSON");
  assert.ok(fn.includes('"Content-Type": "application/json"'));

  // ⚠ AND NO AUTHORIZATION HEADER. The endpoint is anonymous by design and
  // rate-limited per IP; a token would tie a care label — which carries a size,
  // a fact about a body — to an account for nothing in return.
  assert.ok(!/Authorization/.test(fn), "the anonymous tag read sends a token");
})();

(function nothingIsRetriedAndNothingIsStored() {
  // AC5. The result lives in the card and dies with it.
  // Sliced to the label reader's OWN code. A wider slice swept in the watched-
  // lots block, which stores by design, and the guard would have been asserting
  // something about somebody else's feature.
  const start = BG.indexOf("// US-3070: the second item.");
  const end = BG.indexOf("// The toolbar badge:", start);
  const declBlock = BG.slice(start, BG.indexOf("// ── Watched lots (US-3067", start));
  const clickBlock = BG.slice(
    BG.indexOf("if (info.menuItemId === LABEL_MENU_ID) {"),
    BG.indexOf("if (info.menuItemId !== CONTEXT_MENU_ID) return;"),
  );
  assert.ok(start > -1 && end > start, "the label-reader block moved");
  assert.ok(declBlock.length > 400 && clickBlock.length > 100, "a slice came back empty");
  const fn = declBlock + clickBlock;
  for (const forbidden of ["storage.local.set", "storage.sync", "retry", "attempts", "setInterval"]) {
    assert.ok(!fn.includes(forbidden), `the label reader ${forbidden}s`);
  }
  assert.strictEqual(LR.CARD_TTL_MS, 60 * 1000, "the card no longer expires after 60s");
})();

console.log(
  "label-reader.test.cjs: srcUrl is the only input, no token and no page url travel, " +
    "the 8MB check precedes the upload, refusals render as answers and are never " +
    "retried, and nothing is stored",
);
