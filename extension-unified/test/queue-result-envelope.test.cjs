// US-3370 - the queue completion envelope, DRIVEN rather than grepped.
//
// WHAT WENT WRONG, AND WHY A SOURCE SCAN WOULD NOT HAVE CAUGHT IT.
// lister/common.js has emitted `photosWitness` since US-2738. US-3367 built the
// whole seller-facing rendering for it in queue/queue-view.js and popup.js,
// tested every one of the four states, and went green. None of it could ever
// fire, because background.js completed a drained queue row with a result
// envelope of exactly three fields written out by hand - { error, manual,
// listingUrl } - and the witness was not one of them. A test that greps
// background.js for the string "photosWitness" is satisfied by a field that is
// never sent, which is how the gap survived a passing suite in the first place.
//
// So this file BOOTS background.js - the real service worker, with its real
// deps - drives reportJob with a real runFlow result, and reads the field back
// off the HTTP body that reaches POST /:id/complete. Then it feeds that same
// captured body through the real queue/queue-view.js, and asserts US-3367's
// renderer produces its refusal sentence out of it. Nothing is believed because
// a file contains a word.
//
// It also holds the envelope in step with the flows: every result literal in
// lister/common.js and lister/job-store.js is parsed, and a key that is neither
// in QUEUE_RESULT_FIELDS nor named below goes red. A hand-written list is only
// safe if something notices when it falls behind.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(dir, p), "utf8");

// ── booting the worker ─────────────────────────────────────────────────────
//
// background.js is written for two runtimes already (Chrome's MV3 service
// worker with importScripts, Firefox's event page without it), so it reaches
// for nothing that a stub cannot stand in for. Every API it registers on is
// existence-guarded, which background-deps.test.cjs holds separately.

const DEPS = [
  "attribution.js",
  "usage-telemetry.js",
  "lister/selectors.js",
  "lister/lister-guard.js",
  "lister/job-store.js",
  "lister/engagement.js",
  "research/ebay-item-id.js",
  "registry.js",
  "research/seller-memory.js",
  "research/compare-tray.js",
  "research/label-reader.js",
  "research/label-card.js",
  "sync/selectors.js",
  "closet-import/selectors.js",
  "sync/poll-plan.js",
  "queue/queue-view.js",
  "queue/worker-state.js",
  "panel/panel-host.js",
];

function listener() {
  return { addListener() {}, removeListener() {}, hasListener() { return false; } };
}

function storageArea() {
  const data = {};
  return {
    async get(keys) {
      if (keys == null) return Object.assign({}, data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = data[k];
      return out;
    },
    async set(o) { Object.assign(data, o); },
    async remove(keys) {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete data[k];
    },
    _data: data,
  };
}

/** Every request background.js made, newest last. */
const sent = [];

function bootWorker() {
  const local = storageArea();
  // The drained-job path needs a signed-in browser and nothing else.
  local._data.gtBuyerToken = "test-token-not-a-real-one";

  globalThis.chrome = {
    runtime: {
      id: "test",
      getManifest: () => ({ version: "0.0.0-test" }),
      getURL: (p) => "chrome-extension://test/" + p,
      onMessage: listener(),
      onMessageExternal: listener(),
      onInstalled: listener(),
      onStartup: listener(),
      onConnect: listener(),
      sendMessage: async () => ({}),
      lastError: null,
    },
    storage: {
      local,
      session: storageArea(),
      sync: storageArea(),
      onChanged: listener(),
    },
    alarms: {
      create: async () => {},
      clear: async () => true,
      getAll: async () => [],
      onAlarm: listener(),
    },
    tabs: {
      create: async () => ({ id: 1 }),
      update: async () => ({}),
      remove: async () => {},
      sendMessage: async () => ({}),
      query: async () => [],
      get: async () => ({ id: 1 }),
      onUpdated: listener(),
      onRemoved: listener(),
      onActivated: listener(),
    },
    windows: { create: async () => ({}), onRemoved: listener() },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
      setPopup: async () => {},
      onClicked: listener(),
    },
    scripting: { executeScript: async () => [] },
    contextMenus: { create: () => {}, removeAll: async () => {}, onClicked: listener() },
    notifications: { create: async () => {}, onClicked: listener() },
    permissions: { contains: async () => true, request: async () => true },
    sidePanel: { setOptions: async () => {}, setPanelBehavior: async () => {} },
    idle: { onStateChanged: listener() },
    webNavigation: { onCompleted: listener(), onHistoryStateUpdated: listener() },
    commands: { onCommand: listener() },
  };
  globalThis.browser = undefined;

  globalThis.importScripts = function () {
    for (const d of DEPS) new Function("self", read(d))(globalThis);
  };

  // The server. Records everything and accepts the completion, so the branch
  // under test is the one that runs on a working day.
  globalThis.fetch = async function (url, init) {
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch (_e) { body = null; }
    sent.push({ url: String(url), method: (init && init.method) || "GET", body });
    return {
      ok: true,
      status: 200,
      async json() { return { updated: { id: "row-1", status: "done" } }; },
      async text() { return "{}"; },
    };
  };

  // The worker keeps its functions in module scope, which is right for a
  // service worker and unreachable from here, so the boot appends one line that
  // hands out exactly the two the test drives.
  const src = read("background.js") +
    "\n;self.__GT_TEST_EXPORTS__ = {" +
    " reportJob: reportJob," +
    " queueResultEnvelope: queueResultEnvelope," +
    " QUEUE_RESULT_FIELDS: QUEUE_RESULT_FIELDS };\n";
  new Function("self", src)(globalThis);

  const out = globalThis.__GT_TEST_EXPORTS__;
  assert.ok(out && typeof out.reportJob === "function", "background.js did not boot");
  return out;
}

const BG = bootWorker();

// Loaded separately so the assertions below read the SHIPPED view model, not a
// copy of it. (It is also already on globalThis from the boot; this is the
// explicit path, and asserting they are the same object costs nothing.)
const VIEW = globalThis.GT_QUEUE_VIEW;
assert.ok(VIEW && VIEW.viewRow, "queue/queue-view.js must assign self.GT_QUEUE_VIEW");

/** What lister/common.js runFlow actually returns when Poshmark refuses the photos. */
function refusedPhotoResult() {
  return {
    ok: true,
    filled: true,
    priceFilled: true,
    brandFilled: undefined,
    tagsCommitted: 3,
    tagsTotal: 4,
    photosAttached: false,
    photosTotal: 8,
    photosFailed: 8,
    photosUnverified: undefined,
    photosWitness: "none",
    listingUrl: null,
    version: "2026-09-01",
  };
}

function drainedJob(over) {
  return Object.assign({
    jobId: "job-1",
    queueId: "row-1",
    kind: "list",
    platform: "poshmark",
    tabId: 1,
    payload: {},
  }, over || {});
}

function completionFor(url) {
  return sent.filter((r) => r.method === "POST" && r.url.endsWith(url));
}

async function main() {
  // ── 1. AC1 + AC4: the witness survives the trip home ────────────────────
  //
  // reportJob is what a drained job calls when its marketplace tab reports. The
  // assertion is on the HTTP BODY, which is the only thing the server ever
  // sees: a field present in the file and absent from this object is the exact
  // bug this story is about.
  {
    sent.length = 0;
    await BG.reportJob(drainedJob(), refusedPhotoResult());

    const posts = completionFor("/row-1/complete");
    assert.strictEqual(
      posts.length,
      1,
      "a drained job must complete its queue row exactly once; got " + posts.length,
    );
    const body = posts[0].body;
    assert.ok(body && body.result, "the completion carried no result envelope at all");

    assert.strictEqual(
      body.result.photosWitness,
      "none",
      "photosWitness did not reach the wire. This is the whole of US-3370: " +
        "lister/common.js has emitted it since US-2738 and the envelope dropped it, " +
        "so no extension_work_queue.result row has ever carried one.",
    );
    assert.strictEqual(body.result.photosTotal, 8);
    assert.strictEqual(body.result.photosFailed, 8);
    assert.strictEqual(body.result.photosAttached, false);
    assert.strictEqual(body.result.priceFilled, true);
    assert.strictEqual(body.result.tagsCommitted, 3);
    assert.strictEqual(body.result.tagsTotal, 4);
    assert.strictEqual(body.result.version, "2026-09-01");
    // The row goes `done`, because the run DID reach the marketplace. That is
    // US-3367's decision and the reason the edge needed a third list rather
    // than a wider needsAttention.
    assert.strictEqual(body.ok, true, "a photo refusal is not a failed run");

    // `undefined` is load-bearing: queue-view.js tells an old extension build
    // (no counts at all) from a run that attached nothing by whether the counts
    // are absent. A field the flow did not produce must stay absent.
    assert.ok(
      !Object.prototype.hasOwnProperty.call(body.result, "brandFilled"),
      "an inapplicable field must be omitted, not sent as false - a channel " +
        "with no brand selector would report a miss on a field it never tried",
    );
    assert.ok(!Object.prototype.hasOwnProperty.call(body.result, "photosUnverified"));

    // The three fields the old envelope carried are still unconditional: three
    // clients have read them since US-2481 and null is not the same as absent.
    for (const key of ["error", "manual", "listingUrl"]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(body.result, key),
        key + " must stay unconditional - removing it is a client-visible change",
      );
    }
  }

  // ── 2. AC4: US-3367's renderer, fed by that captured body ───────────────
  //
  // The row is built the way the edge builds it: status `done`, result = the
  // envelope that actually went over the wire above. Nothing is retyped.
  {
    const result = completionFor("/row-1/complete")[0].body.result;
    const row = {
      id: "row-1",
      kind: "list",
      platform: "poshmark",
      status: "done",
      payload: {},
      result: result,
      created_at: new Date(Date.now() - 60_000).toISOString(),
      source: "mobile",
    };
    const view = VIEW.viewRow(row, { now: Date.now() });
    assert.ok(view, "queue-view.js refused the row the drain actually produces");
    assert.strictEqual(
      view.photoState,
      "refused",
      "the witness reached the view model and it still read as " + view.photoState,
    );
    assert.strictEqual(view.photoAlert, true);
    assert.ok(
      view.photoNote && view.photoNote.indexOf("Poshmark") === 0,
      "the seller-facing sentence must name the marketplace: " + view.photoNote,
    );
    assert.ok(
      /not on the listing/.test(view.photoNote),
      "the refusal sentence must say the photos are not on the listing",
    );
  }

  // ── 3. a clean run says nothing, which is the other half of the rule ─────
  //
  // A line that fires on every ordinary run is a line the seller learns to
  // skip, and four of the five channels declare no photoConfirm selector.
  {
    sent.length = 0;
    await BG.reportJob(drainedJob({ jobId: "job-2", queueId: "row-2" }), Object.assign(
      refusedPhotoResult(),
      { photosWitness: "page", photosFailed: 0, photosAttached: true },
    ));
    const result = completionFor("/row-2/complete")[0].body.result;
    assert.strictEqual(result.photosWitness, "page");
    const view = VIEW.viewRow(
      { id: "row-2", kind: "list", platform: "poshmark", status: "done", payload: {}, result },
      { now: Date.now() },
    );
    assert.strictEqual(view.photoState, "confirmed");
    assert.strictEqual(view.photoAlert, false, "a confirmed run must raise no alarm");
  }

  // ── 4. the other kinds report what they learned too ──────────────────────
  {
    sent.length = 0;
    await BG.reportJob(drainedJob({ jobId: "job-3", queueId: "row-3", kind: "delist" }), {
      ok: true, delisted: true, verifiedBy: "gone", version: 7,
    });
    const delist = completionFor("/row-3/complete")[0].body.result;
    assert.strictEqual(delist.delisted, true);
    assert.strictEqual(delist.verifiedBy, "gone");
    assert.strictEqual(delist.version, "7", "a numeric version is spelled out, not dropped");

    sent.length = 0;
    await BG.reportJob(drainedJob({ jobId: "job-4", queueId: "row-4", kind: "relist" }), {
      ok: false, manual: true, partial: true, fields: ["price", "title"],
      error: "Grailed took price but not title.", version: "v3",
    });
    const relist = completionFor("/row-4/complete")[0].body.result;
    assert.strictEqual(relist.partial, true);
    assert.deepStrictEqual(relist.fields, ["price", "title"]);
    assert.strictEqual(relist.manual, true);
    assert.strictEqual(relist.error, "Grailed took price but not title.");
  }

  // ── 5. the envelope stays bounded, whatever a flow hands it ──────────────
  //
  // The edge drops a result of more than 8 KB WHOLE rather than truncating it,
  // and refuses the completion outright on a credential-shaped key. Both of
  // those turn a fat envelope into a row with no result at all, so the caps are
  // not tidiness.
  {
    sent.length = 0;
    await BG.reportJob(drainedJob({ jobId: "job-5", queueId: "row-5" }), {
      ok: false,
      error: "x".repeat(50_000),
      listingUrl: "https://poshmark.com/listing/" + "y".repeat(50_000),
      photosWitness: { not: "a word" },
      photosTotal: "eight",
      fields: new Array(500).fill("a-very-long-field-name-".repeat(20)),
      verifiedBy: "z".repeat(5_000),
      version: { nope: true },
    });
    const result = completionFor("/row-5/complete")[0].body.result;
    assert.strictEqual(result.error.length, 400);
    assert.strictEqual(result.listingUrl.length, 500);
    assert.strictEqual(result.photosWitness, null, "a non-word witness is not a witness");
    assert.strictEqual(result.photosTotal, null, "a non-number count is not a count");
    assert.strictEqual(result.fields.length, 12);
    assert.strictEqual(result.fields[0].length, 40);
    assert.strictEqual(result.verifiedBy.length, 64);
    assert.strictEqual(result.version, null);
    const bytes = JSON.stringify(result).length;
    assert.ok(
      bytes < 4096,
      "the envelope must stay well inside the edge's 8 KB cap; it was " + bytes,
    );
  }

  // ── 6. a job with no queue row completes nothing ─────────────────────────
  //
  // An interactive cross-post is reported to the page, not to the queue. A
  // completion here would be a write against a row that does not exist.
  {
    sent.length = 0;
    await BG.reportJob(
      { jobId: "job-6", kind: "list", platform: "poshmark", tabId: 1, payload: {} },
      refusedPhotoResult(),
    );
    assert.strictEqual(
      sent.filter((r) => /\/complete$/.test(r.url)).length,
      0,
      "a job with no queueId must not complete a queue row",
    );
  }
}

// ── 7. AC2/AC5: the list cannot fall behind the flows ──────────────────────
//
// Parses every result literal in the two files that produce one - every object
// literal in a `return` that carries an `ok` key - and requires each key to be
// either in QUEUE_RESULT_FIELDS or named here with a reason. This is the thing
// that makes a hand-written list safe: the next field added to runFlow goes red
// instead of going missing.

const NOT_SENT = {
  ok: "the completion body carries its own top-level ok; two copies could disagree",
};

// lastJobRecord is a PROJECTION for the popup's "last job" line, not a flow
// result, and it happens to carry an `ok`. Its keys (platform, kind, outcome,
// at) are about the job rather than about what the flow found.
const SKIP_FUNCTIONS = ["lastJobRecord"];

function stripStringsAndComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") { out += src[i] === "\n" ? "\n" : " "; i++; }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; }
      i += 2;
      out += "  ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      out += '""';
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        if (src[i] === "\n") out += "\n";
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Keys written at the TOP level of an object-literal body. */
function topLevelKeys(body) {
  const keys = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{" || c === "[" || c === "(") { depth++; continue; }
    if (c === "}" || c === "]" || c === ")") { depth--; continue; }
    if (depth !== 0 || !/[A-Za-z_$]/.test(c)) continue;
    const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(i));
    // A key is preceded by `{` or `,` and nothing else. Without this, the
    // identifier in a ternary (`x ? name : 0`) reads as a key.
    let k = i - 1;
    while (k >= 0 && /\s/.test(body[k])) k--;
    const prev = k < 0 ? "," : body[k];
    if (m && (prev === "," || prev === "{")) keys.push(m[1]);
    while (i < body.length && /[\w$]/.test(body[i])) i++;
    i--;
  }
  return keys;
}

/** Every object literal inside a `return ...;` that carries an `ok` key. */
function resultLiteralKeys(file) {
  const raw = stripStringsAndComments(read(file));
  // Blank out the functions that return something which is not a flow result.
  let src = raw;
  for (const name of SKIP_FUNCTIONS) {
    const at = src.indexOf("function " + name + "(");
    if (at === -1) continue;
    const open = src.indexOf("{", at);
    let depth = 0, j = open;
    for (; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") { depth--; if (depth === 0) break; }
    }
    src = src.slice(0, at) + " ".repeat(j - at + 1) + src.slice(j + 1);
  }

  const found = new Set();
  const re = /\breturn\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    // Walk the return expression to its statement end, collecting every brace
    // group. A ternary return (`return a ? {..} : {..}`) has two.
    let i = m.index + "return".length;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === ";" && depth === 0) break;
      if (c === "\n" && depth === 0 && /^\s*$/.test(src.slice(m.index + 6, i))) break;
      if (c === "{") {
        let d = 0, j = i;
        for (; j < src.length; j++) {
          if (src[j] === "{") d++;
          else if (src[j] === "}") { d--; if (d === 0) break; }
        }
        const keys = topLevelKeys(src.slice(i + 1, j));
        if (keys.indexOf("ok") !== -1) for (const k of keys) found.add(k);
        i = j;
        continue;
      }
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
    }
  }
  return found;
}

function checkDrift() {
  const files = ["lister/common.js", "lister/job-store.js"];
  const all = new Set();
  for (const f of files) for (const k of resultLiteralKeys(f)) all.add(k);

  // A parser that finds nothing passes everything. Two keys that have been in
  // these files since US-1877 and US-2738 stand as the canary.
  assert.ok(all.size >= 15, "the result-literal parser found only " + all.size + " keys");
  for (const canary of ["ok", "photosWitness", "error", "version", "timedOut"]) {
    assert.ok(
      all.has(canary),
      "the parser missed `" + canary + "`, so it is not reading the result " +
        "literals and every assertion below it is empty",
    );
  }

  const unknown = [];
  for (const key of all) {
    if (Object.prototype.hasOwnProperty.call(BG.QUEUE_RESULT_FIELDS, key)) continue;
    if (Object.prototype.hasOwnProperty.call(NOT_SENT, key)) continue;
    unknown.push(key);
  }
  assert.deepStrictEqual(
    unknown,
    [],
    "these result fields reach reportJob and are neither forwarded by " +
      "QUEUE_RESULT_FIELDS nor named in NOT_SENT: " + unknown.join(", ") +
      ". Decide where each one goes; do not leave it to be found by accident " +
      "the way photosWitness was.",
  );

  // And the reverse: a NOT_SENT entry that no longer matches anything is a
  // stale exemption, which is how a list starts lying about itself.
  for (const key of Object.keys(NOT_SENT)) {
    assert.ok(
      all.has(key),
      "NOT_SENT names `" + key + "`, which no result literal produces any more",
    );
  }
  return all;
}

main().then(() => {
  const all = checkDrift();
  console.log(
    "queue-result-envelope.test.cjs: background.js booted and driven - " +
      "photosWitness reaches POST /:id/complete, queue-view.js raises its " +
      "refusal from that same body, the envelope stays under 4 KB against a " +
      "pathological result, and all " + all.size + " result fields across " +
      "lister/common.js and lister/job-store.js are accounted for",
  );
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
