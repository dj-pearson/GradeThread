// US-3138: the AI meter's spend authority.
//
// Every case here guards one decision: WHOSE cap was hit. `limit` reaching the
// reserve layer is already min(planLimit, selfCap), so nothing downstream can
// tell a plan wall from a seller's own spending guard. If that distinction is
// lost, a seller who deliberately capped themselves at 50 has their wallet
// drained the moment they hit 50 -- the exact opposite of what the cap is for.
import "./_env.ts";
import { assertEquals } from "@std/assert";
import {
  type AiSpendAuthority,
  type AiSpendSource,
  toSpendAuthority,
  withAiAction,
} from "../lib/ai-metering.ts";
import { AI_ACTION_LIMITS, creditsAllowedFor } from "../lib/ai-quota.ts";

Deno.test("a bare number is 'plan cap, credits allowed'", () => {
  assertEquals(toSpendAuthority(200), { limit: 200, allowCredits: true });
  assertEquals(toSpendAuthority(-1), { limit: -1, allowCredits: true });
});

Deno.test("an explicit authority passes through untouched", () => {
  const a: AiSpendAuthority = { limit: 50, allowCredits: false };
  assertEquals(toSpendAuthority(a), a);
});

Deno.test("a QuotaResult's ok branch IS a valid spend authority", () => {
  // The whole point of the number|object overload: call sites pass `quota`, not
  // `quota.limit`, and the extra fields ride along harmlessly.
  const quota = { ok: true as const, limit: 750, used: 750, allowCredits: true };
  assertEquals(toSpendAuthority(quota), quota);
  assertEquals(toSpendAuthority(quota).allowCredits, true);
});

// ── creditsAllowedFor: whose cap bit ─────────────────────────────────

Deno.test("no self-cap means the plan is what bound, so credits apply", () => {
  assertEquals(creditsAllowedFor(AI_ACTION_LIMITS.starter!, null), true);
  assertEquals(creditsAllowedFor(AI_ACTION_LIMITS.starter!, undefined), true);
});

Deno.test("a self-cap BELOW the plan is the seller's own guard: no credits", () => {
  // Starter is 200. A seller who set 50 hit their own number, not ours.
  assertEquals(creditsAllowedFor(AI_ACTION_LIMITS.starter!, 50), false);
  assertEquals(creditsAllowedFor(AI_ACTION_LIMITS.pro!, 1), false);
});

Deno.test("a self-cap at or above the plan cannot bind, so credits apply", () => {
  assertEquals(creditsAllowedFor(AI_ACTION_LIMITS.starter!, 200), true);
  assertEquals(creditsAllowedFor(AI_ACTION_LIMITS.starter!, 9999), true);
});

Deno.test("a self-cap of 0 is 'stop', and must never be answered with a purchase", () => {
  // The nastiest case: 0 reads falsy, so a `userLimit || planLimit` style test
  // would treat a hard stop as no cap at all and start spending money.
  assertEquals(creditsAllowedFor(AI_ACTION_LIMITS.free!, 0), false);
  assertEquals(creditsAllowedFor(AI_ACTION_LIMITS.business!, 0), false);
});

// ── withAiAction still honors the reserve/refund contract ────────────

function recordingDeps() {
  const calls: { reserved: (number | AiSpendAuthority)[]; refunds: string[] } = {
    reserved: [],
    refunds: [],
  };
  return {
    calls,
    deps: (allow: boolean) => ({
      reserve: (_id: string, authority: number | AiSpendAuthority) => {
        calls.reserved.push(authority);
        return Promise.resolve(allow);
      },
      refund: (id: string) => {
        calls.refunds.push(id);
        return Promise.resolve();
      },
    }),
  };
}

Deno.test("withAiAction forwards the whole authority to reserve, not just the limit", async () => {
  const { calls, deps } = recordingDeps();
  const authority: AiSpendAuthority = { limit: 25, allowCredits: false };
  await withAiAction("owner-1", authority, () => Promise.resolve("done"), deps(true));
  assertEquals(calls.reserved.length, 1);
  assertEquals(calls.reserved[0], authority);
});

Deno.test("withAiAction refunds when the work it paid for throws", async () => {
  const { calls, deps } = recordingDeps();
  let threw = false;
  try {
    await withAiAction(
      "owner-2",
      { limit: 10, allowCredits: true },
      () => Promise.reject(new Error("model call failed")),
      deps(true),
    );
  } catch (err) {
    threw = true;
    assertEquals((err as Error).message, "model call failed");
  }
  assertEquals(threw, true);
  // One refund, and the ORIGINAL error survives rather than being swallowed by
  // the refund.
  assertEquals(calls.refunds, ["owner-2"]);
});

Deno.test("withAiAction does NOT refund an action it never reserved", async () => {
  const { calls, deps } = recordingDeps();
  let threw = false;
  try {
    await withAiAction("owner-3", 10, () => Promise.resolve("never runs"), deps(false));
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  assertEquals(calls.refunds, []);
});

// ── No route may pass quota.limit to a reserve call ──────────────────

Deno.test("US-3138: no reserve call passes quota.limit instead of the quota", async () => {
  // The regression this exists to stop is invisible in review and silent in
  // production: `withAiAction(ownerId, quota.limit, ...)` still compiles, still
  // reserves, and still works for almost everyone. It only misbehaves for a
  // seller who set their own AI cap, whose wallet it then drains the moment
  // they hit the number they chose as their stop. Nothing else would catch it.
  const dir = new URL("../routes/", import.meta.url);
  const offenders: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const src = await Deno.readTextFile(new URL(entry.name, dir));
    const re = /(?:withAiAction|reserveAiActionSafe|reserveAiAction)\(\s*\w+\s*,\s*quota\.limit/g;
    for (const m of src.matchAll(re)) {
      offenders.push(`${entry.name}: ${m[0]}`);
    }
  }
  assertEquals(
    offenders,
    [],
    "pass the whole quota, not quota.limit - the limit alone has lost the " +
      "self-cap decision by the time it reaches the reserve",
  );
});

Deno.test("US-3138: that scan still detects the shape it was written for", async () => {
  // A source scan that stops matching reads exactly like a clean tree. Prove
  // the pattern against the literal code it is meant to reject.
  const sabotage = `
    const result = await withAiAction(ownerId, quota.limit, () => run());
    if (!(await reserveAiActionSafe(userId, quota.limit))) return;
  `;
  const re = /(?:withAiAction|reserveAiActionSafe|reserveAiAction)\(\s*\w+\s*,\s*quota\.limit/g;
  assertEquals([...sabotage.matchAll(re)].length, 2);
  // And that it does NOT fire on the correct shape.
  const good = `await withAiAction(ownerId, quota, () => run());`;
  assertEquals([...good.matchAll(re)].length, 0);
  await Promise.resolve();
});

// ── The rpc contract reserve_ai_action_v2 returns ────────────────────

Deno.test("only 'allowance' and 'credits' count as paid; anything else is exhausted", () => {
  // Mirrors the narrowing in reserveAiActionSource. A malformed or unexpected
  // rpc response must read as UNPAID, never as a free action.
  const paid = (data: unknown): AiSpendSource =>
    data === "allowance" || data === "credits" ? data : "exhausted";

  assertEquals(paid("allowance"), "allowance");
  assertEquals(paid("credits"), "credits");
  assertEquals(paid("exhausted"), "exhausted");
  for (const junk of [null, undefined, true, 1, "", "ALLOWANCE", {}]) {
    assertEquals(paid(junk), "exhausted", `${JSON.stringify(junk)} must not entitle`);
  }
});
