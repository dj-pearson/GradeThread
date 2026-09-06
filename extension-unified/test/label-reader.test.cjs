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

console.log(
  "label-reader.test.cjs: srcUrl is the only input, no token and no page url travel, " +
    "the 8MB check precedes the upload, refusals render as answers and are never " +
    "retried, nothing is stored, and the card is INJECTED on a right-click rather " +
    "than matched on every page",
);
