// US-2738: what the fill REPORTS about the photos, and what the seller standing
// on the form is told.
//
// attachPhotos learned to ask the page (attach-photos-page-witness.test.cjs).
// Two things were still wrong with the answer once it left that function.
//
// 1. THE ANSWER WAS THROWN AWAY AT THE runFlow BOUNDARY. `confirmed` was logged
//    to a console in a tab the worker closes and never put in the result, so the
//    persisted job row could not tell "the page rendered our photos" from "no
//    flow on this channel can ask, and nobody checked". Both read as a clean
//    attach. That is the story's own sentence one level further out: a claim
//    with no witness behind it, indistinguishable from one with a witness.
//    `photosWitness` is the tri-state that makes the difference readable, and
//    "not-asked" is the honest word for the four channels that declare no
//    preview selector. It warns nobody - it is a record, not a message.
//
// 2. THE SELLER WAS LOOKING AT A SUCCESS BANNER OVER A LISTING WITH NO IMAGES.
//    The price miss has had a banner since US-2477 on the reasoning that the
//    seller is on the form right now and is about to post. The photo miss had
//    only the counts sent home, and on Poshmark the price dialog runs FIRST and
//    rewrites the banner to "including the price - review it and post." So a
//    run where every photo failed ended with a reassuring banner on screen.
//    Photos are the one thing a buyer sees.
//
// Zero dependencies, discovered by scripts/test-extensions.mjs.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "lister", "common.js");

// Loads common.js and hands back runFlow with everything below it stubbed, so
// each case controls exactly one thing: what attachPhotos reported.
function loadFlow(photoResult, opts) {
  const o = opts || {};
  const src = fs.readFileSync(SRC, "utf8");
  const banners = [];
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
  GT.readListingUrl = () => Promise.resolve(null);
  GT.showBanner = (t) => { banners.push(String(t)); };
  GT.fillPriceDialog = () => Promise.resolve(o.priceDialogFills !== false);
  GT.attachPhotos = () => Promise.resolve(photoResult);
  return { GT, banners };
}

const EIGHT = ["1.jpg", "2.jpg", "3.jpg", "4.jpg", "5.jpg", "6.jpg", "7.jpg", "8.jpg"];

function poshFlow(extra) {
  return Object.assign({
    enabled: true,
    version: "3",
    fields: { title: "#title", photoInput: "#img-file-input" },
    priceDialog: { open: "#open", price: "#p" },
  }, extra || {});
}

function payload() {
  return {
    jobId: "job-1",
    platform: "poshmark",
    platformLabel: "Poshmark",
    title: "Levi's 501 straight leg",
    price: "32",
    photoUrls: EIGHT,
    maxPhotos: 8,
    itemId: "11111111-1111-4111-8111-111111111111",
  };
}

// The three shapes attachPhotos can return, named once.
const CONFIRMED = { attached: 8, failed: 0, total: 8, unverified: 0, confirmed: true, asked: true };
const PAGE_SAID_NO = { attached: 0, failed: 8, total: 8, unverified: 0, confirmed: false, asked: true };
const NOT_ASKED_OK = { attached: 8, failed: 0, total: 8, unverified: 0, confirmed: false, asked: false };
const NOT_ASKED_PARTIAL = { attached: 6, failed: 2, total: 8, unverified: 0, confirmed: false, asked: false };
const NOTHING_TO_DO = { attached: 0, failed: 0, total: 0, unverified: 0, confirmed: false, asked: false };

(async () => {
  // 0. The harness must actually reach the photo reporting.
  {
    const { GT } = loadFlow(CONFIRMED);
    const res = await GT.runFlow(poshFlow(), payload());
    assert.strictEqual(
      res.photosTotal, 8,
      "harness check: the stubbed attachPhotos result must reach the returned " +
        "record, or nothing below this proves anything",
    );
  }

  // 1. THE GAP: a channel nobody can ask must not report like one that answered.
  {
    const { GT } = loadFlow(NOT_ASKED_OK);
    const res = await GT.runFlow(poshFlow(), payload());
    assert.strictEqual(
      res.photosWitness, "not-asked",
      "THE BUG: this flow declares no way to ask the page, so the only thing " +
        "saying the photos landed is the browser confirming it took a file " +
        "selection. The record has to say that plainly. Reporting it exactly " +
        "like a run the page confirmed is US-2738's own failure shape moved out " +
        "one level - a claim with no witness, indistinguishable from one with a " +
        "witness, which is what made the original silent success survive.",
    );
    assert.strictEqual(
      res.photosAttached, true,
      "'we could not check' is not 'it failed' - flipping this would cry wolf " +
        "on four channels that have always worked",
    );
  }

  // 2. The page answered yes.
  {
    const { GT } = loadFlow(CONFIRMED);
    const res = await GT.runFlow(poshFlow({ photoConfirm: true }), payload());
    assert.strictEqual(
      res.photosWitness, "page",
      "the page rendered a preview out of our bytes, and that is the only " +
        "witness in this story we did not write ourselves",
    );
    assert.strictEqual(res.photosAttached, true);
  }

  // 3. The page answered no. This is AC8's answer, readable off the job row.
  {
    const { GT } = loadFlow(PAGE_SAID_NO);
    const res = await GT.runFlow(poshFlow({ photoConfirm: true }), payload());
    assert.strictEqual(
      res.photosWitness, "none",
      "asked and refused is a different fact from never asked, and AC8 is " +
        "exactly the question of which one Poshmark does. Recording it means " +
        "the operator reads a stored row rather than a console line in a tab " +
        "the worker already closed.",
    );
    assert.strictEqual(res.photosAttached, false);
    assert.strictEqual(res.photosFailed, 8);
  }

  // 4. Nothing to attach says nothing at all.
  {
    const { GT } = loadFlow(NOTHING_TO_DO);
    const flow = poshFlow();
    delete flow.fields.photoInput;
    const res = await GT.runFlow(flow, payload());
    assert.strictEqual(
      res.photosWitness, undefined,
      "a channel with no photo input never tried, so there is no witness " +
        "question to answer - sending one would be noise in every record",
    );
  }

  // 5. THE SECOND GAP: the seller is told, on the page, while they can fix it.
  {
    const { GT, banners } = loadFlow(PAGE_SAID_NO);
    await GT.runFlow(poshFlow({ photoConfirm: true }), payload());
    const last = banners[banners.length - 1] || "";
    assert.match(
      last, /photo/i,
      "THE BUG: every photo failed and the last banner on screen said the " +
        "listing was prefilled and ready to post. Poshmark's price dialog runs " +
        "before the photos and rewrites the banner, so a total photo failure " +
        "ended with a success message over a listing with no images. The " +
        "counts went home to the SaaS; the seller was on the marketplace tab.",
    );
    assert.match(
      last, /drag/i,
      "the banner has to say what to do about it, like the price one does",
    );
  }

  // 6. A partial attach names the numbers.
  {
    const { GT, banners } = loadFlow(NOT_ASKED_PARTIAL);
    await GT.runFlow(poshFlow(), payload());
    const last = banners[banners.length - 1] || "";
    assert.match(
      last, /6 of 8/,
      "'6 of 8' is the difference between the seller fixing it now and a buyer " +
        "finding out later - the same contract photoNote has had since US-1877",
    );
  }

  // 7. The cry-wolf guard: a clean run keeps its clean banner.
  {
    const { GT, banners } = loadFlow(CONFIRMED);
    await GT.runFlow(poshFlow({ photoConfirm: true }), payload());
    const last = banners[banners.length - 1] || "";
    assert.doesNotMatch(
      last, /drag/i,
      "a run where every photo landed must not warn about photos, or the " +
        "warning stops meaning anything",
    );
    assert.match(last, /review it and post/i, "the success banner survives a good attach");
  }

  // 7b. Not asked and nothing failed is still not a warning.
  {
    const { GT, banners } = loadFlow(NOT_ASKED_OK);
    await GT.runFlow(poshFlow(), payload());
    const last = banners[banners.length - 1] || "";
    assert.doesNotMatch(
      last, /drag/i,
      "'not-asked' is a record, not a message. Four channels have never had a " +
        "preview watched on them and must gain no new warning.",
    );
  }

  // 8. A photo banner must not erase the price warning underneath it.
  {
    // showBanner replaces the bar rather than stacking, so the photo message
    // written after the price message would silently delete it. Two misses in
    // one run is exactly when the seller needs both.
    const { GT, banners } = loadFlow(PAGE_SAID_NO, { priceDialogFills: false });
    await GT.runFlow(poshFlow({ photoConfirm: true }), payload());
    const last = banners[banners.length - 1] || "";
    assert.match(last, /photo/i, "the photo miss is in the final banner");
    assert.match(
      last, /price/i,
      "the price warning was on the bar and the photo warning replaced it. " +
        "Losing the money field to a photo message is a worse trade than the " +
        "one it was meant to fix.",
    );
  }

  console.log(
    "attach-photos-report-witness.test.cjs: the record says which witness " +
      "answered, and a photo miss reaches the seller on the form",
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
