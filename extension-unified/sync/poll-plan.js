// GradeThread sold-sync — the scheduled poll's DECISIONS (US-2701).
//
// WHY THE DECISIONS ARE HERE AND THE DRIVER IS NOT.
//
// Everything in sync/ is held to passivity by test/sync-manifest.test.cjs: no
// tabs.create, no navigation, no timers. That guard is the promise that the
// passive harvest stays passive, and the poll must not be allowed to erode it
// by living next door. So this file decides WHETHER to poll and WHICH channel,
// with no chrome.*, and background.js does the opening.
//
// That split is not tidiness. The poll is the only part of sold-sync that sends
// traffic the seller did not ask for, one request at a time, to a marketplace
// that can throttle an account it decides is automated. Every rule that stops it
// is a pure function here, and a build fails if one is removed — the same shape
// as lister/engagement.js, and for the same reason.
//
// THE RULES, and what each one costs if it goes:
//   1. Consent, versioned, its OWN clickwrap. Not the Lister's and not the
//      engagement runner's: those cover a seller pressing a button. This covers
//      GradeThread opening a marketplace tab while they are doing something
//      else, which is a different thing to agree to.
//   2. Checked before EVERY poll, never once per session. A run that checked at
//      start would sail through a revocation.
//   3. Never while an engagement run holds the tab. Two automations driving one
//      closet is how a seller ends up in share jail with no idea why.
//   4. Back off a channel that said not-signed-in, rather than reopening it
//      every interval to hit the same login wall.
//   5. Stop a channel entirely on a human check. Never answered, never retried
//      around — the same promise the engagement clickwrap makes.

(function (root) {
  "use strict";

  /**
   * Bump when the wording changes. An older acceptance then stops counting and
   * the seller is asked again, which is the point: they agreed to a sentence,
   * not to a feature name.
   */
  var CLICKWRAP_VERSION = "2026-08-20";

  /**
   * The sentences. Held by test/sync-poll.test.cjs and mirrored in the popup,
   * so a clickwrap cannot quietly lose the one about what we open.
   */
  var CLICKWRAP_TERMS = [
    "GradeThread will open a background tab on your own marketplace account, about once an hour, while your browser is open.",
    "It reads only your own sold page and your own listings. It never reads another seller's page.",
    "It never sends GradeThread your password, your session, or the name or address of anyone who bought from you.",
    "GradeThread will stop and hand the tab back if the marketplace asks for a human check.",
    "You can switch this off at any time, and the passive read keeps working without it.",
  ];

  /** Interval bounds, in minutes. */
  var MIN_INTERVAL_MIN = 30;
  var MAX_INTERVAL_MIN = 360;
  var DEFAULT_INTERVAL_MIN = 45;

  /**
   * How long a channel is left alone after saying not-signed-in.
   *
   * Long, deliberately. A logged-out seller stays logged out for hours, and
   * reopening their marketplace every 45 minutes to hit the same login wall is
   * both useless and the most automated-looking thing this feature could do.
   */
  var SIGNED_OUT_BACKOFF_MIN = 6 * 60;

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

  /** Clamp a configured interval into the allowed band. */
  function normalizeIntervalMin(raw) {
    var n = Number(raw);
    if (!isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MIN;
    if (n < MIN_INTERVAL_MIN) return MIN_INTERVAL_MIN;
    if (n > MAX_INTERVAL_MIN) return MAX_INTERVAL_MIN;
    return Math.round(n);
  }

  /**
   * Should this channel be polled right now?
   *
   * `state` is what we know about the channel: when it was last polled, whether
   * it is stopped, and when a backoff expires. Everything is passed in so this
   * is a pure decision with a stated reason, which is what makes the refusals
   * assertable rather than aspirational.
   */
  function channelDue(state, nowMs, intervalMin) {
    if (!state || state.enabled === false) {
      return { due: false, reason: "off" };
    }
    // A human check stops the channel until the seller clears it themselves.
    // Not a backoff, not a retry: stopped.
    if (state.stoppedForHumanCheck) {
      return { due: false, reason: "human_check" };
    }
    if (state.backoffUntilMs && nowMs < state.backoffUntilMs) {
      return { due: false, reason: "backoff" };
    }
    var last = Number(state.lastPolledMs) || 0;
    if (nowMs - last < intervalMin * 60 * 1000) {
      return { due: false, reason: "too_soon" };
    }
    return { due: true, reason: "due" };
  }

  /**
   * The whole decision: which channels to poll on this tick, and why not for
   * the rest.
   *
   * Refusals carry a reason rather than being silently dropped, so the popup can
   * say "off" and "waiting for you to sign in" instead of one shrug.
   */
  function planPoll(ctx) {
    var c = ctx || {};
    var settings = c.settings || {};
    var nowMs = Number(c.nowMs) || 0;

    if (settings.enabled === false) {
      return { poll: [], blocked: "disabled", skipped: [] };
    }
    // RULE 1 + 2: consent, versioned, checked on every tick.
    if (!isClickwrapAccepted(c.clickwrap)) {
      return { poll: [], blocked: "no_consent", skipped: [] };
    }
    // RULE 3: never while an engagement run holds a tab. Checked globally
    // rather than per channel because the runner drives ONE closet at a time and
    // a poll elsewhere still competes for the same account's attention.
    if (c.engagementInFlight) {
      return { poll: [], blocked: "engagement_running", skipped: [] };
    }

    var interval = normalizeIntervalMin(settings.intervalMin);
    var states = c.channels || {};
    var poll = [];
    var skipped = [];

    for (var i = 0; i < (c.platforms || []).length; i++) {
      var platform = c.platforms[i];
      var verdict = channelDue(states[platform], nowMs, interval);
      if (verdict.due) poll.push(platform);
      else skipped.push({ platform: platform, reason: verdict.reason });
    }

    // One channel per tick. Opening four background tabs at once is the shape a
    // marketplace notices; spreading them across ticks costs nothing, because
    // the interval is measured in tens of minutes either way.
    return { poll: poll.slice(0, 1), blocked: null, skipped: skipped };
  }

  /** What a channel's state becomes after a read reports back. */
  function applyPollResult(state, result, nowMs) {
    var next = {
      enabled: state && state.enabled !== false,
      lastPolledMs: nowMs,
      backoffUntilMs: 0,
      stoppedForHumanCheck: false,
    };
    if (!result) return next;
    if (result.humanCheck) {
      // RULE 5: stopped, not backed off. It takes the seller to clear it.
      next.stoppedForHumanCheck = true;
      return next;
    }
    if (result.signedIn === false) {
      // RULE 4.
      next.backoffUntilMs = nowMs + SIGNED_OUT_BACKOFF_MIN * 60 * 1000;
    }
    return next;
  }

  /**
   * The URL the poll may open for a channel, or null.
   *
   * THE ONE RULE: the URL is always a value from the bundled config. Nothing a
   * message carries can reach this — there is no parameter for one. That is the
   * same rule newListingUrlForLocale states in lister/lister-guard.js, and it
   * exists because a URL that arrived in a message is a URL somebody else chose.
   *
   * Re-validated here rather than trusted, so a config edit that points a
   * pollUrl at another domain resolves to null instead of opening it:
   *   - https only;
   *   - host must be one the adapter itself declares;
   *   - the URL must match the sold flow's own urlPattern, so a poll cannot be
   *     aimed at a page the adapter has no selectors for.
   */
  function pollUrlFor(selectors, platform) {
    var cfg = selectors && selectors[platform];
    var sold = cfg && cfg.sold;
    var url = sold && sold.pollUrl;
    if (typeof url !== "string" || url.indexOf("https://") !== 0) return null;

    var rest = url.slice("https://".length);
    var slash = rest.indexOf("/");
    var host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
    if (!host) return null;

    var hosts = cfg.hosts || [];
    var hostOk = false;
    for (var i = 0; i < hosts.length; i++) {
      if (host === hosts[i] || host.slice(-(hosts[i].length + 1)) === "." + hosts[i]) {
        hostOk = true;
        break;
      }
    }
    if (!hostOk) return null;

    if (!sold.urlPattern) return null;
    try {
      if (!new RegExp(sold.urlPattern, "i").test(url)) return null;
    } catch (_e) {
      return null;
    }
    return url;
  }

  root.GT_SYNC_POLL = {
    pollUrlFor: pollUrlFor,
    CLICKWRAP_VERSION: CLICKWRAP_VERSION,
    CLICKWRAP_TERMS: CLICKWRAP_TERMS,
    MIN_INTERVAL_MIN: MIN_INTERVAL_MIN,
    MAX_INTERVAL_MIN: MAX_INTERVAL_MIN,
    DEFAULT_INTERVAL_MIN: DEFAULT_INTERVAL_MIN,
    SIGNED_OUT_BACKOFF_MIN: SIGNED_OUT_BACKOFF_MIN,
    isClickwrapAccepted: isClickwrapAccepted,
    acceptClickwrap: acceptClickwrap,
    normalizeIntervalMin: normalizeIntervalMin,
    channelDue: channelDue,
    planPoll: planPoll,
    applyPollResult: applyPollResult,
  };
})(typeof self !== "undefined" ? self : globalThis);
