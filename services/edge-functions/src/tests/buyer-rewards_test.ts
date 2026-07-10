// US-1813: buyer reward config normalize + issue-gate decision (pure). No DB.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  normalizeBuyerRewardConfig,
  decideRewardIssue,
  DEFAULT_BUYER_REWARD_CONFIG,
} = await import("../lib/buyer-rewards.ts");

// ── normalizeBuyerRewardConfig ──────────────────────────────────────────────

Deno.test("config: absent/garbage → the defaults", () => {
  assertEquals(normalizeBuyerRewardConfig(undefined), DEFAULT_BUYER_REWARD_CONFIG);
  assertEquals(normalizeBuyerRewardConfig(null), DEFAULT_BUYER_REWARD_CONFIG);
  assertEquals(normalizeBuyerRewardConfig("nope"), DEFAULT_BUYER_REWARD_CONFIG);
});

Deno.test("config: a present-but-invalid numeric field clamps to 0", () => {
  const c = normalizeBuyerRewardConfig({ credits_per_confirmation: "lots", daily_confirmation_cap: -4 });
  assertEquals(c.credits_per_confirmation, 0);
  assertEquals(c.daily_confirmation_cap, 0);
  // Absent boolean falls back to the default (true), not coerced away.
  assertEquals(c.require_arrival_evidence, true);
});

Deno.test("config: fractional counts floor; a real bool is honored", () => {
  const c = normalizeBuyerRewardConfig({
    credits_per_confirmation: 2.9,
    daily_confirmation_cap: 10,
    require_arrival_evidence: false,
  });
  assertEquals(c.credits_per_confirmation, 2);
  assertEquals(c.daily_confirmation_cap, 10);
  assertEquals(c.require_arrival_evidence, false);
});

// ── decideRewardIssue ───────────────────────────────────────────────────────

Deno.test("gate: issues the configured credits with evidence", () => {
  assertEquals(
    decideRewardIssue({ credits_per_confirmation: 3, daily_confirmation_cap: 5, require_arrival_evidence: true }, true),
    { issue: true, credits: 3 },
  );
});

Deno.test("gate: zero credits is an off switch", () => {
  assertEquals(
    decideRewardIssue({ credits_per_confirmation: 0, daily_confirmation_cap: 5, require_arrival_evidence: false }, true),
    { issue: false, reason: "disabled" },
  );
});

Deno.test("gate: evidence required but missing → no issue", () => {
  assertEquals(
    decideRewardIssue({ credits_per_confirmation: 1, daily_confirmation_cap: 5, require_arrival_evidence: true }, false),
    { issue: false, reason: "no_evidence" },
  );
});

Deno.test("gate: evidence not required → issues without photos", () => {
  assertEquals(
    decideRewardIssue({ credits_per_confirmation: 1, daily_confirmation_cap: 0, require_arrival_evidence: false }, false),
    { issue: true, credits: 1 },
  );
});
