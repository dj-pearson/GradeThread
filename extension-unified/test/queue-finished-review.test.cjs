// US-3374: the finished-work list reaches the popup AND the popup renders it.
//
// WHAT THIS FILE IS FOR. The queue's GET route grew a third top-level key in
// US-3370 (`finishedNeedsReview`: finished runs from the last 48 hours that
// left the seller something to do) and background.js has forwarded it ever
// since. queue-view.js's buildList read `pending` and `needsAttention` and
// nothing else, so every one of those rows was dropped on the floor, with no
// error, no blank row, and no count that looked wrong. Three stories of work
// ended one `.concat` short of a screen.
//
// SO ASSERTING THAT THE KEY IS READ IS WORTH NOTHING HERE. A `done` row folded
// into either existing list ALSO reads the key, and both foldings were measured
// and are worse than dropping it:
//
//   into `pending`         it groups under Waiting, carries a stateClass no
//                          stylesheet answers, and counts as `waiting: 1`,
//                          which switches on "Run it now" for a queue with
//                          nothing left to run.
//   into `needsAttention`  the web renders that list under "Didn't run" with
//                          "Nothing happened on the marketplace, do it there
//                          yourself, or queue it again". In front of a run that
//                          DID happen, that sentence talks a seller into a
//                          second listing.
//
// So this file drives a real three-key payload through buildList and asserts
// the group, the label, the four counts and which buttons the row offers, and
// then renders the same payload through the two surfaces that can be executed
// with no browser, because US-3371 found the side panel had been painting blank
// rows since US-3062 and nothing in the suite could see it.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(dir, ...p), "utf8").replace(/\r\n/g, "\n");

const scope = {};
new Function("self", read("queue", "queue-view.js"))(scope);
const V = scope.GT_QUEUE_VIEW;
assert.ok(V, "queue/queue-view.js must assign self.GT_QUEUE_VIEW");

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const MIN = 60 * 1000;

// ── the fixture ────────────────────────────────────────────────────────────
//
// The shape GET /api/flipdesk/extension-queue returns: three lists, kept apart
// on the wire precisely so a client cannot render one as another. The finished
// rows are the four causes finishedNeedsReview() qualifies on
// (services/edge-functions/src/routes/flipdesk-extension-queue.ts:152): a
// refused witness, a partial photo failure, a hand-back and an unconfirmed
// save. A fixture with one shape in it pins one arm of four.

const QUEUE_STATE = {
  ok: true,
  pending: [
    {
      id: "q-running",
      kind: "list",
      platform: "mercari",
      status: "claimed",
      created_at: new Date(NOW - 4 * MIN).toISOString(),
      payload: { title: "Nike Air Max 90" },
    },
    {
      id: "q-waiting",
      kind: "list",
      platform: "vinted",
      status: "queued",
      created_at: new Date(NOW - 2 * MIN).toISOString(),
      payload: {},
    },
  ],
  needsAttention: [
    {
      id: "q-failed",
      kind: "revise",
      platform: "poshmark",
      status: "failed",
      created_at: new Date(NOW - 30 * MIN).toISOString(),
      item_title: "Vintage Levi's 501 denim jacket",
      result: { error: "Poshmark asked for a human check." },
    },
  ],
  finishedNeedsReview: [
    {
      // The one the chain was built for: the uploader took the file list and
      // rendered nothing out of it. The listing is live with no images on it.
      id: "f-refused",
      kind: "list",
      platform: "poshmark",
      status: "done",
      created_at: new Date(NOW - 90 * MIN).toISOString(),
      completed_at: new Date(NOW - 88 * MIN).toISOString(),
      item_title: "Carhartt Detroit jacket",
      payload: {},
      result: {
        photosWitness: "none",
        photosTotal: 8,
        photosFailed: 8,
        listingUrl: "https://poshmark.com/listing/carhartt-detroit-abc123",
      },
    },
    {
      // Some went in, some did not, and the page confirmed what did.
      id: "f-partial",
      kind: "list",
      platform: "mercari",
      status: "done",
      created_at: new Date(NOW - 70 * MIN).toISOString(),
      completed_at: new Date(NOW - 69 * MIN).toISOString(),
      item_title: "Patagonia Synchilla fleece",
      payload: {},
      result: {
        photosWitness: "page",
        photosTotal: 6,
        photosFailed: 2,
        listingUrl: "https://www.mercari.com/us/item/m99887766/",
      },
    },
    {
      // The flow gave up part way and handed the rest back.
      id: "f-manual",
      kind: "list",
      platform: "grailed",
      status: "done",
      created_at: new Date(NOW - 50 * MIN).toISOString(),
      completed_at: new Date(NOW - 49 * MIN).toISOString(),
      item_title: "Needles track pant",
      payload: {},
      result: { manual: true, listingUrl: "https://www.grailed.com/listings/55512345" },
    },
    {
      // Saved, and nothing proved it took, and no URL came back, which is the
      // branch where the link must NOT be drawn.
      id: "f-unverified",
      kind: "revise",
      platform: "vinted",
      status: "done",
      created_at: new Date(NOW - 20 * MIN).toISOString(),
      completed_at: new Date(NOW - 19 * MIN).toISOString(),
      item_title: "Acne Studios scarf",
      payload: {},
      result: { unverified: true },
    },
  ],
};

const QUEUE_JOBS = { ok: true, byQueueId: { "q-running": { stage: "filling" } } };

const rows = V.buildList(QUEUE_STATE, { now: NOW, stages: QUEUE_JOBS.byQueueId });
const byId = {};
for (const r of rows) byId[r.id] = r;

// ── 1. AC1: the rows arrive at all ─────────────────────────────────────────
//
// If this reads 3, buildList is back to two concats and every assertion below
// is vacuous. It is first for that reason.
{
  assert.strictEqual(
    rows.length,
    7,
    `buildList dropped rows: expected 7, got ${rows.length}. ` +
      "finishedNeedsReview is the third list on the wire and has to be concatenated.",
  );
  for (const id of ["f-refused", "f-partial", "f-manual", "f-unverified"]) {
    assert.ok(byId[id], `${id} never reached the view list`);
    assert.strictEqual(byId[id].state, "done");
    assert.strictEqual(byId[id].finished, true);
  }
}

// ── 2. AC1: a group of their own, with a heading that names what they are ──
{
  const groups = V.groupRows(rows);
  assert.deepStrictEqual(
    groups.map((g) => g.key),
    ["attention", "review", "running", "waiting"],
    "the finished group renders second: the top two groups are work a human " +
      "has to do, the bottom two are progress",
  );
  assert.deepStrictEqual(groups.map((g) => g.rows.length), [1, 4, 1, 1]);

  const review = groups[1];
  assert.strictEqual(
    review.label,
    "Ran, check the listing",
    "the heading has to say the two things that separate this group: it " +
      "happened, and the rest of the work is on the marketplace",
  );
  // The two headings it must never be, stated as their own assertion so a
  // rename that reaches for either one fails with the reason attached.
  assert.notStrictEqual(review.label, "Waiting");
  assert.notStrictEqual(review.label, "Needs you");
  assert.deepStrictEqual(
    review.rows.map((r) => r.id),
    ["f-refused", "f-partial", "f-manual", "f-unverified"],
    "oldest first inside the group, the same order every other group uses",
  );

  // And nothing leaked sideways.
  assert.deepStrictEqual(groups[0].rows.map((r) => r.id), ["q-failed"]);
  assert.deepStrictEqual(groups[2].rows.map((r) => r.id), ["q-running"]);
  assert.deepStrictEqual(groups[3].rows.map((r) => r.id), ["q-waiting"]);

  // The badge, and a class that a stylesheet actually answers. Exactly three
  // .pop-status modifiers exist (popup.css): on, warn, off. A `done` row fed
  // through the old code came out with stateClass "done" and no rule for it.
  const css = read("popup.css");
  for (const r of review.rows) {
    assert.strictEqual(r.stateLabel, "Ran");
    assert.strictEqual(r.stateClass, "warn");
    assert.ok(
      css.includes(".pop-status." + r.stateClass + " {"),
      `popup.css has no rule for .pop-status.${r.stateClass}`,
    );
  }
  assert.ok(
    css.includes('.pop-qgroup[data-group="review"]'),
    "the new group heading needs a rule of its own; it inherits the muted " +
      "colour otherwise and reads as a divider",
  );
}

// ── 3. AC2: a finished row counts toward neither total that drives an action ─
{
  const counts = V.summarize(rows);
  assert.deepStrictEqual(
    counts,
    { waiting: 1, running: 1, attention: 1, review: 4, total: 7 },
    "four finished rows, and not one of them in waiting or attention",
  );

  // Said again as the two claims that matter, because a deepStrictEqual that
  // someone updates to match new behaviour stops being a guard.
  const onlyFinished = V.summarize(
    V.buildList({ finishedNeedsReview: QUEUE_STATE.finishedNeedsReview }, { now: NOW }),
  );
  assert.strictEqual(
    onlyFinished.waiting,
    0,
    'a queue of nothing but finished rows must not switch on "Run it now": ' +
      "popup.js hides it on counts.waiting < 1 and there is nothing to run",
  );
  assert.strictEqual(
    onlyFinished.attention,
    0,
    'popup.js labels that count "Clear N failed", and these did not fail',
  );
  assert.strictEqual(onlyFinished.running, 0);
  assert.strictEqual(onlyFinished.review, 4);
  assert.strictEqual(
    onlyFinished.total,
    4,
    "the nav badge DOES see them: they want a human, and a badge that cannot " +
      "see them is the silence this feature exists to end",
  );

  // The line under the header says it in the past tense, which is the whole
  // distinction, and never as one of the other three.
  assert.strictEqual(V.statusLine(onlyFinished), "4 ran with problems");
  assert.strictEqual(
    V.statusLine({ waiting: 0, running: 0, attention: 0, review: 1 }),
    "1 ran with a problem",
  );
  assert.strictEqual(
    V.statusLine(counts),
    "1 running now · 1 waiting · 1 needs you · 4 ran with problems",
  );
}

// ── 4. AC3: the action that helps, and not the two that do not ─────────────
//
// RETRY IS THE ONE THAT CANNOT HELP, and the sentence saying why has been in
// this codebase since US-3367: running it again hands the same uploader the
// same list and gets the same nothing. It is also worse than useless on a
// finished row, because it queues a second cross-post against a marketplace
// that already took the first.
//
// CANCEL IS MEANINGLESS: there is nothing left to stop.
//
// DISMISS SURVIVES BUT CHANGES MEANING. On a failed row it throws away an
// instruction that never ran. On a finished row the listing is live and DELETE
// /:id removes the notice only, so the word changes with it: a seller who reads
// "Dismiss" on a live listing can reasonably think it undoes the listing.
{
  for (const id of ["f-refused", "f-partial", "f-manual", "f-unverified"]) {
    const r = byId[id];
    assert.strictEqual(r.canRetry, false, `${id} must not offer Retry`);
    assert.strictEqual(V.retryBody(r), null, `${id} must not produce a retry body`);
    assert.strictEqual(r.canCancel, false, `${id} has nothing left to cancel`);
    assert.strictEqual(r.canDismiss, true, `${id} must be clearable`);
    assert.strictEqual(r.dismissLabel, "Clear");
    assert.ok(
      /clears the notice only/i.test(r.dismissHint),
      `${id} needs a hint that says the listing stays up: ${r.dismissHint}`,
    );
    assert.ok(
      r.dismissHint.includes(r.platformLabel),
      "the hint names the marketplace the listing is on",
    );
    // And it is NOT laundered into the flag that carries Retry and the
    // "never reached the marketplace" wording everywhere it is read.
    assert.strictEqual(r.needsAttention, false, `${id} must not set needsAttention`);
  }

  // A failed row keeps the old word and the old meaning, unchanged.
  assert.strictEqual(byId["q-failed"].dismissLabel, "Dismiss");
  assert.strictEqual(byId["q-failed"].dismissHint, null);
  assert.strictEqual(byId["q-failed"].canRetry, true);

  // The link is the action that helps, and it comes off the RESULT for a
  // `list` job: the listing did not exist when the row was queued, so the
  // payload has no URL and only the completed run knows it.
  assert.strictEqual(
    byId["f-refused"].listingUrl,
    "https://poshmark.com/listing/carhartt-detroit-abc123",
  );
  assert.strictEqual(byId["f-manual"].listingUrl, "https://www.grailed.com/listings/55512345");
  assert.strictEqual(
    byId["f-unverified"].listingUrl,
    null,
    "no URL came back, so there is no link to draw",
  );
  // The https-only rule still holds on the new source.
  for (const bad of ["http://poshmark.com/x", "javascript:alert(1)", "data:text/html,x", 7, null]) {
    const v = V.viewRow(
      Object.assign({}, QUEUE_STATE.finishedNeedsReview[0], {
        result: { manual: true, listingUrl: bad },
      }),
      { now: NOW },
    );
    assert.strictEqual(v.listingUrl, null, `a result listingUrl of ${String(bad)} must be refused`);
  }
  // The payload copy still wins when a row has both: that is the listing the
  // seller asked about, and the result's is whatever the run ended up on.
  const both = V.viewRow(
    Object.assign({}, QUEUE_STATE.finishedNeedsReview[0], {
      payload: { listingUrl: "https://poshmark.com/listing/from-payload" },
      result: { manual: true, listingUrl: "https://poshmark.com/listing/from-result" },
    }),
    { now: NOW },
  );
  assert.strictEqual(both.listingUrl, "https://poshmark.com/listing/from-payload");
}

// ── 5. every finished row says something, and says the right thing ─────────
//
// A row that renders a state badge and no words is the blank row US-3371 spent
// a story finding. `reason` and `photoNote` are the only two places words can
// come from, so every finished row has to carry at least one.
{
  for (const id of ["f-refused", "f-partial", "f-manual", "f-unverified"]) {
    const r = byId[id];
    const words = [r.reason, r.photoAlert ? r.photoNote : null].filter(Boolean);
    assert.ok(words.length > 0, `${id} rendered no words at all`);
    for (const w of words) {
      // The two sentences that are true of work which never ran and false of
      // every row in this group. Either one here is the duplicate-listing bug.
      assert.ok(
        !/queue it again/i.test(w),
        `${id} tells the seller to queue it again, and it already ran: ${w}`,
      );
      assert.ok(!/never ran|did not run|didn't run/i.test(w), `${id}: ${w}`);
    }
  }

  // The refusal keeps US-3367's sentence and does NOT get a second, nearly
  // identical line about the same eight photos.
  const refused = byId["f-refused"];
  assert.strictEqual(refused.photoState, "refused");
  assert.strictEqual(refused.photoAlert, true);
  assert.strictEqual(refused.photoNote, V.photoNoteFor("refused", "Poshmark"));
  assert.strictEqual(
    refused.reason,
    null,
    "photoNote already says the photos are not on the listing; a photosFailed " +
      "count beside it is the same run described twice",
  );

  // A partial failure is a count, and the fix is on the marketplace.
  const partial = byId["f-partial"];
  assert.strictEqual(partial.photoAlert, false, "the page DID preview what it took");
  assert.strictEqual(
    partial.reason,
    "2 photos did not go in. The listing is on Mercari already, so add them " +
      "there rather than running this again.",
  );
  assert.strictEqual(
    V.finishedReasonFor({ result: { photosFailed: 1 } }, "Vinted"),
    "One photo did not go in. The listing is on Vinted already, so add them " +
      "there rather than running this again.",
  );

  assert.strictEqual(
    byId["f-manual"].reason,
    "GradeThread filled what it could and handed the rest back. Open the " +
      "listing on Grailed and finish it there.",
  );
  assert.strictEqual(
    byId["f-unverified"].reason,
    "We clicked save and Vinted never confirmed it took. Open the listing " +
      "there and check it before you count this one as posted.",
  );

  // The flow's own words win when it had any, verbatim.
  const spoke = V.viewRow(
    Object.assign({}, QUEUE_STATE.finishedNeedsReview[2], {
      result: { manual: true, error: "Grailed saved a draft and never published it." },
    }),
    { now: NOW },
  );
  assert.strictEqual(spoke.reason, "Grailed saved a draft and never published it.");

  // A finished row with nothing to say gets null rather than an invented
  // sentence. The edge does not send these, and a client that invents a reason
  // for one would be inventing it for every future result shape too.
  assert.strictEqual(V.finishedReasonFor({ result: null }, "Poshmark"), null);
  assert.strictEqual(V.finishedReasonFor({ result: { error: "   " } }, "Poshmark"), null);
  assert.strictEqual(V.finishedReasonFor({}, "Poshmark"), null);
  // And a queued row never borrows the finished vocabulary.
  assert.strictEqual(
    V.viewRow(
      { id: "x", kind: "list", platform: "poshmark", status: "queued", result: { manual: true } },
      { now: NOW },
    ).reason,
    null,
  );
}

// ── 6. AC5: the popup renders it ───────────────────────────────────────────
//
// popup.js is 2,500 lines of markup and clicks and nobody executes it, so the
// two functions that decide what a queue row looks like are lifted out of the
// SHIPPED source and run against a hand-rolled DOM. Lifting rather than
// copying is the point: a fixture copy of these rules would pass while the
// shipped ones were wrong, which is exactly how the panel stayed blank for
// nine stories.

/**
 * A top-level (column 0) function's source, lifted whole.
 *
 * `async` is picked up deliberately. Dropping it makes the lifted copy throw
 * "await is only valid in async functions" at construction, loudly, which is
 * the good failure, but a function that lost it and had no `await` would run
 * as a DIFFERENT function than the one that ships.
 */
function topLevelFn(src, name) {
  let start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, `could not find function ${name}`);
  if (src.slice(start - 6, start) === "async ") start -= 6;
  const end = src.indexOf("\n}\n", start);
  assert.ok(end > start, `could not find the end of function ${name}`);
  return src.slice(start, end + 2);
}

/** The same, for a function indented inside an IIFE. */
function nestedFn(src, name) {
  const start = src.indexOf("  function " + name + "(");
  assert.ok(start >= 0, `could not find nested function ${name}`);
  const end = src.indexOf("\n  }\n", start);
  assert.ok(end > start, `could not find the end of nested function ${name}`);
  return src.slice(start, end + 4);
}

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
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
  };
  Object.defineProperty(el, "textContent", {
    enumerable: true,
    get() { return this._text; },
    set(v) { this._text = v; this.children.length = 0; },
  });
  return el;
}

function fakeDoc(ids) {
  const map = {};
  for (const id of ids) {
    const el = mkEl("div");
    el.id = id;
    map[id] = el;
  }
  return {
    byId: map,
    doc: {
      createElement: mkEl,
      getElementById(id) {
        return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : null;
      },
    },
  };
}

/** Depth-first text of a node and everything under it. */
function allText(node) {
  const out = [];
  (function walk(n) {
    if (n._text) out.push(n._text);
    for (const c of n.children) walk(c);
  })(node);
  return out;
}

(async function main() {
  const POPUP_JS = read("popup.js");
  const POPUP_IDS = [
    "queueBlock", "queueList", "queueNote", "queueStatus", "queueRunNow",
    "queueRetryAll", "queueClearFailed", "queueCancelAll",
  ];
  const { doc, byId: el } = fakeDoc(POPUP_IDS);

  const harness = [
    "var workCounts = { delist: 0, queue: 0, revise: 0 };",
    "var queueRows = [];",
    "var DELIST_REASON = { error: 'err' };",
    "var PLATFORM_LABELS = QUEUE_VIEW.PLATFORM_LABELS;",
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
    "return { renderQueue: renderQueue, workCounts: workCounts };",
  ].join("\n");

  const popup = new Function("document", "QUEUE_VIEW", "STATE", "JOBS", harness)(
    doc, V, QUEUE_STATE, QUEUE_JOBS,
  );
  await popup.renderQueue({ sellerEnabled: true });

  const list = el.queueList;
  const heads = list.children.filter((c) => c.className === "pop-qgroup");
  assert.deepStrictEqual(
    heads.map((h) => h.dataset.group),
    ["attention", "review", "running", "waiting"],
    "the popup drew four group headings",
  );
  assert.deepStrictEqual(
    heads.map((h) => allText(h).join("")),
    ["Needs you · 1", "Ran, check the listing · 4", "Running now · 1", "Waiting · 1"],
  );

  // "Run it now" stays off. This is AC2 measured where it costs: the button is
  // hidden on counts.waiting < 1, and four finished rows falling through to
  // `waiting` would put it back on a queue with one real job in it.
  assert.strictEqual(el.queueRunNow.hidden, false, "one row really is waiting");
  assert.strictEqual(el.queueRunNow.textContent, "Run it now");
  assert.strictEqual(
    el.queueClearFailed.textContent,
    "Clear 1 failed",
    "the failed count is the attention count and does not pick up the four " +
      "finished rows, whose button says Clear but does not say failed",
  );
  assert.strictEqual(el.queueCancelAll.hidden, true, "one waiting row is not two");
  assert.strictEqual(el.queueStatus.textContent, V.statusLine(V.summarize(rows)));
  assert.strictEqual(popup.workCounts.queue, 7, "the nav badge counts all seven");

  // The note has to contradict itself out loud: some of these ran and some did
  // not, and the sentence for each group has to be attached to that group.
  const note = el.queueNote.textContent;
  assert.ok(/never reached the marketplace/.test(note), note);
  assert.ok(/Ran, check the listing did reach it/.test(note), note);
  assert.ok(/makes a second listing/.test(note), note);

  // The rows themselves. The finished ones are the four between the review
  // heading and the running heading.
  const reviewStart = list.children.indexOf(heads[1]);
  const runningStart = list.children.indexOf(heads[2]);
  const block = list.children.slice(reviewStart + 1, runningStart);
  const finishedRows = block.filter((c) => /^pop-delist( |$)/.test(c.className));
  assert.strictEqual(finishedRows.length, 4, "four finished rows rendered");
  for (const r of finishedRows) {
    assert.ok(
      !/is-attention/.test(r.className),
      "a finished row must not take the failure tint: nothing failed",
    );
  }

  const blockText = block.map((c) => allText(c).join(" ")).join("\n");
  assert.ok(/Carhartt Detroit jacket/.test(blockText), "the finished rows are named");
  assert.ok(/\bRan\b/.test(blockText), "the badge says Ran");
  assert.ok(
    /never showed the photos it was handed/.test(blockText),
    "US-3367's sentence reaches the popup on a finished row",
  );
  assert.ok(/2 photos did not go in/.test(blockText));
  assert.ok(/handed the rest back/.test(blockText));
  assert.ok(/never confirmed it took/.test(blockText));

  // Buttons and links, read off the rendered nodes rather than off the view.
  const controls = block.flatMap((c) =>
    c.children.flatMap((g) => g.children.filter((n) => n.tagName === "A" || n.tagName === "BUTTON")),
  );
  const labels = controls.map((n) => n.tagName + ":" + n.textContent);
  assert.deepStrictEqual(
    labels,
    [
      "A:Open the listing", "BUTTON:Clear",
      "A:Open the listing", "BUTTON:Clear",
      "A:Open the listing", "BUTTON:Clear",
      "BUTTON:Clear",
    ],
    "three rows carry a listing URL and every row carries Clear; no Retry and " +
      "no Cancel appears anywhere in the finished group",
  );
  for (const a of controls.filter((n) => n.tagName === "A")) {
    assert.ok(/^https:\/\//.test(a.href), "the link is https, or it is not drawn");
    assert.strictEqual(a.rel, "noopener noreferrer");
    assert.strictEqual(a.target, "_blank");
  }
  for (const b of controls.filter((n) => n.tagName === "BUTTON")) {
    assert.ok(/clears the notice only/i.test(b.title), `Clear needs its hint: ${b.title}`);
  }

  // And the reason line under a finished row does not wear the failure colour.
  const whys = block.filter((c) => /pop-delist-why/.test(c.className));
  assert.ok(whys.length >= 4, `expected a line under every finished row, got ${whys.length}`);
  for (const w of whys) {
    assert.ok(
      /is-review/.test(w.className),
      "a finished row's note takes the warn tint, not the failure tint",
    );
  }
  assert.ok(
    read("popup.css").includes(".pop-delist-why.is-review"),
    "popup.css needs the rule that class names",
  );

  // ── AC2, measured where it costs ────────────────────────────────────────
  //
  // A queue holding nothing but finished rows. There is no work left to run,
  // so the button that starts work must not be on the screen, and neither must
  // the two bulk controls that act on rows this one has none of. Counting is
  // one claim; this is the rendered one, and it is the one the seller sees.
  const onlyFinishedDom = fakeDoc(POPUP_IDS);
  const onlyFinishedPopup = new Function(
    "document", "QUEUE_VIEW", "STATE", "JOBS", harness,
  )(
    onlyFinishedDom.doc,
    V,
    { ok: true, pending: [], needsAttention: [], finishedNeedsReview: QUEUE_STATE.finishedNeedsReview },
    { ok: true, byQueueId: {} },
  );
  await onlyFinishedPopup.renderQueue({ sellerEnabled: true });
  const q = onlyFinishedDom.byId;
  assert.strictEqual(q.queueBlock.hidden, false, "four rows is not an empty queue");
  assert.strictEqual(
    q.queueRunNow.hidden,
    true,
    '"Run these now" must stay off: every row already ran, and a click would ' +
      "start nothing",
  );
  assert.strictEqual(q.queueCancelAll.hidden, true, "there is nothing to cancel");
  assert.strictEqual(q.queueClearFailed.hidden, true, "nothing failed");
  assert.strictEqual(q.queueRetryAll.hidden, true, "nothing is retryable");
  assert.strictEqual(q.queueStatus.textContent, "4 ran with problems");
  assert.ok(
    !/never reached the marketplace/.test(q.queueNote.textContent),
    "the note must not carry the didn't-run sentence: " + q.queueNote.textContent,
  );
  assert.ok(/makes a second listing/.test(q.queueNote.textContent));
  assert.strictEqual(onlyFinishedPopup.workCounts.queue, 4, "the badge still sees them");

  console.log(
    "✓ queue-finished-review: the popup draws four groups, 4 finished rows, " +
      "Open + Clear and no Retry, and a finished-only queue offers no Run",
  );

  // ── 7. AC5: the side panel renders it ───────────────────────────────────
  //
  // The surface US-3371 found blank. Driven whole, the way panel-queue-row
  // drives it, because its rows read every string off the view and a missing
  // field there is an empty span rather than an error.
  const PANEL_IDS = [
    "queueList", "queueEmpty", "headAcct", "headAcctLabel", "offHostSection",
    "itemSection", "queueSection", "itemCard", "itemEmpty", "queueRunNow",
    "queueRefresh", "panelVer",
  ];
  const panelDom = fakeDoc(PANEL_IDS);
  panelDom.doc.readyState = "complete";
  panelDom.doc.addEventListener = function () {};
  const panelExt = {
    runtime: {
      sendMessage(msg) {
        switch (msg && msg.type) {
          case "GT_PANEL_SUPPORTED": return Promise.resolve({ supported: true });
          case "GT_GET_CAPABILITIES":
            return Promise.resolve({ signedIn: true, email: "seller@example.com" });
          case "GT_QUEUE_STATE": return Promise.resolve(QUEUE_STATE);
          case "GT_QUEUE_JOBS": return Promise.resolve(QUEUE_JOBS);
          default: return Promise.resolve(null);
        }
      },
      getManifest() { return { version: "0.0.0-test" }; },
    },
    tabs: {
      query() { return Promise.resolve([{ id: 1, url: "https://poshmark.com/listing/x" }]); },
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
    },
  };
  new Function("self", "document", "chrome", "browser", read("panel", "panel.js"))(
    { GT_QUEUE_VIEW: V }, panelDom.doc, panelExt, undefined,
  );
  await new Promise((r) => setTimeout(r, 0));

  const panelList = panelDom.byId.queueList;
  const panelHeads = panelList.children.filter((c) => c.className === "gt-panel-group");
  const panelRows = panelList.children.filter((c) => c.className === "gt-panel-row");
  assert.deepStrictEqual(
    panelHeads.map((h) => h.textContent),
    ["Needs you", "Ran, check the listing", "Running now", "Waiting"],
    "the panel draws the new heading from GROUP_LABELS, the same source the popup uses",
  );
  assert.strictEqual(panelRows.length, 7, `expected 7 panel rows, got ${panelRows.length}`);

  const panelStatus = panelRows.map((r) => {
    const hit = r.children.find((c) => c.className === "gt-panel-row-status");
    return hit ? hit.textContent : null;
  });
  for (const s of panelStatus) {
    assert.ok(typeof s === "string" && s.trim(), `a panel row painted a blank status: ${s}`);
  }
  // Rows 1-4 are the finished ones (attention first, then review).
  assert.strictEqual(
    panelStatus[1],
    "Ran · Cross-post · Poshmark · " + V.photoNoteFor("refused", "Poshmark"),
    "the photo refusal reaches the panel; it is the ONLY words this row has, " +
      "and the panel rendered `reason` alone until US-3374",
  );
  assert.ok(/^Ran · Cross-post · Mercari · 2 photos did not go in/.test(panelStatus[2]));
  assert.ok(/^Ran · Cross-post · Grailed · GradeThread filled what it could/.test(panelStatus[3]));
  assert.ok(/^Ran · Update listing · Vinted · We clicked save/.test(panelStatus[4]));

  const panelControls = panelRows.map((r) =>
    r.children.filter((c) => c.tagName === "A" || c.tagName === "BUTTON")
      .map((c) => c.tagName + ":" + c.textContent),
  );
  assert.deepStrictEqual(
    panelControls,
    [
      [],
      ["A:Open the listing"],
      ["A:Open the listing"],
      ["A:Open the listing"],
      [],
      [],
      ["BUTTON:Cancel"],
    ],
    "the panel offers the listing link on the finished rows that have a URL, " +
      "and Cancel is still the queued row's alone",
  );

  console.log("✓ queue-finished-review: the side panel draws the group, the words and the link");

  // ── 8. AC5: the worker tab renders it ───────────────────────────────────
  //
  // The pinned drain tab. It offers no action on any row: not Cancel, not
  // Retry. US-3374 does not make it the first; it is a status board and
  // the actions live in the popup and the panel. What it MUST do is draw the
  // group and carry the words, and its row() reads `reason` the same way the
  // panel's did.
  const WORKER_JS = read("worker.js");
  const workerDom = fakeDoc(["queueList", "empty"]);
  const workerHarness = [
    "function el(id) { return document.getElementById(id); }",
    nestedFn(WORKER_JS, "row"),
    nestedFn(WORKER_JS, "renderQueue"),
    "return { renderQueue: renderQueue };",
  ].join("\n");
  const worker = new Function("document", "QUEUE_VIEW", workerHarness)(workerDom.doc, V);
  worker.renderQueue(QUEUE_STATE, QUEUE_JOBS.byQueueId);

  const wList = workerDom.byId.queueList;
  const wHeads = wList.children.filter((c) => c.className === "pop-delist-group");
  assert.deepStrictEqual(
    wHeads.map((h) => h.textContent),
    ["Needs you", "Ran, check the listing", "Running now", "Waiting"],
  );
  const wRows = wList.children.filter((c) => /^pop-delist( |$)/.test(c.className));
  assert.strictEqual(wRows.length, 7, `expected 7 worker rows, got ${wRows.length}`);
  assert.strictEqual(workerDom.byId.empty.hidden, true);

  const wText = wRows.map((r) => allText(r).join(" | "));
  assert.ok(/\bRan\b/.test(wText[1]), `the worker badge says Ran: ${wText[1]}`);
  assert.ok(
    /never showed the photos it was handed/.test(wText[1]),
    `the photo refusal reaches the worker tab: ${wText[1]}`,
  );
  assert.ok(/2 photos did not go in/.test(wText[2]));
  assert.ok(/handed the rest back/.test(wText[3]));
  assert.ok(/never confirmed it took/.test(wText[4]));
  for (const r of wRows.slice(1, 5)) {
    assert.ok(!/is-attention/.test(r.className), "a finished row is not tinted as a failure");
  }

  console.log("✓ queue-finished-review: the worker tab draws the group and the words");
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
