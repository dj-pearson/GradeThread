// GradeThread unified extension: one platform vocabulary (US-3373).
//
// Zero-dependency node script: throws on drift.
//
// WHAT WENT WRONG. popup.js carried its own platform label map calling facebook
// "Facebook" and handed it to queue-view.js as a `platformLabels` override.
// panel.js and worker.js passed no override, so they got queue-view.js's map,
// which says "Facebook Marketplace". One queue row, one set of data, three
// surfaces, two names. Nothing threw and nothing looked broken on any single
// screen. It only shows up when a seller has the popup and the side panel open
// at once, which is the whole point of the side panel.
//
// WHY THIS FILE DOES NOT LIST THE PLATFORMS. Facebook was found by eye, and an
// eye finds one. A guard that names the platforms it checks is the same eye with
// a longer attention span: the sixth platform lands, it disagrees, and this file
// passes. So every platform below comes out of queue-view.js's own map, and the
// day a key is added there it is checked here with no edit to this file.
//
// THREE THINGS ARE PINNED, and the first is the one with teeth:
//
//   1. THE RENDERED WORDS. Each surface's real render path is driven against the
//      same API rows, and the platform name is read back out of the DOM it
//      produced. Not the map it holds - the words on the row. The override this
//      story removed lived at a CALL SITE, not in a map, so a test that only
//      compared maps would have passed the entire time the bug existed.
//   2. THE MAPS THEMSELVES, for the surfaces a queue row never reaches. popup.js
//      also spells platform names on its channel rows and its research chips,
//      and a split inside one popup is worse than a split across two.
//   3. NO NEW OVERRIDE AND NO NEW COPY. `platformLabels` is gone from
//      queue-view.js's options, so passing one would now fail silently instead
//      of loudly; and a second literal map is how the first one got here.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");
// LF, always. This repo's working tree mixes line endings (popup.js, worker.js
// and queue-view.js are CRLF; panel/panel.js is LF), and every helper below
// slices source on "\n}\n" or matches "\n" in a regex. Left alone, this file
// would have failed on three of the four inputs for a reason that has nothing
// to do with platform names.
const read = (...p) =>
  fs.readFileSync(path.join(dir, ...p), "utf8").replace(/\r\n/g, "\n");

const QUEUE_VIEW_SRC = read("queue", "queue-view.js");
const POPUP_JS = read("popup.js");
const PANEL_JS = read("panel", "panel.js");
const WORKER_JS = read("worker.js");

// The real view model, loaded the way queue-view.test.cjs loads it.
const scope = {};
new Function("self", QUEUE_VIEW_SRC)(scope);
const QUEUE_VIEW = scope.GT_QUEUE_VIEW;
assert.ok(QUEUE_VIEW, "queue/queue-view.js must assign self.GT_QUEUE_VIEW");

// THE source of truth. Everything below is derived from it.
const CANON = QUEUE_VIEW.PLATFORM_LABELS;
assert.ok(CANON && typeof CANON === "object", "GT_QUEUE_VIEW must export PLATFORM_LABELS");
const PLATFORMS = Object.keys(CANON);
// Vacuity guard: an empty or one-key map would make every loop below a no-op
// and this file would pass while checking nothing at all.
assert.ok(
  PLATFORMS.length >= 5,
  `expected at least 5 platforms in queue-view.js, got ${PLATFORMS.length}`,
);
for (const key of PLATFORMS) {
  assert.ok(
    typeof CANON[key] === "string" && CANON[key].trim(),
    `queue-view.js PLATFORM_LABELS.${key} must be a non-empty string`,
  );
}

// -- reading a declaration out of a source file ------------------------------
//
// popup.js cannot be evaluated in node (it touches document at load and wires
// listeners), and its maps are the thing under test, so a fixture copy of them
// here would defeat the file. This lifts the initializer expression for one
// top-level `const`/`var` and evaluates just that, with a `self` carrying the
// module popup.js derives from. It handles an object literal and an
// Object.assign call alike, which is the point: the shape of the declaration is
// popup.js's business, the VALUE is this file's.

function initializerOf(src, name, vars) {
  const re = new RegExp("(?:^|\\n)(?:const|var|let)\\s+" + name + "\\s*=");
  const m = re.exec(src);
  assert.ok(m, `could not find a declaration of ${name}`);
  let i = m.index + m[0].length;
  let depth = 0;
  let quote = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c === ";" && depth === 0) break;
  }
  assert.ok(i < src.length, `could not find the end of the ${name} declaration`);
  const expr = src.slice(m.index + m[0].length, i).trim();
  assert.ok(expr, `${name} has an empty initializer`);
  // One declaration may be built from an earlier one (popup.js's
  // MARKETPLACE_LABELS extends its PLATFORM_LABELS), so the caller passes those
  // in by name rather than this file re-deriving them.
  const names = Object.keys(vars || {});
  const fn = new Function("self", ...names, "return (" + expr + ");");
  return fn({ GT_QUEUE_VIEW: QUEUE_VIEW }, ...names.map((n) => vars[n]));
}

// -- 1. the maps outside the queue agree -------------------------------------
{
  const popupPlatform = initializerOf(POPUP_JS, "PLATFORM_LABELS");
  const popupMarket = initializerOf(
    POPUP_JS, "MARKETPLACE_LABELS", { PLATFORM_LABELS: popupPlatform },
  );

  for (const key of PLATFORMS) {
    assert.strictEqual(
      popupPlatform[key], CANON[key],
      `popup.js PLATFORM_LABELS.${key} is "${popupPlatform[key]}" but ` +
      `queue-view.js says "${CANON[key]}". One vocabulary, and it is ` +
      "queue-view.js's - see US-3373.",
    );
    assert.strictEqual(
      popupMarket[key], CANON[key],
      `popup.js MARKETPLACE_LABELS.${key} is "${popupMarket[key]}" but ` +
      `queue-view.js says "${CANON[key]}". The research chips and the queue ` +
      "rows are in the same popup; they cannot name a site two ways.",
    );
  }

  // The research half legitimately knows sites the Lister has no flow for.
  // They are not listed here by name - whatever they are, they must be real
  // labels rather than a raw key leaking into the UI.
  for (const key of Object.keys(popupMarket)) {
    assert.ok(
      typeof popupMarket[key] === "string" && popupMarket[key].trim(),
      `popup.js MARKETPLACE_LABELS.${key} must be a non-empty string`,
    );
  }
}

// -- 2. nothing re-introduces an override or a second copy -------------------
{
  const files = [
    ["popup.js", POPUP_JS],
    ["panel/panel.js", PANEL_JS],
    ["worker.js", WORKER_JS],
    ["queue/queue-view.js", QUEUE_VIEW_SRC],
  ];

  for (const [name, src] of files) {
    // Comments may talk about it - three of these files now do, saying it is
    // gone. Code may not.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    assert.ok(
      !/platformLabels/.test(code),
      `${name} mentions platformLabels in code. US-3373 removed that option: ` +
      "passing one now does nothing, which is worse than the split it caused.",
    );
  }

  // A second literal spelling of a platform this vocabulary already owns. The
  // keys come from CANON, so a platform added to queue-view.js is covered here
  // the same day with no edit to this file.
  for (const [name, src] of files) {
    if (name === "queue/queue-view.js") continue;
    for (const key of PLATFORMS) {
      const re = new RegExp("(^|[{,\\s])" + key + "\\s*:\\s*[\"'`]");
      assert.ok(
        !re.test(src),
        `${name} maps "${key}" to a string of its own. Platform names live in ` +
        "queue/queue-view.js and are read from there (US-3373).",
      );
    }
  }
}

// -- the fixture: one queue row per platform, no title -----------------------
//
// TITLE-LESS ON PURPOSE. A `list` job queued from a phone carries no title, and
// all three surfaces fall back to `kindLabel + " on " + platformLabel` for it.
// That fallback is the one string where the platform name is the headline
// rather than a fragment of a meta line, so it is the cleanest place to read
// each surface's answer back out and compare them.

// ONE ROW PER PASS, not one list of five. Row ORDER is sortRows' business and
// it is allowed to change; a test that read the third title and called it
// Grailed would start failing for a reason that has nothing to do with names.
// With a single row there is nothing to match up: whatever the surface painted
// is that platform's answer.

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);

function stateFor(key) {
  return {
    ok: true,
    pending: [{
      id: "q-" + key,
      kind: "list",
      platform: key,
      status: "queued",
      payload: {},
      result: null,
      created_at: new Date(NOW - 60 * 1000).toISOString(),
    }],
    needsAttention: [],
    finishedNeedsReview: [],
  };
}

const QUEUE_JOBS = { ok: true, byQueueId: {} };

// Every surface builds a title-less row's headline the same way, so this is the
// prefix each one's answer has to arrive behind.
const KIND = QUEUE_VIEW.KIND_LABELS.list;
const PREFIX = KIND + " on ";

// -- a DOM small enough to hand-roll -----------------------------------------
//
// Same shape as test/panel-queue-row.test.cjs, including the one detail that
// matters: assigning textContent drops the children, so a second render cannot
// leave last render's rows behind and read as a pass.

function mkEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attrs: {},
    dataset: {},
    className: "",
    id: "",
    title: "",
    href: "",
    target: "",
    rel: "",
    type: "",
    hidden: false,
    disabled: false,
    _text: "",
    _listeners: [],
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(type, fn) { this._listeners.push({ type, fn }); },
    removeEventListener() {},
    focus() {},
  };
  Object.defineProperty(el, "textContent", {
    enumerable: true,
    get() { return this._text; },
    set(v) { this._text = v; this.children.length = 0; },
  });
  return el;
}

function fakeDoc(ids) {
  const byId = {};
  for (const id of ids) {
    const el = mkEl("div");
    el.id = id;
    byId[id] = el;
  }
  return {
    byId,
    doc: {
      readyState: "complete",
      createElement: mkEl,
      getElementById(id) {
        return Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : null;
      },
      addEventListener() {},
    },
  };
}

/** Every title span under a rendered list, in render order. */
function titlesUnder(node, className) {
  const out = [];
  (function walk(n) {
    if (!n || !Array.isArray(n.children)) return;
    if (n.className === className && n._text) out.push(n._text);
    for (const c of n.children) walk(c);
  })(node);
  return out;
}

/** A function declared at the top level of a file. */
function topLevelFn(src, name) {
  let start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, `could not find function ${name}`);
  if (src.slice(start - 6, start) === "async ") start -= 6;
  const end = src.indexOf("\n}\n", start);
  assert.ok(end > start, `could not find the end of function ${name}`);
  return src.slice(start, end + 2);
}

/** The same, for a function indented one level inside an IIFE. */
function nestedFn(src, name) {
  let start = src.indexOf("  function " + name + "(");
  assert.ok(start >= 0, `could not find nested function ${name}`);
  if (src.slice(start - 6, start) === "async ") start -= 6;
  const end = src.indexOf("\n  }\n", start);
  assert.ok(end > start, `could not find the end of nested function ${name}`);
  return src.slice(start, end + 4);
}

// -- surface 1: the popup ----------------------------------------------------
//
// renderQueue is the function that holds the buildList CALL, which is where the
// override lived, so this drives renderQueue rather than renderQueueRow. The
// harness hands it popup.js's OWN PLATFORM_LABELS, lifted from popup.js above
// and not from queue-view.js: feeding it the canonical map would make any
// override a no-op and this whole file a formality.

async function renderPopup(state, popupPlatformLabels) {
  const ids = [
    "queueBlock", "queueList", "queueNote", "queueStatus", "queueRunNow",
    "queueRetryAll", "queueClearFailed", "queueCancelAll",
  ];
  const { doc, byId } = fakeDoc(ids);
  const harness = [
    "var workCounts = { delist: 0, queue: 0, revise: 0 };",
    "var queueRows = [];",
    "var DELIST_REASON = { error: 'err' };",
    "function monogram() { return document.createElement('span'); }",
    "function timeAgo() { return '1 hour ago'; }",
    "function renderWorkSummary() {}",
    "function refocusIn() {}",
    "async function send(msg) {",
    "  if (msg.type === 'GT_QUEUE_STATE') return STATE;",
    "  if (msg.type === 'GT_QUEUE_JOBS') return JOBS;",
    "  return { ok: true };",
    "}",
    topLevelFn(POPUP_JS, "renderQueue"),
    topLevelFn(POPUP_JS, "renderQueueRow"),
    "return renderQueue;",
  ].join("\n");
  const renderQueue = new Function(
    "document", "QUEUE_VIEW", "STATE", "JOBS", "PLATFORM_LABELS", harness,
  )(doc, QUEUE_VIEW, state, QUEUE_JOBS, popupPlatformLabels);
  await renderQueue({ sellerEnabled: true });
  return titlesUnder(byId.queueList, "pop-delist-title");
}

// -- surface 2: the side panel -----------------------------------------------
//
// panel.js is an IIFE that calls start() on load, so it is driven the way the
// browser drives it. GT_PANEL_ITEM_CARD is deliberately absent: renderItem
// returns at its first line and this file is about the queue rows only.

function fakeExt(state) {
  return {
    runtime: {
      sendMessage(msg) {
        switch (msg && msg.type) {
          case "GT_PANEL_SUPPORTED": return Promise.resolve({ supported: true });
          case "GT_GET_CAPABILITIES":
            return Promise.resolve({ signedIn: true, sellerEnabled: true });
          case "GT_QUEUE_STATE": return Promise.resolve(state);
          case "GT_QUEUE_JOBS": return Promise.resolve(QUEUE_JOBS);
          default: return Promise.resolve(null);
        }
      },
      getManifest() { return { version: "0.0.0-test" }; },
    },
    tabs: {
      query() { return Promise.resolve([{ id: 1, url: "https://poshmark.com/x" }]); },
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
    },
  };
}

async function renderPanel(state) {
  const ids = [
    "queueList", "queueEmpty", "headAcct", "headAcctLabel", "offHostSection",
    "itemSection", "queueSection", "itemCard", "itemEmpty", "queueRunNow",
    "queueRefresh", "panelVer",
  ];
  const { doc, byId } = fakeDoc(ids);
  const panelSelf = { GT_QUEUE_VIEW: QUEUE_VIEW };
  new Function("self", "document", "chrome", "browser", PANEL_JS)(
    panelSelf, doc, fakeExt(state), undefined,
  );
  // Every await in the panel's refresh chain is on an already-resolved
  // promise, so one macrotask boundary drains all of it.
  await new Promise((r) => setTimeout(r, 0));
  return titlesUnder(byId.queueList, "gt-panel-row-title");
}

// -- surface 3: the worker tab -----------------------------------------------
//
// worker.js's IIFE connects a port and starts an interval on load, so its two
// render functions are lifted out and run instead. renderQueue is still the one
// holding the buildList call, which is the line this file exists to watch.

function renderWorker(state) {
  const { doc, byId } = fakeDoc(["queueList", "empty"]);
  const harness = [
    "function el(id) { return document.getElementById(id); }",
    nestedFn(WORKER_JS, "row"),
    nestedFn(WORKER_JS, "renderQueue"),
    "return renderQueue;",
  ].join("\n");
  const renderQueue = new Function("document", "QUEUE_VIEW", harness)(doc, QUEUE_VIEW);
  renderQueue(state, null);
  return titlesUnder(byId.queueList, "pop-delist-title");
}

// -- 3. the three surfaces say the same thing --------------------------------

(async function main() {
  const popupLabels = initializerOf(POPUP_JS, "PLATFORM_LABELS");

  for (const key of PLATFORMS) {
    const state = stateFor(key);
    const painted = {
      popup: await renderPopup(state, popupLabels),
      panel: await renderPanel(state),
      worker: renderWorker(state),
    };

    const seen = {};
    for (const [surface, titles] of Object.entries(painted)) {
      // If a surface paints nothing, every comparison below is vacuous and this
      // file would pass while the surfaces were free to disagree. That is not a
      // hypothetical here: US-3371 was one story about the side panel painting
      // rows with no words in them at all, and it passed every row-counting
      // test in this directory.
      assert.strictEqual(
        titles.length, 1,
        `the ${surface} painted ${titles.length} queue rows for "${key}", ` +
        "expected exactly 1. A surface that renders nothing makes the rest of " +
        "this file vacuous.",
      );
      assert.ok(
        titles[0].startsWith(PREFIX),
        `the ${surface} headlined a title-less "${key}" row as "${titles[0]}", ` +
        `which does not start with "${PREFIX}". All three surfaces build that ` +
        "fallback the same way; if one stopped, this file can no longer " +
        "compare them and needs rewriting rather than relaxing.",
      );
      seen[surface] = titles[0].slice(PREFIX.length);
    }

    const names = Object.values(seen);
    assert.ok(
      names.every((n) => n === names[0]),
      `the surfaces disagree about "${key}": ` +
      Object.entries(seen).map(([s, n]) => `${s} says "${n}"`).join(", ") +
      ". One vocabulary, and it is queue-view.js's (US-3373).",
    );
    assert.strictEqual(
      names[0], CANON[key],
      `every surface renders "${key}" as "${names[0]}", but queue-view.js ` +
      `PLATFORM_LABELS says "${CANON[key]}".`,
    );
  }

  console.log(
    `platform-label-vocabulary: ${PLATFORMS.length} platforms agree across ` +
    "the popup, the side panel and the worker tab",
  );
})().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
