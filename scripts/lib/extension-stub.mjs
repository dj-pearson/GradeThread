// A chrome.* stub for rendering the unified extension's pages headlessly
// (US-3053 a11y scan, US-3054 screenshots).
//
// The popup talks to the worker over runtime.sendMessage, reads storage.local,
// queries the active tab and the command shortcut. None of that exists in a
// plain page, so this module builds a `chrome` object that answers every
// message the popup sends from a FIXTURE — and, deliberately, FAILS on a
// message it does not know. A new popup message that silently returned
// `ok: true` would render an empty block that a screenshot or a scan reads as
// fine; an unknown message throwing is how the fixture stays honest.
//
// `installStub` is serialised into the page by Playwright's addInitScript, so
// it must be self-contained: no closures over module scope, no imports.

const HOUR = 3600e3;

/** Three fixture states: anonymous, buyer (signed in, no seller plan), seller with work. */
export function fixture(name, now = Date.now()) {
  const reads = [
    { url: "https://www.ebay.com/itm/1", title: "Patagonia Better Sweater 1/4 Zip Fleece Men's L Navy", marketplace: "ebay", overallScore: 8.5, gradeTier: "Excellent", confidence: 0.86, seller: "vintage_finds", claimedGrade: 9.5, at: now - 2 * HOUR },
    { url: "https://poshmark.com/listing/2", title: "Levi's 501 Original Fit Jeans 34x32 Medium Wash", marketplace: "poshmark", overallScore: 6.5, gradeTier: "Good", confidence: 0.79, seller: "closet_queen", claimedGrade: 8, at: now - 26 * HOUR },
    { url: "https://www.grailed.com/listings/3", title: "Carhartt Detroit Jacket Brown Duck Canvas XL", marketplace: "grailed", overallScore: 4.0, gradeTier: "Fair", confidence: 0.62, seller: "vintage_finds", claimedGrade: 7, at: now - 3 * 24 * HOUR },
  ];
  const caps = {
    anon: { research: true, authenticated: false, sellerEnabled: false, buyerPlan: "free", flipdeskPlan: "free", quota: { remaining: 14, limit: 20, resetsAt: null } },
    buyer: { research: true, authenticated: true, sellerEnabled: false, buyerPlan: "guard", flipdeskPlan: "free", quota: { remaining: 3, limit: 20, resetsAt: new Date(now + HOUR).toISOString() } },
    seller: { research: true, authenticated: true, sellerEnabled: true, buyerPlan: "guard", flipdeskPlan: "pro", quota: { remaining: 0, limit: 20, resetsAt: new Date(now + 40 * 60e3).toISOString() } },
  }[name];
  if (!caps) throw new Error("unknown fixture: " + name);
  const seller = name === "seller";
  return {
    caps,
    state: {
      recentReads: name === "anon" ? [] : reads,
      // compare-tray.js KEY. Entries as makeEntry stores them, so compare.html
      // renders real rows (score, price verdict, photos) rather than an empty table.
      compareTray: name === "anon" ? [] : [
        { key: "ebay|1", url: "https://www.ebay.com/itm/1", title: "Patagonia Better Sweater 1/4 Zip Fleece Men's L Navy", marketplace: "ebay", seller: "vintage_finds", priceText: "$64.00", thumbUrl: null, overallScore: 8.5, gradeTier: "Excellent", confidence: 0.86, imagesAnalyzed: 6, fairness: "fair", at: now - 2 * HOUR },
        { key: "poshmark|2", url: "https://poshmark.com/listing/2", title: "Levi's 501 Original Fit Jeans 34x32 Medium Wash", marketplace: "poshmark", seller: "closet_queen", priceText: "$38", thumbUrl: null, overallScore: 6.5, gradeTier: "Good", confidence: 0.79, imagesAnalyzed: 4, fairness: "low", at: now - 26 * HOUR },
        { key: "grailed|3", url: "https://www.grailed.com/listings/3", title: "Carhartt Detroit Jacket Brown Duck Canvas XL", marketplace: "grailed", seller: "vintage_finds", priceText: "$120", thumbUrl: null, overallScore: 4.0, gradeTier: "Fair", confidence: 0.62, imagesAnalyzed: 3, fairness: "high", at: now - 3 * 24 * HOUR },
      ],
      listerLastJob: seller ? { platform: "poshmark", kind: "list", outcome: "done", ok: true, at: now - 40 * 60e3 } : null,
      tosAcceptedAt: seller ? new Date(now - 10 * 24 * HOUR).toISOString() : null,
      tosVersion: seller ? "2026-07-13" : null,
      flipCacheByUrl: seller ? { "https://www.ebay.com/itm/123456": { at: now - 3 * HOUR, data: { decision: { recommendation: "buy", estMarginCents: 3200, roiPct: 0.8, breakevenCents: 5200, confident: true, reason: "Comps at this condition clear the asking price by $32 after fees." }, value: { lowCents: 6000, highCents: 8500, sufficient: true }, sellThrough: { label: "fast", daysLow: 7, daysHigh: 21 } } } } : {},
    },
    queue: seller ? {
      ok: true,
      pending: [
        { id: "q1", kind: "list", platform: "mercari", status: "claimed", payload: {}, created_at: new Date(now - 5 * 60e3).toISOString(), item_title: "Nike Dunk Low Panda 10.5" },
        { id: "q2", kind: "list", platform: "poshmark", status: "queued", payload: {}, created_at: new Date(now - 20 * 60e3).toISOString(), item_title: "Madewell Perfect Vintage Jean 28" },
        { id: "q3", kind: "delist", platform: "vinted", status: "queued", payload: { listingUrl: "https://www.vinted.com/items/1" }, created_at: new Date(now - 2 * HOUR).toISOString(), item_title: "Zara Wool Blend Overcoat M" },
      ],
      needsAttention: [
        { id: "q4", kind: "list", platform: "grailed", status: "failed", payload: {}, created_at: new Date(now - 8 * HOUR).toISOString(), item_title: "Stussy 8 Ball Tee Black L", result: { error: "The sell form asked for a sign-in and stayed on the login page." } },
        { id: "q5", kind: "relist", platform: "poshmark", status: "expired", payload: {}, created_at: new Date(now - 9 * 24 * HOUR).toISOString(), item_title: null },
      ],
    } : { ok: false, reason: seller ? "error" : "no-plan", pending: [], needsAttention: [] },
    stages: seller ? { q1: { stage: "photos", stagedAt: now - 60e3, tabId: 9 } } : {},
  };
}

/**
 * Runs INSIDE the page. Installs globalThis.chrome answering from `fx`.
 * Any message type not listed throws, so the harness fails loudly on a popup
 * message it has never seen rather than rendering a hole.
 */
export function installStub(fx) {
  const S = fx.state;
  const now = Date.now();
  const H = 3600e3;
  const known = {
    GT_GET_CAPABILITIES: () => fx.caps,
    GT_QUEUE_STATE: () => fx.queue,
    GT_QUEUE_JOBS: () => ({ ok: true, byQueueId: fx.stages }),
    GT_QUEUE_CANCEL: () => ({ ok: true }),
    GT_QUEUE_RETRY: () => ({ ok: true }),
    GT_QUEUE_RUN_NOW: () => ({ ok: true }),
    GT_GET_PENDING_DELISTS: () => fx.caps.sellerEnabled
      ? { ok: true, pending: [
        { item_title: "Uniqlo U Crew Neck Tee White M", platform: "mercari", requested_at: new Date(now - 4 * H).toISOString(), auto_delistable: true, listing_url: "https://www.mercari.com/us/item/1" },
        { item_title: "Everlane ReNew Parka S", platform: "grailed", requested_at: new Date(now - 30 * H).toISOString(), auto_delistable: false },
      ] }
      : { ok: false, reason: "no-plan", pending: [] },
    GT_GET_PENDING_REVISES: () => fx.caps.sellerEnabled
      ? { ok: true, pending: [
        { item_title: "Madewell Perfect Vintage Jean 28", platform: "poshmark", fields: ["price"], queued_at: new Date(now - H).toISOString(), auto_revisable: true, listing_url: "https://poshmark.com/listing/2" },
      ] }
      : { ok: false, reason: "no-plan", pending: [] },
    GT_SYNC_STATUS: () => ({ ok: true, channels: [
      { platform: "Poshmark", status: "ok", listings_seen: 42 },
      { platform: "Mercari", status: "not_signed_in", listings_seen: null },
    ] }),
    GT_POLL_STATE: () => ({ ok: true, available: true, accepted: true, enabled: true, intervalMin: 60, terms: [] }),
    GT_POLL_ACCEPT: () => ({ ok: true }),
    GT_POLL_REVOKE: () => ({ ok: true }),
    GT_POLL_INTERVAL: () => ({ ok: true }),
    GT_ENGAGE_STATE: () => ({ ok: true, accepted: true, engageEnabled: true, meter: { label: "Shares today", pct: 34, atCap: false, note: "1,700 of 5,000. At 5,000 GradeThread stops for the day, well short of share jail." }, settings: { pacingFloorMs: 1400 }, lastRun: { ok: true, done: 120, action: "share" } }),
    GT_ENGAGE_ACCEPT: () => ({ ok: true }),
    GT_ENGAGE_REVOKE: () => ({ ok: true }),
    GT_ENGAGE_SETTINGS: () => ({ ok: true }),
    GT_ENGAGE_START: () => ({ ok: true }),
    GT_ENGAGE_STOP: () => ({ ok: true }),
    GT_CC_RUN_ACTIVE: () => ({ ok: true }),
    GT_CC_APPRAISE: () => ({ ok: false, status: 402, needsUpgrade: true, error: "FlipDesk plan required." }),
    GT_CC_USAGE: () => ({ ok: true }),
  };
  const respond = (msg) => {
    const t = msg && msg.type;
    if (!known[t]) throw new Error("extension-stub: unknown message " + t);
    return known[t](msg);
  };
  const api = {
    runtime: {
      id: "stubbedextensionid",
      getManifest: () => ({ version: "0.0.0-stub" }),
      sendMessage: (m) => Promise.resolve(respond(m)),
      getURL: (p) => "chrome-extension://stub/" + p,
      openOptionsPage: () => {},
      onMessage: { addListener: () => {} },
    },
    storage: {
      local: {
        get: (keys) => { const k = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(S); const o = {}; for (const x of k) if (x in S && S[x] != null) o[x] = S[x]; return Promise.resolve(o); },
        set: (o) => { Object.assign(S, o); return Promise.resolve(); },
        remove: (k) => { for (const x of [].concat(k)) delete S[x]; return Promise.resolve(); },
      },
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1, url: "https://www.ebay.com/itm/123456" }]),
      create: () => Promise.resolve(),
      sendMessage: () => Promise.resolve(null),
      get: () => Promise.resolve({ status: "complete" }),
      reload: () => Promise.resolve(),
    },
    commands: { getAll: () => Promise.resolve([{ name: "run-condition-read", shortcut: "Alt+G" }]) },
    permissions: { contains: () => Promise.resolve(true) },
  };
  globalThis.chrome = api;
  globalThis.__gtStub = { unknown: [] };
}

/** Where the pre-installed Chromium lives when Playwright's own download is absent. */
export async function launchChromium(chromium) {
  try {
    return await chromium.launch();
  } catch (err) {
    const fallback = process.env.GT_CHROMIUM || "/opt/pw-browsers/chromium";
    try {
      return await chromium.launch({ executablePath: fallback });
    } catch {
      throw err;
    }
  }
}
