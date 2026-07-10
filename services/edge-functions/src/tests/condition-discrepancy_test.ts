// US-1834: claimed-vs-objective condition discrepancy (pure). No DB.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { claimedConditionToGrade, scoreDiscrepancy } = await import("../lib/condition-discrepancy.ts");

// ── claimedConditionToGrade ─────────────────────────────────────────────────

Deno.test("claim: eBay conditionIds map to grades", () => {
  assertEquals(claimedConditionToGrade("1000"), 10); // New with tags
  assertEquals(claimedConditionToGrade(1500), 9); // numeric ok
  assertEquals(claimedConditionToGrade("3000"), 6); // Used
  assertEquals(claimedConditionToGrade("7000"), 2); // parts
});

Deno.test("claim: free-text labels normalize (any marketplace)", () => {
  assertEquals(claimedConditionToGrade("New With Tags"), 10);
  assertEquals(claimedConditionToGrade("NWT"), 10);
  assertEquals(claimedConditionToGrade("Like New"), 8);
  assertEquals(claimedConditionToGrade("Excellent condition"), 8);
  assertEquals(claimedConditionToGrade("Very Good"), 7);
  assertEquals(claimedConditionToGrade("Good"), 6);
  assertEquals(claimedConditionToGrade("Fair"), 4.5);
  assertEquals(claimedConditionToGrade("for parts"), 2);
});

Deno.test("claim: absent / unrecognized → null (graceful)", () => {
  assertEquals(claimedConditionToGrade(null), null);
  assertEquals(claimedConditionToGrade(""), null);
  assertEquals(claimedConditionToGrade("  "), null);
  assertEquals(claimedConditionToGrade("wibble"), null);
  assertEquals(claimedConditionToGrade("9999"), null); // unknown id
});

// ── scoreDiscrepancy ────────────────────────────────────────────────────────

Deno.test("score: claim far above objective → over_graded", () => {
  const r = scoreDiscrepancy(6, 10); // seller says NWT, photos say Good
  assertEquals(r.signal, "over_graded");
  assertEquals(r.delta, 4);
});

Deno.test("score: claim ~1 above → mild_gap", () => {
  assertEquals(scoreDiscrepancy(7, 8).signal, "mild_gap");
  assertEquals(scoreDiscrepancy(7, 8.5).signal, "mild_gap");
});

Deno.test("score: claim matches (or under) objective → match", () => {
  assertEquals(scoreDiscrepancy(8, 8).signal, "match");
  assertEquals(scoreDiscrepancy(8, 7).signal, "match"); // under-claimed = buyer's gain
});

Deno.test("score: unknown claim → unknown, null delta", () => {
  const r = scoreDiscrepancy(8, null);
  assertEquals(r.signal, "unknown");
  assertEquals(r.delta, null);
  assertEquals(r.objectiveGrade, 8);
});
