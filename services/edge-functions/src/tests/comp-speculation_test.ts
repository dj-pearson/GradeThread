// US-2753: is the speculative comp query the one the grade turns out to want?
//
// The whole speedup rests on one empirical claim about gradeToConditionId: it
// collapses to four buckets, and everything from 3.0 to 8.4 is "3000". If that
// stops being true — someone adds a bucket, or moves a threshold — the
// speculation starts missing and the feature silently returns to costing two
// serial calls. Nothing would break; it would just quietly get slow again.
//
// So the hit rate is asserted here rather than assumed, and the thresholds are
// pinned at both edges.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  resolveComps,
  SPECULATIVE_CONDITION_ID,
  speculationHits,
} from "../lib/comp-speculation.ts";
import { gradeToConditionId } from "../lib/repricing.ts";

Deno.test("the speculative condition is what a null grade asks for", () => {
  // Not a hard-coded "3000": derived, so moving the default moves the guess too.
  assertEquals(SPECULATIVE_CONDITION_ID, gradeToConditionId(null));
});

Deno.test("a barcode-only appraisal with no grade always hits", () => {
  // No photo means no grade means the default condition — the query we already
  // issued IS the query, so the wait is the eBay call alone.
  assert(speculationHits(null));
});

Deno.test("the ordinary thrift range hits", () => {
  // The claim the speedup depends on. If this fails, the feature is pointless.
  for (const grade of [3.0, 4.5, 5.0, 6.5, 7.0, 8.0, 8.4]) {
    assert(speculationHits(grade), `grade ${grade} missed the speculative condition`);
  }
});

Deno.test("the edges of the used band are pinned", () => {
  // 8.5 crosses into new-without-tags and 2.9 into for-parts. Both are real
  // misses and both must stay misses, or the speculation would be reusing comps
  // from the wrong condition — which IS the accuracy change this design exists
  // to avoid.
  assert(speculationHits(8.4));
  assert(!speculationHits(8.5));
  assert(speculationHits(3.0));
  assert(!speculationHits(2.9));
});

Deno.test("new and for-parts grades miss, and that is correct", () => {
  for (const grade of [10, 9.5, 9.0, 8.5, 2.0, 1.0]) {
    assert(!speculationHits(grade), `grade ${grade} wrongly reused Used comps`);
  }
});

Deno.test("a miss names the condition it actually needs", () => {
  // The caller re-queries with this, so it has to be the real answer and not
  // just 'not 3000'.
  assertEquals(gradeToConditionId(9.6), "1000");
  assertEquals(gradeToConditionId(8.6), "1500");
  assertEquals(gradeToConditionId(2.0), "7000");
});

Deno.test("the hit rate across the grading scale is worth the complexity", () => {
  // A speculation that missed most of the time would be added latency, not
  // saved. Measured across the scale in 0.1 steps rather than asserted.
  let hits = 0;
  let total = 0;
  for (let g = 10; g >= 10; g -= 0.1) break;
  for (let tenths = 100; tenths >= 10; tenths--) {
    const g = tenths / 10;
    total++;
    if (speculationHits(g)) hits++;
  }
  const rate = hits / total;
  assert(
    rate > 0.5,
    `the speculative condition only covers ${(rate * 100).toFixed(0)}% of the scale — ` +
      `at that hit rate the extra query costs more than it saves`,
  );
  // Recorded rather than merely asserted, so the number is visible when someone
  // changes a threshold.
  console.log(`   speculative-condition coverage: ${(rate * 100).toFixed(0)}% of the 1.0-10.0 scale`);
});

// ── the reuse decision, counted rather than read ───────────────────────────

Deno.test("a hit issues NO second fetch", () => {
  // The entire point. If this ever stops holding, the feature is pure overhead:
  // a speculative call AND a real one for every appraisal.
  let calls = 0;
  const requery = (_c: string) => {
    calls++;
    return Promise.resolve("requeried");
  };
  return resolveComps({ ok: true, result: "speculative" }, 6.5, requery).then((out) => {
    assertEquals(out.result, "speculative");
    assertEquals(out.reused, true);
    assertEquals(calls, 0, "a hit re-queried anyway");
  });
});

Deno.test("a miss re-queries exactly once, at the condition the grade wants", async () => {
  const seen: string[] = [];
  const requery = (c: string) => {
    seen.push(c);
    return Promise.resolve("requeried");
  };
  const out = await resolveComps({ ok: true, result: "speculative" }, 9.6, requery);
  assertEquals(out.result, "requeried");
  assertEquals(out.reused, false);
  assertEquals(seen, ["1000"], "a new-with-tags grade did not re-query at 1000");
});

Deno.test("mismatched comps are NEVER reused to save a call", async () => {
  // Valuing a new-with-tags jacket against used comps is the one thing this
  // optimisation must not do. Checked across every miss band.
  for (const [grade, wanted] of [[10, "1000"], [8.6, "1500"], [1.5, "7000"]] as const) {
    const seen: string[] = [];
    const out = await resolveComps(
      { ok: true, result: "USED-COMPS" },
      grade,
      (c) => {
        seen.push(c);
        return Promise.resolve("CORRECT-COMPS");
      },
    );
    assertEquals(out.result, "CORRECT-COMPS", `grade ${grade} reused used comps`);
    assertEquals(seen, [wanted]);
  }
});

Deno.test("a FAILED speculation falls through to the re-query rather than erroring", async () => {
  // The speculative call is an optimisation nobody asked for. Its failure should
  // cost a retry, not an error the seller sees.
  let calls = 0;
  const out = await resolveComps(
    { ok: false, err: new Error("eBay timed out") },
    6.5,
    (_c) => {
      calls++;
      return Promise.resolve("recovered");
    },
  );
  assertEquals(out.result, "recovered");
  assertEquals(out.reused, false);
  assertEquals(calls, 1);
});

Deno.test("a re-query that fails DOES propagate — that error is real", async () => {
  let threw = false;
  try {
    await resolveComps({ ok: false, err: new Error("first") }, 6.5, () => {
      return Promise.reject(new Error("eBay is down"));
    });
  } catch (err) {
    threw = true;
    assertEquals((err as Error).message, "eBay is down");
  }
  assert(threw, "a failed re-query was swallowed");
});

Deno.test("no grade reuses the speculation, so a barcode-only appraisal waits once", async () => {
  let calls = 0;
  const out = await resolveComps({ ok: true, result: "speculative" }, null, (_c) => {
    calls++;
    return Promise.resolve("requeried");
  });
  assertEquals(out.reused, true);
  assertEquals(calls, 0);
});

// ── the route actually starts it early ─────────────────────────────────────
//
// The decision above is unit-tested; this is the other half — that the route
// FIRES the speculative query before the grade rather than after it. Scoped to
// the /appraise handler, because the file has several handlers and a file-wide
// search would pass on any of them.

Deno.test("the /appraise handler starts comps before it grades", async () => {
  const src = await Deno.readTextFile(
    new URL("../routes/flipdesk-scout.ts", import.meta.url),
  );
  const start = src.indexOf('flipdeskScoutRoutes.post("/appraise", ');
  const end = src.indexOf('flipdeskScoutRoutes.post("/appraise-url"');
  assert(start !== -1 && end > start, "could not isolate the /appraise handler");
  const handler = src.slice(start, end);

  // Matches the assignment, not the callee, so routing the query through the
  // cache (US-2754) does not read as the speculation being removed. What this
  // guard is about is WHEN the query starts, not who answers it.
  const speculativeAt = handler.indexOf("const speculativeComps = ");
  const gradeAt = handler.indexOf("await quickGrade(");
  const awaitAt = handler.indexOf("await speculativeComps");

  assert(speculativeAt !== -1, "the speculative comp query is gone");
  assert(gradeAt !== -1, "the grade call is gone");
  assert(awaitAt !== -1, "the speculative result is never awaited");
  assert(
    speculativeAt < gradeAt,
    "the comp query is started AFTER the grade — it is back on the critical path",
  );
  assert(
    awaitAt > gradeAt,
    "the speculative result is awaited before the grade runs, which serialises it again",
  );
});
