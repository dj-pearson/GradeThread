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


// ── the card (US-3070 AC2/AC3) ─────────────────────────────────────────────

const CARD = load("research/label-card.js", "GT_LABEL_CARD");
const CARD_SRC = fs.readFileSync(path.resolve(root, "research/label-card.js"), "utf8");

(function renderClosesOverNothing() {
  // ⚠ THE ONE THAT IS INVISIBLE FROM THE WORKER. executeScript sends this
  // function's SOURCE to the page and runs it there. The page has no
  // GT_LABEL_READER, no chrome.runtime, no `ext` — a reference to any of them
  // is a ReferenceError inside somebody else's page, which surfaces as the card
  // silently never appearing. Nothing in the worker would log.
  const body = CARD.render.toString();
  for (const forbidden of [
    "GT_LABEL_READER", "GT_CC_", "GT_ATTRIBUTION", "chrome.", "browser.",
    "ext.", "self.", "module.exports", "require(",
  ]) {
    assert.ok(
      !body.includes(forbidden),
      `label-card render() references ${forbidden} — it is serialised into the ` +
        `page, where that does not exist`,
    );
  }
  // Everything it needs arrives as arguments.
  assert.strictEqual(CARD.render.length, 2, "render() takes (answer, opts)");
})();

// A DOM small enough to hand-roll and big enough to prove what the card builds.
// The extension suite is zero-dependency by rule, so there is no jsdom here.
function fakeDom() {
  const listeners = [];
  const timers = [];
  const mk = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attrs: {},
      style: {},
      className: "",
      id: "",
      textContent: "",
      shadow: null,
      removed: false,
      appendChild(c) { this.children.push(c); return c; },
      append(...cs) { for (const c of cs) this.children.push(c); },
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(type, fn) { listeners.push({ on: el, type, fn }); },
      removeEventListener() {},
      remove() { this.removed = true; doc._mounted = doc._mounted.filter((m) => m !== this); },
      attachShadow() { this.shadow = mk("shadow-root"); return this.shadow; },
    };
    return el;
  };
  const doc = {
    _mounted: [],
    body: { appendChild(el) { doc._mounted.push(el); return el; } },
    createElement: mk,
    getElementById(id) { return doc._mounted.find((m) => m.id === id) || null; },
    addEventListener(type, fn) { listeners.push({ on: doc, type, fn }); },
    removeEventListener() {},
  };
  return { doc, listeners, timers };
}

function runRender(answer, opts) {
  const { doc, listeners, timers } = fakeDom();
  const prevDoc = global.document;
  const prevTimeout = global.setTimeout;
  const prevNav = global.navigator;
  global.document = doc;
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return 0; };
  global.navigator = { clipboard: { writeText: () => Promise.resolve() } };
  try {
    CARD.render(answer, opts);
  } finally {
    global.document = prevDoc;
    global.setTimeout = prevTimeout;
    global.navigator = prevNav;
  }
  const flatten = (el, out = []) => {
    out.push(el);
    for (const c of el.children || []) flatten(c, out);
    if (el.shadow) flatten(el.shadow, out);
    return out;
  };
  const all = doc._mounted.flatMap((m) => flatten(m));
  // The dismiss path calls document.getElementById and removeEventListener, so
  // a handler fired AFTER the globals were restored throws on a missing
  // `document`. `act` reinstalls the fake for the duration of an interaction.
  const act = (fn) => {
    const prev = global.document;
    global.document = doc;
    try { fn(); } finally { global.document = prev; }
  };
  return { doc, listeners, timers, all, act, text: all.map((e) => e.textContent).join(" ") };
}

const OK_ANSWER = {
  state: "ok",
  fields: { brand: "Patagonia", size: "M", fiberContent: "100% cotton", styleCode: "25528", rn: "RN 51884" },
  disclaimer: "Read from one photo by AI.",
};
const OK_OPTS = {
  rows: [
    { key: "brand", label: "Brand", value: "Patagonia" },
    { key: "rn", label: "RN", value: "RN 51884" },
  ],
  siteUrl: "https://gradethread.com/tools/rn-lookup?rn=51884",
  ttlMs: 60000,
  hostId: "gt-label-card",
};

(function aReadRendersItsRowsAndOneCopyButton() {
  const r = runRender(OK_ANSWER, OK_OPTS);
  assert.ok(r.text.includes("Patagonia"), "the brand never reached the card");
  assert.ok(r.text.includes("RN 51884"));
  const buttons = r.all.filter((e) => e.tagName === "BUTTON");
  // The close button and Copy all. Not one per row: a card with five copy
  // buttons is five things to aim at for a result you mostly read.
  assert.strictEqual(buttons.length, 2, "unexpected button count");
  // rel/target/href are set as PROPERTIES by the card, not through
  // setAttribute, so they land on the element rather than in attrs.
  const link = r.all.find((e) => e.tagName === "A");
  assert.ok(link, "the RN lookup link never rendered");
  assert.strictEqual(link.rel, "noopener", "the outbound link is not rel=noopener");
  assert.strictEqual(link.target, "_blank");
  assert.ok(String(link.href).includes("rn-lookup"), link.href);
})();

(function aRefusalRendersTheSentenceAndNothingToCopy() {
  // AC3. Rendered as itself, never retried.
  for (const state of ["rate_limited", "at_capacity", "error"]) {
    const r = runRender({ state, message: "Try again in an hour." }, { rows: [], ttlMs: 1000 });
    assert.ok(r.text.includes("Try again in an hour."), state);
    const buttons = r.all.filter((e) => e.tagName === "BUTTON");
    assert.strictEqual(buttons.length, 1, `${state} offered something to copy`);
    assert.ok(!r.all.some((e) => e.tagName === "A"), `${state} rendered a link`);
  }
})();

(function anEmptyReadSaysSoRatherThanShowingBlanks() {
  const r = runRender({ state: "empty", fields: {} }, { rows: [], ttlMs: 1000 });
  assert.ok(/Nothing readable/i.test(r.text));
  assert.ok(!/undefined|null/.test(r.text), r.text);
})();

(function itLeavesOnItsOwn() {
  // Escape, the close button, or the TTL — whichever comes first. A card that
  // outlives the moment is a thing somebody else's page has to live with, and
  // this one was never asked for by the site.
  const r = runRender(OK_ANSWER, OK_OPTS);
  const host = r.doc._mounted[0];
  assert.ok(host, "nothing was mounted");

  const escape = r.listeners.find((l) => l.type === "keydown");
  assert.ok(escape, "no Escape handler");
  r.act(() => escape.fn({ key: "Escape" }));
  assert.strictEqual(host.removed, true, "Escape did not dismiss the card");

  // And a TTL is always armed, at the reader's own constant.
  const r2 = runRender(OK_ANSWER, OK_OPTS);
  const ttl = r2.timers.find((t) => t.ms === 60000);
  assert.ok(ttl, "no 60s teardown armed");
  const mounted = r2.doc._mounted[0];
  r2.act(() => ttl.fn());
  assert.strictEqual(mounted.removed, true, "the TTL did not dismiss");
})();

(function aSecondCardReplacesTheFirst() {
  // Two cards on one page is worse than a stale one.
  assert.ok(
    CARD_SRC.includes("if (existing) existing.remove()"),
    "a second right-click stacks a second card",
  );
})();

// ── the injection, and what it is NOT ──────────────────────────────────────

(function theWorkerInjectsRatherThanMatchingEveryPage() {
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(root, "manifest.json"), "utf8"),
  );
  // ⚠ activeTab + scripting, NOT <all_urls>. A context-menu click is a
  // qualifying gesture for activeTab, which this extension already held, so the
  // card reaches any page with no host permission at all. The alternative reads
  // as "read and change all your data on all websites" at update time.
  assert.ok(manifest.permissions.includes("scripting"), "no scripting permission");
  assert.ok(manifest.permissions.includes("activeTab"), "activeTab was dropped");
  for (const p of manifest.permissions) {
    assert.ok(p !== "tabs", "the broad tabs permission was added");
  }
  for (const h of manifest.host_permissions) {
    assert.ok(!/^\*:\/\/\*\/\*|<all_urls>/.test(h), `host_permissions gained ${h}`);
  }
  for (const cs of manifest.content_scripts || []) {
    for (const m of cs.matches) {
      assert.ok(
        !/<all_urls>|^\*:\/\/\*\//.test(m),
        `a content script now matches ${m} — the card is injected on demand instead`,
      );
    }
  }

  // And the worker really does inject, with the shaping done on its side.
  const fn = BG.slice(
    BG.indexOf("async function showLabelCard"),
    BG.indexOf("function blobToDataUri"),
  );
  assert.ok(fn.length > 200, "showLabelCard not found where expected");
  assert.ok(/ext\.scripting\.executeScript\(/.test(fn), "the card is not injected");
  assert.ok(/func: CARD\.render/.test(fn), "executeScript does not run the card's render");
  assert.ok(/target: \{ tabId: tabId \}/.test(fn), "the injection is not scoped to the clicked tab");
  // A transport failure renders NOTHING. A card saying "something went wrong"
  // on a page the person did not ask anything of is worse than no card.
  assert.ok(/if \(!res \|\| !res\.ok\) return;/.test(fn), "a failed read still draws");
})();

(function theStoreListingJustifiesTheNewPermission() {
  // US-1874 shipped `alarms` unjustified and it was a review rejection.
  const sub = fs.readFileSync(path.resolve(root, "SUBMISSION.md"), "utf8");
  assert.ok(/`scripting`/.test(sub), "scripting has no justification in SUBMISSION.md");
  const para = sub.slice(sub.indexOf("- `scripting`"), sub.indexOf("- `scripting`") + 900);
  assert.ok(/activeTab/.test(para), "the justification does not say where the access comes from");
  assert.ok(/right-click|right click/i.test(para), "it does not say what triggers it");
})();

// -- the worker half, EXECUTED against a fake fetch (US-3070 AC6) -----------
//
// !! EVERYTHING ABOVE ABOUT readLabelFromImage IS A SOURCE SCAN, AND A SCAN PINS
// THE SPELLING OF A RULE RATHER THAN ITS ANSWER. `sizeCheck < post` is equally
// true of code that measures the blob and then posts it anyway; a grep for
// "storage.local.set" is equally true of code that persists through a helper;
// "no Authorization in this slice" is equally true of a header added two
// functions away. AC6 asks for a fake fetch by name, so the worker's own slice
// is lifted out and RUN, and every property below is measured from what the
// fakes were actually asked for.
//
// The slice is bounded by two markers that occur once each in background.js,
// and it is asserted to contain all three functions before anything runs - an
// extraction that silently comes back empty is a test that passes against
// deleted code.

const TAG_READ_URL =
  "https://functions.gradethread.com/api/grading/public/tag-read";

const WORKER_SRC = (function () {
  const start = BG.indexOf("const TAG_READ_ENDPOINT =");
  const end = BG.indexOf("if (ext.commands && ext.commands.onCommand) {");
  assert.ok(start > -1, "TAG_READ_ENDPOINT was renamed or removed");
  assert.ok(end > start, "the label reader's worker half is no longer one block");
  const slice = BG.slice(start, end);
  for (const need of [
    "async function readLabelFromImage",
    "async function showLabelCard",
    "function blobToDataUri",
  ]) {
    assert.ok(slice.includes(need), "the extracted slice lost " + need);
  }
  assert.ok(slice.includes(TAG_READ_URL), "the tag-read endpoint host changed");
  return slice;
})();

const ATTR = load("attribution.js", "GT_ATTRIBUTION");

const FAKE_DATA_URI = "data:image/jpeg;base64,QUJD";
const IMAGE_URL = "https://cdn.example/tag.jpg";

/**
 * Run the whole right-click path against fakes and report what it asked for.
 *
 * Returns every observable: the fetches in order, any persistence call, and the
 * executeScript specs. Nothing here reaches a network, a disk or a DOM.
 */
function driveRead(opts) {
  const o = opts || {};
  const fetches = [];
  const persisted = [];
  const injections = [];

  const blob = {
    size: typeof o.bytes === "number" ? o.bytes : 2048,
    type: o.blobType === undefined ? "image/jpeg" : o.blobType,
  };

  function fakeFetch(url, init) {
    fetches.push({ url: String(url), init: init || null });
    if (String(url) === TAG_READ_URL) {
      if (o.endpointThrows) return Promise.reject(new Error("offline"));
      return Promise.resolve({
        ok: true,
        json: function () { return Promise.resolve(o.body); },
      });
    }
    if (o.imageFetchFails) return Promise.resolve({ ok: false });
    return Promise.resolve({
      ok: true,
      blob: function () { return Promise.resolve(blob); },
    });
  }

  function FakeFileReader() {
    const reader = this;
    this.result = null;
    this.onload = null;
    this.onerror = null;
    this.readAsDataURL = function () {
      setImmediate(function () {
        reader.result = FAKE_DATA_URI;
        if (reader.onload) reader.onload();
      });
    };
  }

  // Every way this worker could keep the read is handed over as a RECORDER, so
  // a write is observable rather than merely unspelled. AC5 is the rule: a care
  // label carries a size, which is a fact about a body, and the result lives in
  // the card and dies with it.
  function recorder(name) {
    return function () { persisted.push(name); return Promise.resolve(); };
  }
  const store = {
    local: { set: recorder("storage.local.set"), get: recorder("storage.local.get"), remove: recorder("storage.local.remove") },
    sync: { set: recorder("storage.sync.set"), get: recorder("storage.sync.get") },
    session: { set: recorder("storage.session.set"), get: recorder("storage.session.get") },
  };
  const ext = {
    storage: store,
    scripting: {
      executeScript: function (spec) {
        injections.push(spec);
        return Promise.resolve([]);
      },
    },
  };

  const selfObj = {
    GT_LABEL_READER: LR,
    GT_LABEL_CARD: CARD,
    GT_ATTRIBUTION: ATTR,
    chrome: ext,
    browser: ext,
  };

  const worker = new Function(
    "self", "ext", "fetch", "FileReader", "chrome", "browser",
    "localStorage", "indexedDB", "caches",
    WORKER_SRC +
      "\nreturn { readLabelFromImage: readLabelFromImage, showLabelCard: showLabelCard };",
  )(
    selfObj, ext, fakeFetch, FakeFileReader, ext, ext,
    { setItem: recorder("localStorage.setItem") },
    { open: recorder("indexedDB.open") },
    { open: recorder("caches.open") },
  );

  return worker
    .readLabelFromImage(o.srcUrl === undefined ? IMAGE_URL : o.srcUrl)
    .then(function (res) {
      return worker.showLabelCard(7, res).then(function () {
        return { res: res, fetches: fetches, persisted: persisted, injections: injections };
      });
    });
}

const A_GOOD_READ = {
  brand: "Patagonia",
  size: "M",
  fiberContent: "100% cotton",
  styleCode: "25528",
  rn: "RN 51884",
  disclaimer: "Read from one photo by AI.",
};

async function theWorkerHalfBehaves() {
  // -- AC6: the 8MB refusal is CLIENT-SIDE AND BEFORE THE UPLOAD ------------
  //
  // Measured as "the endpoint was never asked", which is the thing that costs
  // the person their upload. An ordering assertion on two string indexes
  // cannot tell this apart from code that checks and posts anyway.
  {
    const r = await driveRead({ bytes: 9 * 1024 * 1024, body: A_GOOD_READ });
    assert.strictEqual(
      r.fetches.length, 1,
      "a 9MB image reached the network twice - the cap was checked after the upload",
    );
    assert.strictEqual(r.fetches[0].url, IMAGE_URL);
    assert.ok(
      !r.fetches.some(function (f) { return f.url === TAG_READ_URL; }),
      "a 9MB image was posted to the tag reader",
    );
    assert.ok(/8MB/.test(r.res.data.error), r.res.data.error);
    // And it still SAYS so. Silence on a menu item somebody just clicked reads
    // as a broken feature, which is the one thing worse than the refusal.
    assert.strictEqual(r.injections.length, 1, "the size refusal drew nothing");
    assert.strictEqual(r.injections[0].args[0].state, "error");
  }

  // Just under the cap still goes.
  {
    const r = await driveRead({ bytes: 8 * 1024 * 1024, body: A_GOOD_READ });
    assert.strictEqual(r.fetches.length, 2, "an 8MB image was refused at the cap");
  }

  // -- AC1: only the image travels -----------------------------------------
  {
    const r = await driveRead({ body: A_GOOD_READ });
    assert.strictEqual(r.fetches.length, 2, "unexpected request count");
    const post = r.fetches[1];
    assert.strictEqual(post.url, TAG_READ_URL);
    assert.strictEqual(post.init.method, "POST");
    assert.deepStrictEqual(
      JSON.parse(post.init.body), { image: FAKE_DATA_URI },
      "the request body carries something other than the image",
    );
    // !! THE HEADER LIST IS EXACT. An Authorization header would tie a care
    // label to an account for nothing in return; the endpoint is anonymous by
    // design and rate-limited per IP.
    assert.deepStrictEqual(
      Object.keys(post.init.headers), ["Content-Type"],
      "the anonymous tag read sends a header it does not need",
    );
    assert.notStrictEqual(post.init.credentials, "include", "a cookie rides along");
    assert.strictEqual(post.init.cache, "no-store");

    // -- AC2: the card is injected into the clicked tab, with DATA only -----
    assert.strictEqual(r.injections.length, 1);
    assert.deepStrictEqual(r.injections[0].target, { tabId: 7 }, "the injection is unscoped");
    const handedOver = JSON.stringify(r.injections[0].args);
    assert.ok(!handedOver.includes("data:image"), "the image bytes were handed to the page");
    assert.ok(!handedOver.includes("cdn.example"), "the image URL was handed to the page");

    // The RN link, built through attribution.js rather than concatenated here.
    const siteUrl = r.injections[0].args[1].siteUrl;
    assert.ok(siteUrl, "no RN lookup link on a read that found one");
    assert.strictEqual(siteUrl.split("?")[0], "https://gradethread.com/tools/rn-lookup");
    assert.ok(siteUrl.includes("rn=51884"), siteUrl);
    assert.ok(
      siteUrl.includes("utm_medium=label-reader"),
      "the link is not built through attribution.js - it carries no medium",
    );
    assert.deepStrictEqual(
      r.injections[0].args[1].rows.map(function (row) { return row.key; }),
      ["brand", "size", "fiberContent", "styleCode", "rn"],
    );
  }

  // -- AC3: a refusal is an answer, and NOTHING is retried -----------------
  {
    for (const body of [
      { code: "rate_limited", error: "Try again in an hour." },
      { code: "at_capacity", error: "Busy right now." },
    ]) {
      const r = await driveRead({ body: body });
      assert.strictEqual(
        r.fetches.length, 2,
        body.code + " was retried - a limit the person cannot see is one they cannot wait out",
      );
      assert.strictEqual(r.injections.length, 1, body.code + " drew nothing");
      assert.strictEqual(r.injections[0].args[0].state, body.code);
      assert.strictEqual(r.injections[0].args[0].message, body.error);
      assert.strictEqual(r.injections[0].args[1].siteUrl, null, "a refusal offered an RN link");
      assert.deepStrictEqual(r.injections[0].args[1].rows, [], "a refusal offered rows to copy");
    }
  }

  // -- a URL the worker cannot read never reaches the network at all -------
  {
    for (const src of ["blob:https://poshmark.com/abc", "javascript:alert(1)", "file:///etc/passwd", ""]) {
      const r = await driveRead({ srcUrl: src, body: A_GOOD_READ });
      assert.strictEqual(r.fetches.length, 0, src + " reached the network");
      assert.strictEqual(r.injections.length, 0, src + " drew a card");
    }
  }

  // -- a body that is not an image is never posted -------------------------
  {
    const r = await driveRead({ blobType: "text/html", body: A_GOOD_READ });
    assert.strictEqual(r.fetches.length, 1, "a non-image body was posted to the tag reader");
  }

  // -- a transport failure draws nothing at all ----------------------------
  //
  // A card reading "something went wrong" on a page the person did not ask
  // anything of is worse than no card.
  {
    for (const scenario of [{ endpointThrows: true }, { imageFetchFails: true }]) {
      const r = await driveRead(Object.assign({ body: A_GOOD_READ }, scenario));
      assert.strictEqual(r.injections.length, 0, "a failed read still drew a card");
    }
  }

  // -- AC5/AC6: nothing is kept, across every path above -------------------
  {
    const scenarios = [
      { body: A_GOOD_READ },
      { body: { code: "rate_limited", error: "Try again in an hour." } },
      { body: { rn: null, brand: null, size: null, fiberContent: null, styleCode: null } },
      { bytes: 9 * 1024 * 1024, body: A_GOOD_READ },
      { endpointThrows: true, body: A_GOOD_READ },
      { srcUrl: "blob:https://x/abc", body: A_GOOD_READ },
    ];
    for (const scenario of scenarios) {
      const r = await driveRead(scenario);
      assert.deepStrictEqual(
        r.persisted, [],
        "the label reader persisted the read through " + r.persisted.join(", ") +
          " - the result lives in the card and dies with it",
      );
    }
  }
}

theWorkerHalfBehaves().then(
  function () {
    console.log(
      "label-reader.test.cjs: srcUrl is the only input, no token and no page url travel, " +
        "the 8MB check precedes the upload, refusals render as answers and are never " +
        "retried, nothing is stored, and the card is INJECTED on a right-click rather " +
        "than matched on every page - the worker half DRIVEN against a fake fetch, not scanned",
    );
  },
  function (err) {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  },
);
