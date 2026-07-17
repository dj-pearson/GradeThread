// GradeThread unified extension — Lister job state machine (US-1874)
//
// WHY THIS FILE EXISTS. Job state used to live in two module-scope objects in
// background.js (`jobsByTab` / `pendingExternal`). That is not durable, and the
// comment that justified it ("the worker stays alive while a job is outstanding
// (sendResponse port open)") is FACTUALLY WRONG: Chrome terminates an idle MV3
// service worker ~30s after the last event, and an open sendResponse channel does
// NOT keep it alive. A marketplace page that takes longer than that to load — the
// common case on a cold Poshmark/Mercari tab — got its worker killed, taking the
// job map and the setTimeout safety net with it. The fill then never ran, and the
// SaaS promise hung until its own 130s client timeout. That is the "jobs silently
// vanish" bug (audit F1/F2/F3/F10/F11/F12).
//
// The fix needs the state in chrome.storage.session and the timeouts on
// chrome.alarms. Both are async, chrome-only APIs — so ALL the decision logic
// lives HERE as pure functions over a plain jobs map, and background.js is left as
// a thin async shell that loads, calls, and saves. Same split as lister-guard.js,
// and for the same reason: it makes the part that is easy to get wrong testable
// with zero dependencies and no browser (test/lister-jobs.test.cjs).
//
// The map is keyed by jobId (not tabId) because a job outlives its tab: a tab can
// close, or time out, while a late result still needs to find the job's saasTabId
// to report against. Both lookups scan; a user has single-digit concurrent jobs.
(function (root) {
  "use strict";

  // How long a job may sit un-reported before the alarm fails it. Matches the old
  // setTimeout value, and stays comfortably under the SaaS client's 130s timeout so
  // the extension is the side that reports the timeout (with a useful message)
  // rather than the page giving up on a job that is still notionally alive.
  var JOB_TIMEOUT_MS = 120000;

  // A terminal job is KEPT this long rather than deleted (AC4). It is the only way
  // a late GT_LISTER_RESULT — a fill that did finish, just after we gave up — can
  // still be attributed to its saasTabId and reported as a late success instead of
  // being silently dropped. Long enough to cover a slow-but-working fill, short
  // enough that storage.session can't grow without bound.
  var TERMINAL_GRACE_MS = 10 * 60 * 1000;

  // US-1875 AC3: how far a login-wall notice pushes the deadline out. Generous —
  // it covers finding the password, a 2FA code, and the redirect back.
  var LOGIN_WALL_GRACE_MS = 5 * 60 * 1000;

  var PENDING = "pending";

  function isPending(job) {
    return Boolean(job) && job.state === PENDING;
  }

  function makeJob(o) {
    var now = typeof o.now === "number" ? o.now : 0;
    return {
      jobId: String(o.jobId),
      // The page's OWN correlation id, echoed back on every push so the SaaS can
      // match a result to the promise it is waiting on. The page never learns the
      // jobId (the background mints that after the request), so without this there
      // is nothing to correlate a push against. Page-supplied and untrusted: it is
      // only ever echoed, never used to key our own state.
      clientRef: typeof o.clientRef === "string" ? o.clientRef.slice(0, 64) : null,
      // The marketplace tab we opened; the content script asks for its job by it.
      tabId: typeof o.tabId === "number" ? o.tabId : null,
      // The gradethread.com tab that STARTED the job. Persisted because it is how
      // the result gets home once the sendResponse port is gone (AC3).
      saasTabId: typeof o.saasTabId === "number" ? o.saasTabId : null,
      platform: String(o.platform || ""),
      kind: o.kind === "delist" ? "delist" : "list",
      payload: o.payload || null,
      state: PENDING,
      createdAt: now,
      deadlineAt: now + (typeof o.ttlMs === "number" ? o.ttlMs : JOB_TIMEOUT_MS),
      // Set when the job goes terminal; drives the grace-window sweep.
      endedAt: null,
    };
  }

  function put(jobs, job) {
    var next = Object.assign({}, jobs);
    next[job.jobId] = job;
    return next;
  }

  function remove(jobs, jobId) {
    var next = Object.assign({}, jobs);
    delete next[jobId];
    return next;
  }

  function findById(jobs, jobId) {
    if (!jobs || typeof jobId !== "string") return null;
    return jobs[jobId] || null;
  }

  // Only ever resolves a PENDING job. A terminal job's tab id is deliberately not
  // matchable: once a job has timed out we must not hand it back to a content
  // script that finally woke up and asked for work — it would re-run a fill the
  // user was already told had failed.
  function findByTab(jobs, tabId) {
    if (!jobs || typeof tabId !== "number") return null;
    var keys = Object.keys(jobs);
    for (var i = 0; i < keys.length; i++) {
      var job = jobs[keys[i]];
      if (job && job.tabId === tabId && isPending(job)) return job;
    }
    return null;
  }

  // US-1875 AC3: push a pending job's deadline out. A login wall means the seller
  // has to go and sign in, which routinely takes longer than the 120s job timeout —
  // so without this the job we deliberately kept alive would be failed by its own
  // alarm before they finished typing their password. Terminal jobs are never
  // revived: once we have told the seller an outcome, it stands.
  function extendDeadline(jobs, jobId, deadlineAt) {
    var job = findById(jobs, jobId);
    if (!isPending(job)) return { jobs: jobs, job: null };
    // Never pull a deadline IN — an extension is the only legal move, or a
    // misbehaving page could shorten its own job.
    if (deadlineAt <= job.deadlineAt) return { jobs: jobs, job: job };
    var next = Object.assign({}, job, { deadlineAt: deadlineAt });
    return { jobs: put(jobs, next), job: next };
  }

  // Move a job to a terminal state, keeping it for the grace window (AC4).
  // Returns the unchanged map when the job is missing or already terminal, so a
  // duplicate alarm/close/result can't double-report.
  function markTerminal(jobs, jobId, state, now) {
    var job = findById(jobs, jobId);
    if (!isPending(job)) return { jobs: jobs, job: null };
    var ended = Object.assign({}, job, {
      state: state,
      endedAt: typeof now === "number" ? now : 0,
    });
    return { jobs: put(jobs, ended), job: ended };
  }

  // Drop terminal jobs whose grace window has passed. Pending jobs are NEVER swept
  // here — their alarm owns them; sweeping one would race the alarm and lose the
  // saasTabId the timeout report needs.
  function sweep(jobs, now) {
    var next = {};
    var dropped = [];
    Object.keys(jobs || {}).forEach(function (id) {
      var job = jobs[id];
      if (!job) return;
      var expired =
        !isPending(job) &&
        typeof job.endedAt === "number" &&
        now - job.endedAt >= TERMINAL_GRACE_MS;
      if (expired) dropped.push(job);
      else next[id] = job;
    });
    return { jobs: next, dropped: dropped };
  }

  // The user-facing copy for each way a job can end without a result. Kept here so
  // the message is part of the tested state machine rather than buried in the
  // worker — these strings are the seller's only signal that something went wrong.
  function timeoutResultFor(job, label) {
    var name = label || job.platform;
    return job.kind === "delist"
      ? {
          ok: false,
          timedOut: true,
          error:
            "Timed out ending the " + name +
            " listing. End it manually if the tab didn't.",
        }
      : {
          ok: false,
          timedOut: true,
          error:
            "Timed out waiting for the " + name +
            " form. List manually if the tab didn't prefill.",
        };
  }

  // AC4: a closed tab is reported IMMEDIATELY. Previously onRemoved deleted the
  // per-tab entry but left the pending callback, so closing the tab bought the
  // seller a 120s wait for a job that could no longer possibly complete.
  function tabClosedResultFor(job, label) {
    var name = label || job.platform;
    return {
      ok: false,
      tabClosed: true,
      error:
        "The " + name + " tab was closed before the " +
        (job.kind === "delist" ? "listing was ended" : "form was filled") + ".",
    };
  }

  // US-1885 AC1: the compact record the popup renders as "last job".
  //
  // Deliberately NOT the job itself. A job carries the full listing payload —
  // title, description, price, photo URLs — and this is written to storage.LOCAL
  // (it must survive the session, unlike the job map) where it would sit on disk
  // indefinitely for no reason. So this projects only what the popup shows.
  //
  // The outcome is derived from the same result the seller was shown, so the popup
  // can never disagree with the page: ok -> done, and the specific failure modes
  // stay distinguishable because "timed out" and "you closed the tab" and "we
  // couldn't confirm it" call for completely different responses.
  function lastJobRecord(job, result, now) {
    var r = result || {};
    var outcome = "failed";
    if (r.ok) outcome = "done";
    else if (r.pending) outcome = "pending";
    else if (r.timedOut) outcome = "timedOut";
    else if (r.tabClosed) outcome = "tabClosed";
    else if (r.unverified) outcome = "unverified";
    return {
      platform: job.platform,
      kind: job.kind,
      outcome: outcome,
      ok: Boolean(r.ok),
      late: Boolean(r.late),
      // Bounded: this is user-facing copy, not a log.
      error: typeof r.error === "string" ? r.error.slice(0, 240) : null,
      at: typeof now === "number" ? now : 0,
    };
  }

  root.GT_LISTER_JOBS = {
    lastJobRecord: lastJobRecord,
    JOB_TIMEOUT_MS: JOB_TIMEOUT_MS,
    LOGIN_WALL_GRACE_MS: LOGIN_WALL_GRACE_MS,
    TERMINAL_GRACE_MS: TERMINAL_GRACE_MS,
    makeJob: makeJob,
    put: put,
    remove: remove,
    findById: findById,
    findByTab: findByTab,
    markTerminal: markTerminal,
    extendDeadline: extendDeadline,
    sweep: sweep,
    isPending: isPending,
    timeoutResultFor: timeoutResultFor,
    tabClosedResultFor: tabClosedResultFor,
  };
})(typeof self !== "undefined" ? self : globalThis);
