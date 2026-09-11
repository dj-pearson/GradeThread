// GradeThread unified extension — pacing between cross-posts (US-3367).
//
// A queue of six listings used to run back to back: one settles, the next
// opens. A LIST job now earns a gap before the next drain, with jitter so the
// gaps are not identical. A DELIST never waits: the garment is sold and the
// listing is live, and every second of gap is a second a buyer can pay twice.
//
// Loaded with an injected `self`, the same trick as lister-jobs.test.cjs.

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
const T = 1_000_000;

// ── the constants the options page offers ───────────────────────────────────
assert.deepStrictEqual(J.PACING.OPTIONS_MS, [15000, 30000, 60000, 120000]);
assert.strictEqual(J.PACING.DEFAULT_GAP_MS, 30000);
assert.strictEqual(J.PACING.JITTER_MS, 15000);

// ── pacingGapFor: an unknown or absent option is the default ─────────────────
assert.strictEqual(J.pacingGapFor(undefined), 30000);
assert.strictEqual(J.pacingGapFor("banana"), 30000);
assert.strictEqual(J.pacingGapFor(60000), 60000);
assert.strictEqual(J.pacingGapFor(999), 30000, "not one of the options: default");

// ── nextListDrainAt: settled + gap, jittered, never before the settle ────────
assert.strictEqual(J.nextListDrainAt(T, 30000, 15000, () => 0.5), T + 30000, "rng 0.5 is no jitter");
assert.strictEqual(J.nextListDrainAt(T, 30000, 15000, () => 0), T + 15000, "rng 0 is minus jitter");
assert.strictEqual(J.nextListDrainAt(T, 30000, 15000, () => 1), T + 45000, "rng 1 is plus jitter");
assert.strictEqual(J.nextListDrainAt(T, 5000, 15000, () => 0), T, "never before the settle time");
assert.strictEqual(J.nextListDrainAt(null, 30000, 15000, () => 0.5), null, "no settle time: no hold");
assert.strictEqual(J.nextListDrainAt("soon", 30000, 15000, () => 0.5), null, "garbage: no hold");

// ── pacingHold: held only while now < nextListDrainAt ───────────────────────
assert.deepStrictEqual(J.pacingHold({ nextListDrainAt: T + 100 }, T), { held: true, until: T + 100 });
assert.deepStrictEqual(J.pacingHold({ nextListDrainAt: T + 100 }, T + 100), { held: false, until: null });
assert.deepStrictEqual(J.pacingHold({ nextListDrainAt: null }, T), { held: false, until: null });
assert.deepStrictEqual(J.pacingHold({}, T), { held: false, until: null });
assert.deepStrictEqual(J.pacingHold(null, T), { held: false, until: null });
assert.deepStrictEqual(J.pacingHold({ nextListDrainAt: "soon" }, T), { held: false, until: null }, "garbage is not a hold");

// ── pacesAfter: only a list job schedules a gap ──────────────────────────────
assert.strictEqual(J.pacesAfter({ kind: "list" }), true);
assert.strictEqual(J.pacesAfter({ kind: "delist" }), false);
assert.strictEqual(J.pacesAfter({ kind: "revise" }), false);
assert.strictEqual(J.pacesAfter({ kind: "relist" }), false);
assert.strictEqual(J.pacesAfter(null), false);

// ── background.js wiring, by source ──────────────────────────────────────────
//
// The rule above is only worth anything if the shell honours it: the hold is
// checked BEFORE /claim (a row claimed by a browser about to sit on it is the
// US-3061 stranding bug wearing a gap), a list job schedules through an alarm
// rather than re-draining, and the alarm handler runs the drain.
const BG = fs.readFileSync(path.resolve(__dirname, "..", "background.js"), "utf8");
{
  const claimAt = BG.indexOf('await queueFetch("/claim"');
  const holdAt = BG.indexOf("pacingHold(");
  assert.ok(claimAt > 0 && holdAt > 0 && holdAt < claimAt, "the pacing hold is checked before /claim");
  assert.ok(/return "paced";/.test(BG), "drainQueue reports \"paced\"");
  assert.ok(/pacesAfter\(job\)/.test(BG), "reportJob asks pacesAfter before re-draining");
  assert.ok(/PACED_DRAIN_ALARM/.test(BG) && /alarms\.create\(PACED_DRAIN_ALARM/.test(BG), "the next drain is an alarm");
  assert.ok(/name === PACED_DRAIN_ALARM/.test(BG), "the alarm handler runs the paced drain");
}

console.log("lister-pacing: ok");
