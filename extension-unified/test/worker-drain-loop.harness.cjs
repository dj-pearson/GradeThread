// US-3061 AC4 - twenty consecutive drains against a real seeded queue.
//
// NOT a *.test.cjs, and the name is deliberate: scripts/test-extensions.mjs
// discovers every *.test.cjs in this folder and runs it with no arguments, and a
// check that needs Postgres, PostgREST and a running edge service must not sit
// in a lane that runs on every commit. It is an operator harness. It refuses to
// run rather than skipping green, because a queue check that passes when it did
// nothing is the exact shape this story exists to catch.
//
// WHAT IT PROVES. AC4: "20 consecutive drains against a seeded queue complete
// every row exactly once, asserted from extension_work_queue rows." The row
// state is read back from the database at the end; nothing is believed because a
// response said 200.
//
// WHY IT DRIVES THE REAL MODULES. The claim size and the run plan are the two
// decisions this check is about, so it calls lister/job-store.js for both rather
// than restating them. A harness that decides for itself how many rows to claim
// proves only that the harness agrees with the harness. The one thing it does
// model is the browser: a marketplace tab opens, takes a while, and reports.
//
// RUN IT (see CLAUDE.md "PostgREST CAN run locally"):
//   docker start supabase_db_gradethread supabase_rest_gradethread
//   # PostgREST publishes no port of its own; put anything in front that
//   # answers /rest/v1/ and /auth/v1/, then:
//   GT_HARNESS_SUPABASE_URL=http://127.0.0.1:54341 \
//   GT_HARNESS_SERVICE_KEY=... \
//   GT_HARNESS_EDGE_BASE_URL=http://127.0.0.1:8787 \
//   GT_HARNESS_EXTENSION_TOKEN_SECRET=... \
//   node extension-unified/test/worker-drain-loop.harness.cjs

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(dir, ...p), "utf8");

// -- configuration, and a refusal rather than a skip ------------------------

const REQUIRED = [
  "GT_HARNESS_SUPABASE_URL",
  "GT_HARNESS_SERVICE_KEY",
  "GT_HARNESS_EDGE_BASE_URL",
  "GT_HARNESS_EXTENSION_TOKEN_SECRET",
];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(
    "worker-drain-loop.harness.cjs needs a local stack and a running edge " +
      "service. Missing: " + missing.join(", ") + ". See the header for the recipe.",
  );
  process.exit(2);
}

const SUPABASE_URL = process.env.GT_HARNESS_SUPABASE_URL.replace(/\/+$/, "");
const SERVICE_KEY = process.env.GT_HARNESS_SERVICE_KEY;
const EDGE = process.env.GT_HARNESS_EDGE_BASE_URL.replace(/\/+$/, "");
const TOKEN_SECRET = process.env.GT_HARNESS_EXTENSION_TOKEN_SECRET;

/** How many rows the seeded queue holds. */
const SEED_ROWS = 8;
/** AC4's number. */
const DRAINS = 20;
/**
 * How many drain passes a started job stays open before it reports.
 *
 * TWO, and the number was found by a sabotage that should have gone red and did
 * not. At one, a job started on pass N settles at the top of pass N+1 -- before
 * that pass decides how much to claim -- so the job map is empty every single
 * time the limit is computed, and the harness never asks the concurrency
 * question at all. Breaking drainClaimLimit to ignore running jobs passed 5 of 5
 * checks. At two, a job is still open when the next pass decides, which is what
 * a marketplace tab actually looks like against a 60-second cadence, and the
 * same sabotage strands rows.
 */
const JOB_PASSES = 2;

// -- the real modules -------------------------------------------------------

const root = {};
new Function("self", read("lister", "job-store.js"))(root);
const JOBS = root.GT_LISTER_JOBS;
assert.ok(JOBS && JOBS.planDrain, "lister/job-store.js must assign self.GT_LISTER_JOBS");

/**
 * How many rows a drain pass may claim.
 *
 * Taken from job-store.js when it exports the decision, so this harness and
 * background.js cannot disagree about it. The fallback is what background.js
 * sent before there was a shared answer, and it is PRINTED, because a harness
 * quietly using its own number is how a drain check passes against the drain it
 * was supposed to be measuring.
 */
function claimLimit(jobs) {
  if (typeof JOBS.drainClaimLimit === "function") return JOBS.drainClaimLimit(jobs);
  return 5;
}
const LIMIT_SOURCE = typeof JOBS.drainClaimLimit === "function"
  ? "GT_LISTER_JOBS.drainClaimLimit"
  : "the pre-US-3061 literal 5 (job-store.js exports no drainClaimLimit)";

// -- HTTP -------------------------------------------------------------------

async function rest(pathAndQuery, init) {
  const resp = await fetch(SUPABASE_URL + "/rest/v1/" + pathAndQuery, Object.assign({}, init || {}, {
    headers: Object.assign({
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
    }, (init && init.headers) || {}),
  }));
  const text = await resp.text();
  if (!resp.ok) throw new Error("REST " + resp.status + " on " + pathAndQuery + ": " + text);
  return text ? JSON.parse(text) : null;
}

let token = null;

/** The edge call the extension makes, byte for byte: bearer token, JSON body. */
async function queueFetch(p, init) {
  const resp = await fetch(EDGE + "/api/flipdesk/extension-queue" + p, Object.assign({}, init || {}, {
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
  }));
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_e) { body = null; }
  return { status: resp.status, ok: resp.ok, body: body, raw: text };
}

// -- the fixture ------------------------------------------------------------

function mintToken(userId) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const sig = crypto.createHmac("sha256", TOKEN_SECRET)
    .update(userId + ":" + expires).digest("hex");
  return userId + "." + expires + "." + sig;
}

async function seed() {
  const email = "us3061-harness-" + crypto.randomUUID() + "@example.invalid";
  const resp = await fetch(SUPABASE_URL + "/auth/v1/admin/users", {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: email, password: crypto.randomUUID(), email_confirm: true }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error("could not create the fixture user: " + resp.status + " " + text);
  const userId = JSON.parse(text).id;

  const rows = [];
  for (let i = 0; i < SEED_ROWS; i++) {
    rows.push({
      user_id: userId,
      kind: "delist",
      platform: "poshmark",
      source: "mobile",
      payload: { listingUrl: "https://poshmark.com/listing/us3061-harness-" + i },
    });
  }
  const inserted = await rest("extension_work_queue", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(rows),
  });
  assert.strictEqual(inserted.length, SEED_ROWS, "the fixture seeded " + SEED_ROWS + " rows");
  return { userId: userId, ids: inserted.map((r) => r.id) };
}

async function cleanup(userId) {
  try {
    await rest("extension_work_queue?user_id=eq." + userId, { method: "DELETE" });
    await fetch(SUPABASE_URL + "/auth/v1/admin/users/" + userId, {
      method: "DELETE",
      headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY },
    });
  } catch (e) {
    console.error("cleanup failed (harmless, the rows are a fixture):", e.message);
  }
}

// -- the drain loop ---------------------------------------------------------

/**
 * One pass of what background.js's drainQueue does, with the browser modelled.
 *
 * The bookkeeping counted here is the whole point: how many rows each pass took,
 * and how many it started. A pass that claims more than it starts is a pass that
 * left rows behind, and no response body anywhere says so.
 */
async function drainPass(state, jobId) {
  // A tab that has been open long enough reports its result and the row is
  // completed. This is reportJob: the settle comes first, then the next drain.
  for (const job of Object.values(state.jobs)) {
    if (state.pass - state.startedPass[job.jobId] < JOB_PASSES) continue;
    const out = await queueFetch("/" + job.queueId + "/complete", {
      method: "POST",
      body: JSON.stringify({ ok: true, result: { error: null, manual: false, listingUrl: null } }),
    });
    state.completePosts += 1;
    if (!out.ok) state.completeMisses.push({ id: job.queueId, status: out.status, body: out.raw });
    state.jobs = JOBS.remove(state.jobs, job.jobId);
  }

  const limit = claimLimit(state.jobs);
  if (limit <= 0) return { claimed: 0, started: 0 };

  const claimed = await queueFetch("/claim", {
    method: "POST",
    body: JSON.stringify({ limit: limit, installId: "us3061-harness" }),
  });
  assert.ok(claimed.ok, "/claim returned " + claimed.status + ": " + claimed.raw);
  const rows = (claimed.body && claimed.body.claimed) || [];
  for (const r of rows) {
    state.claimCount[r.id] = (state.claimCount[r.id] || 0) + 1;
  }
  if (rows.length === 0) return { claimed: 0, started: 0 };

  const plan = JOBS.planDrain(rows, state.jobs, { now: Date.now() });

  for (const r of plan.expired.concat(plan.unsupported || [])) {
    await queueFetch("/" + r.id + "/complete", {
      method: "POST",
      body: JSON.stringify({ ok: false, result: { error: "not runnable" } }),
    });
    state.completePosts += 1;
  }
  for (const r of plan.toRun) {
    // The REAL job factory, not a stand-in. An earlier version of this harness
    // put `{ jobId, queueId, startedPass }` in the map, and both `isPending` and
    // therefore `drainClaimLimit` and `planDrain` read `job.state` -- so every
    // job looked already settled, the map was effectively always empty, and two
    // sabotages of the claim size passed 5 of 5 checks. A fake whose shape the
    // code under test does not recognise is a harness measuring itself.
    const job = JOBS.jobFromQueueRow(r, {
      jobId: "job-" + (jobId.n++),
      tabId: 1000 + jobId.n,
      now: Date.now(),
    });
    assert.ok(job && JOBS.isPending(job), "a started job must read as pending to job-store");
    state.jobs = JOBS.put(state.jobs, job);
    state.startedPass[job.jobId] = state.pass;
    state.started[r.id] = (state.started[r.id] || 0) + 1;
  }
  state.abandoned += plan.skipped.length;
  return { claimed: rows.length, started: plan.toRun.length, skipped: plan.skipped.length };
}

// -- run --------------------------------------------------------------------

(async () => {
  console.log("US-3061 AC4 harness");
  console.log("  edge:        " + EDGE);
  console.log("  stack:       " + SUPABASE_URL);
  console.log("  claim limit: " + LIMIT_SOURCE);

  const fixture = await seed();
  token = mintToken(fixture.userId);
  let failed = false;
  try {
    const state = {
      pass: 0,
      jobs: {},
      startedPass: {},
      claimCount: {},
      started: {},
      abandoned: 0,
      completePosts: 0,
      completeMisses: [],
    };
    const jobId = { n: 1 };
    for (let i = 1; i <= DRAINS; i++) {
      state.pass = i;
      const r = await drainPass(state, jobId);
      console.log(
        "  drain " + String(i).padStart(2, " ") +
          ": claimed " + r.claimed + ", started " + r.started +
          ", left claimed and unstarted " + (r.skipped || 0),
      );
    }

    // -- the assertions, every one read back from the table ----------------
    const after = await rest(
      "extension_work_queue?user_id=eq." + fixture.userId +
        "&select=id,status,claimed_at,completed_at&order=created_at.asc",
    );
    const byStatus = {};
    for (const r of after) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    console.log("\n  rows after " + DRAINS + " drains: " + JSON.stringify(byStatus));
    console.log("  /complete posts: " + state.completePosts +
      ", posts the server did not accept: " + state.completeMisses.length);
    console.log("  rows claimed and never started: " + state.abandoned);

    const check = (name, fn) => {
      try {
        fn();
        console.log("  PASS  " + name);
      } catch (e) {
        failed = true;
        console.log("  FAIL  " + name + "\n        " + e.message);
      }
    };

    check("every seeded row reached a terminal state", () => {
      const stuck = after.filter((r) => r.status !== "done" && r.status !== "failed");
      assert.strictEqual(
        stuck.length,
        0,
        stuck.length + " of " + SEED_ROWS + " rows are still " +
          JSON.stringify(stuck.map((r) => r.status)) + " after " + DRAINS +
          " drains. A row left `claimed` is not retried by the next drain -- " +
          "/claim reads status = 'queued' -- so it waits out expires_at.",
      );
    });

    check("every row completed exactly once", () => {
      const started = Object.entries(state.started).filter(([, n]) => n !== 1);
      assert.deepStrictEqual(
        started,
        [],
        "these rows were started a number of times other than once: " +
          JSON.stringify(started),
      );
      assert.strictEqual(
        after.filter((r) => r.completed_at).length,
        SEED_ROWS,
        "every row carries a completed_at",
      );
    });

    check("no row was claimed twice", () => {
      const twice = Object.entries(state.claimCount).filter(([, n]) => n > 1);
      assert.deepStrictEqual(twice, [], "double-claimed rows: " + JSON.stringify(twice));
    });

    check("no /complete post was refused by the server", () => {
      assert.deepStrictEqual(
        state.completeMisses,
        [],
        "the extension discards this response, so a refusal here is invisible " +
          "to the seller: " + JSON.stringify(state.completeMisses),
      );
    });

    check("no row was claimed without being started", () => {
      assert.strictEqual(
        state.abandoned,
        0,
        state.abandoned + " row-claims were left claimed and unstarted. " +
          "planDrain puts them in `skipped` and background.js reads only " +
          "toRun/expired/unsupported, so nothing releases them.",
      );
    });
  } finally {
    await cleanup(fixture.userId);
  }

  if (failed) {
    console.error("\nworker-drain-loop.harness.cjs: FAILED");
    process.exit(1);
  }
  console.log(
    "\nworker-drain-loop.harness.cjs: " + DRAINS + " drains, " + SEED_ROWS +
      " rows, each claimed once, started once and completed once, read back " +
      "from extension_work_queue.",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
