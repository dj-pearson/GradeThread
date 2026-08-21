// US-2732 AC3: photos attach in the seller's order, not in completion order.
//
// WHY THIS IS THE PROPERTY WORTH A TEST. The fix made the fetches concurrent so
// the set is bounded by ONE timeout rather than their sum - twelve photos on a
// slow connection used to spend three minutes here, longer than the job's own
// deadline, so "the photos were slow" surfaced as "the cross-post timed out".
//
// Concurrency is where photo order gets lost, and the FIRST photo is the
// seller's cover image. `Promise.all` resolves positionally, which is what makes
// the current code correct - but the natural "improvement" to a concurrency
// pattern is to consume results as they settle, and that reorders silently.
// Nothing failed, nothing warned, the cover is just a different photo.
//
// AC3 says this was "verified against a mixed success/failure set". This is that
// verification, run every time rather than once.
//
// Zero dependencies, node assertions, discovered by scripts/test-extensions.mjs
// so it runs in verify:web and in CI.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "lister", "common.js");

/**
 * Load common.js with the browser surface it touches stubbed out.
 *
 * `fetch` is the seam: each url resolves after a delay chosen so completion
 * order is the REVERSE of request order. If the code ever consumes results as
 * they settle, the assertions below invert.
 */
function loadGT({ delays, failures = new Set() }) {
  const src = fs.readFileSync(SRC, "utf8");

  const added = [];
  class FakeFile {
    constructor(parts, name, opts) {
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

  const scope = {
    document: {
      querySelector: () => ({
        // attachPhotos assigns .files and dispatches; neither needs a real DOM.
        set files(v) { this._files = v; },
        get files() { return this._files; },
        value: "",
        dispatchEvent: () => true,
      }),
    },
    DataTransfer: FakeDataTransfer,
    File: FakeFile,
    Event: class { constructor(t) { this.type = t; } },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    setTimeout,
    clearTimeout,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    fetch: (url) =>
      new Promise((resolve) => {
        setTimeout(() => {
          if (failures.has(url)) return resolve({ ok: false });
          resolve({
            ok: true,
            blob: async () => ({ type: "image/jpeg" }),
          });
        }, delays[url] ?? 0);
      }),
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
  return { GT, added };
}

const urls = ["a.jpg", "b.jpg", "c.jpg", "d.jpg"];

// ── 1. Completion order is the REVERSE of request order ─────────────────────

(async () => {
  {
    // a is slowest, d is fastest: if results were consumed as they settled, the
    // cover would end up being d.
    const delays = { "a.jpg": 40, "b.jpg": 30, "c.jpg": 20, "d.jpg": 5 };
    const { GT, added } = loadGT({ delays });
    const res = await GT.attachPhotos("input", urls, 10);

    assert.strictEqual(res.total, 4, "total should count every url offered");
    assert.strictEqual(res.failed, 0, "no url was set to fail");
    assert.deepStrictEqual(
      added.map((f) => f.name),
      ["01.jpg", "02.jpg", "03.jpg", "04.jpg"],
      "photos were attached in COMPLETION order, not the seller's order — the " +
        "first photo is the cover image, so this silently changes which photo " +
        "fronts the listing (US-2732 AC3)",
    );
  }

  // ── 2. A mixed success/failure set keeps the survivors in position ─────────

  {
    // b and c fail. a and d must stay first and last, and must not shuffle up.
    const delays = { "a.jpg": 30, "b.jpg": 5, "c.jpg": 5, "d.jpg": 25 };
    const { GT, added } = loadGT({ delays, failures: new Set(["b.jpg", "c.jpg"]) });
    const res = await GT.attachPhotos("input", urls, 10);

    assert.strictEqual(res.failed, 2, "both failures should be counted");
    assert.strictEqual(res.attached, 2, "both survivors should be attached");
    assert.strictEqual(res.total, 4, "total is what was offered, not what landed");
    // The names carry the ORIGINAL index, so a gap is visible rather than closed.
    assert.deepStrictEqual(
      added.map((f) => f.name),
      ["01.jpg", "04.jpg"],
      "a failed photo renumbered the ones after it — position is how the cover " +
        "is identified, so the survivors must keep their original index",
    );
  }

  // ── 3. One slow photo does not cost the others ─────────────────────────────

  {
    const delays = { "a.jpg": 0, "b.jpg": 0, "c.jpg": 0, "d.jpg": 0 };
    const { GT } = loadGT({ delays, failures: new Set(["a.jpg"]) });
    const res = await GT.attachPhotos("input", urls, 10);
    assert.strictEqual(res.failed, 1, "one bad photo must cost only itself");
    assert.strictEqual(res.attached, 3);
  }

  // ── 4. The max cap is applied before fetching, not after ───────────────────

  {
    const delays = { "a.jpg": 0, "b.jpg": 0, "c.jpg": 0, "d.jpg": 0 };
    const { GT, added } = loadGT({ delays });
    const res = await GT.attachPhotos("input", urls, 2);
    assert.strictEqual(res.total, 2, "the cap should bound what is even attempted");
    assert.deepStrictEqual(added.map((f) => f.name), ["01.jpg", "02.jpg"]);
  }

  // ── 5. Nothing to do is not a failure ──────────────────────────────────────

  {
    const { GT } = loadGT({ delays: {} });
    const res = await GT.attachPhotos("input", [], 10);
    assert.strictEqual(res.total, 0, "no photos offered is not a partial failure");
    assert.strictEqual(res.failed, 0, "reporting failed:N here would nag about a non-problem");
  }

  console.log("attach-photos-order.test.cjs: order survives concurrency; failures keep their position");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
