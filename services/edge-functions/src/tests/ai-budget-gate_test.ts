// US-2013 — a failed budget read must never UN-KILL a breached feature.
//
// The old behaviour cached an EMPTY set on any read error, so a feature whose
// hard USD ceiling had already been hit silently resumed spending for the cache
// TTL, repeatedly, for as long as the outage lasted.
//
// That mattered because it was CORRELATED: the per-user rate limiters read the
// same Postgres, so a single degradation removed the per-user cap AND the hard
// spend cap together — while Anthropic stayed up and billable.
//
// Blanket fail-CLOSED was considered and rejected (a transient blip must not
// halt all AI). Retention is strictly better than either extreme, and these
// tests pin exactly that asymmetry.

import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  isAiBudgetExhausted,
  clearAiBudgetGateCache,
  expireAiBudgetGateCacheForTest: clearCacheOnly,
} = await import("../lib/ai-budget-gate.ts");

const KILLED = [
  { feature: "grading", enabled: true, breached: true, action: "kill" },
] as unknown as Parameters<typeof JSON.stringify>[0];

const ok = (rows: unknown) => () => Promise.resolve(rows as never);
const fails = () => Promise.resolve(null);

Deno.test("a breached kill-budget blocks the feature", async () => {
  clearAiBudgetGateCache();
  assertEquals(await isAiBudgetExhausted("grading", ok(KILLED)), true);
});

Deno.test("US-2013: a read FAILURE retains a known kill instead of clearing it", async () => {
  clearAiBudgetGateCache();
  // 1. Establish a known breach.
  assertEquals(await isAiBudgetExhausted("grading", ok(KILLED)), true);
  // 2. Expire the cache, then fail the read. The OLD code cached an empty set
  //    here and returned false — resuming spend on a feature over its ceiling.
  clearCacheOnly();
  assertEquals(
    await isAiBudgetExhausted("grading", fails),
    true,
    "a failed read must not un-kill a feature already known to be breached",
  );
});

Deno.test("US-2013: a failure does NOT block a feature with no known breach", async () => {
  clearAiBudgetGateCache();
  // Nothing known-killed, read fails → must stay open. This is the half that
  // makes retention better than blanket fail-closed: a transient blip cannot
  // halt AI for features that were never over budget.
  assertEquals(await isAiBudgetExhausted("grading", fails), false);
});

Deno.test("recovery: a successful read clears a previously-killed feature", async () => {
  clearAiBudgetGateCache();
  assertEquals(await isAiBudgetExhausted("grading", ok(KILLED)), true);
  clearCacheOnly();
  // Operator raised the limit / period rolled over.
  assertEquals(
    await isAiBudgetExhausted("grading", ok([])),
    false,
    "retention must not become a permanent lockout",
  );
});

Deno.test("an admin cache clear also drops the retained verdict", async () => {
  clearAiBudgetGateCache();
  assertEquals(await isAiBudgetExhausted("grading", ok(KILLED)), true);
  // clearAiBudgetGateCache is what an admin budget edit calls; it must not
  // leave a stale kill behind, or "I raised the limit" wouldn't take effect
  // until the next successful read.
  clearAiBudgetGateCache();
  assertEquals(await isAiBudgetExhausted("grading", fails), false);
});
