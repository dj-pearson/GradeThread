// US-2738 AC7: a page that took no photos must be reported as having taken none.
//
// WHAT WAS STILL WRONG. The fix for this story assigns a FileList from a
// DataTransfer and treats a non-empty `input.value` as proof the attach worked.
// That is the BROWSER confirming the element took a file selection, and on
// Chrome it essentially always does. It says nothing about the PAGE. An uploader
// that never reads a programmatically-set selection leaves `value` populated,
// `files` populated, and the listing with no images on it - and the extension
// reported 8 of 8, exactly as it did before the fix, sourced from `value`
// instead of from `files`.
//
// Same family as ebay-lifecycle-verbs-infer-instead-of-checking: a local fact
// standing in for a remote one, failing toward success.
//
// THE WITNESS is the page's own preview. An uploader that has read the selection
// renders the image before uploading it, and a preview of a file the page was
// just handed comes from an object or data URL built out of OUR bytes. Nothing
// in attachPhotos writes it, so it cannot be read back from something we set.
//
// Boolean, not a count: some uploaders render one carousel node for eight
// photos. Opt-in per flow, so the six channels nobody has watched a preview on
// gain no new warning.
//
// Zero dependencies, discovered by scripts/test-extensions.mjs.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "lister", "common.js");
const SELECTORS = path.join(__dirname, "..", "lister", "selectors.js");

/**
 * @param mode      "accept" - the assignment works and populates value, like
 *                             Chrome. This is the case that used to report a
 *                             clean success no matter what the page did.
 *                  "shadow" - the assignment is swallowed, defineProperty works.
 *                  "refuse" - neither works.
 * @param preview   how the page reacts: "never", "immediate", or a delay in ms
 *                  before the uploader renders its thumbnails.
 * @param preexisting  witness-matching nodes already on the page before the
 *                  attach (an avatar, a site icon). These must NOT be read as
 *                  confirmation.
 */
function loadGT({ mode = "accept", preview = "never", preexisting = 0 } = {}) {
  const src = fs.readFileSync(SRC, "utf8");
  const added = [];
  const logs = [];
  const queriedAll = [];
  // The page's rendered previews. Seeded with whatever was already there.
  const previews = [];
  for (let i = 0; i < preexisting; i++) previews.push({ tag: "pre-existing" });

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

  const input = { id: "img-file-input", value: "", dispatched: [] };
  input.dispatchEvent = (e) => {
    input.dispatched.push(e.type);
    // The uploader reacts to the event, or does not. THIS is the seam the whole
    // file turns on: "accept" plus preview "never" is a real host that takes the
    // selection and ignores it.
    if (preview === "immediate") previews.push({ tag: "preview" });
    else if (typeof preview === "number") {
      setTimeout(() => { previews.push({ tag: "preview" }); }, preview);
    }
    return true;
  };

  if (mode === "accept") {
    Object.defineProperty(input, "files", {
      configurable: true,
      get() { return this._f; },
      set(v) { this._f = v; this.value = "C:\\fakepath\\" + (v[0] ? v[0].name : ""); },
    });
  } else if (mode === "refuse") {
    Object.defineProperty(input, "files", {
      configurable: false,
      get() { return this._f || []; },
      set(_v) { /* swallowed */ },
    });
  } else {
    Object.defineProperty(input, "files", {
      configurable: true,
      get() { return this._f || []; },
      set(_v) { /* swallowed */ },
    });
  }

  // A clock that runs fast, so the 6s no-preview deadline costs the suite a
  // second rather than six. Only attachPhotos' own poll reads it; the fetch
  // timeout is a real setTimeout and is untouched.
  const t0 = Date.now();
  let ticks = 0;
  const FakeDate = {
    now() { return t0 + (ticks++) * 1200; },
  };

  const documentStub = {
    querySelector: () => input,
    querySelectorAll: (sel) => {
      queriedAll.push(sel);
      return previews.slice();
    },
  };

  const scope = {
    document: documentStub,
    DataTransfer: FakeDataTransfer,
    File: FakeFile,
    Event: class { constructor(t) { this.type = t; } },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    setTimeout,
    clearTimeout,
    Date: FakeDate,
    console: {
      log: (m) => logs.push(String(m)),
      debug: (...a) => logs.push(a.map(String).join(" ")),
      warn: () => {},
      error: () => {},
    },
    fetch: () => Promise.resolve({ ok: true, blob: async () => ({ type: "image/jpeg" }) }),
  };

  const self = {};
  const fn = new Function(
    "self", "document", "DataTransfer", "File", "Event", "AbortController",
    "setTimeout", "clearTimeout", "Date", "console", "fetch", "globalThis",
    `${src}; return self.GTLister;`,
  );
  const GT = fn(
    self, scope.document, scope.DataTransfer, scope.File, scope.Event,
    scope.AbortController, scope.setTimeout, scope.clearTimeout, scope.Date,
    scope.console, scope.fetch, { chrome: undefined, browser: undefined },
  );
  return { GT, added, input, logs, previews, queriedAll };
}

const eight = ["1.jpg", "2.jpg", "3.jpg", "4.jpg", "5.jpg", "6.jpg", "7.jpg", "8.jpg"];

// ── The runFlow harness, for the wiring case ────────────────────────────────
function loadLister() {
  const src = fs.readFileSync(SRC, "utf8");
  const seen = [];
  const selfObj = {};
  const chromeStub = {
    runtime: { sendMessage() { return Promise.resolve(); }, onMessage: { addListener() {} } },
  };
  const documentStub = {
    body: null,
    documentElement: { appendChild() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({
      style: {}, setAttribute() {}, addEventListener() {}, appendChild() {}, remove() {},
    }),
  };
  const sandbox = {
    self: selfObj,
    globalThis: { chrome: chromeStub },
    chrome: chromeStub,
    document: documentStub,
    window: { location: { href: "https://poshmark.com/create-listing" } },
    console: { debug() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    fetch: () => Promise.reject(new Error("no network in this test")),
  };
  const keys = Object.keys(sandbox);
  new Function(...keys, src)(...keys.map((k) => sandbox[k]));
  const GT = selfObj.GTLister;
  assert.ok(GT, "common.js must assign self.GTLister");
  GT.probe = () => Promise.resolve([]);
  GT.fill = () => true;
  GT.commitTags = () => Promise.resolve({ committed: 0, total: 0 });
  GT.showBanner = () => {};
  GT.readListingUrl = () => Promise.resolve(null);
  GT.attachPhotos = (sel, urls, max, confirm) => {
    seen.push({ sel, max, confirm });
    return Promise.resolve({ attached: 0, failed: 0, total: 0, unverified: 0 });
  };
  return { GT, seen };
}

(async () => {
  // ── 0. The harness must be able to express the bug ────────────────────────
  {
    // If the accepting stub did not populate `value`, the code would take the
    // shadow branch and case 1 would pass for the wrong reason - the whole file
    // would then prove nothing about the case that actually shipped.
    const g = loadGT({ mode: "accept", preview: "never" });
    g.input.files = [{ name: "x.jpg" }];
    assert.notStrictEqual(
      g.input.value, "",
      "the accepting stub must populate value, or this file is not testing the " +
        "browser-accepted path at all",
    );
    assert.strictEqual(
      g.previews.length, 0,
      "the silent page must render nothing, or there is no false success to catch",
    );
  }

  // ── 1. THE REGRESSION: browser took it, page did nothing ──────────────────
  {
    const g = loadGT({ mode: "accept", preview: "never" });
    const res = await g.GT.attachPhotos("input", eight, 10, true);

    assert.strictEqual(
      res.attached, 0,
      "THE BUG: the browser accepted the file selection and the page rendered " +
        "nothing from it, and the extension still reported the photos as " +
        "attached. A non-empty input.value is the BROWSER's answer to 'did this " +
        "element take a selection', not the PAGE's answer to 'are the photos on " +
        "the listing' - and a seller told 8 of 8 here finds out from a buyer " +
        "(US-2738 AC1/AC7).",
    );
    assert.strictEqual(
      res.failed, 8,
      "a page that took nothing must read as every photo failing, so photoNote " +
        "tells the seller to drag them in",
    );
    assert.strictEqual(res.total, 8, "total is what was offered");
    assert.strictEqual(res.confirmed, false, "nothing confirmed it");
    assert.strictEqual(
      res.unverified, 0,
      "'we could not confirm' is a softer lie than the one this replaced - the " +
        "page answered, and the answer was no",
    );
    assert.ok(
      g.logs.some((l) => /no photo preview/i.test(l)),
      "the cause must be findable in the log without a repro",
    );
    assert.notStrictEqual(
      g.input.value, "",
      "harness check: the browser DID accept it. That is precisely why the old " +
        "witness reported success.",
    );
  }

  // ── 2. The page rendered previews: confirmed, no hedging ──────────────────
  {
    const g = loadGT({ mode: "accept", preview: "immediate" });
    const res = await g.GT.attachPhotos("input", eight, 10, true);
    assert.strictEqual(res.attached, 8, "the page took them");
    assert.strictEqual(res.failed, 0);
    assert.strictEqual(res.confirmed, true, "the page's own preview is the witness");
    assert.strictEqual(
      res.unverified, 0,
      "a run the page confirmed carries no doubt; warning anyway trains the " +
        "seller to ignore the warning that means something",
    );
  }

  // ── 3. A late preview still counts ────────────────────────────────────────
  {
    // An uploader that decodes or crops before rendering takes a moment. Failing
    // it would be the cry-wolf version of this fix.
    const g = loadGT({ mode: "accept", preview: 250 });
    const res = await g.GT.attachPhotos("input", eight, 10, true);
    assert.strictEqual(res.attached, 8, "a preview that arrives late is still a preview");
    assert.strictEqual(res.confirmed, true);
  }

  // ── 4. The shadow path, settled by the page (US-2775) ─────────────────────
  {
    // US-2775 left this open on purpose: the fallback's acceptance check reads
    // back what defineProperty just wrote, so it cannot fail, and `unverified`
    // was the honest hedge. When the PAGE previews, the hedge is answered - the
    // uploader read the list however it was set.
    const g = loadGT({ mode: "shadow", preview: "immediate" });
    const res = await g.GT.attachPhotos("input", eight, 10, true);
    assert.strictEqual(res.attached, 8);
    assert.strictEqual(res.failed, 0);
    assert.strictEqual(res.confirmed, true);
    assert.strictEqual(
      res.unverified, 0,
      "the shadow's unwitnessed success now HAS a witness, and it is not one we " +
        "wrote - keeping the hedge would be warning about a thing we can see",
    );
    assert.strictEqual(g.input.value, "", "harness check: this really was the shadow path");
  }

  // ── 5. The shadow path with a silent page is a failure, not a hedge ───────
  {
    const g = loadGT({ mode: "shadow", preview: "never" });
    const res = await g.GT.attachPhotos("input", eight, 10, true);
    assert.strictEqual(res.attached, 0, "nothing landed and nothing said otherwise");
    assert.strictEqual(res.failed, 8);
    assert.strictEqual(res.unverified, 0);
  }

  // ── 6. A pre-existing preview node is not confirmation ────────────────────
  {
    // The witness is a DELTA against a baseline taken before the handover. A
    // create form already carrying an avatar or a site icon would otherwise
    // confirm every attach forever, which is a false success with extra steps.
    const g = loadGT({ mode: "accept", preview: "never", preexisting: 3 });
    const res = await g.GT.attachPhotos("input", eight, 10, true);
    assert.strictEqual(
      res.attached, 0,
      "an image that was on the page BEFORE the attach cannot be evidence that " +
        "the attach worked",
    );
    assert.strictEqual(res.failed, 8);
    assert.strictEqual(res.confirmed, false);
  }

  // ── 7. A flow that declares nothing behaves exactly as before ─────────────
  {
    // The cry-wolf guard. Six channels have never had a preview watched on them;
    // turning this on everywhere would tell those sellers their photos failed on
    // every successful cross-post.
    const g = loadGT({ mode: "accept", preview: "never" });
    const res = await g.GT.attachPhotos("input", eight, 10);
    assert.strictEqual(
      res.attached, 8,
      "an opt-out flow must be unchanged - this is what keeps a wrong reading " +
        "costing one channel instead of seven",
    );
    assert.strictEqual(res.failed, 0);
    assert.strictEqual(res.confirmed, false);
    assert.strictEqual(
      g.queriedAll.length, 0,
      "a flow that declares no confirmation must not even look for one",
    );
  }

  // ── 8. A refused list short-circuits; it does not wait for a preview ──────
  {
    const g = loadGT({ mode: "refuse", preview: "never" });
    const res = await g.GT.attachPhotos("input", eight, 10, true);
    assert.strictEqual(res.attached, 0);
    assert.strictEqual(res.failed, 8, "a refusal is already a failure");
    assert.strictEqual(
      g.queriedAll.length, 1,
      "the baseline is taken before the handover and nothing else - there is " +
        "nothing to confirm when the input refused the list, and polling six " +
        "seconds for a preview that cannot exist would just delay the banner",
    );
  }

  // ── 9. A custom selector is used instead of the generic witness ───────────
  {
    const g = loadGT({ mode: "accept", preview: "immediate" });
    await g.GT.attachPhotos("input", eight, 10, ".upload-thumb");
    assert.ok(
      g.queriedAll.length > 0 && g.queriedAll.every((s) => s === ".upload-thumb"),
      "a flow that names its own preview selector must be asked with THAT " +
        "selector, not the generic one",
    );
  }

  // ── 10. runFlow hands the flow's declaration to attachPhotos ──────────────
  {
    // Without this the mechanism is dead code: attachPhotos would keep its
    // fourth argument undefined on every real cross-post.
    const { GT, seen } = loadLister();
    await GT.runFlow(
      {
        enabled: true,
        version: "3",
        fields: { title: "#title", photoInput: "#img-file-input" },
        photoConfirm: true,
      },
      {
        jobId: "job-1",
        platform: "poshmark",
        platformLabel: "Poshmark",
        title: "Levi's 501 - straight leg",
        photoUrls: eight,
        maxPhotos: 8,
        itemId: "11111111-1111-4111-8111-111111111111",
      },
    );
    assert.strictEqual(seen.length, 1, "the fill should have reached attachPhotos once");
    assert.strictEqual(
      seen[0].confirm, true,
      "runFlow must pass flow.photoConfirm through, or the page is never asked",
    );
  }

  // ── 11. Poshmark, the channel this story is about, opts in ────────────────
  {
    // US-2738 opened on Poshmark reporting attached photos it did not have. A
    // mechanism no flow turns on would leave that exactly where it was.
    const src = fs.readFileSync(SELECTORS, "utf8");
    const posh = src.slice(src.indexOf("poshmark:"), src.indexOf("mercari:"));
    assert.ok(
      /photoConfirm:\s*(true|['"])/.test(posh),
      "the Poshmark flow must declare photoConfirm - it is the channel that " +
        "reported eight attached photos onto a listing with none",
    );
  }

  console.log(
    "attach-photos-page-witness.test.cjs: a page that rendered no preview is " +
      "reported as having attached nothing; a page that did is confirmed",
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
