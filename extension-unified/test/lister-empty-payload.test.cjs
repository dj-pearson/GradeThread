// GradeThread unified extension — a list job with no content is refused (US-3096).
//
// The failure this guards is the quietest one in the whole cross-listing path.
// Every client queued `payload: {}` (web listing-kit.tsx and review.tsx, iOS
// ListingKitView.swift, Android ExtensionQueue.kt) and the server enriched only
// `revise` and `relist`, so a drained cross-post arrived carrying a platform, an
// item id and nothing else. `GT.probe` passed — the FORM was fine, it was the
// CONTENT that was missing — and `GT.fill` then wrote empty strings into every
// field and returned `ok: true`. The seller was told their item had been
// cross-posted while looking at a blank Poshmark form.
//
// The server hydrates the row at claim time now. This test holds the second
// half of that fix: the extension refuses an empty payload rather than trusting
// that the server will always fill it, because a guard living only on the server
// is one deploy away from not existing.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// ── Load common.js with the browser surface it expects ─────────────────────
//
// It is a content script, not a module: an IIFE that reads `globalThis.chrome`
// and assigns `self.GTLister`. Everything it touches on the page is stubbed
// here, and every stub records what it was asked to do so the assertions can be
// about behaviour rather than about not throwing.

function loadLister() {
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "lister", "common.js"),
    "utf8",
  );

  const filled = [];
  const stages = [];
  const logs = [];
  const selfObj = {};

  const chromeStub = {
    runtime: {
      sendMessage(message) {
        if (message && message.type === "GT_LISTER_STAGE") stages.push(message.stage);
        if (message && message.type === "GT_LISTER_LOG") logs.push(message.message);
        return Promise.resolve();
      },
      onMessage: { addListener() {} },
    },
  };

  const elements = new Map();
  const documentStub = {
    body: null,
    documentElement: { appendChild() {} },
    querySelector(sel) {
      return elements.get(sel) || null;
    },
    querySelectorAll(sel) {
      const el = elements.get(sel);
      return el ? [el] : [];
    },
    createElement() {
      return {
        style: {},
        setAttribute() {},
        addEventListener() {},
        appendChild() {},
        remove() {},
      };
    },
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
    Date,
    Promise,
    String,
    Array,
    Object,
    Number,
    Boolean,
    JSON,
    Math,
    fetch: () => Promise.reject(new Error("no network in this test")),
  };

  const keys = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  new Function(...keys, src)(...keys.map((k) => sandbox[k]));

  const GT = selfObj.GTLister;
  assert.ok(GT, "common.js must assign self.GTLister");

  // The two page-touching helpers are replaced wholesale. The point of this
  // test is which of them runFlow reaches, not what they do to a real DOM.
  GT.probe = () => Promise.resolve([]);
  GT.fill = (selector, value) => {
    filled.push({ selector, value });
    return true;
  };
  GT.commitTags = () => Promise.resolve({ committed: 0, total: 0 });
  GT.attachPhotos = () => Promise.resolve({ attached: 0, failed: 0, total: 0, unverified: 0 });
  GT.showBanner = () => {};
  GT.readListingUrl = () => Promise.resolve(null);

  return { GT, filled, stages, logs };
}

const FLOW = {
  enabled: true,
  version: "3",
  fields: {
    title: "#title",
    description: "#description",
    price: "#price",
    photos: "#photos",
  },
};

// CommonJS has no top-level await, so the three cases run inside one async
// main and the process exits non-zero if any of them rejects.
async function main() {
// ── 1. An empty payload is refused, and says so in the seller's words ──────
{
  const { GT, filled, stages, logs } = loadLister();
  const result = await GT.runFlow(FLOW, {
    jobId: "job-1",
    platform: "poshmark",
    platformLabel: "Poshmark",
    itemId: "11111111-1111-4111-8111-111111111111",
  });

  assert.strictEqual(result.ok, false, "an empty list payload must not report success");
  assert.strictEqual(result.reason, "empty_payload");
  assert.strictEqual(result.manual, true, "the seller finishes this one by hand");
  assert.match(
    result.error,
    /Poshmark/,
    "the refusal names the platform the seller was looking at",
  );
  assert.match(
    result.error,
    /queue it again/i,
    "a refusal with no next step is the sentence people uninstall over",
  );
  assert.strictEqual(
    filled.length,
    0,
    "NOTHING may be written to the form — a half-filled listing is worse than none",
  );
  assert.ok(
    stages.includes("failed"),
    "the worker has to hear about it, or the queue row stays 'running now' forever",
  );
  assert.ok(
    logs.some((l) => /empty list payload/i.test(l)),
    "the log line is what makes this diagnosable the next time it happens",
  );
  assert.ok(
    !stages.includes("filling"),
    "reporting 'filling' before refusing would put the lie back in a different place",
  );
}

// ── 2. A hydrated payload still runs ───────────────────────────────────────
//
// The guard is a floor, not a gate: the server-hydrated payload is the ordinary
// case and it must be untouched by any of the above.
{
  const { GT, filled, stages } = loadLister();
  const result = await GT.runFlow(FLOW, {
    jobId: "job-2",
    platform: "poshmark",
    platformLabel: "Poshmark",
    itemId: "11111111-1111-4111-8111-111111111111",
    title: "Patagonia Better Sweater, women's M",
    description: "Worn twice. No pilling.",
    price: "68",
    photoUrls: ["https://example.test/a.jpg"],
    maxPhotos: 16,
  });

  assert.notStrictEqual(
    result.reason,
    "empty_payload",
    "a payload with a title is never the empty case",
  );
  assert.ok(
    filled.some((f) => f.value === "Patagonia Better Sweater, women's M"),
    "the title still reaches the form",
  );
  assert.ok(stages.includes("filling"), "the ordinary path still reports its stage");
}

// ── 3. A delist-shaped payload is not caught by the title check ────────────
//
// `runFlow` is shared. A job that names a live listing has no title by design,
// and refusing it for that would break the feature this guard is defending.
{
  const { GT } = loadLister();
  const result = await GT.runFlow(FLOW, {
    jobId: "job-3",
    platform: "poshmark",
    platformLabel: "Poshmark",
    listingUrl: "https://poshmark.com/listing/abc123",
  });

  assert.notStrictEqual(
    result.reason,
    "empty_payload",
    "a job carrying a listing URL is not an empty list job",
  );
}

}

main().then(
  () => console.log("lister-empty-payload: ok"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
