// US-1791: per-key monthly API quota helpers.
import { assert, assertEquals } from "@std/assert";
import { billingMonthStartIso, quotaResetIso, computeQuotaState } from "../lib/api-quota.ts";

const D = (iso: string) => new Date(iso);

Deno.test("billingMonthStartIso / quotaResetIso: UTC month boundaries", () => {
  assertEquals(billingMonthStartIso(D("2026-07-09T13:20:00Z")), "2026-07-01T00:00:00.000Z");
  assertEquals(quotaResetIso(D("2026-07-09T13:20:00Z")), "2026-08-01T00:00:00.000Z");
  // December rolls into next year.
  assertEquals(quotaResetIso(D("2026-12-15T00:00:00Z")), "2027-01-01T00:00:00.000Z");
});

Deno.test("computeQuotaState: null quota is unlimited (never exceeded)", () => {
  const s = computeQuotaState(null, 9999, D("2026-07-09T00:00:00Z"));
  assertEquals(s.quota, null);
  assertEquals(s.remaining, null);
  assertEquals(s.exceeded, false);
});

Deno.test("computeQuotaState: under / at / over the quota", () => {
  const now = D("2026-07-09T00:00:00Z");
  assertEquals(computeQuotaState(100, 40, now).remaining, 60);
  assertEquals(computeQuotaState(100, 40, now).exceeded, false);
  assert(computeQuotaState(100, 100, now).exceeded, "at quota is exceeded");
  assert(computeQuotaState(100, 150, now).exceeded);
  assertEquals(computeQuotaState(100, 150, now).remaining, 0); // floored
  assertEquals(computeQuotaState(100, 40, now).resets_at, "2026-08-01T00:00:00.000Z");
});
