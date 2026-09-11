// US-3371: the side panel's queue rows must say something.
//
// WHAT WENT WRONG. panel.js asked queue-view.js for a row's title with
// `QUEUE_VIEW.titleFor(row)` and for its status with `QUEUE_VIEW.statusLine(row)`,
// where `row` is a VIEW object built by viewRow(). Neither function takes a view.
// titleFor reads `item_title` / `payload.title` / `payload.listingTitle`, none of
// which a view has, and returned null. statusLine takes a COUNTS object and reads
// `running` / `waiting` / `attention`, none of which a view has, and returned the
// empty string. So every row in the panel painted an empty title and an empty
// status.
//
// WHY NOBODY NOTICED, AND WHY THIS FILE RENDERS RATHER THAN COUNTS. Both
// functions returned a FALSY value instead of throwing. The panel still rendered,
// the group headings were right, the row count was right, and the Cancel button
// was on the right rows. Any test that counted rows or checked which ones offer
// Cancel passed the whole time. The only assertion that could have caught it is
// one that reads the rendered TEXT, so that is what this does: it drives the real
// panel.js against a hand-rolled DOM and reads the words out of the spans.
//
// The extension suite is zero-dependency by rule, so there is no jsdom here. The
// fake DOM below is the same shape test/label-reader.test.cjs uses, with one
// addition that matters: setting textContent clears children, the way a real node
// does, so a re-render cannot leave stale rows behind and read as a pass.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(dir, ...p), "utf8");

const PANEL_JS = read("panel", "panel.js");

// The real view model, loaded the way queue-view.test.cjs loads it. A fixture
// copy of these rules here would pass while the shipped ones were wrong.
const scope = {};
new Function("self", read("queue", "queue-view.js"))(scope);
const QUEUE_VIEW = scope.GT_QUEUE_VIEW;
assert.ok(QUEUE_VIEW, "queue/queue-view.js must assign self.GT_QUEUE_VIEW");

// ── a DOM small enough to hand-roll ─────────────────────────────────────────

const PANEL_IDS = [
  "queueList", "queueEmpty", "headAcct", "headAcctLabel", "offHostSection",
  "itemSection", "queueSection", "itemCard", "itemEmpty", "queueRunNow",
  "queueRefresh", "panelVer",
];

function mkEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attrs: {},
    dataset: {},
    className: "",
    id: "",
    title: "",
    type: "",
    hidden: false,
    disabled: false,
    _text: "",
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { this._listeners.push({ type, fn }); },
    removeEventListener() {},
  };
  el._listeners = [];
  Object.defineProperty(el, "textContent", {
    enumerable: true,
    get() { return this._text; },
    // A real node drops every child when textContent is assigned. Without this,
    // a second render would append to the first one's rows and the assertions
    // below would be reading last time's answer.
    set(v) { this._text = v; this.children.length = 0; },
  });
  return el;
}

function fakeDom() {
  const byId = {};
  for (const id of PANEL_IDS) {
    const el = mkEl("div");
    el.id = id;
    byId[id] = el;
  }
  const doc = {
    readyState: "complete",
    createElement: mkEl,
    getElementById(id) { return Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : null; },
    addEventListener() {},
  };
  return { doc, byId };
}

// ── the fixture: three real API rows, one per group ─────────────────────────
//
// These are the shape the queue's GET route returns (`pending` / `needsAttention`
// kept separate), so buildList() produces genuine view objects rather than
// hand-written ones that could agree with a wrong panel.

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);

const QUEUE_STATE = {
  ok: true,
  pending: [
    {
      id: "q-running",
      kind: "list",
      platform: "mercari",
      status: "claimed",
      created_at: new Date(NOW - 4 * 60 * 1000).toISOString(),
      payload: { title: "Nike Air Max 90" },
    },
    {
      id: "q-waiting",
      kind: "list",
      platform: "vinted",
      status: "queued",
      created_at: new Date(NOW - 2 * 60 * 1000).toISOString(),
      payload: {},
    },
  ],
  needsAttention: [
    {
      id: "q-failed",
      kind: "revise",
      platform: "poshmark",
      status: "failed",
      created_at: new Date(NOW - 30 * 60 * 1000).toISOString(),
      item_title: "Vintage Levi's 501 denim jacket",
      result: { error: "Poshmark asked for a human check." },
    },
  ],
};

const QUEUE_JOBS = { ok: true, byQueueId: { "q-running": { stage: "filling" } } };

function respond(msg) {
  switch (msg && msg.type) {
    case "GT_PANEL_SUPPORTED": return { supported: true };
    case "GT_GET_CAPABILITIES": return { signedIn: true, email: "seller@example.com" };
    case "GT_QUEUE_STATE": return QUEUE_STATE;
    case "GT_QUEUE_JOBS": return QUEUE_JOBS;
    default: return null;
  }
}

function fakeExt() {
  return {
    runtime: {
      sendMessage(msg) { return Promise.resolve(respond(msg)); },
      getManifest() { return { version: "0.0.0-test" }; },
    },
    tabs: {
      query() { return Promise.resolve([{ id: 1, url: "https://poshmark.com/listing/x" }]); },
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
    },
  };
}

/**
 * Load panel.js and let it render once.
 *
 * panel.js is an IIFE that exports nothing and calls start() on load, so it is
 * driven exactly the way the browser drives it: give it a document, a chrome and
 * a `self` carrying the modules it reads, then let the microtask queue drain.
 * GT_PANEL_ITEM_CARD is deliberately absent so renderItem() returns at its first
 * line: this file is about the queue block and nothing else.
 */
async function renderPanel() {
  const { doc, byId } = fakeDom();
  const self = { GT_QUEUE_VIEW: QUEUE_VIEW };
  new Function("self", "document", "chrome", "browser", PANEL_JS)(
    self, doc, fakeExt(), undefined,
  );
  // Every await in refresh() is on an already-resolved promise, so one macrotask
  // boundary drains the whole chain.
  await new Promise((r) => setTimeout(r, 0));
  return { doc, byId };
}

function spanText(rowEl, className) {
  const hit = rowEl.children.find((c) => c.className === className);
  return hit ? hit.textContent : null;
}

(async function main() {
  const { byId } = await renderPanel();
  const list = byId.queueList;

  const headings = list.children.filter((c) => c.className === "gt-panel-group");
  const rows = list.children.filter((c) => c.className === "gt-panel-row");

  // If this ever reads 0, every assertion below is vacuous and the file is
  // testing nothing. Same reason panel-host.test.cjs checks its host count first.
  assert.strictEqual(rows.length, 3, `expected 3 queue rows, got ${rows.length}`);
  assert.deepStrictEqual(
    headings.map((h) => h.textContent),
    ["Needs you", "Running now", "Waiting"],
    "the three groups, in render order",
  );

  // ── THE ONE THAT FAILED ───────────────────────────────────────────────────
  //
  // Counted rather than asserted one at a time, so the failure message says how
  // much of the queue is blank instead of stopping at the first row.
  const painted = rows.map((r) => ({
    title: spanText(r, "gt-panel-row-title"),
    status: spanText(r, "gt-panel-row-status"),
  }));
  const blank = painted.filter(
    (p) => typeof p.title !== "string" || !p.title.trim() ||
      typeof p.status !== "string" || !p.status.trim(),
  );
  assert.strictEqual(
    blank.length,
    0,
    `${blank.length} of ${rows.length} panel rows rendered a blank title or a ` +
      `blank status: ${JSON.stringify(painted)}`,
  );

  // ── and the words are the right words ─────────────────────────────────────
  //
  // Non-empty is not enough: "Failed" on every row would pass the count above.
  // These are the same two rules popup.js's renderQueueRow and worker.js's row()
  // apply, because three surfaces describing one queue in three vocabularies is
  // the next bug after this one.

  // item_title, joined on by the GET route.
  assert.strictEqual(painted[0].title, "Vintage Levi's 501 denim jacket");
  // A failed row must carry WHY. "Failed" alone is what makes someone uninstall.
  assert.strictEqual(
    painted[0].status,
    "Failed · Update listing · Poshmark · Poshmark asked for a human check.",
  );

  // The payload snapshot the server took at enqueue time.
  assert.strictEqual(painted[1].title, "Nike Air Max 90");
  // US-3050: a running row this browser is driving says what it is DOING, which
  // is the stage, not the state.
  assert.strictEqual(painted[1].status, "Filling the form · Cross-post · Mercari");

  // A `list` job queued from a phone has no title at all. The verb is the honest
  // headline for it, never a blank line and never an invented placeholder.
  assert.strictEqual(painted[2].title, "Cross-post on Vinted");
  assert.strictEqual(painted[2].status, "Waiting · Cross-post · Vinted");

  // ── the row still behaves ────────────────────────────────────────────────
  // Cancel on the QUEUED row only: a claimed row is mid-fill in a marketplace
  // tab and pulling it leaves that tab half done.
  const cancels = rows.map((r) => r.children.filter((c) => c.tagName === "BUTTON").length);
  assert.deepStrictEqual(cancels, [0, 0, 1], "Cancel is offered on the waiting row only");

  console.log("✓ panel-queue-row: 3 rows, every title and status non-empty and correct");

  // ── AC3 regression pin ───────────────────────────────────────────────────
  //
  // The render test above is the real guard. This is the cheap one that names
  // the exact mistake, so a future edit that reaches for the old call gets told
  // what it is reaching for rather than a diff in a string comparison.
  for (const wrong of ["QUEUE_VIEW.titleFor(", "QUEUE_VIEW.statusLine("]) {
    assert.ok(
      !PANEL_JS.includes(wrong),
      `panel.js calls ${wrong}row). Those take an API row and a counts object, ` +
        `not a view. The view already carries .title, .stateLabel and .stageLabel.`,
    );
  }

  // ── AC4: the two functions reject a shape they cannot read ───────────────
  //
  // A silent empty string is how this hid. Both now throw on a view object, so
  // the same mistake is a stack trace on the first render instead of a panel
  // that looks fine and says nothing.
  const view = QUEUE_VIEW.viewRow(QUEUE_STATE.needsAttention[0], { now: NOW });
  assert.ok(view && view.stateLabel, "viewRow must produce a view to test against");
  assert.throws(
    () => QUEUE_VIEW.titleFor(view),
    /view object/i,
    "titleFor must refuse a view object rather than returning null",
  );
  assert.throws(
    () => QUEUE_VIEW.statusLine(view),
    /counts object/i,
    "statusLine must refuse a view object rather than returning an empty string",
  );

  // The shapes each one DOES take still work, including the absent-argument
  // cases both were already written to tolerate.
  assert.strictEqual(QUEUE_VIEW.titleFor(QUEUE_STATE.needsAttention[0]), "Vintage Levi's 501 denim jacket");
  assert.strictEqual(QUEUE_VIEW.titleFor(null), null);
  assert.strictEqual(QUEUE_VIEW.titleFor({ payload: { title: "From the payload" } }), "From the payload");
  assert.strictEqual(QUEUE_VIEW.titleFor({}), null, "a row with no title is still null, not a throw");
  assert.strictEqual(QUEUE_VIEW.statusLine(QUEUE_VIEW.summarize([view])), "1 needs you");
  assert.strictEqual(QUEUE_VIEW.statusLine(null), "");
  assert.strictEqual(QUEUE_VIEW.statusLine(undefined), "");
  assert.strictEqual(
    QUEUE_VIEW.statusLine({ waiting: 0, running: 0, attention: 0, total: 0 }),
    "",
    "an empty queue is still a counts object and still says nothing",
  );

  console.log("✓ panel-queue-row: titleFor and statusLine refuse a view object");
})().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
