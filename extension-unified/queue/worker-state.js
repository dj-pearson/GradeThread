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

  // -- unsent results --------------------------------------------------------
  //
  // When a drained job finishes, the extension posts the result back to the
  // queue row it came from. That post was fire-and-forget: `queueFetch` returns
  // null for a dead token, an offline moment and every HTTP error alike, and all
  // six call sites threw the value away. So a marketplace tab that did the work,
  // plus one lost POST, left the row `claimed` on the server - and `/claim` only
  // ever reads rows whose status is `queued`, so nothing ever picked it up
  // again. The seller's phone showed the job as still running for the seven days
  // until `expires_at`, while this page printed its next-check countdown and the
  // drain reported "ok".
  //
  // The window is not small. A drained job holds a marketplace tab for tens of
  // seconds and the result lands at the end of it, so a laptop lid, a train
  // tunnel or a token that lapsed mid-job all land squarely inside it.
  //
  // So a result is HELD until the server says it took it. This is the ledger;
  // background.js does the posting and the persisting, and the worker page shows
  // the count, because a backlog nobody can see is the thing being fixed.

  /**
   * How many times one result may be re-sent before it is dropped.
   *
   * Eight, against the backoff below, is a bit over an hour of trying - long
   * enough to cover a closed lid or a dead tunnel, short enough that a row the
   * server will never accept (the seller cancelled it from their phone) does not
   * ride along for a week.
   */
  var RESULT_ATTEMPT_LIMIT = 8;

  /** The wait before each attempt, in ms. The last value repeats. */
  var RESULT_BACKOFF_MS = [0, 30 * 1000, 60 * 1000, 2 * 60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];

  /**
   * Most unsent results held at once.
   *
   * The drain runs one job at a time, so reaching even ten means something is
   * broken rather than busy. The cap is here so a browser offline for a week
   * cannot fill storage.local; the OLDEST go, because the newest result is the
   * one whose marketplace tab the seller most recently watched.
   */
  var RESULT_MAX_ENTRIES = 25;

  function resultList(store) {
    if (!Array.isArray(store)) return [];
    return store.filter(function (e) {
      return isObj(e) && typeof e.queueId === "string" && e.queueId !== "";
    });
  }

  function resultBackoffFor(attempts) {
    var i = Math.max(0, Math.min(RESULT_BACKOFF_MS.length - 1, attempts));
    return RESULT_BACKOFF_MS[i];
  }

  /**
   * Did the server take this result?
   *
   * THE FUNCTION THE WHOLE SECTION EXISTS FOR. `/:id/complete` answers
   * `{ updated: { id, status } }` for a row it actually updated and 404
   * `{ error: "Not found." }` for an id that matched none - and the id is
   * filtered together with the owner, so "matched none" is also what a foreign
   * id gets. A caller that checks only the HTTP status, or only that some body
   * came back, accepts both. So the id is compared: the row the server says it
   * updated has to be the row we asked about.
   */
  function resultAccepted(result, queueId) {
    if (!isObj(result) || result.ok !== true) return false;
    var body = result.body;
    if (!isObj(body) || !isObj(body.updated)) return false;
    return body.updated.id === queueId;
  }

  /**
   * Record a result the server did not take.
   *
   * One entry per queue row: a second miss for the same row REPLACES the first
   * rather than queueing beside it, because both describe the same job and the
   * newer one is the attempt that actually just happened.
   */
  function recordUnsentResult(store, entry, now) {
    var e = isObj(entry) ? entry : {};
    if (typeof e.queueId !== "string" || e.queueId === "") return resultList(store);
    var t = num(now) === null ? 0 : now;
    var prior = null;
    var rest = resultList(store).filter(function (x) {
      if (x.queueId === e.queueId) { prior = x; return false; }
      return true;
    });
    var attempts = (prior && num(prior.attempts) !== null ? prior.attempts : 0) + 1;
    var next = rest.concat([{
      queueId: e.queueId,
      body: isObj(e.body) ? e.body : {},
      attempts: attempts,
      firstAt: prior && num(prior.firstAt) !== null ? prior.firstAt : t,
      lastAt: t,
      nextAt: t + resultBackoffFor(attempts),
      lastStatus: num(e.status),
    }]);
    return next.length <= RESULT_MAX_ENTRIES
      ? next
      : next.slice(next.length - RESULT_MAX_ENTRIES);
  }

  /** The server took it. Nothing about this row is owed any more. */
  function clearUnsentResult(store, queueId) {
    return resultList(store).filter(function (e) { return e.queueId !== queueId; });
  }

  /** Entries whose backoff has elapsed, oldest first. */
  function dueUnsentResults(store, now) {
    var t = num(now) === null ? 0 : now;
    return resultList(store)
      .filter(function (e) { return (num(e.nextAt) === null ? 0 : e.nextAt) <= t; })
      .sort(function (a, b) { return (a.firstAt || 0) - (b.firstAt || 0); });
  }

  /**
   * Entries that have used up RESULT_ATTEMPT_LIMIT.
   *
   * Returned rather than dropped in place, so the caller has to say something
   * about them. A result silently binned is the failure this section exists to
   * stop, one level up.
   */
  function exhaustedUnsentResults(store) {
    return resultList(store).filter(function (e) {
      return (num(e.attempts) === null ? 0 : e.attempts) >= RESULT_ATTEMPT_LIMIT;
    });
  }

  /** The ledger minus everything that is out of attempts. */
  function dropExhaustedResults(store) {
    return resultList(store).filter(function (e) {
      return (num(e.attempts) === null ? 0 : e.attempts) < RESULT_ATTEMPT_LIMIT;
    });
  }

  /** How many results are waiting to be sent. */
  function unsentResultCount(store) {
    return resultList(store).length;
  }

  /**
   * The line the worker page shows while results are owed.
   *
   * Said out loud rather than kept in storage, because the seller's own
   * understanding of "the drain is running" has to include "and two results have
   * not reached GradeThread yet" - otherwise the page is making the same
   * unchecked claim the ledger was written to stop.
   */
  function unsentResultLine(count) {
    var n = num(count) === null ? 0 : count;
    if (n <= 0) return "";
    return n === 1
      ? "One finished job has not been recorded on GradeThread yet. It will " +
        "keep trying; nothing has been lost."
      : n + " finished jobs have not been recorded on GradeThread yet. They " +
        "will keep trying; nothing has been lost.";
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
    RESULT_ATTEMPT_LIMIT: RESULT_ATTEMPT_LIMIT,
    RESULT_BACKOFF_MS: RESULT_BACKOFF_MS,
    RESULT_MAX_ENTRIES: RESULT_MAX_ENTRIES,
    resultAccepted: resultAccepted,
    recordUnsentResult: recordUnsentResult,
    clearUnsentResult: clearUnsentResult,
    dueUnsentResults: dueUnsentResults,
    exhaustedUnsentResults: exhaustedUnsentResults,
    dropExhaustedResults: dropExhaustedResults,
    unsentResultCount: unsentResultCount,
    unsentResultLine: unsentResultLine,
  };
})(typeof self !== "undefined" ? self : globalThis);
