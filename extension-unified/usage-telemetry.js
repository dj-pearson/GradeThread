// GradeThread unified extension — opt-in anonymous usage telemetry (US-1757 AC2).
//
// WHY THIS FILE EXISTS.
//
// US-1753 tagged every outbound link so a SIGNUP can be traced to the extension.
// That measures the bottom of the funnel and nothing above it. Nobody could
// answer the two questions the store listing is actually judged on — do installs
// produce reads, and do reads produce clicks back to gradethread.com — because
// the extension counted neither. An install/uninstall number from a store
// dashboard with nothing in between is not a funnel.
//
// This is that missing middle, and it is deliberately the SMALLEST thing that
// answers it: two counters.
//
// WHAT IT IS NOT. It is not an event stream. Nothing here records WHEN a read
// happened, WHICH listing it was, or in what order anything occurred — a
// timestamped stream of "read, read, click" from one install is a browsing
// trail, which is the thing we promise not to build. Instead events are TALLIED
// ON THE DEVICE and only a bag of totals is ever sent:
//
//     { "read": 12, "click_through:overlay": 2 }
//
// The window is hours long, so the send carries no usable timing, and there is
// no install id, no account, no URL, and no free-text field to smuggle one into.
// The counters saturate (MAX_COUNT) so a runaway loop can't turn a tally back
// into a high-resolution signal.
//
// SEPARATE CONSENT FROM THE SELECTOR-HEALTH TOGGLE, ON PURPOSE. That toggle
// (US-1880) says, in its own words, that it sends "only the marketplace name and
// which part failed". Folding usage counts under it would retroactively widen a
// consent people already gave for something narrower — the exact "toggle you
// feel tricked by later" that popup.html's comment warns about. Same PATTERN
// (versioned key, off by default, revocable, re-read on every send), separate
// decision, separate checkbox, separate line in the privacy policy.
//
// Loaded as a classic script in every world that can produce an event: the
// background worker/event page, the extension pages, and the research content
// script. The UMD shim gives node's require() a module.exports for the tests.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node
  if (typeof root !== "undefined") root.GT_USAGE = api; // every browser world
})(typeof self !== "undefined" ? self : this, function () {
  // storage.local keys. Consent is its OWN key so revoking it is a delete, not a
  // stored `false` — nothing is left behind to be misread later.
  const CONSENT_KEY = "usageTelemetry";
  const BATCH_KEY = "usageTelemetryBatch";

  // The whole vocabulary. Anything not in here is dropped rather than sent, and
  // the server enforces the same closed list — the client is not trusted to be
  // the only guard (a modified extension must not be able to widen this).
  const EVENTS = ["read", "click_through"];
  // A click's surface, which is the SAME word already on the link as utm_medium
  // (attribution.js). Reporting the surface is what separates "the overlay
  // converts" from "the popup converts"; it is a bounded enum, not free text.
  const SURFACES = ["popup", "overlay", "flip", "onboarding"];

  // Send at most every 6 hours, or once a batch reaches 50 events. Both bounds
  // matter: the interval is what strips timing out of the payload, and the count
  // cap keeps a heavy day from sitting unsent on the device forever.
  const FLUSH_AFTER_MS = 6 * 60 * 60 * 1000;
  const FLUSH_AT_COUNT = 50;
  // Per-counter ceiling. A saturating counter is a deliberate loss of precision:
  // past this the exact number tells us nothing we'd act on, and an unbounded one
  // is a channel.
  const MAX_COUNT = 999;
  // A batch may hold at most one key per event × surface combination, so this is
  // a structural bound rather than a policy — asserted in the tests so a widened
  // vocabulary can't silently grow the payload.
  const MAX_KEYS = EVENTS.length * (SURFACES.length + 1);

  const EVENT_SET = new Set(EVENTS);
  const SURFACE_SET = new Set(SURFACES);

  /**
   * The counter key for an event, with an optional surface: "read" or
   * "click_through:overlay". Returns "" for anything outside the vocabulary —
   * callers drop rather than guess, so a typo at a call site is silently
   * uncounted instead of quietly inventing a new counter.
   */
  function counterKey(event, surface) {
    if (!EVENT_SET.has(event)) return "";
    if (surface === undefined || surface === null || surface === "") return event;
    if (!SURFACE_SET.has(surface)) return event; // known event, unknown surface
    return event + ":" + surface;
  }

  /** A fresh, empty accumulation window opened at `now`. */
  function emptyBatch(now) {
    return { startedAt: Number(now) || 0, counts: {} };
  }

  /**
   * Coerce whatever came back out of storage into a usable batch. Storage is
   * shared with the rest of the extension and survives upgrades, so a batch
   * written by an older build (or corrupted) must degrade to "start over"
   * rather than throw inside a telemetry path that must never break a read.
   */
  function normalizeBatch(raw, now) {
    if (!raw || typeof raw !== "object" || !raw.counts || typeof raw.counts !== "object") {
      return emptyBatch(now);
    }
    const counts = {};
    for (const k of Object.keys(raw.counts)) {
      const n = Math.floor(Number(raw.counts[k]));
      if (!Number.isFinite(n) || n <= 0) continue;
      // Drop keys this build does not know: an old build's vocabulary is not
      // this build's, and forwarding one would send something the server rejects.
      const [event, surface] = k.split(":");
      if (counterKey(event, surface) !== k) continue;
      counts[k] = Math.min(n, MAX_COUNT);
    }
    // `>= 0`, not `> 0`: epoch zero is a legitimate (if unlikely) window start,
    // and treating it as missing would re-stamp the window to NOW on every read
    // — which silently means it never comes due and nothing is ever sent.
    const startedAt = Number(raw.startedAt);
    return {
      startedAt: Number.isFinite(startedAt) && startedAt >= 0 ? startedAt : Number(now) || 0,
      counts,
    };
  }

  /** Total events tallied in a batch. */
  function totalOf(batch) {
    const counts = (batch && batch.counts) || {};
    let n = 0;
    for (const k of Object.keys(counts)) n += counts[k];
    return n;
  }

  /**
   * Tally one event. Pure: returns a NEW batch and never mutates the input, so
   * the caller decides whether the write to storage actually happens.
   */
  function record(batch, event, surface, now) {
    const key = counterKey(event, surface);
    const base = normalizeBatch(batch, now);
    if (!key) return base; // outside the vocabulary — dropped, not invented
    const counts = Object.assign({}, base.counts);
    counts[key] = Math.min((counts[key] || 0) + 1, MAX_COUNT);
    return { startedAt: base.startedAt, counts };
  }

  /**
   * Is this batch due to be sent? Empty batches never are — a send that carries
   * nothing still tells the server an install exists and is running today, which
   * is a heartbeat, and a heartbeat is a thing we did not ask consent for.
   */
  function shouldFlush(batch, now) {
    const b = normalizeBatch(batch, now);
    const total = totalOf(b);
    if (total <= 0) return false;
    if (total >= FLUSH_AT_COUNT) return true;
    return Number(now) - b.startedAt >= FLUSH_AFTER_MS;
  }

  /**
   * The wire body, or null when there is nothing worth sending. `counts` is a
   * flat object keyed by counterKey(); extVersion is the only other field, and
   * it exists so a drop in reads-per-install can be pinned to the build that
   * caused it. There is deliberately no timestamp, no window length, no id.
   */
  function payloadFor(batch, extVersion, now) {
    const b = normalizeBatch(batch, now);
    if (totalOf(b) <= 0) return null;
    const version = typeof extVersion === "string" && /^[\w.-]{1,32}$/.test(extVersion)
      ? extVersion
      : null;
    return { counts: b.counts, extVersion: version };
  }

  /**
   * The surface to report for a click, derived from the link's OWN utm_medium.
   *
   * Deriving it rather than passing it in is what keeps the two halves of the
   * funnel consistent: whatever medium the site records for the visit is the
   * same word the counter uses, so "overlay clicks" and "overlay signups" are
   * the same population. A fallback covers a link the tagger left alone.
   *
   * Returns null when the URL is not ours — the caller must not count it. A
   * marketplace link is somebody else's, and counting it would make this a
   * record of outbound browsing.
   */
  function clickSurface(url, fallback, isSiteUrl) {
    if (typeof isSiteUrl === "function" && !isSiteUrl(url)) return null;
    let medium = "";
    try {
      medium = new URL(String(url)).searchParams.get("utm_medium") || "";
    } catch (_e) {
      return null;
    }
    if (SURFACE_SET.has(medium)) return medium;
    return SURFACE_SET.has(fallback) ? fallback : "";
  }

  /**
   * Install ONE delegated click listener that tallies click-throughs to
   * gradethread.com from `root` (a document, or the overlay's own element).
   *
   * Delegated and capture-phase on purpose: the popup and the overlay both build
   * links in several places and rebuild them on every render, so per-anchor
   * listeners would be N wirings that go stale. This is one, and it cannot miss
   * a link that a later feature adds.
   *
   * @param {Document|Element} rootNode
   * @param {string} fallbackSurface  used when the link carries no known utm_medium
   * @param {{isSiteUrl: Function, send: Function}} deps
   * @returns {Function} detach
   */
  function trackSiteClicks(rootNode, fallbackSurface, deps) {
    const d = deps || {};
    if (!rootNode || typeof rootNode.addEventListener !== "function") return function () {};
    const onClick = function (ev) {
      try {
        const target = ev && ev.target;
        const anchor = target && typeof target.closest === "function"
          ? target.closest("a[href]")
          : null;
        if (!anchor) return;
        const surface = clickSurface(anchor.href, fallbackSurface, d.isSiteUrl);
        if (surface === null) return; // not our link
        if (typeof d.send === "function") d.send("click_through", surface);
      } catch (_e) { /* a counter must never break a click */ }
    };
    rootNode.addEventListener("click", onClick, true);
    return function detach() {
      try {
        rootNode.removeEventListener("click", onClick, true);
      } catch (_e) { /* already gone */ }
    };
  }

  return {
    CONSENT_KEY,
    BATCH_KEY,
    EVENTS,
    SURFACES,
    FLUSH_AFTER_MS,
    FLUSH_AT_COUNT,
    MAX_COUNT,
    MAX_KEYS,
    counterKey,
    emptyBatch,
    normalizeBatch,
    totalOf,
    record,
    shouldFlush,
    payloadFor,
    clickSurface,
    trackSiteClicks,
  };
});
