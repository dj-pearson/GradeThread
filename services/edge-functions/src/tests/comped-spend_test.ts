// US-2358: a super_admin role grant is also an unmetered Claude Vision grant,
// and until now that spend was indistinguishable from revenue-generating usage.
//
// The coupling itself is intended (see lib/comped-spend.ts for the decision).
// What was wrong is that nothing could answer "how much are we giving away, and
// to whom" — so a second super_admin could run up unbounded vision spend and it
// would look like business on the dashboard.

import { assertEquals } from "@std/assert";
import { periodStartIso, summarizeCompedSpend } from "../lib/comped-spend.ts";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");

Deno.test("numeric costs arrive as STRINGS and must be summed as numbers", () => {
  // The trap this exists for: `cost_usd` is numeric(12,6), and supabase-js hands
  // numerics back as strings to avoid float rounding. Summing with `+` would
  // CONCATENATE — "0.01" + "0.02" = "0.010.02" — so the total would read as a
  // nonsense number rather than failing, which is the worst outcome for a
  // figure whose whole job is to be trusted.
  const s = summarizeCompedSpend([
    { user_id: "u1", submission_id: "s1", cost_usd: "0.010000", model: "opus" },
    { user_id: "u1", submission_id: "s1", cost_usd: "0.020000", model: "opus" },
  ]);
  assertEquals(s.costUsd, 0.03);
  assertEquals(s.calls, 2);
});

Deno.test("a grade is many calls but one grade", () => {
  // N per-image calls + 1 composite share a submission_id. Counting calls as
  // grades would inflate the comped-grade count by roughly 5x and make the
  // number useless for comparing against a plan's included allowance.
  const s = summarizeCompedSpend([
    { user_id: "u1", submission_id: "s1", cost_usd: 1, model: "opus" },
    { user_id: "u1", submission_id: "s1", cost_usd: 1, model: "opus" },
    { user_id: "u1", submission_id: "s2", cost_usd: 1, model: "opus" },
  ]);
  assertEquals(s.grades, 2);
  assertEquals(s.calls, 3);
});

Deno.test("a runaway has a name — the biggest spender sorts first", () => {
  // The point of the per-user split. "Comped spend is up" is not actionable;
  // "this account is 90% of it" is.
  const s = summarizeCompedSpend([
    { user_id: "small", submission_id: "a", cost_usd: 1, model: "opus" },
    { user_id: "big", submission_id: "b", cost_usd: 50, model: "opus" },
    { user_id: "big", submission_id: "c", cost_usd: 40, model: "opus" },
  ]);
  assertEquals(s.byUser[0]?.userId, "big");
  assertEquals(s.byUser[0]?.costUsd, 90);
  assertEquals(s.byUser[0]?.grades, 2);
  assertEquals(s.byUser[1]?.userId, "small");
});

Deno.test("spend from a deleted user is still counted, under a name", () => {
  // ai_usage_events.user_id is ON DELETE SET NULL precisely so the cost record
  // survives the account. Dropping those rows would let deleting an account
  // erase its spend from the report — which is the one thing a cost ledger must
  // not allow.
  const s = summarizeCompedSpend([
    { user_id: null, submission_id: "s1", cost_usd: 5, model: "opus" },
  ]);
  assertEquals(s.costUsd, 5);
  assertEquals(s.byUser[0]?.userId, "(deleted user)");
});

Deno.test("an unparseable cost still counts as a call", () => {
  // Volume and money are separate questions. Dropping the row would understate
  // both; zeroing only the money understates one, visibly.
  const s = summarizeCompedSpend([
    { user_id: "u1", submission_id: "s1", cost_usd: "not a number", model: "opus" },
    { user_id: "u1", submission_id: "s1", cost_usd: "2", model: "opus" },
  ]);
  assertEquals(s.calls, 2);
  assertEquals(s.costUsd, 2);
});

Deno.test("no comped events is zero, not an error", () => {
  const s = summarizeCompedSpend([]);
  assertEquals(s, { grades: 0, calls: 0, costUsd: 0, byUser: [], byModel: [] });
});

Deno.test("the model split is there, because a model swap is how cost jumps", () => {
  const s = summarizeCompedSpend([
    { user_id: "u1", submission_id: "s1", cost_usd: 10, model: "opus" },
    { user_id: "u1", submission_id: "s2", cost_usd: 1, model: "haiku" },
  ]);
  assertEquals(s.byModel.map((m) => m.model), ["opus", "haiku"]);
});

Deno.test("the period window matches the AI-spend dashboard's vocabulary", () => {
  const day = 24 * 60 * 60_000;
  assertEquals(periodStartIso("today", NOW), new Date(NOW - day).toISOString());
  assertEquals(periodStartIso("7d", NOW), new Date(NOW - 7 * day).toISOString());
  assertEquals(periodStartIso("90d", NOW), new Date(NOW - 90 * day).toISOString());
  // An unknown period falls back to 30d rather than to "all time" — the route
  // rejects unknown values anyway, so this only decides what a future caller
  // gets, and the safe default is the smaller window.
  assertEquals(periodStartIso("nonsense", NOW), new Date(NOW - 30 * day).toISOString());
});

Deno.test("the route reads the ledger PAGED and scoped to super_admins", () => {
  const src = Deno.readTextFileSync(
    new URL("../routes/admin-ai-spend.ts", import.meta.url),
  );
  const route = src.slice(src.indexOf('adminAiSpendRoutes.get("/comped"'));
  // Unbounded, this is exactly the read PostgREST clips at db-max-rows with
  // error:null — and a clipped read would UNDERSTATE the number the endpoint
  // exists to make un-hideable.
  assertEquals(route.includes("fetchAllPages<UsageEvent>"), true);
  assertEquals(route.includes('.eq("role", "super_admin")'), true);
  assertEquals(route.includes('.in("user_id", ids)'), true);
});
