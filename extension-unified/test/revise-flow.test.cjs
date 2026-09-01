// GradeThread Lister — edit sync (US-9202): the revise flow's contract.
//
// Four things, each the kind that decays quietly:
//   1. every extension channel with a list flow declares a `revise` flow, and
//      it stays OFF until a human verifies it (enabled:false, lastVerified:null);
//   2. runReviseFlow never reports applied without evidence, degrades to
//      "edit manually" on a disabled flow, and refuses a partial write;
//   3. the job store carries the kind and the marker id;
//   4. the background accepts GT_LISTER_REVISE from the web, host-pins the URL
//      like a delist, drains the pending list one job at a time behind the
//      seller gate, and confirms the outcome to the marker.

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

// ── 1. Every listing channel declares revise, off, unverified ──────────────
{
  const withList = Object.entries(SEL).filter(([, c]) => c.enabled);
  assert.ok(withList.length >= 4, "expected at least four enabled list channels");
  for (const [platform, cfg] of withList) {
    const r = cfg.revise;
    assert.ok(r, `${platform}: an enabled list channel must declare a revise flow`);
    assert.strictEqual(r.enabled, false, `${platform}.revise must stay off until verified on the live editor`);
    assert.strictEqual(r.lastVerified, null, `${platform}.revise: lastVerified must be null while off`);
    assert.ok(/draft/.test(r.version), `${platform}.revise: version should say draft while unverified`);
    assert.deepStrictEqual(r.required, ["edit"], `${platform}.revise: only edit exists pre-interaction`);
    assert.ok(r.edit && r.save && r.navigatesTo, `${platform}.revise: edit, save and navigatesTo`);
    for (const key of ["title", "description", "price"]) {
      assert.ok(r.fields && r.fields[key], `${platform}.revise.fields.${key}`);
    }
    assert.ok(r.verify && (r.verify.urlChanged || r.verify.toast), `${platform}.revise: verify evidence`);
    // navigatesTo must never match the listing page itself, or page 1 would
    // think it had already arrived on the editor and type into the listing.
    const re = new RegExp(r.navigatesTo, "i");
    const host = cfg.hosts[0];
    assert.ok(!re.test(`https://${host}/listing/abc`), `${platform}.revise.navigatesTo matches a listing page`);
    assert.ok(!re.test(`https://www.${host}/item/m123`), `${platform}.revise.navigatesTo matches an item page`);
  }
}

// ── 2. runReviseFlow: evidence or nothing ──────────────────────────────────
//
// common.js runs against a stub document. Elements are plain objects with the
// two things GT.fill and click() need.
function loadGT(page) {
  const src = fs.readFileSync(path.join(dir, "lister/common.js"), "utf8");
  const clicked = [];
  class HTMLTextAreaElement {}
  class HTMLInputElement {
    constructor(id) { this.id = id; this.value = ""; }
    dispatchEvent() { return true; }
    click() { clicked.push(this.id); if (page.onClick) page.onClick(this.id); }
    closest() { return null; }
  }
  const els = {};
  for (const [sel, id] of Object.entries(page.els || {})) els[sel] = new HTMLInputElement(id);
  const document = {
    querySelector(sel) {
      for (const part of String(sel).split(",")) {
        const k = part.trim();
        if (els[k] && !(page.absent && page.absent.includes(k))) return els[k];
      }
      return null;
    },
    querySelectorAll() { return []; },
    body: { appendChild() {}, querySelector() { return null; } },
    createElement() {
      return { style: {}, setAttribute() {}, appendChild() {}, remove() {}, textContent: "" };
    },
    getElementById() { return null; },
  };
  const location = { href: page.href, origin: new URL(page.href).origin, pathname: new URL(page.href).pathname };
  const sent = [];
  const chrome = {
    runtime: {
      sendMessage: (m) => { sent.push(m); return Promise.resolve({ ok: true }); },
    },
  };
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
  // Make verify's urlChanged testable: the test flips href when told to.
  return { GT, clicked, sent, els, location };
}

const FLOW = {
  enabled: true,
  version: "test",
  required: ["edit"],
  edit: "a.edit",
  navigatesTo: "^https://poshmark\\.com/edit-listing/",
  fields: { title: "input.title", description: "textarea.desc", price: "input.price" },
  save: "button.save",
  verify: { urlChanged: true, toast: ".toast" },
  timeouts: { control: 20, verify: 60 },
};
const PAYLOAD = {
  platform: "poshmark", platformLabel: "Poshmark", jobId: "j1",
  fields: ["price", "title"], price: 24, title: "New title", description: "d",
};

(async () => {
  // a. Disabled flow → manual, nothing touched, never ok.
  {
    const { GT, clicked } = loadGT({ href: "https://poshmark.com/listing/x", els: { "a.edit": "edit" } });
    const out = await GT.runReviseFlow({ ...FLOW, enabled: false }, PAYLOAD);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.manual, true);
    assert.ok(/manually/.test(out.error));
    assert.deepStrictEqual(clicked, [], "a disabled flow must not click anything");
  }

  // b. Page 1: probes edit, records the stage FIRST, clicks it, defers.
  {
    const { GT, clicked, sent } = loadGT({ href: "https://poshmark.com/listing/x", els: { "a.edit": "edit" } });
    const out = await GT.runReviseFlow(FLOW, PAYLOAD);
    assert.deepStrictEqual(out, { deferred: true });
    assert.deepStrictEqual(clicked, ["edit"]);
    assert.ok(sent.some((m) => m.type === "GT_LISTER_STAGE" && m.stage === "navigated" && m.jobId === "j1"),
      "the stage is recorded before the link is followed");
  }

  // c. Page 1 without the edit control → manual, nothing clicked.
  {
    const { GT, clicked } = loadGT({ href: "https://poshmark.com/listing/x", els: {} });
    const out = await GT.runReviseFlow(FLOW, PAYLOAD);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.manual, true);
    assert.ok(/can't find: edit/.test(out.error));
    assert.deepStrictEqual(clicked, []);
  }

  // d. Page 2 on the WRONG page → stop, type nothing.
  {
    const { GT, clicked } = loadGT({
      href: "https://poshmark.com/closet/me",
      els: { "input.title": "title", "input.price": "price", "button.save": "save" },
    });
    const out = await GT.runReviseFlow(FLOW, { ...PAYLOAD, stage: "navigated" });
    assert.strictEqual(out.ok, false);
    assert.ok(/unexpected page/.test(out.error));
    assert.deepStrictEqual(clicked, []);
  }

  // e. Page 2 happy path: fills the wanted fields only, saves, proves it.
  {
    const page = {
      href: "https://poshmark.com/edit-listing/x",
      els: { "input.title": "title", "textarea.desc": "desc", "input.price": "price", "button.save": "save" },
    };
    const h = loadGT(page);
    page.onClick = (id) => { if (id === "save") h.location.href = "https://poshmark.com/listing/x"; };
    const out = await h.GT.runReviseFlow(FLOW, { ...PAYLOAD, stage: "navigated" });
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(out.revised, true);
    assert.deepStrictEqual(out.fields, ["price", "title"]);
    assert.strictEqual(out.verifiedBy, "navigated");
    assert.strictEqual(h.els["input.price"].value, "24");
    assert.strictEqual(h.els["input.title"].value, "New title");
    assert.strictEqual(h.els["textarea.desc"].value, "", "a field not in payload.fields is left alone");
    assert.deepStrictEqual(h.clicked, ["save"]);
  }

  // f. Save clicked, no evidence → unverified, never applied.
  {
    const h = loadGT({
      href: "https://poshmark.com/edit-listing/x",
      els: { "input.title": "title", "input.price": "price", "button.save": "save" },
    });
    const out = await h.GT.runReviseFlow(FLOW, { ...PAYLOAD, stage: "navigated" });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.unverified, true);
    assert.strictEqual(out.manual, true);
    assert.deepStrictEqual(h.clicked, ["save"]);
  }

  // g. A field that could not be written is a PARTIAL: reported, not applied.
  {
    const page = {
      href: "https://poshmark.com/edit-listing/x",
      els: { "input.title": "title", "button.save": "save" }, // no price input
    };
    const h = loadGT(page);
    page.onClick = (id) => { if (id === "save") h.location.href = "https://poshmark.com/listing/x"; };
    const out = await h.GT.runReviseFlow(FLOW, { ...PAYLOAD, stage: "navigated" });
    assert.strictEqual(out.ok, false, "a partial write must not read as applied");
    assert.strictEqual(out.partial, true);
    assert.deepStrictEqual(out.fields, ["title"]);
    assert.ok(/not price/.test(out.error), out.error);
  }

  // h. Nothing writable → manual, save never clicked.
  {
    const h = loadGT({ href: "https://poshmark.com/edit-listing/x", els: { "button.save": "save" } });
    const out = await h.GT.runReviseFlow(FLOW, { ...PAYLOAD, stage: "navigated" });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.manual, true);
    assert.deepStrictEqual(h.clicked, [], "with nothing written there is nothing to save");
  }

  // i. Photos are never written by the flow; they are reported for the seller.
  {
    const page = { href: "https://poshmark.com/edit-listing/x", els: { "input.price": "price", "button.save": "save" } };
    const h = loadGT(page);
    page.onClick = (id) => { if (id === "save") h.location.href = "https://poshmark.com/listing/x"; };
    const out = await h.GT.runReviseFlow(FLOW, { ...PAYLOAD, fields: ["price", "photos"], stage: "navigated" });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.partial, true);
    assert.ok(/not photos/.test(out.error));
  }

  // ── 3. The job store carries the kind and the marker id ───────────────
  {
    const job = JOBS.makeJob({ jobId: "r1", kind: "revise", platform: "poshmark", payload: { fields: ["price"] }, reviseListingId: "L1", now: 0 });
    assert.strictEqual(job.kind, "revise");
    assert.strictEqual(job.reviseListingId, "L1");
    assert.strictEqual(JOBS.makeJob({ jobId: "r2", kind: "revise", platform: "poshmark", now: 0 }).reviseListingId, null);
    assert.ok(JOBS.RUNNABLE_QUEUE_KINDS.revise === true, "the mobile queue may carry a revise");
    const fromRow = JOBS.jobFromQueueRow(
      { id: "q1", kind: "revise", platform: "mercari", listing_id: "L2", payload: { fields: ["title"], listingUrl: "https://www.mercari.com/item/m1" }, created_at: "2026-09-01" },
      { jobId: "j", tabId: 3, now: 0 },
    );
    assert.strictEqual(fromRow.kind, "revise");
    assert.strictEqual(fromRow.reviseListingId, "L2");
    assert.strictEqual(fromRow.payload.listingId, "L2");
    const timeout = JOBS.timeoutResultFor(job, "Poshmark");
    assert.strictEqual(timeout.unverified, true, "a timed-out revise is unverified, never applied");
    assert.ok(/Timed out updating/.test(timeout.error));
    assert.ok(/listing was updated/.test(JOBS.tabClosedResultFor(job, "Poshmark").error));
    assert.strictEqual(typeof JOBS.isPending, "function", "the drain needs isPending to serialise jobs");
  }

  // ── 4. Background wiring ─────────────────────────────────────────────
  {
    const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
    const external = /const EXTERNAL_TYPES = new Set\(\[([\s\S]*?)\]\);/.exec(bg);
    assert.ok(external && /"GT_LISTER_REVISE"/.test(external[1]), "GT_LISTER_REVISE must be accepted from the web");
    assert.ok(/function isValidRevisePayload\(/.test(bg));
    const validator = bg.slice(bg.indexOf("function isValidRevisePayload("), bg.indexOf("function isValidRevisePayload(") + 600);
    assert.ok(/isAllowedDelistUrl/.test(validator), "a revise URL is host-pinned exactly like a delist URL");
    assert.ok(/Array\.isArray\(p\.fields\)/.test(validator), "a revise names its fields");
    assert.ok(/function handleReviseRequest\(/.test(bg));
    assert.ok(/startJob\("revise"/.test(bg));
    assert.ok(/async function drainPendingRevises\(/.test(bg));
    const drain = bg.slice(bg.indexOf("async function drainPendingRevises("), bg.indexOf("// ── selector-failure telemetry"));
    assert.ok(/sellerAllowed\(\)/.test(drain) && /tosAccepted\(\)/.test(drain), "the drain runs behind the seller gate and the clickwrap");
    assert.ok(/revise\.enabled/.test(drain), "the drain never runs a channel whose revise flow is off");
    assert.ok(/isPending\(/.test(drain), "the drain waits for any running Lister job");
    assert.ok(/active: false/.test(drain), "the drain opens its tab unfocused");
    assert.ok(/void drainPendingRevises\(\)/.test(bg), "the sweep tick drains pending revises");
    const report = bg.slice(bg.indexOf("async function reportJob("), bg.indexOf("async function reportJob(") + 1800);
    assert.ok(/job\.kind === "revise" && job\.reviseListingId/.test(report), "reportJob confirms the marker for a revise");
    const confirm = bg.slice(bg.indexOf("async function confirmRevise("), bg.indexOf("async function confirmRevise(") + 1200);
    assert.ok(/result\.ok === true && result\.revised === true/.test(confirm), "applied is sent only when the flow proved it");
    assert.ok(/case "GT_GET_PENDING_REVISES"/.test(bg), "the popup can read the count");
    // The drain's target comes from the server's pending list and is validated
    // before a tab opens; the queue drain host-pins revise rows like delists.
    assert.ok(/row\.kind === "delist" \|\| row\.kind === "revise"/.test(bg), "queue rows of kind revise open their listing URL under the delist guard");

    const popup = fs.readFileSync(path.join(dir, "popup.js"), "utf8");
    assert.ok(/async function renderPendingRevises\(/.test(popup) && /renderPendingRevises\(caps\)/.test(popup));
    const html = fs.readFileSync(path.join(dir, "popup.html"), "utf8");
    assert.ok(/id="reviseBlock"/.test(html) && /id="reviseCount"/.test(html));
  }

  console.log("revise-flow.test.cjs: four channels declare revise (off, unverified); the flow proves or refuses; jobs and background carry the marker");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
