// US-9119: the ceiling on what one conversation can do.
//
// Rate limits (US-9105) stop a flood. This stops a well-paced mistake: forty
// publishes over forty minutes is inside every per-minute budget and is still a
// seller's whole store live at the wrong price.
//
// The property worth guarding hardest is the FAIL-CLOSED half. If the counter
// cannot be read we do not know how much has been spent, and "unknown" must not
// read as "none" for an action that ends listings.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  budgetKindForTool,
  checkBudget,
  DEFAULT_BUDGETS,
  TOOLS_BY_KIND,
} = await import("../lib/mcp-budget.ts");

const SUBJECT = "apikey-1";
const NOW = Date.parse("2026-08-18T12:00:00.000Z");

/** A counter that reports a fixed number, and records what it was asked. */
function fixedCounter(used: number) {
  const calls: Array<{ subject: string; kind: string; sinceIso: string }> = [];
  return {
    calls,
    counter: (subject: string, kind: string, sinceIso: string) => {
      calls.push({ subject, kind, sinceIso });
      return Promise.resolve(used);
    },
  };
}

const brokenCounter = () => Promise.reject(new Error("counter store down"));

// ---------------------------------------------------------------------------
// The ceiling
// ---------------------------------------------------------------------------

Deno.test("an action inside the budget is allowed", async () => {
  const { counter } = fixedCounter(3);
  const verdict = await checkBudget({
    subject: SUBJECT,
    kind: "publish",
    counter: counter as never,
    nowMs: NOW,
  });
  assert(verdict.allowed);
  assertEquals(verdict.used, 4);
  assertEquals(verdict.max, DEFAULT_BUDGETS.publish.max);
});

Deno.test("the action that would cross the ceiling is refused, not the one after it", async () => {
  const max = DEFAULT_BUDGETS.publish.max;
  const atLimit = fixedCounter(max);
  const refused = await checkBudget({
    subject: SUBJECT,
    kind: "publish",
    counter: atLimit.counter as never,
    nowMs: NOW,
  });
  assert(!refused.allowed);

  const justUnder = fixedCounter(max - 1);
  const allowed = await checkBudget({
    subject: SUBJECT,
    kind: "publish",
    counter: justUnder.counter as never,
    nowMs: NOW,
  });
  assert(allowed.allowed, "the last action inside the budget must still go through");
});

Deno.test("the refusal names the number, the window and when it resets", async () => {
  const { counter } = fixedCounter(DEFAULT_BUDGETS.publish.max);
  const verdict = await checkBudget({
    subject: SUBJECT,
    kind: "publish",
    counter: counter as never,
    nowMs: NOW,
  });
  assert(!verdict.allowed);
  const message = verdict.message ?? "";
  assert(message.includes(String(DEFAULT_BUDGETS.publish.max)), message);
  assert(message.includes("resets"), message);
  // A refusal that leaves the seller stuck is a bad refusal.
  assert(message.includes("dashboard"), message);
  assertEquals(verdict.resetsAt, new Date(NOW + DEFAULT_BUDGETS.publish.windowMs).toISOString());
});

Deno.test("a costly action spends its whole cost, not one unit", async () => {
  // AI spend is counted in cents; a 500-cent call must not look like one action.
  const { counter } = fixedCounter(1800);
  const verdict = await checkBudget({
    subject: SUBJECT,
    kind: "ai_spend_cents",
    cost: 500,
    counter: counter as never,
    nowMs: NOW,
  });
  assert(!verdict.allowed, "1800 + 500 exceeds the 2000-cent daily ceiling");
});

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

Deno.test("the counter is asked about the right window, per budget kind", async () => {
  const hourly = fixedCounter(0);
  await checkBudget({
    subject: SUBJECT,
    kind: "publish",
    counter: hourly.counter as never,
    nowMs: NOW,
  });
  assertEquals(
    hourly.calls[0].sinceIso,
    new Date(NOW - DEFAULT_BUDGETS.publish.windowMs).toISOString(),
  );

  const daily = fixedCounter(0);
  await checkBudget({
    subject: SUBJECT,
    kind: "grade",
    counter: daily.counter as never,
    nowMs: NOW,
  });
  assertEquals(
    daily.calls[0].sinceIso,
    new Date(NOW - DEFAULT_BUDGETS.grade.windowMs).toISOString(),
  );
});

Deno.test("the budget is per CREDENTIAL, so one key cannot spend another's", async () => {
  const { calls, counter } = fixedCounter(0);
  await checkBudget({
    subject: "apikey-A",
    kind: "publish",
    counter: counter as never,
    nowMs: NOW,
  });
  assertEquals(calls[0].subject, "apikey-A");
});

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------

Deno.test("a counter outage REFUSES the action rather than assuming nothing was spent", async () => {
  const verdict = await checkBudget({
    subject: SUBJECT,
    kind: "end_listing",
    counter: brokenCounter as never,
    nowMs: NOW,
  });
  assert(!verdict.allowed, "an unreadable counter must not read as an empty one");
  assert((verdict.message ?? "").includes("refused rather than risked"));
});

Deno.test("checkBudget never throws, so a caller cannot accidentally treat an outage as a pass", async () => {
  // If this threw, a handler with a try/catch around the tool call would turn a
  // counter outage into a generic error and, on some paths, into a retry.
  const verdict = await checkBudget({
    subject: SUBJECT,
    kind: "publish",
    counter: brokenCounter as never,
    nowMs: NOW,
  });
  assertEquals(verdict.allowed, false);
});

// ---------------------------------------------------------------------------
// The tool mapping
// ---------------------------------------------------------------------------

Deno.test("every budgeted tool maps to exactly one budget", () => {
  const seen = new Map<string, string>();
  for (const [kind, names] of Object.entries(TOOLS_BY_KIND)) {
    for (const name of names) {
      assert(!seen.has(name), `${name} is budgeted twice: ${seen.get(name)} and ${kind}`);
      seen.set(name, kind);
    }
  }
  for (const [name, kind] of seen) {
    assertEquals(budgetKindForTool(name), kind);
  }
});

Deno.test("a read tool spends from no budget", () => {
  for (const name of ["gradethread_list_items", "gradethread_get_grade", "gradethread_usage"]) {
    assertEquals(budgetKindForTool(name), null, `${name} should not be budgeted`);
  }
});

Deno.test("every mutating tool the registry declares is budgeted", async () => {
  // The mapping lives next to the budgets so "what can spend money" is one list
  // someone can read. This asserts the list has not fallen behind the registry.
  const { TOOLS } = await import("../lib/mcp-tools.ts");
  const unbudgeted = TOOLS
    .filter((t) => t.annotations.destructiveHint === true)
    .map((t) => t.name)
    .filter((name) => budgetKindForTool(name) === null);
  assertEquals(
    unbudgeted,
    [],
    "these tools mutate something but spend from no budget; add them to TOOLS_BY_KIND",
  );
});
