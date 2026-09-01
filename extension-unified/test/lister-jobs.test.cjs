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
  assert.strictEqual(job({ kind: "revise" }).kind, "revise", "revise is preserved (US-9202)");
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

// ── lastJobRecord: what the popup shows (US-1885 AC1) ──────────────────────
{
  const j = job({ platform: "poshmark", kind: "list" });

  // The distinct outcomes stay distinct. Collapsing them into "failed" is how a
  // seller ends up double-posting: a timeout means retry, an unconfirmed delist
  // means go and CHECK the marketplace, a login wall means finish signing in.
  const cases = [
    [{ ok: true, filled: true }, "done"],
    [{ ok: false, pending: true, loginWall: true }, "pending"],
    [{ ok: false, timedOut: true }, "timedOut"],
    [{ ok: false, tabClosed: true }, "tabClosed"],
    [{ ok: false, unverified: true }, "unverified"],
    [{ ok: false, error: "something else" }, "failed"],
  ];
  for (const [result, expected] of cases) {
    assert.strictEqual(
      J.lastJobRecord(j, result, T0).outcome,
      expected,
      `result ${JSON.stringify(result)} → outcome "${expected}"`,
    );
  }

  // A late success is a success, but the popup has to say so — we already told the
  // seller it timed out, and they will re-post if we now just say "Done".
  const late = J.lastJobRecord(j, { ok: true, late: true }, T0);
  assert.strictEqual(late.ok, true);
  assert.strictEqual(late.late, true);

  // It is a PROJECTION, not the job: this goes to storage.local and would
  // otherwise park the whole listing payload (title, description, price, photo
  // URLs) on disk indefinitely for a line of UI text.
  const rec = J.lastJobRecord(job({ payload: { title: "secret", photoUrls: ["u"] } }), { ok: true }, T0);
  assert.strictEqual(rec.payload, undefined, "the record must not carry the listing payload");
  assert.strictEqual(rec.saasTabId, undefined, "nor internal routing state");
  assert.deepStrictEqual(Object.keys(rec).sort(), ["at", "error", "kind", "late", "ok", "outcome", "platform"]);

  // User-facing copy, not a log.
  assert.strictEqual(J.lastJobRecord(j, { error: "x".repeat(500) }, T0).error.length, 240, "error is capped");
  assert.strictEqual(J.lastJobRecord(j, { ok: true }, T0).error, null, "a success carries no error");
  assert.strictEqual(J.lastJobRecord(j, { error: 42 }, T0).error, null, "a non-string error is dropped");
  assert.strictEqual(J.lastJobRecord(j, {}, T0).at, T0, "the record is stamped");
}

console.log("lister-jobs: all assertions passed");

// ── US-1877 (AC1): the post-fill watch ─────────────────────────────────────
//
// A fill ends when the form is prefilled; the seller submits MINUTES later, and
// only then does the marketplace navigate to the live listing. That capture is what
// promotes the row from draft to active — so the watch has to outlive both the fill
// AND the worker, which is why it is a persisted record rather than a timer.
{
  const W0 = 5_000_000;
  const watch = J.makeWatch({
    tabId: 7,
    saasTabId: 99,
    clientRef: "ref-1",
    platform: "poshmark",
    itemId: "item-1",
    now: W0,
  });

  assert.strictEqual(watch.expiresAt, W0 + J.WATCH_TTL_MS, "the watch is bounded");
  assert.strictEqual(watch.saasTabId, 99, "it remembers where to report");

  let ws = J.putWatch({}, watch);
  assert.strictEqual(J.findWatch(ws, 7, W0 + 1000).itemId, "item-1", "found while live");
  assert.strictEqual(J.findWatch(ws, 8, W0 + 1000), null, "another tab has no watch");

  // THE POINT of the expiry: a tab the seller abandoned and reused hours later must
  // not have an unrelated listing captured against this item.
  assert.strictEqual(
    J.findWatch(ws, 7, W0 + J.WATCH_TTL_MS),
    null,
    "an expired watch must never match — it would capture whatever they browsed to next",
  );

  // Survives the worker dying mid-wait (the whole reason it is in storage.session).
  const roundTripped = JSON.parse(JSON.stringify(ws));
  assert.strictEqual(
    J.findWatch(roundTripped, 7, W0 + 1000).itemId,
    "item-1",
    "a watch survives a storage round-trip (worker death) and still captures",
  );

  ws = J.removeWatch(ws, 7);
  assert.strictEqual(J.findWatch(ws, 7, W0 + 1000), null, "removed after capture");

  // The sweep drops expired watches so storage.session can't grow unbounded.
  const mixed = J.putWatch(
    J.putWatch({}, watch),
    J.makeWatch({ tabId: 9, saasTabId: 99, platform: "grailed", now: W0 + J.WATCH_TTL_MS }),
  );
  const swept = J.sweepWatches(mixed, W0 + J.WATCH_TTL_MS + 1);
  assert.strictEqual(swept["7"], undefined, "the expired watch is swept");
  assert.ok(swept["9"], "the live one is kept");
}

// ── US-2481: draining the mobile queue ──────────────────────────────────────
//
// A seller queues cross-listing or delist work from their phone; this browser
// runs it the next time it opens. That is the honest answer to the cloud-session
// model — the server holds WHAT to do and never a marketplace credential
// (vault/60-decisions/adr-no-server-side-marketplace-automation.md).
//
// What the drain has to get right is small and unforgiving:
//   • one job at a time, because the seller is using this browser;
//   • never start a row already in flight, or a share run happens twice;
//   • never run an expired row, and never drop it silently either — a delist
//     that never happened is the thing they most need told about.
{
  const NOW = Date.parse("2026-08-10T12:00:00Z");
  const future = new Date(NOW + 86_400_000).toISOString();
  const past = new Date(NOW - 60_000).toISOString();

  const row = (id, over) => Object.assign({
    id,
    kind: "list",
    platform: "poshmark",
    inventory_item_id: "item-" + id,
    listing_id: null,
    payload: { locale: null },
    status: "claimed",
    expires_at: future,
    created_at: "2026-08-10T09:00:00Z",
  }, over || {});

  // ── one at a time ─────────────────────────────────────────────────────────
  {
    const plan = J.planDrain([row("a"), row("b"), row("c")], {}, { now: NOW });
    assert.strictEqual(
      plan.toRun.length,
      1,
      "the drain must start ONE job. Six queued rows means six marketplace tabs " +
        "opening at once, each stealing focus and several filling forms the " +
        "seller cannot see — their browser is not a worker pool.",
    );
    assert.strictEqual(plan.skipped.length, 2, "the rest wait their turn");
  }

  // ── oldest first ──────────────────────────────────────────────────────────
  {
    const plan = J.planDrain(
      [
        row("newer", { created_at: "2026-08-10T11:00:00Z" }),
        row("older", { created_at: "2026-08-09T08:00:00Z" }),
      ],
      {},
      { now: NOW },
    );
    assert.strictEqual(
      plan.toRun[0].id,
      "older",
      "the seller queued these in an order — a delist queued before a relist " +
        "has to run before it, or the replacement goes up while the original " +
        "is still live",
    );
  }

  // ── a pending job blocks the drain entirely ───────────────────────────────
  {
    const busy = J.put({}, J.makeJob({
      jobId: "j1", tabId: 5, saasTabId: 9, platform: "mercari", now: NOW,
    }));
    const plan = J.planDrain([row("a")], busy, { now: NOW });
    assert.strictEqual(
      plan.toRun.length,
      0,
      "an ordinary cross-post is already holding a tab; the drain must wait",
    );
  }

  // ── a row already in flight is never started twice ────────────────────────
  {
    const inFlight = J.put({}, J.makeJob({
      jobId: "j1", tabId: 5, platform: "poshmark", queueId: "a", now: NOW,
    }));
    const plan = J.planDrain([row("a"), row("b")], inFlight, {
      now: NOW,
      maxConcurrent: 5, // room to spare, so the ONLY reason to skip is the match
    });
    assert.ok(
      !plan.toRun.some((r) => r.id === "a"),
      "queue row 'a' is already running in this browser — starting it again " +
        "would fill the same form twice, or run a share job twice",
    );
    assert.ok(plan.toRun.some((r) => r.id === "b"), "the other row still runs");
  }

  // ── expired rows: not run, not silent ─────────────────────────────────────
  {
    const plan = J.planDrain(
      [row("dead", { expires_at: past }), row("live")],
      {},
      { now: NOW },
    );
    assert.deepStrictEqual(
      plan.expired.map((r) => r.id),
      ["dead"],
      "an expired row must be REPORTED, not quietly dropped (US-2481 AC6). A " +
        "seller who believes a delist is still pending is a seller heading for " +
        "a double sale.",
    );
    assert.ok(
      !plan.toRun.some((r) => r.id === "dead"),
      "an expired row must never be run",
    );
    assert.strictEqual(plan.toRun[0].id, "live");
  }

  // ── a kind this build cannot run: refused and REPORTED, never coerced ─────
  //
  // US-2497 removed kind=share at the server, so `share` is now standing in for
  // any kind a newer server grows that this build has no branch for. It is still
  // the right fixture, because it is the case that actually went wrong: with the
  // old implicit `kind === "delist" ? "delist" : "list"`, a share row became a
  // LIST job, and a request to share a closet opened the new-listing form and
  // filled it. Coercing an unknown kind is the failure; reporting it is the fix.
  {
    const plan = J.planDrain(
      [row("sh", { kind: "share" }), row("ok")],
      {},
      { now: NOW, maxConcurrent: 5 },
    );
    assert.deepStrictEqual(
      plan.unsupported.map((r) => r.id),
      ["sh"],
      "an unrunnable kind must be reported, like an expired row is — work that " +
        "nothing will ever pick up looks, from the phone, exactly like work " +
        "about to run (US-2165)",
    );
    assert.ok(
      !plan.toRun.some((r) => r.id === "sh"),
      "a share row must NEVER become a list job",
    );
    assert.ok(plan.toRun.some((r) => r.id === "ok"), "the runnable row still runs");

    assert.strictEqual(
      J.jobFromQueueRow(row("sh", { kind: "share" }), { jobId: "j", tabId: 1, now: NOW }),
      null,
      "the translation refuses rather than guessing a kind",
    );
    assert.deepStrictEqual(
      Object.keys(J.RUNNABLE_QUEUE_KINDS).sort(),
      ["delist", "list", "relist", "revise"],
      "adding a runnable kind here means teaching the drain to run it",
    );
  }

  // ── an unrunnable row is never reported as merely expired ─────────────────
  {
    const plan = J.planDrain([row("sh", { kind: "share", expires_at: past })], {}, { now: NOW });
    assert.strictEqual(plan.expired.length, 0);
    assert.strictEqual(
      plan.unsupported.length,
      1,
      "'it timed out' would name the wrong problem and invite the seller to " +
        "queue it again",
    );
  }

  // ── a malformed row cannot crash the drain ────────────────────────────────
  {
    const plan = J.planDrain([null, {}, { id: 7 }, row("ok")], {}, { now: NOW });
    assert.strictEqual(plan.toRun.length, 1);
    assert.strictEqual(plan.toRun[0].id, "ok");
  }

  // ── a row with no expiry is treated as live, not as expired ───────────────
  {
    const plan = J.planDrain([row("a", { expires_at: null })], {}, { now: NOW });
    assert.strictEqual(
      plan.toRun.length,
      1,
      "an unparseable expiry must not silently expire real work",
    );
  }

  // ── the row → job translation ─────────────────────────────────────────────
  {
    const job = J.jobFromQueueRow(
      row("q1", { kind: "delist", platform: "vinted", payload: { locale: "vinted.fr" } }),
      { jobId: "j9", tabId: 3, now: NOW },
    );
    assert.strictEqual(job.queueId, "q1", "the job carries its queue row id home");
    assert.strictEqual(job.kind, "delist");
    assert.strictEqual(job.platform, "vinted");
    assert.strictEqual(
      job.saasTabId,
      null,
      "a drained job has NO originating GradeThread tab — the seller queued it " +
        "from a phone hours ago. The result goes back to the queue endpoint, " +
        "which is what queueId exists for.",
    );
    assert.strictEqual(job.payload.locale, "vinted.fr", "the instruction survives");
    assert.strictEqual(job.payload.itemId, "item-q1");
    assert.ok(J.isPending(job));
  }

  // ── an ordinary job still has no queueId ──────────────────────────────────
  {
    const job = J.makeJob({ jobId: "j1", tabId: 1, saasTabId: 2, platform: "poshmark", now: NOW });
    assert.strictEqual(
      job.queueId,
      null,
      "a same-session cross-post must not look like a drained one, or its " +
        "result would be reported to a queue row that does not exist",
    );
  }
}

// ── US-2486: the stage marker on a two-page delist ─────────────────────────
//
// Poshmark and Grailed keep "delete this listing" on a different page from the
// listing, so ending one means following a link. That reloads the document, the
// content script re-injects and asks for its job BY TAB ID — and gets the same
// job back, because findByTab is exactly that mechanism. Without a marker it
// would click the link again, from a page that no longer has one.
{
  const J = loadJobs();
  const NOW = 1_000_000;

  const fresh = J.makeJob({ jobId: "d1", tabId: 7, platform: "poshmark", kind: "delist", now: NOW });
  assert.strictEqual(fresh.stage, null, "a new job has not navigated");

  let jobs = J.put({}, fresh);

  // Forward once.
  const a = J.advanceStage(jobs, "d1", "navigated", NOW + 10);
  assert.strictEqual(a.job.stage, "navigated");
  assert.strictEqual(a.job.stagedAt, NOW + 10);
  jobs = a.jobs;

  // The far page gets the SAME job back, now carrying the marker. This is the
  // whole mechanism: same tab, same job, different stage.
  const served = J.findByTab(jobs, 7);
  assert.strictEqual(served.jobId, "d1");
  assert.strictEqual(served.stage, "navigated");

  // ONE-WAY. Nothing may talk a navigated job back into thinking it has not
  // navigated — that is the loop, and it would be a delist clicking a link
  // that is no longer there on every page load until the deadline killed it.
  const back = J.advanceStage(jobs, "d1", null, NOW + 20);
  assert.strictEqual(back.job.stage, "navigated", "stage must not be cleared");
  const empty = J.advanceStage(jobs, "d1", "", NOW + 20);
  assert.strictEqual(empty.job.stage, "navigated", "an empty stage must be ignored");

  // Idempotent: a duplicate message from a re-injected script changes nothing,
  // including the timestamp.
  const again = J.advanceStage(jobs, "d1", "navigated", NOW + 999);
  assert.strictEqual(again.job.stagedAt, NOW + 10, "a repeat must not re-stamp");
  assert.strictEqual(again.jobs, jobs, "a no-op must not rewrite the map");

  // A terminal job is never staged. Once the seller has been told an outcome it
  // stands, and a late navigation must not revive it.
  const ended = J.markTerminal(jobs, "d1", "done", NOW + 30).jobs;
  const late = J.advanceStage(ended, "d1", "navigated-again", NOW + 40);
  assert.strictEqual(late.job, null, "a terminal job must not accept a stage");

  // And an unknown job id is a no-op rather than a throw.
  assert.strictEqual(J.advanceStage(jobs, "nope", "navigated", NOW).job, null);
}
