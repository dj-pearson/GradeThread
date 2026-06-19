import { assert, assertEquals } from "@std/assert";
import {
  applyTokens,
  type DripGraph,
  evaluateAll,
  nextTickIso,
  pickVariant,
  renderStep,
  simulateJourney,
  validateGraph,
} from "../lib/drip-graph.ts";

// US-945: the drip graph validator, renderer, and dry-run evaluator are pure —
// no supabase/env imports — so they're tested directly.

function step(over: Record<string, unknown> = {}) {
  return {
    id: "a",
    label: "A",
    phase: "in_trial",
    trigger: "trial_started",
    anchor: "enrollment",
    delayHours: 0,
    conditions: [],
    brief: "",
    incentiveEnabled: false,
    branches: [],
    next: null,
    exit: true,
    variants: [{ id: "A", weight: 100, subject: "Hi {{firstName}}", html: "<p>x</p>" }],
    ...over,
  };
}

Deno.test("validateGraph accepts a sound linear graph", () => {
  const g = {
    entryStepId: "a",
    steps: [
      step({ id: "a", next: "b", exit: false }),
      step({ id: "b", next: null, exit: true }),
    ],
  };
  const r = validateGraph(g);
  assert(r.ok, r.errors.join("; "));
});

Deno.test("validateGraph rejects a loop", () => {
  const g = {
    entryStepId: "a",
    steps: [
      step({ id: "a", next: "b", exit: false }),
      step({ id: "b", next: "a", exit: false }),
    ],
  };
  const r = validateGraph(g);
  assert(!r.ok);
  assert(r.errors.some((e) => /loop/i.test(e)), r.errors.join("; "));
});

Deno.test("validateGraph rejects orphans", () => {
  const g = {
    entryStepId: "a",
    steps: [
      step({ id: "a", next: null, exit: true }),
      step({ id: "orphan", next: null, exit: true }),
    ],
  };
  const r = validateGraph(g);
  assert(!r.ok);
  assert(r.errors.some((e) => /orphan|unreachable/i.test(e)), r.errors.join("; "));
});

Deno.test("validateGraph rejects a dangling next target", () => {
  const g = {
    entryStepId: "a",
    steps: [step({ id: "a", next: "ghost", exit: false })],
  };
  const r = validateGraph(g);
  assert(!r.ok);
  assert(r.errors.some((e) => /ghost/.test(e)), r.errors.join("; "));
});

Deno.test("validateGraph requires at least one variant per step", () => {
  const g = {
    entryStepId: "a",
    steps: [step({ id: "a", variants: [] })],
  };
  const r = validateGraph(g);
  assert(!r.ok);
  assert(r.errors.some((e) => /variant/i.test(e)));
});

Deno.test("applyTokens substitutes known tokens and blanks unknown", () => {
  assertEquals(applyTokens("Hi {{firstName}}!", { firstName: "Dana" }), "Hi Dana!");
  assertEquals(applyTokens("a {{nope}} b", {}), "a  b");
});

Deno.test("renderStep fills firstName + incentive", () => {
  const rendered = renderStep(
    {
      incentiveEnabled: true,
      variants: [{ id: "A", weight: 1, subject: "Hi {{firstName}}", html: "{{incentive}}" }],
    },
    { firstName: "Dana" },
    "A",
  );
  assert(rendered);
  assertEquals(rendered!.subject, "Hi Dana");
  assert(rendered!.html.includes("TRIAL20"));
});

Deno.test("renderStep omits incentive when disabled", () => {
  const rendered = renderStep(
    {
      incentiveEnabled: false,
      variants: [{ id: "A", weight: 1, subject: "s", html: "x{{incentive}}y" }],
    },
    {},
  );
  assertEquals(rendered!.html, "xy");
});

Deno.test("evaluateAll gates on converted=is_false", () => {
  const conds = [{ field: "converted", op: "is_false" as const }];
  assert(evaluateAll(conds, { converted: false }));
  assert(!evaluateAll(conds, { converted: true }));
});

Deno.test("pickVariant is deterministic per user", () => {
  const s = step({
    variants: [
      { id: "A", weight: 50, subject: "s", html: "h" },
      { id: "B", weight: 50, subject: "s", html: "h" },
    ],
  }) as Parameters<typeof pickVariant>[0];
  const first = pickVariant(s, "user-123").id;
  assertEquals(pickVariant(s, "user-123").id, first);
});

Deno.test("simulateJourney exits immediately when converted", () => {
  const g: DripGraph = {
    entryStepId: "a",
    steps: [step({ id: "a" }) as unknown as DripGraph["steps"][number]],
  };
  const r = simulateJourney(g, {
    userId: "u1",
    enrolledAtMs: 0,
    converted: true,
  }, 0);
  assertEquals(r.campaignWouldEnroll, false);
  assert(r.exitReason && /converted/i.test(r.exitReason));
});

Deno.test("simulateJourney projects a timeline and respects branches", () => {
  const g: DripGraph = {
    entryStepId: "welcome",
    steps: [
      step({
        id: "welcome",
        exit: false,
        next: "default",
        branches: [{ conditions: [{ field: "gradesUsed", op: "gte", value: 1 }], targetStepId: "engaged" }],
      }) as unknown as DripGraph["steps"][number],
      step({ id: "default", exit: true }) as unknown as DripGraph["steps"][number],
      step({ id: "engaged", exit: true }) as unknown as DripGraph["steps"][number],
    ],
  };
  // gradesUsed >= 1 → branch to "engaged".
  const r = simulateJourney(g, {
    userId: "u1",
    enrolledAtMs: 0,
    converted: false,
    gradesUsed: 3,
  }, 0);
  assertEquals(r.sends.map((s) => s.stepId), ["welcome", "engaged"]);
  // gradesUsed 0 → fall through to "default".
  const r2 = simulateJourney(g, {
    userId: "u1",
    enrolledAtMs: 0,
    converted: false,
    gradesUsed: 0,
  }, 0);
  assertEquals(r2.sends.map((s) => s.stepId), ["welcome", "default"]);
});

Deno.test("nextTickIso returns a future top-of-hour", () => {
  const now = Date.parse("2026-06-19T10:15:00.000Z");
  assertEquals(nextTickIso(now), "2026-06-19T11:00:00.000Z");
});
