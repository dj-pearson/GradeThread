// GradeThread Lister — relist by copying (US-9203): the flow's contract.
//
//   1. Poshmark and Mercari declare a `relist` flow, OFF until verified;
//   2. runRelistFlow follows the copy link with the stage recorded first, opens
//      the copy's form and hands it to the seller, and never claims a listing
//      went live (that is the live-URL watch's job);
//   3. the job store and the background carry the kind, the watch carries the
//      new row's id, and a captured URL is confirmed to the server.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

function loadGlobal(rel, name) {
  const src = fs.readFileSync(path.join(dir, rel), "utf8");
  const scope = {};
  return new Function("self", `${src}; return self.${name};`)(scope);
}

const SEL = loadGlobal("lister/selectors.js", "GT_LISTER_SELECTORS");
const JOBS = loadGlobal("lister/job-store.js", "GT_LISTER_JOBS");

// ── 1. Declared, off, unverified ───────────────────────────────────────────
for (const platform of ["poshmark", "mercari"]) {
  const r = SEL[platform].relist;
  assert.ok(r, `${platform}: must declare a relist flow`);
  assert.strictEqual(r.enabled, false, `${platform}.relist stays off until verified on a live owned listing`);
  assert.strictEqual(r.lastVerified, null);
  assert.deepStrictEqual(r.required, ["copy"]);
  assert.ok(r.copy && r.navigatesTo);
  const re = new RegExp(r.navigatesTo, "i");
  assert.ok(!re.test(`https://${SEL[platform].hosts[0]}/listing/abc`), `${platform}.relist.navigatesTo matches a listing page`);
  // The copy's form must not itself read as a LIVE listing, or the watch would
  // capture the form as the new listing.
  const live = new RegExp(SEL[platform].liveListingUrlPattern, "i");
  const formUrl = platform === "poshmark" ? "https://poshmark.com/create-listing" : "https://www.mercari.com/sell/";
  assert.ok(re.test(formUrl), `${platform}: the copy's form URL should satisfy navigatesTo`);
  assert.ok(!live.test(formUrl), `${platform}: the copy's form must not look like a live listing`);
}

// ── 2. runRelistFlow ──────────────────────────────────────────────────────
function loadGT(page) {
  const src = fs.readFileSync(path.join(dir, "lister/common.js"), "utf8");
  const clicked = [];
  class HTMLTextAreaElement {}
  class HTMLInputElement {
    constructor(id) { this.id = id; this.value = ""; }
    dispatchEvent() { return true; }
    click() { clicked.push(this.id); }
    closest() { return null; }
  }
  const els = {};
  for (const [sel, id] of Object.entries(page.els || {})) els[sel] = new HTMLInputElement(id);
  const document = {
    querySelector(sel) {
      for (const part of String(sel).split(",")) {
        const k = part.trim();
        if (els[k]) return els[k];
      }
      return null;
    },
    querySelectorAll() { return []; },
    body: { appendChild() {}, querySelector() { return null; } },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {}, remove() {}, textContent: "" }; },
    getElementById() { return null; },
  };
  const location = { href: page.href, origin: new URL(page.href).origin, pathname: new URL(page.href).pathname };
  const sent = [];
  const chrome = { runtime: { sendMessage: (m) => { sent.push(m); return Promise.resolve({ ok: true }); } } };
  const fn = new Function(
    "self", "document", "location", "Event", "KeyboardEvent", "HTMLInputElement",
    "HTMLTextAreaElement", "setTimeout", "clearTimeout", "console", "globalThis", "chrome", "window",
    src + "; return self.GTLister;",
  );
  const GT = fn(
    {}, document, location,
    class Event { constructor(t) { this.type = t; } },
    class KeyboardEvent { constructor(t, o) { Object.assign(this, o); this.type = t; } },
    HTMLInputElement, HTMLTextAreaElement,
    (f, ms) => setTimeout(f, Math.min(ms || 0, 5)), clearTimeout,
    { log() {}, warn() {}, error() {}, debug() {}, info() {} },
    { chrome, browser: undefined }, chrome, { location },
  );
  return { GT, clicked, sent };
}

const FLOW = {
  enabled: true, version: "test", required: ["copy"], copy: "a.copy",
  navigatesTo: "^https://poshmark\\.com/create-listing", timeouts: { control: 20 },
};
const PAYLOAD = { platform: "poshmark", platformLabel: "Poshmark", jobId: "r1", newListingId: "N1", listingId: "L1" };

(async () => {
  // a. Disabled → manual, nothing clicked, never ok.
  {
    const { GT, clicked } = loadGT({ href: "https://poshmark.com/listing/x", els: { "a.copy": "copy" } });
    const out = await GT.runRelistFlow({ ...FLOW, enabled: false }, PAYLOAD);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.manual, true);
    assert.ok(/manually/.test(out.error));
    assert.deepStrictEqual(clicked, []);
  }
  // b. Page 1: probe, record stage, click copy, defer.
  {
    const { GT, clicked, sent } = loadGT({ href: "https://poshmark.com/listing/x", els: { "a.copy": "copy" } });
    const out = await GT.runRelistFlow(FLOW, PAYLOAD);
    assert.deepStrictEqual(out, { deferred: true });
    assert.deepStrictEqual(clicked, ["copy"]);
    assert.ok(sent.some((m) => m.type === "GT_LISTER_STAGE" && m.stage === "navigated" && m.jobId === "r1"));
  }
  // c. Page 1 without the copy control → manual.
  {
    const { GT, clicked } = loadGT({ href: "https://poshmark.com/listing/x", els: {} });
    const out = await GT.runRelistFlow(FLOW, PAYLOAD);
    assert.strictEqual(out.ok, false);
    assert.ok(/can't find: copy/.test(out.error));
    assert.deepStrictEqual(clicked, []);
  }
  // d. Page 2 on the wrong page → stop.
  {
    const { GT } = loadGT({ href: "https://poshmark.com/closet/me", els: {} });
    const out = await GT.runRelistFlow(FLOW, { ...PAYLOAD, stage: "navigated" });
    assert.strictEqual(out.ok, false);
    assert.ok(/unexpected page/.test(out.error));
  }
  // e. Page 2 on the copy's form → copied, never "listed".
  {
    const { GT } = loadGT({ href: "https://poshmark.com/create-listing?copy=x", els: {} });
    const out = await GT.runRelistFlow(FLOW, { ...PAYLOAD, stage: "navigated" });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.copied, true);
    assert.strictEqual(out.listed, undefined, "the flow never claims the copy went live");
    assert.strictEqual(out.listingUrl, undefined);
  }

  // ── 3. Job store + watch ────────────────────────────────────────────
  {
    const job = JOBS.makeJob({ jobId: "j", kind: "relist", platform: "poshmark", payload: PAYLOAD, now: 0 });
    assert.strictEqual(job.kind, "relist");
    assert.ok(JOBS.RUNNABLE_QUEUE_KINDS.relist === true);
    const w = JOBS.makeWatch({ tabId: 1, platform: "poshmark", itemId: "I1", relistNewListingId: "N1", queueId: "q1", now: 0 });
    assert.strictEqual(w.relistNewListingId, "N1");
    assert.strictEqual(w.queueId, "q1");
    assert.strictEqual(JOBS.makeWatch({ tabId: 1, platform: "poshmark", now: 0 }).relistNewListingId, null);
    assert.ok(/Timed out copying/.test(JOBS.timeoutResultFor(job, "Poshmark").error));
    assert.ok(/listing was copied/.test(JOBS.tabClosedResultFor(job, "Poshmark").error));
    const fromRow = JOBS.jobFromQueueRow(
      { id: "q2", kind: "relist", platform: "mercari", listing_id: "L2", payload: { listingUrl: "https://www.mercari.com/item/m1", newListingId: "N2" }, created_at: "2026-09-01" },
      { jobId: "j2", tabId: 3, now: 0 },
    );
    assert.strictEqual(fromRow.kind, "relist");
    assert.strictEqual(fromRow.payload.newListingId, "N2");
  }

  // ── 4. Background wiring ────────────────────────────────────────────
  {
    const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
    const external = /const EXTERNAL_TYPES = new Set\(\[([\s\S]*?)\]\);/.exec(bg);
    assert.ok(external && /"GT_LISTER_RELIST"/.test(external[1]));
    const validator = bg.slice(bg.indexOf("function isValidRelistPayload("), bg.indexOf("function isValidRelistPayload(") + 700);
    assert.ok(/isAllowedDelistUrl/.test(validator), "a relist URL is host-pinned like a delist URL");
    assert.ok(/newListingId/.test(validator), "a relist names the server's new row");
    assert.ok(/startJob\("relist"/.test(bg));
    assert.ok(/job\.kind === "relist" && out\.ok && out\.copied\) await startListedWatch\(job\)/.test(bg), "a copied form starts the live-URL watch");
    assert.ok(/relistNewListingId: job\.kind === "relist"/.test(bg), "the watch carries the new row id");
    assert.ok(/if \(watch\.relistNewListingId\) \{[\s\S]*?confirmRelistListed\(watch\.relistNewListingId, url\)/.test(bg), "a captured URL is confirmed to the server");
    assert.ok(/async function confirmRelistListed\(/.test(bg) && /RELIST_LISTED_ENDPOINT/.test(bg));
    assert.ok(/row\.kind === "delist" \|\| row\.kind === "revise" \|\| row\.kind === "relist"/.test(bg), "queue relist rows open their listing URL under the delist guard");
  }

  console.log("relist-flow.test.cjs: two channels declare relist (off); the flow copies and defers; the watch confirms the copy server-side");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
