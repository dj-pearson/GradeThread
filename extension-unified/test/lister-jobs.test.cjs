// GradeThread unified extension — Lister job state machine tests (US-1874).
//
// The bug this guards is the one that made cross-post jobs silently vanish: job
// state lived in the MV3 service worker's module memory, and Chrome kills an idle
// worker ~30s after its last event (an open sendResponse port does NOT keep it
// alive, despite the old comment saying so). A slow marketplace tab therefore
// routinely outlived the worker holding its job.
//
// background.js is now a thin async shell over the pure state machine in
// lister/job-store.js; every decision that used to be tangled up with chrome APIs
// lives there so it can be tested with zero dependencies and no browser. Loaded
// with an injected `self` — the same trick as registry/guard tests.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function loadJobs() {
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "lister", "job-store.js"),
    "utf8",
  );
  const selfObj = {};
  // eslint-disable-next-line no-new-func
  new Function("self", src)(selfObj);
  assert.ok(selfObj.GT_LISTER_JOBS, "job-store.js must assign self.GT_LISTER_JOBS");
  return selfObj.GT_LISTER_JOBS;
}

const J = loadJobs();
const T0 = 1_000_000;

function job(over) {
  return J.makeJob(
    Object.assign(
      {
        jobId: "job-1",
        clientRef: "ref-1",
        tabId: 10,
        saasTabId: 99,
        platform: "poshmark",
        kind: "list",
        payload: { title: "x" },
        now: T0,
      },
      over,
    ),
  );
}

// ── makeJob: the durable shape ─────────────────────────────────────────────
{
  const j = job();
  assert.strictEqual(j.state, "pending", "a new job is pending");
  assert.strictEqual(j.deadlineAt, T0 + J.JOB_TIMEOUT_MS, "deadline is now + timeout");
  assert.strictEqual(j.endedAt, null, "a pending job has no end stamp");
  // AC3: the originating SaaS tab is the whole point — without it a result that
  // arrives after the port died has nowhere to go.
  assert.strictEqual(j.saasTabId, 99, "the originating SaaS tab id is persisted");
  assert.strictEqual(j.clientRef, "ref-1", "the page's correlation ref is persisted");

  // clientRef is page-supplied and untrusted: bounded, and never invented.
  assert.strictEqual(job({ clientRef: "x".repeat(500) }).clientRef.length, 64, "clientRef is capped");
  assert.strictEqual(job({ clientRef: 42 }).clientRef, null, "a non-string clientRef is dropped");
  assert.strictEqual(job({ kind: "nonsense" }).kind, "list", "an unknown kind falls back to list");
  assert.strictEqual(job({ kind: "delist" }).kind, "delist", "delist is preserved");
}

// ── findByTab: what the respawned content script asks ──────────────────────
{
  let jobs = J.put({}, job());
  assert.strictEqual(J.findByTab(jobs, 10).jobId, "job-1", "a pending job is found by its tab");
  assert.strictEqual(J.findByTab(jobs, 11), null, "another tab gets nothing");
  assert.strictEqual(J.findByTab(jobs, undefined), null, "a missing tab id gets nothing");

  // The load-bearing case for AC1: this map came out of storage.session, i.e. it
  // survived the worker being killed. The fill still runs.
  const roundTripped = JSON.parse(JSON.stringify(jobs));
  assert.strictEqual(
    J.findByTab(roundTripped, 10).jobId,
    "job-1",
    "a job survives a storage round-trip (worker death) and is still served",
  );

  // A terminal job must NEVER be handed back: we already told the seller it failed,
  // so re-running the fill would prefill a form they were told to do by hand.
  jobs = J.markTerminal(jobs, "job-1", "timedOut", T0 + 1).jobs;
  assert.strictEqual(J.findByTab(jobs, 10), null, "a timed-out job is not re-served to its tab");
}

// ── markTerminal: exactly-once reporting ───────────────────────────────────
{
  let jobs = J.put({}, job());
  const first = J.markTerminal(jobs, "job-1", "timedOut", T0 + 5);
  assert.strictEqual(first.job.state, "timedOut");
  assert.strictEqual(first.job.endedAt, T0 + 5, "the end is stamped for the grace sweep");
  jobs = first.jobs;

  // A duplicate alarm + tab-close + late result can all race. Only the first wins,
  // or the SaaS promise gets settled twice with contradictory outcomes.
  const second = J.markTerminal(jobs, "job-1", "tabClosed", T0 + 6);
  assert.strictEqual(second.job, null, "a second terminal transition reports nothing");
  assert.strictEqual(second.jobs, jobs, "and does not mutate the map");
  assert.strictEqual(J.markTerminal(jobs, "nope", "timedOut", T0).job, null, "unknown job → no report");
}

// ── sweep: the late-result grace window (AC4) ──────────────────────────────
{
  const pending = job({ jobId: "p", tabId: 1 });
  let jobs = J.put({}, pending);
  jobs = J.put(jobs, J.markTerminal(J.put({}, job({ jobId: "t", tabId: 2 })), "t", "timedOut", T0).job);

  // Inside the window the terminal job is KEPT — that is what lets a fill that
  // finished late still be attributed to its saasTabId and reported.
  let out = J.sweep(jobs, T0 + J.TERMINAL_GRACE_MS - 1);
  assert.ok(out.jobs.t, "a terminal job is kept inside its grace window");
  assert.strictEqual(out.dropped.length, 0);

  out = J.sweep(jobs, T0 + J.TERMINAL_GRACE_MS);
  assert.strictEqual(out.jobs.t, undefined, "a terminal job is dropped once the window passes");
  assert.strictEqual(out.dropped.length, 1);

  // A pending job is never swept — its alarm owns it, and dropping it would lose
  // the saasTabId the timeout report needs.
  assert.ok(out.jobs.p, "a pending job is never swept, however old");
  out = J.sweep(jobs, T0 + J.TERMINAL_GRACE_MS * 100);
  assert.ok(out.jobs.p, "a pending job survives an arbitrarily late sweep");
}

// ── the user-facing copy is part of the contract ───────────────────────────
{
  const listTimeout = J.timeoutResultFor(job(), "Poshmark");
  assert.strictEqual(listTimeout.ok, false);
  assert.strictEqual(listTimeout.timedOut, true, "a timeout is machine-readable");
  assert.match(listTimeout.error, /Poshmark/, "the timeout names the marketplace");
  assert.match(listTimeout.error, /List manually/, "and tells the seller what to do");

  const delistTimeout = J.timeoutResultFor(job({ kind: "delist" }), "Mercari");
  assert.match(delistTimeout.error, /End it manually/, "delist gets its own copy, not the fill copy");

  // AC4: a closed tab is its own distinct, immediate outcome — not a 120s timeout.
  const closed = J.tabClosedResultFor(job(), "Grailed");
  assert.strictEqual(closed.tabClosed, true, "tab-close is machine-readable");
  assert.notStrictEqual(closed.timedOut, true, "and is NOT reported as a timeout");
  assert.match(closed.error, /Grailed tab was closed/);
  assert.match(
    J.tabClosedResultFor(job({ kind: "delist" }), "Grailed").error,
    /listing was ended/,
    "delist tab-close copy describes delisting, not filling",
  );
}

// ── put/remove are non-mutating (storage read-modify-write safety) ─────────
{
  const base = J.put({}, job());
  const added = J.put(base, job({ jobId: "job-2", tabId: 20 }));
  assert.strictEqual(Object.keys(base).length, 1, "put does not mutate its input");
  assert.strictEqual(Object.keys(added).length, 2);
  const removed = J.remove(added, "job-1");
  assert.strictEqual(Object.keys(added).length, 2, "remove does not mutate its input");
  assert.strictEqual(J.findById(removed, "job-1"), null);
  assert.ok(J.findById(removed, "job-2"), "removing one job leaves the other");
}

console.log("lister-jobs: all assertions passed");
