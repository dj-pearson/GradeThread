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
      // US-9202: revise joins delist as a kind that targets a live listing.
      // Anything else is a list, as before.
      kind: o.kind === "delist" ? "delist" : o.kind === "revise" ? "revise" : "list",
      payload: o.payload || null,
      // US-9202: the listing whose pending-revise marker this job settles.
      // Ours, never the page's: set from the server's pending list or from a
      // payload the server owner-checked, and read only by reportJob.
      reviseListingId: typeof o.reviseListingId === "string" ? o.reviseListingId : null,
      // US-2481: the server-side queue row this job came from, when it was
      // DRAINED rather than started from an open GradeThread tab. It is how the
      // result finds its way back to a queue entry whose originating device — a
      // phone, hours ago — is not part of this conversation at all. Null for an
      // ordinary same-session cross-post.
      queueId: typeof o.queueId === "string" ? o.queueId : null,
      // US-2486: where a MULTI-PAGE job has got to.
      //
      // Poshmark and Grailed keep "delete this listing" on a different page
      // from the listing, so ending one means following a link. That reloads
      // the document, the content script re-runs, and it asks for its job by
      // tab id — getting the same job back. Without a marker it would click the
      // link again, from a page that no longer has one, forever.
      //
      // `null` means "has not navigated yet". It only ever moves forward, and
      // the destination is checked against the config's own URL pattern before
      // anything is clicked on the far side.
      stage: null,
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

  /**
   * Record that a multi-page job has moved on (US-2486).
   *
   * ONE-WAY, and that is the whole safety property. A job that has navigated
   * can never be told it has not, so the content script on the far page cannot
   * be talked into clicking the link a second time — which, on a page that no
   * longer has one, is the difference between a failed delist and a loop.
   *
   * Terminal jobs are never staged: once the seller has been told an outcome,
   * it stands.
   */
  function advanceStage(jobs, jobId, stage, now) {
    var job = findById(jobs, jobId);
    if (!isPending(job)) return { jobs: jobs, job: null };
    if (typeof stage !== "string" || !stage) return { jobs: jobs, job: job };
    if (job.stage === stage) return { jobs: jobs, job: job };
    var next = Object.assign({}, job, {
      stage: stage,
      stagedAt: typeof now === "number" ? now : job.createdAt,
    });
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
      : job.kind === "revise"
      ? {
          ok: false,
          timedOut: true,
          unverified: true,
          error:
            "Timed out updating the " + name +
            " listing. Check it there and edit it manually if the change didn't land.",
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
        (job.kind === "delist"
          ? "listing was ended"
          : job.kind === "revise"
          ? "listing was updated"
          : "form was filled") + ".",
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

  // US-1877 (AC1): the post-fill WATCH.
  //
  // A fill ends when the form is prefilled — but the seller submits minutes later,
  // and that is when the marketplace navigates the tab to the new live listing.
  // Capturing that URL is what promotes the row from draft to active.
  //
  // WHY THE WATCH LIVES HERE AND NOT IN THE CONTENT SCRIPT. Submitting often does a
  // FULL PAGE LOAD, which tears the content script down and re-injects it with no
  // memory of having filled anything — an in-page watch would simply die at the
  // moment it was needed. The background watches via tabs.onUpdated instead, keyed
  // on the tab id, and this record is what survives the worker being suspended in
  // between (the whole point of US-1874's storage.session).
  //
  // Deliberately NOT a job: the job is over (its result was reported). Reviving it
  // would re-open a settled promise. This is a separate, later observation.
  var WATCH_TTL_MS = 30 * 60 * 1000;

  function makeWatch(o) {
    var now = typeof o.now === "number" ? o.now : 0;
    return {
      tabId: typeof o.tabId === "number" ? o.tabId : null,
      saasTabId: typeof o.saasTabId === "number" ? o.saasTabId : null,
      clientRef: typeof o.clientRef === "string" ? o.clientRef.slice(0, 64) : null,
      platform: String(o.platform || ""),
      itemId: typeof o.itemId === "string" ? o.itemId : null,
      createdAt: now,
      // 30 minutes: long enough for a seller to write a description and pick a
      // category, short enough that a tab reused for something else hours later
      // can't have an unrelated listing captured against this item.
      expiresAt: now + WATCH_TTL_MS,
    };
  }

  function putWatch(watches, watch) {
    var next = Object.assign({}, watches);
    next[String(watch.tabId)] = watch;
    return next;
  }

  function findWatch(watches, tabId, now) {
    var w = watches && watches[String(tabId)];
    if (!w) return null;
    // An expired watch is not a match — returning it would capture whatever the
    // seller happened to browse to later.
    if (typeof now === "number" && w.expiresAt <= now) return null;
    return w;
  }

  function removeWatch(watches, tabId) {
    var next = Object.assign({}, watches);
    delete next[String(tabId)];
    return next;
  }

  function sweepWatches(watches, now) {
    var next = {};
    Object.keys(watches || {}).forEach(function (k) {
      if (watches[k] && watches[k].expiresAt > now) next[k] = watches[k];
    });
    return next;
  }

  // ── US-2481: draining the mobile queue ────────────────────────────────────
  //
  // A seller queues work from their phone; this browser runs it the next time it
  // opens. The decision of WHAT to run now is pure and lives here, next to the
  // job map it has to reason about, so test/lister-jobs.test.cjs can hold it.
  //
  // ONE AT A TIME, deliberately. A drain that started six jobs would open six
  // marketplace tabs at once, each of which steals focus, and several of which
  // would be filling forms the seller cannot see. The seller's browser is not a
  // worker pool — it is the thing they are also using. So the drain runs a
  // single job and comes back for the next one when that finishes.
  var DRAIN_MAX_CONCURRENT = 1;

  /**
   * The queue kinds this extension can actually carry out.
   *
   * The server used to accept a third kind, `share`, and this list was the only
   * thing stopping it being run as something else. US-2497 removed the kind at
   * the source: an engagement pass (US-2482) only ever runs in a tab already
   * sitting on the seller's own closet, the extension deliberately does not know
   * their Poshmark handle and will not navigate to a URL that arrived in a
   * message (US-1876), and its clickwrap promises to hand the tab back if
   * Poshmark asks for a human check — which needs a human there to hand it to.
   *
   * This list stays explicit anyway, and so does the `unsupported` bucket below.
   * An older extension build meets a newer server eventually, and the previous
   * shape of this line was the implicit `kind === "delist" ? "delist" : "list"`,
   * which turned a share row into a LIST job: the drain opened the new-listing
   * form and filled it. A seller who asked for their closet to be shared would
   * have got a duplicate listing. Unrunnable is reported now, per US-2165.
   */
  var RUNNABLE_QUEUE_KINDS = { list: true, delist: true, revise: true };

  /**
   * Decide which queued rows to start now.
   *
   * Returns:
   *   toRun   — rows to turn into jobs, oldest first.
   *   expired — rows past their window. NOT run, and NOT silently dropped: the
   *             caller reports them, because a delist that never happened is
   *             the thing the seller most needs told about (AC6).
   *   skipped — rows already in flight in this browser, so a second drain tick
   *             cannot double-run a share job.
   *   unsupported — rows whose kind this build cannot carry out. Also reported,
   *             for the same reason: work sitting in a queue that nothing will
   *             ever pick up looks exactly like work that is about to run.
   */
  function planDrain(rows, jobs, ctx) {
    var now = (ctx && typeof ctx.now === "number") ? ctx.now : 0;
    var max = (ctx && typeof ctx.maxConcurrent === "number")
      ? ctx.maxConcurrent
      : DRAIN_MAX_CONCURRENT;

    // What this browser is already doing. A pending job holds a marketplace tab,
    // and starting another job for the same queue row would fill the same form
    // twice.
    var inFlight = {};
    var pendingCount = 0;
    Object.keys(jobs || {}).forEach(function (id) {
      var job = jobs[id];
      if (!isPending(job)) return;
      pendingCount += 1;
      if (job.queueId) inFlight[job.queueId] = true;
    });

    var toRun = [];
    var expired = [];
    var skipped = [];
    var unsupported = [];
    var slots = Math.max(0, max - pendingCount);

    var list = Array.isArray(rows) ? rows.slice() : [];
    // Oldest first: the seller queued them in an order, and a delist queued
    // before a listing should be ended before the replacement goes up.
    list.sort(function (a, b) {
      return String(a && a.created_at || "").localeCompare(String(b && b.created_at || ""));
    });

    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      if (!row || typeof row.id !== "string") continue;

      // Checked BEFORE the clock. A row this build can never run is not waiting
      // for anything, so calling it "expired" would name the wrong problem and
      // invite the seller to queue it again.
      if (!RUNNABLE_QUEUE_KINDS[row.kind]) {
        unsupported.push(row);
        continue;
      }

      var expiresAt = Date.parse(row.expires_at);
      if (Number.isFinite(expiresAt) && expiresAt <= now) {
        expired.push(row);
        continue;
      }
      if (inFlight[row.id]) {
        skipped.push(row);
        continue;
      }
      if (slots <= 0) {
        skipped.push(row);
        continue;
      }
      toRun.push(row);
      slots -= 1;
    }

    return {
      toRun: toRun,
      expired: expired,
      skipped: skipped,
      unsupported: unsupported,
    };
  }

  /**
   * Turn a queue row into the payload shape the content scripts already expect.
   *
   * The queue speaks the SERVER's language (snake_case columns, an instruction
   * blob); the job runner speaks the extension's. Translating here rather than
   * in the worker means the mapping is testable and there is exactly one of it.
   *
   * Only ever called with a row `planDrain` put in `toRun`, so its kind is
   * already known runnable. Returns null rather than guessing if that stops
   * being true — guessing is what sent share rows to the new-listing form.
   */
  function jobFromQueueRow(row, o) {
    if (!row || !RUNNABLE_QUEUE_KINDS[row.kind]) return null;
    return makeJob({
      jobId: o.jobId,
      clientRef: null,
      tabId: o.tabId,
      // A drained job has no originating GradeThread tab — the seller queued it
      // from a phone. Results go back to the queue endpoint instead, which is
      // what queueId is for.
      saasTabId: null,
      platform: row.platform,
      kind: row.kind,
      payload: Object.assign({}, row.payload || {}, {
        platform: row.platform,
        itemId: row.inventory_item_id || null,
        listingId: row.listing_id || null,
      }),
      queueId: row.id,
      reviseListingId: row.kind === "revise" ? (row.listing_id || null) : null,
      now: o.now,
      ttlMs: o.ttlMs,
    });
  }

  root.GT_LISTER_JOBS = {
    isPending: isPending,
    DRAIN_MAX_CONCURRENT: DRAIN_MAX_CONCURRENT,
    RUNNABLE_QUEUE_KINDS: RUNNABLE_QUEUE_KINDS,
    planDrain: planDrain,
    jobFromQueueRow: jobFromQueueRow,
    WATCH_TTL_MS: WATCH_TTL_MS,
    makeWatch: makeWatch,
    putWatch: putWatch,
    findWatch: findWatch,
    removeWatch: removeWatch,
    sweepWatches: sweepWatches,
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
    advanceStage: advanceStage,
    sweep: sweep,
    isPending: isPending,
    timeoutResultFor: timeoutResultFor,
    tabClosedResultFor: tabClosedResultFor,
  };
})(typeof self !== "undefined" ? self : globalThis);
