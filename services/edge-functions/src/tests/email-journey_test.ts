// US-929: unit tests for the pure lifecycle email-journey engine.
import { assert, assertEquals } from "@std/assert";
import {
  applyJourneyTokens,
  type JourneyStepDef,
  journeyGoalMet,
  planJourneyTick,
  renderJourneyStep,
} from "../lib/email-journey.ts";

const DAY = 24 * 60 * 60 * 1000;

function step(stepOrder: number, offsetDays: number, over: Partial<JourneyStepDef> = {}): JourneyStepDef {
  return {
    stepOrder,
    offsetDays,
    subject: `Step ${stepOrder}`,
    bodyHtml: "<p>hi {{firstName}}</p>",
    ctaLabel: "Go",
    ctaUrl: "{{dashboardUrl}}/x",
    aiPersonalize: false,
    enabled: true,
    ...over,
  };
}

Deno.test("renderJourneyStep applies tokens + appends CTA", () => {
  const r = renderJourneyStep(
    step(1, 0, { subject: "Welcome {{firstName}}", bodyHtml: "<p>Hi {{firstName}}{{aiIntro}}</p>" }),
    { firstName: "Sam", dashboardUrl: "https://gradethread.com/dashboard", aiIntro: "<p>Nice!</p>" },
  );
  assertEquals(r.subject, "Welcome Sam");
  assert(r.contentHtml.includes("Hi Sam"));
  assert(r.contentHtml.includes("<p>Nice!</p>"), "aiIntro injected");
  assert(r.contentHtml.includes("https://gradethread.com/dashboard/x"), "CTA url token resolved");
  assert(r.contentHtml.includes(">Go<") || r.contentHtml.includes("Go\n"), "CTA label present");
});

Deno.test("renderJourneyStep falls back firstName + empty aiIntro; escapes values", () => {
  const r = renderJourneyStep(step(1, 0, { subject: "Hi {{firstName}}", bodyHtml: "<p>{{firstName}}{{aiIntro}}</p>" }), {});
  assertEquals(r.subject, "Hi there");
  assert(r.contentHtml.includes("there"));
  assert(!r.contentHtml.includes("{{"), "unknown/empty tokens collapse");

  const escaped = renderJourneyStep(step(1, 0, { bodyHtml: "<p>{{firstName}}</p>", ctaLabel: null, ctaUrl: null }), {
    firstName: "<b>x</b>",
  });
  assert(escaped.contentHtml.includes("&lt;b&gt;x&lt;/b&gt;"), "firstName value HTML-escaped");
});

Deno.test("renderJourneyStep omits CTA when label/url missing", () => {
  const r = renderJourneyStep(step(1, 0, { ctaLabel: null, ctaUrl: null }), { firstName: "A" });
  assert(!r.contentHtml.includes("padding: 14px 32px"), "no CTA button rendered");
});

Deno.test("applyJourneyTokens leaves unknown tokens empty", () => {
  assertEquals(applyJourneyTokens("a{{nope}}b", {}), "ab");
  assertEquals(applyJourneyTokens("{{x}}", { x: "Y" }), "Y");
});

Deno.test("planJourneyTick: first step due now → send", () => {
  const now = 1_000 * DAY;
  const plan = planJourneyTick([step(1, 0), step(2, 2)], now, new Set(), now);
  assertEquals(plan.status, "send");
  assertEquals(plan.step?.stepOrder, 1);
});

Deno.test("planJourneyTick: future step → wait with dueAt", () => {
  const enrolled = 1_000 * DAY;
  const now = enrolled; // step 2 offset 2 not due
  const plan = planJourneyTick([step(1, 0), step(2, 2)], enrolled, new Set([1]), now);
  assertEquals(plan.status, "wait");
  assertEquals(plan.step?.stepOrder, 2);
  assertEquals(plan.dueAtMs, enrolled + 2 * DAY);
});

Deno.test("planJourneyTick: due later step after first sent → send", () => {
  const enrolled = 1_000 * DAY;
  const now = enrolled + 3 * DAY; // step 2 (offset 2) is now due
  const plan = planJourneyTick([step(1, 0), step(2, 2)], enrolled, new Set([1]), now);
  assertEquals(plan.status, "send");
  assertEquals(plan.step?.stepOrder, 2);
});

Deno.test("planJourneyTick: all sent → complete", () => {
  const now = 1_000 * DAY;
  const plan = planJourneyTick([step(1, 0), step(2, 2)], now, new Set([1, 2]), now + 5 * DAY);
  assertEquals(plan.status, "complete");
  assertEquals(plan.step, null);
});

Deno.test("planJourneyTick: disabled steps are skipped", () => {
  const enrolled = 1_000 * DAY;
  const plan = planJourneyTick(
    [step(1, 0, { enabled: false }), step(2, 0)],
    enrolled,
    new Set(),
    enrolled,
  );
  assertEquals(plan.status, "send");
  assertEquals(plan.step?.stepOrder, 2);
});

Deno.test("planJourneyTick: only one step sent per tick (no flood on catch-up)", () => {
  const enrolled = 1_000 * DAY;
  // Both steps long overdue, none sent: plan returns the FIRST one only.
  const plan = planJourneyTick([step(1, 0), step(2, 1)], enrolled, new Set(), enrolled + 30 * DAY);
  assertEquals(plan.status, "send");
  assertEquals(plan.step?.stepOrder, 1);
});

Deno.test("journeyGoalMet: trial_ending stops on convert", () => {
  assertEquals(journeyGoalMet("trial_ending", { converted: true }).met, true);
  assertEquals(journeyGoalMet("trial_ending", { converted: true }).reason, "converted");
  assertEquals(journeyGoalMet("trial_ending", { converted: false }).met, false);
});

Deno.test("journeyGoalMet: inactivity stops on re-activation", () => {
  assertEquals(journeyGoalMet("inactivity", { reactivated: true }).met, true);
  assertEquals(journeyGoalMet("inactivity", { reactivated: true }).reason, "reactivated");
  assertEquals(journeyGoalMet("inactivity", { reactivated: false }).met, false);
});

Deno.test("journeyGoalMet: signup/first_* have no early goal", () => {
  assertEquals(journeyGoalMet("signup", { converted: true, reactivated: true }).met, false);
  assertEquals(journeyGoalMet("first_grade", { converted: true }).met, false);
  assertEquals(journeyGoalMet("first_sale", { reactivated: true }).met, false);
});
