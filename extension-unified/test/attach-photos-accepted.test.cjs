// US-2738 AC5: a file list the page refused must read as FAILED, never attached.
//
// THE BUG THIS GUARDS was the worst shape available. attachPhotos used
// Object.defineProperty to hang a `files` value off the input, which shadows the
// prototype getter: anything reading el.files saw the list, but the input's real
// state never changed. el.value stayed empty and no internal file selection
// existed, so Poshmark's uploader saw an empty input. Every count said 8 of 8,
// photoNote emitted no warning because failed was zero, and the seller was told
// the photos were on a listing that had none.
//
// The fix ASSIGNS from a DataTransfer and then checks that the browser accepted
// it - a non-empty el.value is the browser's own witness, not one we wrote.
//
// AC5 says this was "verified against three cases: accepted 8/0, refused 0/8,
// partial 6/2". This is that verification, run every time rather than once.
//
// NOTE ON THE SIBLING TEST: attach-photos-order.test.cjs stubs an input whose
// `value` never changes, so it exercises the defineProperty FALLBACK rather than
// the assignment. That is fine for what it asserts (ordering) and is exactly why
// the witness needs its own file - the accept path had no coverage at all.
//
// Zero dependencies, discovered by scripts/test-extensions.mjs.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "lister", "common.js");

/**
 * @param mode "accept"  - assignment works and populates value, like Chrome
 *             "refuse"  - assignment is swallowed AND defineProperty throws,
 *                         which is the host that used to produce a false success
 *             "shadow"  - assignment is swallowed but defineProperty works; the
 *                         documented fallback path
 */
function loadGT({ mode = "accept", failures = new Set() } = {}) {
  const src = fs.readFileSync(SRC, "utf8");
  const added = [];
  const logs = [];

  class FakeFile {
    constructor(_parts, name, opts) {
      this.name = name;
      this.type = (opts && opts.type) || "";
    }
  }
  class FakeDataTransfer {
    constructor() {
      this.items = { add: (f) => added.push(f) };
      this.files = added;
    }
  }

  const input = { value: "", dispatched: [] };
  input.dispatchEvent = (e) => { input.dispatched.push(e.type); return true; };

  if (mode === "accept") {
    // Chrome sets the real selection and writes a fake path into `value`.
    Object.defineProperty(input, "files", {
      configurable: true,
      get() { return this._f; },
      set(v) { this._f = v; this.value = "C:\\fakepath\\" + (v[0] ? v[0].name : ""); },
    });
  } else if (mode === "refuse") {
    // Swallows the assignment and cannot be redefined - so neither path can
    // claim success, and the code must report every photo as failed.
    Object.defineProperty(input, "files", {
      configurable: false,
      get() { return this._f || []; },
      set(_v) { /* swallowed: value stays "" */ },
    });
  } else {
    // Swallows the assignment but allows defineProperty: the fallback.
    Object.defineProperty(input, "files", {
      configurable: true,
      get() { return this._f || []; },
      set(_v) { /* swallowed */ },
    });
  }

  const scope = {
    document: { querySelector: () => input },
    DataTransfer: FakeDataTransfer,
    File: FakeFile,
    Event: class { constructor(t) { this.type = t; } },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    setTimeout,
    clearTimeout,
    // GT.log writes via console.DEBUG, not console.log. Capturing only `log`
    // made the refusal assertion fail against correct code.
    console: {
      log: (m) => logs.push(String(m)),
      debug: (...a) => logs.push(a.map(String).join(" ")),
      warn: () => {},
      error: () => {},
    },
    fetch: (url) =>
      Promise.resolve(
        failures.has(url)
          ? { ok: false }
          : { ok: true, blob: async () => ({ type: "image/jpeg" }) },
      ),
  };

  const self = {};
  const fn = new Function(
    "self", "document", "DataTransfer", "File", "Event", "AbortController",
    "setTimeout", "clearTimeout", "console", "fetch", "globalThis",
    `${src}; return self.GTLister;`,
  );
  const GT = fn(
    self, scope.document, scope.DataTransfer, scope.File, scope.Event,
    scope.AbortController, scope.setTimeout, scope.clearTimeout, scope.console,
    scope.fetch, { chrome: undefined, browser: undefined },
  );
  return { GT, added, input, logs };
}

const eight = ["1.jpg", "2.jpg", "3.jpg", "4.jpg", "5.jpg", "6.jpg", "7.jpg", "8.jpg"];

(async () => {
  // ── The harness must be able to express the bug ───────────────────────────
  {
    // If "refuse" cannot actually refuse, every assertion below is vacuous and
    // this file would pass against the ORIGINAL broken code. Checked first.
    const { input } = loadGT({ mode: "refuse" });
    input.files = ["x"];
    assert.strictEqual(
      input.value, "",
      "the refusing stub accepted a file list — it cannot model the host that " +
        "produced the false success, so the rest of this file proves nothing",
    );
    let threw = false;
    try {
      Object.defineProperty(input, "files", { value: ["x"], configurable: true });
    } catch (_e) { threw = true; }
    assert.ok(threw, "the refusing stub allowed defineProperty; it is not refusing");
  }

  // ── 1. accepted: 8 of 8 ───────────────────────────────────────────────────
  {
    const { GT, added, input } = loadGT({ mode: "accept" });
    const res = await GT.attachPhotos("input", eight, 10);
    assert.strictEqual(res.attached, 8, "an accepting input should attach all eight");
    assert.strictEqual(res.failed, 0, "nothing failed");
    assert.strictEqual(res.total, 8);
    assert.strictEqual(added.length, 8, "eight files should reach the DataTransfer");
    assert.notStrictEqual(
      input.value, "",
      "the browser's witness is a non-empty value; without it the code cannot " +
        "tell an accepted list from a shadowed one",
    );
    // AC6: both events, in the order a real selection fires them.
    assert.deepStrictEqual(
      input.dispatched, ["input", "change"],
      "some uploaders listen for input and some for change; both must fire, in " +
        "that order (US-2738 AC6)",
    );
  }

  // ── 2. refused: 0 of 8, and it says so ────────────────────────────────────
  {
    const g = loadGT({ mode: "refuse" });
    const res = await g.GT.attachPhotos("input", eight, 10);

    assert.strictEqual(
      res.attached, 0,
      "THE REGRESSION: a refused file list reported photos as attached. This is " +
        "the silent false success — the seller publishes believing images are on " +
        "the listing (US-2738 AC1/AC5).",
    );
    assert.strictEqual(
      res.failed, 8,
      "every photo must be counted as failed so photoNote warns the seller",
    );
    assert.strictEqual(res.total, 8, "total is what was offered");
    assert.ok(
      g.logs.some((l) => /refused/i.test(l)),
      "a refusal should be logged, so the cause is findable without a repro",
    );
  }

  // ── 3. partial: 6 of 8, from FETCH failures on an accepting input ─────────
  {
    const g = loadGT({ mode: "accept", failures: new Set(["3.jpg", "7.jpg"]) });
    const res = await g.GT.attachPhotos("input", eight, 10);
    assert.strictEqual(res.attached, 6, "six photos were fetched successfully");
    assert.strictEqual(res.failed, 2, "two fetches failed and must be reported");
    assert.strictEqual(res.total, 8);
  }

  // ── 4. the fallback path reports what it actually knows (US-2775) ─────────
  {
    // A host that swallows the assignment but allows defineProperty takes the
    // documented fallback. It used to be reported as fully attached, and the
    // check that said so was `input.files.length === dt.files.length` run
    // immediately after defineProperty WROTE input.files - reading back what it
    // just set, so it could not fail. That is the same shadow, and the same
    // unwitnessed success, that produced the original bug: el.files reports
    // eight, el.value is empty, the uploader sees nothing, and the seller is
    // told the photos are on.
    //
    // THE DECISION (US-2775, taken 2026-08-21): three states, not two.
    // Reporting the fallback as FAILED would cry wolf on the hosts where the
    // shadow genuinely works, across seven platforms. Reporting it as attached
    // claims a confirmation nobody gave. `unverified` says the true thing on
    // both kinds of host - the photos may well be there, and nothing outside
    // this extension has said so.
    const g = loadGT({ mode: "shadow" });
    const res = await g.GT.attachPhotos("input", eight, 10);
    assert.strictEqual(
      res.attached, 8,
      "the fallback still reports the photos as attached - they probably are, " +
        "and failing here would cry wolf on every host where the shadow works",
    );
    assert.strictEqual(res.failed, 0, "the shadow path is not a failure");
    assert.strictEqual(
      res.unverified, 8,
      "the fallback claimed a confirmation it does not have. Its acceptance " +
        "check reads back what defineProperty just wrote, so it cannot fail - " +
        "which is exactly how US-2738's silent false success came back.",
    );
    assert.strictEqual(
      g.input.value, "",
      "the fallback leaves value empty - that is precisely why its success is " +
        "unwitnessed",
    );
  }

  // ── 5. the confirmed path claims no doubt (US-2775) ───────────────────────
  {
    // The mirror of case 4, and the reason `unverified` is worth a field rather
    // than a blanket warning. When the browser DOES confirm the assignment by
    // populating value, there is nothing to hedge about - a run that warned
    // every time would train the seller to ignore the warning that means
    // something, the same trap priceNote's undefined rule avoids.
    const g = loadGT({ mode: "accept" });
    const res = await g.GT.attachPhotos("input", eight, 10);
    assert.strictEqual(res.attached, 8);
    assert.strictEqual(
      res.unverified, 0,
      "a browser-confirmed attach must carry no doubt",
    );
    assert.notStrictEqual(g.input.value, "", "harness check: the browser confirmed it");
  }

  // ── 6. a refused list is failed, not merely unverified (US-2775) ──────────
  {
    // The third state must not swallow the second. A host that refuses BOTH the
    // assignment and defineProperty attached nothing, and "we could not confirm"
    // would be a softer lie than the one this replaced.
    const g = loadGT({ mode: "refuse" });
    const res = await g.GT.attachPhotos("input", eight, 10);
    assert.strictEqual(res.attached, 0, "nothing landed");
    assert.strictEqual(res.failed, 8, "every photo must read as failed");
    assert.strictEqual(
      res.unverified, 0,
      "a refusal is a failure, not an unconfirmed success",
    );
  }

  console.log(
    "attach-photos-accepted.test.cjs: refused lists report as failed, accepted " +
      "lists carry the browser's own witness",
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
