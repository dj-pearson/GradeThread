// SRC-3: phase two, the paid half of a Scout scan.
//
// A cap hit on the first reservation and an all-failed run (an Anthropic
// outage) both used to come back as `candidates: []` with no flag, and the page
// told the seller to broaden a search that was fine. runShadowGrades now says
// which of the two it was.

// US-2379: FIRST, before anything that reaches lib/supabase.ts at import time.
import "./_env.ts";
import { assertEquals } from "@std/assert";
import { runShadowGrades } from "../routes/flipdesk-scout.ts";
import type { ScoutScored } from "../lib/scout-scoring.ts";

type Cand = { itemId: string };
const queue: Cand[] = Array.from({ length: 8 }, (_, i) => ({ itemId: `item-${i}` }));

function row(itemId: string): ScoutScored {
  return { itemId } as unknown as ScoutScored;
}

Deno.test("SRC-3: a cap refusal on the first reservation reports capReached with nothing scored", async () => {
  let reserves = 0;
  let grades = 0;
  const run = await runShadowGrades(queue, {
    reserve: () => {
      reserves++;
      return Promise.resolve(false);
    },
    refund: () => Promise.resolve(),
    grade: () => {
      grades++;
      return Promise.resolve({ overallScore: 8, confidence: 0.9 });
    },
    score: (c) => Promise.resolve(row(c.itemId)),
    concurrency: 1,
  });
  assertEquals(run.capReached, true);
  assertEquals(run.scored, []);
  assertEquals(run.queued, 8);
  assertEquals(reserves, 1);
  assertEquals(grades, 0);
});

Deno.test("SRC-3: a grade that always throws counts every listing as failed and refunds each", async () => {
  let refunds = 0;
  const run = await runShadowGrades(queue, {
    reserve: () => Promise.resolve(true),
    refund: () => {
      refunds++;
      return Promise.resolve();
    },
    grade: () => Promise.reject(new Error("anthropic 529")),
    score: (c) => Promise.resolve(row(c.itemId)),
    concurrency: 4,
  });
  assertEquals(run.capReached, false);
  assertEquals(run.failed, run.queued);
  assertEquals(run.failed, 8);
  assertEquals(refunds, 8);
  assertEquals(run.scored.length, 0);
});

Deno.test("SRC-3: a cap hit midway keeps what was graded", async () => {
  let n = 0;
  const run = await runShadowGrades(queue, {
    reserve: () => Promise.resolve(++n <= 3),
    refund: () => Promise.resolve(),
    grade: () => Promise.resolve({ overallScore: 7, confidence: 0.8 }),
    score: (c) => Promise.resolve(row(c.itemId)),
    concurrency: 1,
  });
  assertEquals(run.capReached, true);
  assertEquals(run.scored.map((r) => r.itemId), ["item-0", "item-1", "item-2"]);
});
