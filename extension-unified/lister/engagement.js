// GradeThread Lister — Poshmark engagement state machine (US-2482).
//
// Share, follow and send-offer. The feature Nifty charges $25/month for, built
// the way the US-2476 ADR requires: every action happens as a content script in
// the seller's OWN logged-in tab. No GradeThread server ever performs a Poshmark
// action, holds a Poshmark cookie, or sees a Poshmark page.
//
// WHY ALL THE DECISIONS LIVE IN THIS FILE. Engagement automation is the part of
// the product that can cost a seller their closet. Poshmark throttles or stops
// shares from a closet it decides is automated — "share jail" — and the seller
// finds out because their sales stop, not because anything says so. So the caps,
// the pacing and the consent gate are not policy sprinkled through a content
// script; they are a pure state machine here, with no chrome.* and no DOM, and
// test/engagement.test.cjs holds them. A build cannot ship with the gate removed
// because removing it fails the build.
//
// Everything this file computes lives in chrome.storage.LOCAL and stays on the
// device. GradeThread's servers receive run COUNTS at most, and never a listing,
// a handle, a cookie, or anything typed into Poshmark.

(function (root) {
  "use strict";

  // ── Consent ───────────────────────────────────────────────────────────────
  //
  // A SEPARATE clickwrap from the Lister one, deliberately. The Lister clickwrap
  // covers "I am filling in my own listing form". Sharing 5,000 times a day is a
  // different thing to agree to, with a different consequence, and rolling it
  // into an already-accepted consent would mean sellers were opted in to
  // engagement automation by a checkbox they ticked for cross-listing.
  //
  // Bump when the wording changes — an older acceptance stops counting and every
  // seller is asked again.
  var CLICKWRAP_VERSION = "2026-08-10";

  // The exact statements the seller has to accept. Kept here rather than in the
  // popup markup so the test can assert they are present: a clickwrap that
  // quietly loses the sentence about who is responsible is not a clickwrap.
  var CLICKWRAP_TERMS = [
    "Poshmark's terms restrict third-party automation. Poshmark may limit or close an account it decides is automated.",
    "I am responsible for my Poshmark account. GradeThread cannot appeal a limit on my behalf.",
    "These actions run on my machine, in my own logged-in Poshmark tab. GradeThread's servers never sign in to Poshmark and never see my password or session cookie.",
    "GradeThread will stop and hand the tab back to me if Poshmark asks for a human check. It will never answer one for me.",
  ];

  // ── Caps ──────────────────────────────────────────────────────────────────
  //
  // Two numbers per action, and the difference between them is the point:
  //
  //   DEFAULT — what a fresh install does. Conservative.
  //   ABSOLUTE — the ceiling. The seller CANNOT raise past this, in the UI or by
  //              editing storage, because every read goes through clampSettings.
  //
  // 5,000 shares is the documented default US-2482 asks for. The absolute sits
  // at 9,000 — below the ~9,500/day figure sellers report as the point where
  // Poshmark stops counting — because a cap the seller can push to the exact
  // edge of the tolerance is not a safety limit, it is a dare. The gap is the
  // margin, and it is not configurable for the same reason.
  var LIMITS = {
    share: { default: 5000, absolute: 9000 },
    follow: { default: 200, absolute: 500 },
    offer: { default: 100, absolute: 300 },
  };

  var ACTIONS = ["share", "follow", "offer"];

  // ── Pacing ────────────────────────────────────────────────────────────────
  //
  // Randomized, with a floor the seller cannot go below. A fixed interval is the
  // single most legible automation signal there is — a human does not click
  // every 1.000s — so the delay is drawn from [floor, floor + jitter).
  //
  // The floor is configurable UPWARD only. Someone who wants to run slower is
  // being careful; someone who wants to run faster than PACING_FLOOR_MIN_MS is
  // asking for the outcome this file exists to avoid.
  var PACING_FLOOR_MIN_MS = 800;
  var PACING_FLOOR_DEFAULT_MS = 1400;
  var PACING_FLOOR_MAX_MS = 30000;
  var PACING_JITTER_DEFAULT_MS = 1600;
  var PACING_JITTER_MIN_MS = 400;

  // How long a run may sit paused waiting for the seller to clear a human check
  // before we give up and report it, rather than leaving a tab spinning.
  var CAPTCHA_PAUSE_TIMEOUT_MS = 10 * 60 * 1000;

  function defaultSettings() {
    return {
      shareCap: LIMITS.share.default,
      followCap: LIMITS.follow.default,
      offerCap: LIMITS.offer.default,
      pacingFloorMs: PACING_FLOOR_DEFAULT_MS,
      pacingJitterMs: PACING_JITTER_DEFAULT_MS,
    };
  }

  function clampInt(value, min, max, fallback) {
    var n = typeof value === "number" ? Math.floor(value) : NaN;
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  /**
   * Normalise whatever is in storage into settings that cannot hurt the seller.
   *
   * EVERY read of settings goes through this, not just the ones from the options
   * UI. That is the whole defence: storage.local is writable by anything running
   * in the extension, and a cap enforced only where the UI writes it is a cap
   * that a bug (or a future feature that forgets) can route around. Clamping on
   * READ means a stored 50,000 becomes 9,000 at the moment it is used.
   */
  function clampSettings(stored) {
    var s = stored && typeof stored === "object" ? stored : {};
    var d = defaultSettings();
    return {
      shareCap: clampInt(s.shareCap, 0, LIMITS.share.absolute, d.shareCap),
      followCap: clampInt(s.followCap, 0, LIMITS.follow.absolute, d.followCap),
      offerCap: clampInt(s.offerCap, 0, LIMITS.offer.absolute, d.offerCap),
      pacingFloorMs: clampInt(
        s.pacingFloorMs,
        PACING_FLOOR_MIN_MS,
        PACING_FLOOR_MAX_MS,
        d.pacingFloorMs,
      ),
      pacingJitterMs: clampInt(
        s.pacingJitterMs,
        PACING_JITTER_MIN_MS,
        PACING_FLOOR_MAX_MS,
        d.pacingJitterMs,
      ),
    };
  }

  function capFor(settings, action) {
    if (action === "share") return settings.shareCap;
    if (action === "follow") return settings.followCap;
    if (action === "offer") return settings.offerCap;
    return 0;
  }

  // ── Daily counters ────────────────────────────────────────────────────────
  //
  // The day is the SELLER's local day, because that is the day they are looking
  // at when they read the meter. The offset is passed in rather than read from
  // the environment so this stays pure and the tests can cross a midnight
  // without waiting for one.
  function dayKey(nowMs, tzOffsetMinutes) {
    var offset = typeof tzOffsetMinutes === "number" ? tzOffsetMinutes : 0;
    var local = new Date(nowMs - offset * 60000);
    var y = local.getUTCFullYear();
    var m = String(local.getUTCMonth() + 1).padStart(2, "0");
    var d = String(local.getUTCDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }

  function emptyCounters(day) {
    return { day: day, share: 0, follow: 0, offer: 0 };
  }

  /**
   * Return today's counters, resetting them if the stored ones are from an
   * earlier day. Never carries a count forward — a stale count would either
   * lock a seller out of a fresh day or, worse, let yesterday's headroom stack
   * onto today's.
   */
  function rollCounters(stored, nowMs, tzOffsetMinutes) {
    var day = dayKey(nowMs, tzOffsetMinutes);
    if (!stored || stored.day !== day) return emptyCounters(day);
    return {
      day: day,
      share: clampInt(stored.share, 0, Number.MAX_SAFE_INTEGER, 0),
      follow: clampInt(stored.follow, 0, Number.MAX_SAFE_INTEGER, 0),
      offer: clampInt(stored.offer, 0, Number.MAX_SAFE_INTEGER, 0),
    };
  }

  function recordAction(counters, action, count) {
    if (ACTIONS.indexOf(action) === -1) return counters;
    var n = clampInt(count, 0, 10000, 1);
    var next = Object.assign({}, counters);
    next[action] = (next[action] || 0) + n;
    return next;
  }

  function remaining(counters, settings, action) {
    var used = (counters && counters[action]) || 0;
    return Math.max(0, capFor(settings, action) - used);
  }

  // ── The meter ─────────────────────────────────────────────────────────────
  //
  // US-2482 AC4: shares used today against the cap, and share jail NAMED as the
  // consequence. Naming it matters — "you have used 82% of your limit" tells a
  // seller nothing about what happens at 100%, and the thing that happens is
  // that their closet stops reaching buyers and nobody tells them why.
  function meter(counters, settings, action) {
    var act = action || "share";
    var used = (counters && counters[act]) || 0;
    var cap = capFor(settings, act);
    var pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 100;
    var label = used.toLocaleString() + " of " + cap.toLocaleString() + " " +
      (act === "share" ? "shares" : act === "follow" ? "follows" : "offers") + " today";

    var note;
    if (used >= cap) {
      note = act === "share"
        ? "Daily share limit reached. GradeThread stops here — pushing past what Poshmark tolerates puts a closet in share jail, where shares quietly stop reaching buyers."
        : "Daily limit reached for today. GradeThread stops here.";
    } else if (pct >= 80) {
      note = act === "share"
        ? "Close to the daily limit. Share jail is what sits on the other side of it: Poshmark stops counting a closet's shares and does not tell you."
        : "Close to the daily limit.";
    } else {
      note = act === "share"
        ? "GradeThread stops at the cap. Past it is share jail — Poshmark stops counting a closet's shares, and your listings quietly stop reaching buyers."
        : null;
    }

    return {
      action: act,
      used: used,
      cap: cap,
      pct: pct,
      atCap: used >= cap,
      label: label,
      note: note,
    };
  }

  // ── The gate ──────────────────────────────────────────────────────────────
  //
  // One function, checked before EVERY action rather than once per run. A run of
  // 5,000 shares that checked its consent at the start would keep going through
  // a revocation; one that checked its cap at the start would sail past it if
  // another tab was sharing too.
  //
  // Returns { ok: true } or { ok: false, reason, message } — the message is what
  // the seller reads, so it says what to do rather than what failed.
  function gate(ctx) {
    var action = ctx.action;
    if (ACTIONS.indexOf(action) === -1) {
      return { ok: false, reason: "unknown_action", message: "Unknown action." };
    }

    // Paid FlipDesk, same as the Lister. Fail-safe: unknown means locked.
    if (ctx.sellerAllowed !== true) {
      return {
        ok: false,
        reason: "needs_upgrade",
        message: "Poshmark sharing is a FlipDesk seller feature — upgrade your GradeThread plan to enable it.",
      };
    }

    // AC5: the DEDICATED clickwrap. The Lister consent does not satisfy this and
    // is deliberately not consulted here.
    if (!isClickwrapAccepted(ctx.clickwrap)) {
      return {
        ok: false,
        reason: "needs_consent",
        message: ctx.clickwrap && ctx.clickwrap.acceptedAt
          ? "The Poshmark automation terms changed — open the GradeThread extension and accept them again."
          : "Open the GradeThread extension and accept the Poshmark automation terms before the first run.",
      };
    }

    // AC2: a human check pauses the run. It is never answered, never routed to a
    // solver service, and never retried around. The seller finishes it.
    if (ctx.humanCheck === true) {
      return {
        ok: false,
        reason: "human_check",
        paused: true,
        message: "Poshmark is asking for a human check. Finish it in the tab and GradeThread will pick up where it stopped — it will never answer one for you.",
      };
    }

    var settings = clampSettings(ctx.settings);
    var counters = ctx.counters || emptyCounters(dayKey(ctx.now || 0, ctx.tzOffsetMinutes));
    if (remaining(counters, settings, action) <= 0) {
      return {
        ok: false,
        reason: "daily_cap",
        message: meter(counters, settings, action).note,
      };
    }

    return { ok: true, remaining: remaining(counters, settings, action) };
  }

  function isClickwrapAccepted(clickwrap) {
    return Boolean(
      clickwrap &&
      clickwrap.acceptedAt &&
      clickwrap.version === CLICKWRAP_VERSION,
    );
  }

  function acceptClickwrap(nowIso) {
    return { acceptedAt: nowIso, version: CLICKWRAP_VERSION };
  }

  /**
   * The delay before the NEXT action, in ms.
   *
   * `rand` is injected so the tests can pin both ends of the range. A caller
   * that passes nothing gets Math.random, which is the right source here: this
   * is jitter to look human, not a security decision.
   */
  function nextDelayMs(settings, rand) {
    var s = clampSettings(settings);
    var r = typeof rand === "function" ? rand() : Math.random();
    // NaN fails BOTH comparisons below, so it has to be caught first — otherwise
    // it propagates through the arithmetic and the delay becomes NaN, which
    // setTimeout treats as 0. A broken random source would silently turn the
    // floor into a click storm, which is the one failure this function exists to
    // make impossible.
    var bounded = !Number.isFinite(r) ? 0 : r < 0 ? 0 : r >= 1 ? 0.999999 : r;
    return s.pacingFloorMs + Math.floor(bounded * s.pacingJitterMs);
  }

  /**
   * Plan a run: how many actions we will actually attempt, given the cap.
   *
   * Returns the count AND whether it was trimmed, because a run that silently
   * does 300 of a requested 5,000 is a run the seller thinks completed. The
   * caller reports `trimmed` rather than swallowing it.
   */
  function planRun(requested, counters, settings, action) {
    var s = clampSettings(settings);
    var want = clampInt(requested, 0, LIMITS[action] ? LIMITS[action].absolute : 0, 0);
    var left = remaining(counters, s, action);
    var count = Math.min(want, left);
    return {
      action: action,
      count: count,
      requested: want,
      trimmed: count < want,
      remainingAfter: left - count,
    };
  }

  root.GT_ENGAGE = {
    CLICKWRAP_VERSION: CLICKWRAP_VERSION,
    CLICKWRAP_TERMS: CLICKWRAP_TERMS,
    LIMITS: LIMITS,
    ACTIONS: ACTIONS,
    PACING_FLOOR_MIN_MS: PACING_FLOOR_MIN_MS,
    PACING_FLOOR_MAX_MS: PACING_FLOOR_MAX_MS,
    CAPTCHA_PAUSE_TIMEOUT_MS: CAPTCHA_PAUSE_TIMEOUT_MS,
    defaultSettings: defaultSettings,
    clampSettings: clampSettings,
    capFor: capFor,
    dayKey: dayKey,
    emptyCounters: emptyCounters,
    rollCounters: rollCounters,
    recordAction: recordAction,
    remaining: remaining,
    meter: meter,
    gate: gate,
    isClickwrapAccepted: isClickwrapAccepted,
    acceptClickwrap: acceptClickwrap,
    nextDelayMs: nextDelayMs,
    planRun: planRun,
  };
})(typeof self !== "undefined" ? self : globalThis);
