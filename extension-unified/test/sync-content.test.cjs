// GradeThread sold-sync — the reader's THREE REFUSALS, executed (US-2717).
//
// WHY THIS FILE EXISTS. sync/poll-plan.js already proves that applyPollResult
// stops a channel when it is handed `{ humanCheck: true }`, and sync-poll.test
// asserts it in as many words. Nothing proved anybody ever hands it one. They
// did not: sync/content.js returned on a human check before it reported
// anything, so RULE 5 — the rule that stops GradeThread reopening a page a
// marketplace has challenged — had nothing to fire on, and the poll would open
// the same challenged closet every interval.
//
// A pure-function test cannot catch that, and neither can a source scan for a
// string. So this one RUNS the content script against a fake page and asserts
// what came out of it.
//
// The DOM here is a stub, not a browser: `querySelector` looks the literal
// selector string up in a table the test seeds. That is enough, because the
// script only ever asks with strings that came out of sync/selectors.js, and it
// keeps the assertions about the reader's decisions rather than about a parser.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const dir = path.resolve(__dirname, "..");
const CONTENT_SRC = fs.readFileSync(path.join(dir, "sync/content.js"), "utf8");
const OBSERVE_SRC = fs.readFileSync(path.join(dir, "sync/observe.js"), "utf8");
const BACKGROUND_SRC = fs.readFileSync(path.join(dir, "background.js"), "utf8");

/** A page: `hits` maps a selector string to the element(s) it finds. */
function makeDocument(hits) {
  const get = (sel) => (Object.prototype.hasOwnProperty.call(hits, sel) ? hits[sel] : []);
  const doc = {
    body: {},
    querySelector: (sel) => get(sel)[0] || null,
    querySelectorAll: (sel) => get(sel),
  };
  return doc;
}

/**
 * Run sync/content.js on a fake page and return every message it sent.
 *
 * `selectors` is passed in rather than read from sync/selectors.js on purpose:
 * the shipped adapters are `enabled: false` until a human verifies them against
 * a live page, and a test that flipped that flag would be asserting against a
 * config nobody has checked.
 */
function runContent({ href, hits, selectors }) {
  const sent = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    RegExp,
    Array,
    Object,
    Boolean,
    String,
    JSON,
    MutationObserver: function () {
      return { observe() {} };
    },
    location: new URL(href),
    document: makeDocument(hits),
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.chrome = {
    runtime: {
      sendMessage: (msg) => {
        sent.push(msg);
        return Promise.resolve({ ok: true });
      },
      onMessage: { addListener() {} },
    },
  };
  // `location` is a URL, which carries hostname/href — the two the script reads.
  vm.createContext(sandbox);
  vm.runInContext(OBSERVE_SRC, sandbox);
  sandbox.GT_SYNC_SELECTORS = selectors;
  vm.runInContext(CONTENT_SRC, sandbox);
  return sent;
}

/** One adapter, enabled, with selector strings this test can seed hits for. */
const ADAPTER = {
  poshmark: {
    enabled: true,
    hosts: ["poshmark.com"],
    login: { urlPattern: "poshmark\\.com/(login|signup)" },
    humanCheck: "#captcha",
    sold: {
      urlPattern: "poshmark\\.com/order/sales",
      pollUrl: "https://poshmark.com/order/sales",
      row: ".order-row",
      fields: {
        listingUrl: "a.listing",
        title: ".title",
        priceText: ".price",
        dateText: ".date",
        orderRef: ".ref",
      },
      pagination: {},
    },
    closet: {
      urlPattern: "poshmark\\.com/closet/",
      tile: ".tile",
      ownClosetTell: "#mine",
      soldBadge: ".sold",
      fields: { listingUrl: "a.listing" },
      pagination: {},
    },
  },
};

/** A sold row element, as the stub DOM sees it. */
function soldRow({ url, title, price, date, ref }) {
  const hits = {
    "a.listing": url ? [{ href: url }] : [],
    ".title": title ? [{ textContent: title }] : [],
    ".price": price ? [{ textContent: price }] : [],
    ".date": date ? [{ textContent: date }] : [],
    ".ref": ref ? [{ textContent: ref }] : [],
  };
  const el = makeDocument(hits);
  return el;
}

// ── 1. A human check STOPS the read AND says so ────────────────────────────
//
// The saying-so is the half that was missing. Without a message the worker
// never calls applyPollResult, `stoppedForHumanCheck` is never set, and the
// scheduled poll reopens the challenged page on its next tick — repeatedly
// driving traffic at a marketplace that has just asked whether a person is
// there, which is the single most account-threatening thing this feature does.
{
  const sent = runContent({
    href: "https://poshmark.com/order/sales",
    hits: {
      "#captcha": [{}],
      ".order-row": [soldRow({ url: "https://poshmark.com/listing/a-1", ref: "ORDER-1" })],
    },
    selectors: ADAPTER,
  });

  const types = sent.map((m) => m.type);
  assert.ok(
    types.includes("GT_SYNC_HUMAN_CHECK"),
    "a human check was found and NOTHING was reported — the scheduled poll's " +
      "RULE 5 can only stop a channel it is told about, so this silence means " +
      "GradeThread reopens a challenged page every interval",
  );
  assert.ok(
    !types.includes("GT_SYNC_OBSERVE"),
    "a human check must read no rows: the page behind a challenge is not the " +
      "seller's Sold list, and reporting it as one is how an empty read becomes " +
      "an empty closet",
  );
  const note = sent.find((m) => m.type === "GT_SYNC_HUMAN_CHECK");
  assert.strictEqual(
    note.platform,
    "poshmark",
    "the human-check report must name its channel — the worker stops ONE " +
      "channel, not the feature",
  );
  // It carries no page content. Nothing was read, and a challenge page is the
  // last place to start collecting from.
  assert.deepStrictEqual(
    Object.keys(note).sort(),
    ["platform", "type"],
    "the human-check report may carry nothing but its type and its channel",
  );
}

// ── 2. A login wall reports not-signed-in, and reads no rows ───────────────
//
// RULE 4's input, asserted the same way and for the same reason: the six-hour
// backoff exists so a logged-out seller is not visited every 45 minutes to hit
// the same wall, and it can only run on a report that arrives.
{
  const sent = runContent({
    href: "https://poshmark.com/order/sales",
    hits: {
      'input[type="password"]': [{}],
      ".order-row": [soldRow({ url: "https://poshmark.com/listing/a-1", ref: "ORDER-1" })],
    },
    selectors: ADAPTER,
  });

  const batch = sent.find((m) => m.type === "GT_SYNC_OBSERVE");
  assert.ok(batch, "a login wall must still REPORT — silence is not a backoff");
  assert.strictEqual(batch.batch.signedIn, false);
  // Length, not deepStrictEqual: the batch is built inside the VM realm, so its
  // Array has a different prototype than this file's.
  assert.strictEqual(
    batch.batch.sold.length,
    0,
    "a login page's rows are not sold rows",
  );
  assert.strictEqual(batch.batch.closet, null);
}

// ── 3. A clean Sold page reports the rows, and only the six fields ─────────
{
  const sent = runContent({
    href: "https://poshmark.com/order/sales",
    hits: {
      ".order-row": [
        soldRow({
          url: "https://poshmark.com/listing/a-1",
          title: "Blue Jacket",
          price: "$42.00",
          date: "Aug 18, 2026",
          ref: "ORDER-1",
        }),
      ],
    },
    selectors: ADAPTER,
  });

  const msg = sent.find((m) => m.type === "GT_SYNC_OBSERVE");
  assert.ok(msg, "a readable Sold page must report");
  assert.strictEqual(msg.batch.signedIn, true);
  assert.strictEqual(msg.batch.sold.length, 1);
  assert.strictEqual(msg.batch.sold[0].orderRef, "ORDER-1");
  assert.deepStrictEqual(
    Object.keys(msg.batch.sold[0]).sort(),
    ["listingUrl", "orderRef", "soldAt", "soldPriceCents", "thumbAssetId", "title"],
    "the six-field allowlist is what keeps the buyer's name — printed on this " +
      "very page — off the wire",
  );
}

// ── 4. A stranger's closet is not read ─────────────────────────────────────
//
// /closet/{handle} matches ANY seller. Reading one would post their listings as
// if they were the seller's own, and would make every real listing look absent.
{
  const sent = runContent({
    href: "https://poshmark.com/closet/somebody-else",
    hits: {
      // no "#mine" — this is not the seller's own closet
      ".tile": [soldRow({ url: "https://poshmark.com/listing/theirs-1" })],
    },
    selectors: ADAPTER,
  });
  assert.deepStrictEqual(
    sent,
    [],
    "a closet with no owner-only affordance must produce NO report at all",
  );
}

// ── 5. The worker actually routes the human-check report ───────────────────
//
// The content script's message is worth nothing if background.js drops it. Read
// off the source because background.js is a 2,500-line service worker with a
// browser API surface no stub reproduces honestly; what is asserted is the
// wiring, which is precisely what was missing.
{
  assert.ok(
    /case "GT_SYNC_HUMAN_CHECK":/.test(BACKGROUND_SRC),
    "background.js has no GT_SYNC_HUMAN_CHECK case, so the reader's report is " +
      "dropped and RULE 5 never fires",
  );
  const handler = BACKGROUND_SRC.slice(
    BACKGROUND_SRC.indexOf('case "GT_SYNC_HUMAN_CHECK":'),
    BACKGROUND_SRC.indexOf('case "GT_SYNC_HUMAN_CHECK":') + 400,
  );
  assert.ok(
    /notePollResult\(\s*\{[^}]*humanCheck:\s*true/.test(handler),
    "the GT_SYNC_HUMAN_CHECK case must reach notePollResult with humanCheck " +
      "true — that call is the only thing that sets stoppedForHumanCheck",
  );
  assert.ok(
    !/postSyncObservations/.test(handler),
    "a human check must not be posted to the server: nothing was read, and an " +
      "empty batch would overwrite the channel's last_ok_at with a read that " +
      "never happened",
  );
}

console.log("sync-content: the three refusals execute, and the human check reaches the poll");
