// GradeThread unified extension — the worker tab's state machine (US-3061).
//
// WHY THIS IS A SEPARATE FILE. The worker tab is the honest answer to what Nifty
// sells: work that happens while the seller is not watching, without anyone
// holding their marketplace login. That only earns the claim if the drain keeps
// running, and every way it can quietly stop is arithmetic or bookkeeping —
// a countdown that never fires, a tab that is not ours, a pause that resumes
// itself. None of those throw. All of them are testable with no browser, so
// they live here rather than inside worker.js's event wiring.
//
// THE ONE RULE THAT IS NOT ARITHMETIC, and the reason `resume` takes an explicit
// argument instead of a timeout: a paused drain NEVER restarts on its own. A
// pause means a marketplace asked for a person — a login wall, or a human check.
// The ADR (vault/60-decisions/adr-no-server-side-marketplace-automation.md §3.2)
// refuses to answer either one, and a drain that resumed after a timer would be
// answering it by waiting: the next job opens the same challenged page, and the
// marketplace sees a machine retrying a check it was told a human would clear.
//
// Pure. No `chrome`, no `browser`, no timers, no storage. Every function takes
// its clock.
(function (root) {
  "use strict";

  /** The port the worker tab holds open so the MV3 service worker stays alive. */
  var PORT_NAME = "gt-worker";

  /**
   * How often the open worker tab asks for a drain.
   *
   * 60s, against the 5-minute SWEEP_ALARM that stays as the fallback for a
   * closed tab. The point of the tab is the gap between those two numbers: a
   * delist queued by a sale lands in about a minute instead of up to five.
   * Shorter would buy little — the claim, the tab open and the form fill cost
   * more than the wait — and would multiply empty queue reads by five.
   */
  var DRAIN_INTERVAL_MS = 60 * 1000;

  /**
   * How long past a job's deadline a marketplace tab may still be open before
   * the worker reports it.
   *
   * REPORTED, NEVER CLOSED. A tab still open ten minutes after its deadline is
   * usually a seller who took over the form by hand — the login wall they just
   * cleared, the price field they wanted to set themselves. Closing that tab
   * would destroy work a person is doing, to tidy a list nobody is looking at.
   * So the worker says "this one is still open" and leaves it alone.
   */
  var STALE_TAB_GRACE_MS = 10 * 60 * 1000;

  /** Why the drain is paused. Both mean: a marketplace asked for a person. */
  var PAUSE_REASONS = {
    login_wall: "login_wall",
    human_check: "human_check",
  };

  /**
   * The sentence the worker page shows for each pause, in the words the popup
   * already uses for the same two events. A seller who reads "log in and this
   * will retry" in one surface and something else in the other has to work out
   * whether they are the same problem.
   */
  var PAUSE_TEXT = {
    login_wall: "asked you to log in",
    human_check: "asked for a human check",
  };

  function isObj(v) {
    return Boolean(v) && typeof v === "object";
  }

  function num(v) {
    return typeof v === "number" && isFinite(v) ? v : null;
  }

  /**
   * Read a pause out of a job notice, or null if the notice is not one.
   *
   * TWO SHAPES, because two subsystems report the same situation differently and
   * neither is going to be rewritten for this: lister/common.js sends
   * `{ loginWall: true, platform, error }` on GT_LISTER_NOTICE, and
   * lister/engagement.js sends `{ reason: "human_check", platform, message }` on
   * GT_ENGAGE_NOTICE. Missing either would leave the drain running straight into
   * a challenged page, which is the failure mode the ADR cares about most.
   */
  function pauseFor(notice) {
    if (!isObj(notice)) return null;
    var platform = typeof notice.platform === "string" ? notice.platform : null;
    if (notice.loginWall === true) {
      return { reason: PAUSE_REASONS.login_wall, platform: platform };
    }
    if (notice.reason === "human_check" || notice.humanCheck === true) {
      return { reason: PAUSE_REASONS.human_check, platform: platform };
    }
    return null;
  }

  /**
   * The worker's starting state. `running` is what the Stop button turns off;
   * `pause` is what a marketplace turns on. They are separate because they are
   * undone by different people: Stop is the seller's choice and Resume is the
   * seller's answer to a challenge, and collapsing them would let a Stop clear a
   * pause the seller never dealt with.
   */
  function initialState(now) {
    return {
      running: true,
      pause: null,
      lastDrainAt: null,
      lastOutcome: null,
      startedAt: num(now),
    };
  }

  function pause(state, info, now) {
    var s = Object.assign({}, isObj(state) ? state : {});
    var p = isObj(info) ? info : {};
    s.pause = {
      reason: Object.prototype.hasOwnProperty.call(PAUSE_REASONS, p.reason)
        ? p.reason
        : PAUSE_REASONS.human_check,
      platform: typeof p.platform === "string" ? p.platform : null,
      at: num(now),
    };
    return s;
  }

  /**
   * Clear a pause. `bySeller` must be true — there is no other caller, and the
   * argument exists so that a future one has to say so out loud rather than
   * discovering that `resume(state)` quietly works.
   */
  function resume(state, bySeller) {
    var s = Object.assign({}, isObj(state) ? state : {});
    if (bySeller !== true) return s;
    s.pause = null;
    return s;
  }

  function stop(state) {
    var s = Object.assign({}, isObj(state) ? state : {});
    s.running = false;
    return s;
  }

  function start(state, now) {
    var s = Object.assign({}, isObj(state) ? state : {});
    s.running = true;
    if (s.startedAt === null || s.startedAt === undefined) s.startedAt = num(now);
    return s;
  }

  function noteDrain(state, outcome, now) {
    var s = Object.assign({}, isObj(state) ? state : {});
    s.lastDrainAt = num(now);
    s.lastOutcome = typeof outcome === "string" ? outcome : null;
    return s;
  }

  /** Whether the tick at `now` should ask the background for a drain. */
  function shouldDrain(state, now, intervalMs) {
    if (!isObj(state)) return false;
    if (state.running !== true) return false;
    if (state.pause) return false;
    var every = num(intervalMs) === null ? DRAIN_INTERVAL_MS : intervalMs;
    var last = num(state.lastDrainAt);
    if (last === null) return true; // never drained: go now, do not wait a minute
    var t = num(now);
    if (t === null) return false;
    return t - last >= every;
  }

  function nextDrainAt(state, intervalMs) {
    if (!isObj(state) || state.running !== true || state.pause) return null;
    var every = num(intervalMs) === null ? DRAIN_INTERVAL_MS : intervalMs;
    var last = num(state.lastDrainAt);
    return last === null ? null : last + every;
  }

  /** Whole seconds until the next drain, floored at 0. Null when there is none. */
  function countdownSeconds(state, now, intervalMs) {
    var at = nextDrainAt(state, intervalMs);
    var t = num(now);
    if (at === null || t === null) return null;
    return Math.max(0, Math.ceil((at - t) / 1000));
  }

  function hhmm(ms) {
    var t = num(ms);
    if (t === null) return null;
    var d = new Date(t);
    var h = String(d.getHours()).padStart(2, "0");
    var m = String(d.getMinutes()).padStart(2, "0");
    return h + ":" + m;
  }

  /**
   * The line under the header. Says what the browser is doing and when it will
   * next do it, because "running" on its own is the claim a seller cannot check.
   */
  function statusLine(state, now, intervalMs) {
    if (!isObj(state)) return "";
    if (state.pause) {
      var who = state.pause.platform ? labelPlatform(state.pause.platform) : "A marketplace";
      var what = PAUSE_TEXT[state.pause.reason] || "asked for a person";
      return who + " " + what + ". Finish it in that tab, then choose Resume.";
    }
    if (state.running !== true) return "Stopped. Nothing is running.";
    var last = hhmm(state.lastDrainAt);
    var secs = countdownSeconds(state, now, intervalMs);
    if (last === null) return "Starting the first check.";
    if (secs === null) return "Last check " + last + ".";
    return "Last check " + last + ", next in " + secs + "s.";
  }

  function labelPlatform(key) {
    var labels = root.GT_QUEUE_VIEW && root.GT_QUEUE_VIEW.PLATFORM_LABELS;
    if (labels && Object.prototype.hasOwnProperty.call(labels, key)) return labels[key];
    return "The marketplace";
  }

  // ── tab ownership ─────────────────────────────────────────────────────────
  //
  // The worker acts ONLY in tabs it opened. Not "tabs on a marketplace domain",
  // and not "the active tab": either of those would let a drain type into a
  // Poshmark tab the seller has open for their own reasons, mid-sentence, with
  // no way for them to tell what happened. The set is persisted because an MV3
  // service worker is evicted between alarms and would otherwise wake up
  // believing it owns nothing — which fails the safe way, but also abandons
  // every tab it did open.

  function ownedList(owned) {
    return Array.isArray(owned) ? owned.filter(function (id) { return num(id) !== null; }) : [];
  }

  function ownsTab(owned, tabId) {
    if (num(tabId) === null) return false;
    return ownedList(owned).indexOf(tabId) > -1;
  }

  function addOwnedTab(owned, tabId) {
    if (num(tabId) === null) return ownedList(owned);
    var list = ownedList(owned);
    return list.indexOf(tabId) > -1 ? list : list.concat([tabId]);
  }

  function removeOwnedTab(owned, tabId) {
    return ownedList(owned).filter(function (id) { return id !== tabId; });
  }

  /**
   * Drop owned ids that no longer name an open tab.
   *
   * `openIds` is what tabs.query returned. Without this the list grows for the
   * life of the profile and a recycled tab id eventually reads as ours — which
   * is the one way this ownership check can fail OPEN rather than closed.
   */
  function pruneOwnedTabs(owned, openIds) {
    var open = Array.isArray(openIds) ? openIds : [];
    return ownedList(owned).filter(function (id) { return open.indexOf(id) > -1; });
  }

  /**
   * Owned tabs whose job passed its deadline more than STALE_TAB_GRACE_MS ago.
   *
   * `jobs` is the background's job map (lister/job-store.js). Returns ids to
   * REPORT. Nothing here closes anything; see STALE_TAB_GRACE_MS.
   */
  function staleTabs(jobs, owned, now, graceMs) {
    var t = num(now);
    if (t === null) return [];
    var grace = num(graceMs) === null ? STALE_TAB_GRACE_MS : graceMs;
    var out = [];
    var map = isObj(jobs) ? jobs : {};
    Object.keys(map).forEach(function (id) {
      var job = map[id];
      if (!isObj(job)) return;
      var deadline = num(job.deadlineAt);
      if (deadline === null) return;
      if (!ownsTab(owned, job.tabId)) return;
      if (t - deadline > grace) out.push(job.tabId);
    });
    return out;
  }

  root.GT_WORKER_STATE = {
    PORT_NAME: PORT_NAME,
    DRAIN_INTERVAL_MS: DRAIN_INTERVAL_MS,
    STALE_TAB_GRACE_MS: STALE_TAB_GRACE_MS,
    PAUSE_REASONS: PAUSE_REASONS,
    PAUSE_TEXT: PAUSE_TEXT,
    pauseFor: pauseFor,
    initialState: initialState,
    pause: pause,
    resume: resume,
    stop: stop,
    start: start,
    noteDrain: noteDrain,
    shouldDrain: shouldDrain,
    nextDrainAt: nextDrainAt,
    countdownSeconds: countdownSeconds,
    statusLine: statusLine,
    ownsTab: ownsTab,
    addOwnedTab: addOwnedTab,
    removeOwnedTab: removeOwnedTab,
    pruneOwnedTabs: pruneOwnedTabs,
    staleTabs: staleTabs,
  };
})(typeof self !== "undefined" ? self : globalThis);
