import { assert, assertEquals } from "@std/assert";
import {
  applyTokens,
  buildLostFeaturesHtml,
  type DripGraph,
  type DripUserState,
  evaluateAll,
  isIncentiveEligible,
  isWinBackEligible,
  lostProFeatures,
  marketingOptedOutEmail,
  nextTickIso,
  pickVariant,
  planTick,
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

Deno.test("renderStep fills firstName + resolved incentive (US-942)", () => {
  const rendered = renderStep(
    {
      incentiveEnabled: true,
      variants: [{ id: "A", weight: 1, subject: "Hi {{firstName}}", html: "{{incentive}}" }],
    },
    { firstName: "Dana" },
    "A",
    { promoCode: "WELCOME15", label: "15% off your first month", expiresAt: null },
  );
  assert(rendered);
  assertEquals(rendered!.subject, "Hi Dana");
  // Code + discount come from the resolved incentive — never hardcoded.
  assert(rendered!.html.includes("WELCOME15"));
  assert(rendered!.html.includes("15% off your first month"));
});

Deno.test("renderStep omits incentive when no resolved offer passed (US-942)", () => {
  // incentiveEnabled but NO resolved incentive → token collapses (no leak).
  const rendered = renderStep(
    {
      incentiveEnabled: true,
      variants: [{ id: "A", weight: 1, subject: "s", html: "x{{incentive}}y" }],
    },
    {},
  );
  assertEquals(rendered!.html, "xy");
});

Deno.test("renderStep omits incentive when step disabled even if offer passed (US-942)", () => {
  const rendered = renderStep(
    {
      incentiveEnabled: false,
      variants: [{ id: "A", weight: 1, subject: "s", html: "x{{incentive}}y" }],
    },
    {},
    "A",
    { promoCode: "NOPE", label: "20% off", expiresAt: null },
  );
  assertEquals(rendered!.html, "xy");
});

Deno.test("isIncentiveEligible: win-back, not converted only (US-942)", () => {
  assert(isIncentiveEligible({ phase: "win_back", incentiveEnabled: true }, { converted: false }));
  // in-trial never exposes a code, even when enabled.
  assert(!isIncentiveEligible({ phase: "in_trial", incentiveEnabled: true }, { converted: false }));
  // already-paid never gets an incentive.
  assert(!isIncentiveEligible({ phase: "win_back", incentiveEnabled: true }, { converted: true }));
  // step-level toggle off → no incentive.
  assert(!isIncentiveEligible({ phase: "win_back", incentiveEnabled: false }, { converted: false }));
});

Deno.test("validateGraph accepts a disabled/absent incentive (US-942)", () => {
  const base = {
    entryStepId: "a",
    steps: [step({ id: "a", next: null, exit: true })],
  };
  assert(validateGraph(base).ok);
  assert(validateGraph({ ...base, incentive: { enabled: false } }).ok);
});

Deno.test("validateGraph requires full incentive shape when enabled (US-942)", () => {
  const base = {
    entryStepId: "a",
    steps: [step({ id: "a", next: null, exit: true })],
  };
  const bad = validateGraph({ ...base, incentive: { enabled: true } });
  assert(!bad.ok);
  assert(bad.errors.some((e) => /couponId/.test(e)), bad.errors.join("; "));
  assert(bad.errors.some((e) => /promoCode/.test(e)), bad.errors.join("; "));

  const good = validateGraph({
    ...base,
    incentive: {
      enabled: true,
      couponId: "co_123",
      promoCode: "WINBACK20",
      maxPercentOff: 25,
      expiryHours: 168,
    },
  });
  assert(good.ok, good.errors.join("; "));

  const overMax = validateGraph({
    ...base,
    incentive: {
      enabled: true,
      couponId: "co_123",
      promoCode: "WINBACK20",
      maxPercentOff: 150,
      expiryHours: 168,
    },
  });
  assert(!overMax.ok);
  assert(overMax.errors.some((e) => /maxPercentOff/.test(e)), overMax.errors.join("; "));
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

// ── planTick (US-943 autonomous tick planner) ──

const HOUR = 60 * 60 * 1000;

function tickUser(
  over: Partial<DripUserState> = {},
): DripUserState & { userId: string; enrolledAtMs: number } {
  return { userId: "u1", enrolledAtMs: 0, converted: false, ...over };
}

function twoStepGraph(): DripGraph {
  return {
    entryStepId: "welcome",
    steps: [
      step({
        id: "welcome",
        anchor: "enrollment",
        delayHours: 0,
        conditions: [{ field: "converted", op: "is_false" }],
        next: "tips",
        exit: false,
      }) as unknown as DripGraph["steps"][number],
      step({
        id: "tips",
        anchor: "previous",
        delayHours: 72,
        conditions: [{ field: "converted", op: "is_false" }],
        next: null,
        exit: true,
      }) as unknown as DripGraph["steps"][number],
    ],
  };
}

Deno.test("planTick sends the first due unsent step (ordinal = graph index)", () => {
  const plan = planTick(twoStepGraph(), tickUser(), new Set(), HOUR);
  assertEquals(plan.status, "send");
  assertEquals(plan.send?.stepId, "welcome");
  assertEquals(plan.send?.ordinal, 1); // 1-based index in graph.steps
});

Deno.test("planTick waits when the next unsent step isn't due yet", () => {
  // welcome (ordinal 1) already sent; tips is +72h from welcome's schedule (t=0).
  const plan = planTick(twoStepGraph(), tickUser(), new Set([1]), HOUR);
  assertEquals(plan.status, "wait");
  assertEquals(plan.send, null);
  assertEquals(plan.nextEvaluationMs, 72 * HOUR);
});

Deno.test("planTick sends the next step once its window arrives (catch-up)", () => {
  // welcome sent; now well past the +72h window → tips is due.
  const plan = planTick(twoStepGraph(), tickUser(), new Set([1]), 100 * HOUR);
  assertEquals(plan.status, "send");
  assertEquals(plan.send?.stepId, "tips");
  assertEquals(plan.send?.ordinal, 2);
});

Deno.test("planTick completes when all steps are sent", () => {
  const plan = planTick(twoStepGraph(), tickUser(), new Set([1, 2]), 100 * HOUR);
  assertEquals(plan.status, "complete");
  assertEquals(plan.nextEvaluationMs, null);
});

// ── US-941 post-trial win-back sequence (days 16/20/24/28) ──

// A faithful slice of the seeded win-back tail: four steps anchored to trial_end,
// every one gated on converted=is_false, the day-24 step incentive-enabled, the
// day-28 step terminal.
function winBackGraph(): DripGraph {
  const wb = (id: string, delayHours: number, over: Record<string, unknown> = {}) =>
    step({
      id,
      phase: "win_back",
      anchor: "trial_end",
      delayHours,
      conditions: [{ field: "converted", op: "is_false" }],
      exit: false,
      ...over,
    }) as unknown as DripGraph["steps"][number];
  return {
    entryStepId: "win_back_free",
    steps: [
      wb("win_back_free", 48, { next: "win_back_value" }),
      wb("win_back_value", 144, { next: "win_back_offer" }),
      wb("win_back_offer", 240, { next: "win_back_final", incentiveEnabled: true }),
      wb("win_back_final", 336, { next: null, exit: true, incentiveEnabled: true }),
    ],
  };
}

Deno.test("win-back graph is structurally valid (days 16/20/24/28)", () => {
  const r = validateGraph(winBackGraph());
  assert(r.ok, r.errors.join("; "));
});

Deno.test("win-back: a converted user is excluded — receives no win-back send", () => {
  const g = winBackGraph();
  // trial_end anchored; well past day 28 so every step would otherwise be due.
  const trialEnd = "2026-01-01T00:00:00.000Z";
  const trialEndMs = Date.parse(trialEnd);
  const nowMs = trialEndMs + 400 * HOUR;
  const converted = tickUser({ converted: true, trialEndsAt: trialEnd });

  // The pure planner skips every converted-gated step → completes with no send.
  const plan = planTick(g, converted, new Set(), nowMs);
  assertEquals(plan.status, "complete");
  assertEquals(plan.send, null);

  // simulateJourney exits a converted user immediately with no projected sends.
  const sim = simulateJourney(g, converted, nowMs);
  assertEquals(sim.campaignWouldEnroll, false);
  assertEquals(sim.sends.length, 0);

  // A NOT-converted user, by contrast, does have the day-16 step due.
  const lapsed = tickUser({ converted: false, trialEndsAt: trialEnd });
  const lapsedPlan = planTick(g, lapsed, new Set(), nowMs);
  assertEquals(lapsedPlan.status, "send");
  assertEquals(lapsedPlan.send?.stepId, "win_back_free");
});

Deno.test("win-back: an opted-out user is ineligible — receives none (US-941)", () => {
  const optedOut = { marketing: { email: false } };
  assert(marketingOptedOutEmail(optedOut));
  // Not converted, but marketing-opted-out → not eligible to enter/receive.
  assert(!isWinBackEligible({ converted: false }, optedOut));
  // No marketing prefs at all → eligible (default opt-in).
  assert(isWinBackEligible({ converted: false }, null));
  assert(isWinBackEligible({ converted: false }, { marketing: { email: true } }));
  // Converted always excluded, regardless of consent.
  assert(!isWinBackEligible({ converted: true }, { marketing: { email: true } }));
});

Deno.test("win-back: only the day-24/28 steps surface the incentive (US-941/942)", () => {
  const g = winBackGraph();
  const byId = Object.fromEntries(g.steps.map((s) => [s.id, s]));
  const u = { converted: false };
  // Earlier win-back touches are value-only (no code exposed).
  assert(!isIncentiveEligible(byId["win_back_free"]!, u));
  assert(!isIncentiveEligible(byId["win_back_value"]!, u));
  // The offer + final touches may surface the (config-gated) incentive.
  assert(isIncentiveEligible(byId["win_back_offer"]!, u));
  assert(isIncentiveEligible(byId["win_back_final"]!, u));
});

// ── US-940 Phase 2 conversion-push (days 7–14) ──

Deno.test("recap renders the user's REAL activity numbers (US-940)", () => {
  const rendered = renderStep(
    {
      incentiveEnabled: false,
      variants: [{
        id: "A",
        weight: 1,
        subject: "{{firstName}} recap",
        html:
          "g={{gradesCount}} c={{certificatesCount}} l={{listingsCount}} s={{salesCount}} " +
          "<a href=\"{{checkoutUrl}}\">{{recommendedPlan}}</a>",
      }],
    },
    {
      firstName: "Dana",
      gradesCount: 4,
      certificatesCount: 2,
      listingsCount: 7,
      salesCount: 1,
      checkoutUrl: "https://gradethread.com/dashboard/billing?upgrade=pro",
      recommendedPlan: "Pro",
    },
  );
  assert(rendered);
  assertEquals(
    rendered!.html,
    "g=4 c=2 l=7 s=1 " +
      "<a href=\"https://gradethread.com/dashboard/billing?upgrade=pro\">Pro</a>",
  );
});

Deno.test("recap counts default to 0, checkout/plan have safe fallbacks (US-940)", () => {
  const rendered = renderStep(
    {
      incentiveEnabled: false,
      variants: [{
        id: "A",
        weight: 1,
        subject: "s",
        html: "g={{gradesCount}} url={{checkoutUrl}} plan={{recommendedPlan}}",
      }],
    },
    {},
  );
  assertEquals(
    rendered!.html,
    "g=0 url=https://gradethread.com/dashboard/billing?upgrade=pro plan=Pro",
  );
});

Deno.test("lostProFeatures lists only Pro-and-not-Free gates; renders a <ul> (US-940)", () => {
  const pro = {
    bulkActions: true, compPulls: true, autolister: true, apiAccess: false,
  };
  const free = {
    bulkActions: false, compPulls: false, autolister: false, apiAccess: false,
  };
  const labels = lostProFeatures(pro, free);
  // apiAccess is off in BOTH → not lost; the three Pro-only gates are.
  assert(labels.includes("Bulk listing actions"));
  assert(labels.includes("Sold-comp pricing research"));
  assert(labels.includes("AI AutoLister (photos → listings)"));
  assert(!labels.some((l) => /API access/.test(l)));

  const html = buildLostFeaturesHtml(labels);
  assert(html.startsWith("<ul"));
  assert(html.includes("<li>Bulk listing actions</li>"));
  // Empty list → empty string (token collapses, no stray <ul>).
  assertEquals(buildLostFeaturesHtml([]), "");
});

// A faithful slice of the seeded Phase-2 in-trial sequence: a day-7 recap that
// only sends to active users (+ a zero-activity re-activation branch), a day-10
// certificate deep-dive skipped if already used, and trial_end-anchored urgency.
function phase2Graph(): DripGraph {
  const s = (id: string, over: Record<string, unknown>) =>
    step({ id, phase: "in_trial", exit: false, ...over }) as unknown as
      DripGraph["steps"][number];
  return {
    entryStepId: "recap",
    steps: [
      s("recap", {
        anchor: "enrollment",
        delayHours: 168,
        conditions: [
          { field: "converted", op: "is_false" },
          { field: "totalActivity", op: "gt", value: 0 },
        ],
        branches: [{
          conditions: [{ field: "totalActivity", op: "is_false" }],
          targetStepId: "recap_reactivate",
        }],
        next: "feature_deepdive",
      }),
      s("recap_reactivate", {
        anchor: "enrollment",
        delayHours: 168,
        conditions: [{ field: "converted", op: "is_false" }],
        next: "feature_deepdive",
      }),
      s("feature_deepdive", {
        anchor: "enrollment",
        delayHours: 240,
        conditions: [
          { field: "converted", op: "is_false" },
          { field: "certificatesCount", op: "is_false" },
        ],
        branches: [{
          conditions: [{ field: "certificatesCount", op: "gt", value: 0 }],
          targetStepId: "urgency_today",
        }],
        next: "urgency_today",
      }),
      s("urgency_today", {
        anchor: "trial_end",
        delayHours: 0,
        conditions: [{ field: "converted", op: "is_false" }],
        next: null,
        exit: true,
      }),
    ],
  };
}

Deno.test("phase-2 in-trial graph is structurally valid (US-940)", () => {
  const r = validateGraph(phase2Graph());
  assert(r.ok, r.errors.join("; "));
});

Deno.test("recap: an ACTIVE trialist gets the recap (US-940)", () => {
  // Past day 7 so recap is due; has activity → conditions pass → send recap.
  const plan = simulateJourney(
    phase2Graph(),
    { userId: "u1", enrolledAtMs: 0, converted: false, totalActivity: 5, certificatesCount: 0 },
    1000 * HOUR,
  );
  const sent = plan.sends.filter((x) => x.willSend).map((x) => x.stepId);
  assert(sent.includes("recap"));
  assert(!sent.includes("recap_reactivate"));
});

Deno.test("recap: a ZERO-activity trialist gets the re-activation variant instead (US-940)", () => {
  const r = simulateJourney(
    phase2Graph(),
    { userId: "u1", enrolledAtMs: 0, converted: false, totalActivity: 0, certificatesCount: 0 },
    1000 * HOUR,
  );
  const sent = r.sends.filter((x) => x.willSend).map((x) => x.stepId);
  // recap is gated off (no activity); the branch routes to recap_reactivate.
  assert(!sent.includes("recap"));
  assert(sent.includes("recap_reactivate"));
});

Deno.test("feature deep-dive is skipped for a user who already made a certificate (US-940)", () => {
  const r = simulateJourney(
    phase2Graph(),
    { userId: "u1", enrolledAtMs: 0, converted: false, totalActivity: 3, certificatesCount: 2 },
    1000 * HOUR,
  );
  const sent = r.sends.filter((x) => x.willSend).map((x) => x.stepId);
  assert(!sent.includes("feature_deepdive"));
  // Skipping the deep-dive still lands on the urgency step.
  assert(sent.includes("urgency_today"));
});

Deno.test("conversion at any point exits the in-trial push — no further sends (US-940)", () => {
  const converted = { userId: "u1", enrolledAtMs: 0, converted: true, totalActivity: 5 };
  const plan = planTick(phase2Graph(), converted, new Set(), 1000 * HOUR);
  assertEquals(plan.status, "complete");
  assertEquals(plan.send, null);
});

Deno.test("urgency is anchored to the ACTUAL trial_end, not a fixed offset (US-940)", () => {
  // Admin-shortened trial: trial_end well before enrollment+14d. The urgency
  // step must schedule off trial_end, so it's due immediately here.
  const trialEnd = "2026-02-01T00:00:00.000Z";
  const trialEndMs = Date.parse(trialEnd);
  const g: DripGraph = {
    entryStepId: "urgency_today",
    steps: [
      step({
        id: "urgency_today",
        phase: "in_trial",
        anchor: "trial_end",
        delayHours: 0,
        conditions: [{ field: "converted", op: "is_false" }],
        next: null,
        exit: true,
      }) as unknown as DripGraph["steps"][number],
    ],
  };
  const plan = planTick(
    g,
    { userId: "u1", enrolledAtMs: trialEndMs - 200 * HOUR, converted: false, trialEndsAt: trialEnd },
    new Set(),
    trialEndMs,
  );
  assertEquals(plan.status, "send");
  assertEquals(plan.send?.stepId, "urgency_today");
});

Deno.test("planTick skips a gated step and sends the next sendable one", () => {
  const g: DripGraph = {
    entryStepId: "a",
    steps: [
      step({
        id: "a",
        anchor: "enrollment",
        delayHours: 0,
        conditions: [{ field: "gradesUsed", op: "gte", value: 1 }],
        next: "b",
        exit: false,
      }) as unknown as DripGraph["steps"][number],
      step({
        id: "b",
        anchor: "enrollment",
        delayHours: 0,
        conditions: [],
        next: null,
        exit: true,
      }) as unknown as DripGraph["steps"][number],
    ],
  };
  // gradesUsed 0 → step "a" is due but gated, so it's skipped and "b" sends.
  const plan = planTick(g, tickUser({ gradesUsed: 0 }), new Set(), HOUR);
  assertEquals(plan.status, "send");
  assertEquals(plan.send?.stepId, "b");
  assertEquals(plan.skipped, [1]);
});
