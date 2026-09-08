// GradeThread unified extension — the web's "drain now" nudge (US-3143).
//
// Zero-dependency node script: throws on drift.
//
// WHAT THIS PROTECTS. Since US-3141 a sale puts the sibling's delist into
// extension_work_queue by itself, and the 5-minute SWEEP_ALARM runs it. The
// nudge only changes WHEN. That makes it the easiest thing in this file to get
// casually wrong, because every mistake still looks like it works:
//
//   1. Accepting a job FROM the page. The whole reason a nudge is safe to take
//      from gradethread.com is that it carries nothing — the extension re-reads
//      its own queue with its own token. A handler that started reading
//      msg.payload would be an origin-checked page steering a browser to a URL,
//      which is the exact thing lister-guard.js host-pinning exists to prevent.
//   2. Skipping the gates. drainQueue() checks sellerAllowed and tosAccepted
//      before it claims anything. A nudge that bypassed them would run
//      cross-listing automation for an account that never accepted the terms,
//      and it would look identical from the outside.
//   3. Losing the alarm. The nudge is an optimisation for a seller with a tab
//      open. If the periodic drain ever goes away "because the web triggers it
//      now", every seller without a GradeThread tab open silently stops
//      delisting — and that is most of them, most of the time.
//   4. No floor. A page in a render loop turns into a queue read per frame.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");
const BG = fs.readFileSync(path.join(dir, "background.js"), "utf8");

/** The body of a handler block, from its `if (msg.type === X)` to the close. */
function handlerBody(type) {
  const start = BG.indexOf(`if (msg.type === "${type}")`);
  assert.ok(start > -1, `no handler for ${type}`);
  const end = BG.indexOf("\n  }", start);
  assert.ok(end > start, `could not find the end of the ${type} handler`);
  return BG.slice(start, end);
}

// ── 1. The message is declared, and reaches the handler ────────────────────
{
  const types = BG.slice(
    BG.indexOf("const EXTERNAL_TYPES = new Set(["),
    BG.indexOf("]);", BG.indexOf("const EXTERNAL_TYPES = new Set([")),
  );
  assert.ok(
    types.includes('"GT_DRAIN_NOW"'),
    "GT_DRAIN_NOW is not in EXTERNAL_TYPES, so the SaaS can never reach it",
  );

  // The origin check is the first thing handleExternalMessage does, and every
  // type shares it. Pin the ordering rather than the string: a handler added
  // above the check would be reachable from any page on the web.
  const fn = BG.indexOf("function handleExternalMessage(");
  const originCheck = BG.indexOf("isOriginAllowed(sender)", fn);
  const handler = BG.indexOf('if (msg.type === "GT_DRAIN_NOW")', fn);
  assert.ok(originCheck > fn, "handleExternalMessage no longer checks the origin");
  assert.ok(
    originCheck < handler,
    "the drain-now handler sits above the origin check, so any page can reach it",
  );
}

// ── 2. It takes nothing from the message ───────────────────────────────────
{
  const body = handlerBody("GT_DRAIN_NOW");

  // The single property that makes this safe to accept from a page. `msg.type`
  // is the dispatch itself and is matched separately below.
  const reads = body.match(/msg\.[A-Za-z_$][\w$]*/g) || [];
  const beyondType = reads.filter((r) => r !== "msg.type");
  assert.deepStrictEqual(
    beyondType,
    [],
    "the drain-now handler now reads " + beyondType.join(", ") +
      " from the page. It must carry no listing, no URL and no job — the " +
      "extension re-reads its own queue with its own token.",
  );

  // And it must not smuggle one in through the job path either.
  for (const f of ["startJob(", "handleDelistRequest(", "tabs.create("]) {
    assert.ok(
      !body.includes(f),
      `the drain-now handler calls ${f} directly instead of going through drainQueue()`,
    );
  }

  assert.ok(
    /await drainQueue\(\)/.test(body),
    "the drain-now handler no longer calls drainQueue(), so the gates it owns are gone",
  );
}

// ── 3. The gates still belong to drainQueue, and still run first ───────────
{
  const start = BG.indexOf("async function drainQueue()");
  assert.ok(start > -1, "drainQueue is gone");
  const body = BG.slice(start, BG.indexOf("\n}", BG.indexOf("drainInFlight = false;", start)));

  const seller = body.indexOf("await sellerAllowed()");
  const tos = body.indexOf("await tosAccepted()");
  const claim = body.indexOf('queueFetch("/claim"');
  assert.ok(seller > -1 && tos > -1, "drainQueue lost the seller or the terms gate");
  assert.ok(
    seller < claim && tos < claim,
    "a gate now runs after the claim, so work is claimed before consent is checked",
  );

  // The re-entrancy guard, and its early return. Two drains claiming the same
  // row is how one listing gets two background tabs.
  assert.ok(
    /if \(drainInFlight\) return "busy";/.test(body),
    "the re-entrancy guard no longer short-circuits a nudge that lands mid-drain",
  );

  // The reported states, so the page can tell "nothing to do" from "your plan
  // lapsed". Each must be an actual return, not just a string in a comment.
  for (const state of ["busy", "not-allowed", "needs-consent", "empty", "ok"]) {
    assert.ok(
      new RegExp(`return "${state}";`).test(body),
      `drainQueue no longer reports "${state}"`,
    );
  }
}

// ── 4. The periodic drain survives ─────────────────────────────────────────
{
  // Point 3 in the header. The nudge is an optimisation for a seller with a tab
  // open; the alarm is what serves everyone else.
  assert.ok(
    /alarms\.create\(SWEEP_ALARM, \{ periodInMinutes: 5 \}\)/.test(BG),
    "the 5-minute sweep alarm is gone, so a browser with no GradeThread tab " +
      "open never drains the queue at all",
  );
  const sweep = BG.slice(BG.indexOf("if (name === SWEEP_ALARM)"));
  assert.ok(
    /void drainQueue\(\);/.test(sweep.slice(0, 1200)),
    "the sweep tick no longer drains the queue",
  );
  assert.ok(
    /onStartup[\s\S]{0,200}void drainQueue\(\)/.test(BG),
    "the browser-start drain is gone",
  );
}

// ── 5. A floor under it ────────────────────────────────────────────────────
{
  const m = BG.match(/const DRAIN_NUDGE_MIN_GAP_MS = (\d+);/);
  assert.ok(m, "the drain-nudge floor is gone; a page in a loop is a queue read per frame");
  const gap = Number(m[1]);
  assert.ok(gap > 0, "the floor is zero, which is no floor");
  assert.ok(
    gap < 5 * 60 * 1000,
    `the floor (${gap}ms) is at or above the 5-minute alarm it exists to beat, ` +
      "so a real nudge would be refused and the feature does nothing",
  );

  const body = handlerBody("GT_DRAIN_NOW");
  assert.ok(
    body.indexOf("DRAIN_NUDGE_MIN_GAP_MS") < body.indexOf("await drainQueue()"),
    "the floor is checked after the drain, so it throttles nothing",
  );
  assert.ok(
    /state: "throttled"/.test(body),
    "a throttled nudge no longer says so, so the page cannot tell it from a real drain",
  );
}

console.log("drain-nudge.test.cjs: ok");
