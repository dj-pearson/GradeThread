// US-1822: guarantee claims-pool gate + stats + config (pure). No DB.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  evaluatePoolGate,
  computePoolPeriodStats,
  normalizeGuaranteePoolConfig,
  periodKey,
  DEFAULT_GUARANTEE_POOL_CONFIG,
} = await import("../lib/guarantee-pool.ts");

const CFG = DEFAULT_GUARANTEE_POOL_CONFIG; // budget 500000, acct cap 20000, ratio 0.85, accrual 100

// ── evaluatePoolGate ────────────────────────────────────────────────────────

Deno.test("gate: within all caps → allow", () => {
  const g = evaluatePoolGate(3000, { periodAccruedCents: 100000, periodDrawnCents: 1000, accountDrawnCents: 0 }, CFG);
  assertEquals(g.allowAuto, true);
});

Deno.test("gate: per-account cap breach → block account_cap", () => {
  const g = evaluatePoolGate(5000, { periodAccruedCents: 100000, periodDrawnCents: 1000, accountDrawnCents: 18000 }, CFG);
  assertEquals(g, { allowAuto: false, reason: "account_cap" });
});

Deno.test("gate: period budget breach → block period_budget", () => {
  const g = evaluatePoolGate(
    3000,
    { periodAccruedCents: 100000, periodDrawnCents: 499000, accountDrawnCents: 0 },
    CFG,
  );
  assertEquals(g, { allowAuto: false, reason: "period_budget" });
});

Deno.test("gate: loss-ratio circuit-breaker trips once accrual exists", () => {
  // accrued 10000, drawn 8000 + remedy 1000 = 9000 → ratio 0.9 > 0.85
  const g = evaluatePoolGate(1000, { periodAccruedCents: 10000, periodDrawnCents: 8000, accountDrawnCents: 0 }, CFG);
  assertEquals(g, { allowAuto: false, reason: "loss_ratio" });
});

Deno.test("gate: no accrual yet → loss-ratio does NOT trip (budget governs)", () => {
  const g = evaluatePoolGate(1000, { periodAccruedCents: 0, periodDrawnCents: 400000, accountDrawnCents: 0 }, CFG);
  assertEquals(g.allowAuto, true);
});

Deno.test("gate: account cap is checked before the budget", () => {
  const g = evaluatePoolGate(
    5000,
    { periodAccruedCents: 100000, periodDrawnCents: 499000, accountDrawnCents: 18000 },
    CFG,
  );
  assertEquals(g, { allowAuto: false, reason: "account_cap" });
});

Deno.test("gate: zero caps mean unlimited", () => {
  const cfg = { ...CFG, per_account_period_cap_cents: 0, period_budget_cents: 0 };
  const g = evaluatePoolGate(999999, { periodAccruedCents: 0, periodDrawnCents: 0, accountDrawnCents: 0 }, cfg);
  assertEquals(g.allowAuto, true);
});

// ── computePoolPeriodStats ──────────────────────────────────────────────────

Deno.test("stats: rolls up accrual/drawdown/exposure/loss ratio for a period", () => {
  const entries = [
    { entry_type: "accrual" as const, amount_cents: 10000, period: "2026-07" },
    { entry_type: "drawdown" as const, amount_cents: 3000, period: "2026-07" },
    { entry_type: "drawdown" as const, amount_cents: 2000, period: "2026-07" },
    { entry_type: "accrual" as const, amount_cents: 9999, period: "2026-06" }, // other period ignored
  ];
  const s = computePoolPeriodStats(entries, "2026-07");
  assertEquals(s.accruedCents, 10000);
  assertEquals(s.drawnCents, 5000);
  assertEquals(s.exposureCents, 5000);
  assertEquals(s.lossRatio, 0.5);
  assertEquals(s.drawdownCount, 2);
});

Deno.test("stats: loss ratio is null when nothing accrued", () => {
  const s = computePoolPeriodStats([{ entry_type: "drawdown", amount_cents: 100, period: "2026-07" }], "2026-07");
  assertEquals(s.lossRatio, null);
  assertEquals(s.exposureCents, -100);
});

// ── config + period key ─────────────────────────────────────────────────────

Deno.test("config: garbage → defaults; ratio kept as a float", () => {
  assertEquals(normalizeGuaranteePoolConfig(undefined), DEFAULT_GUARANTEE_POOL_CONFIG);
  assertEquals(normalizeGuaranteePoolConfig({ loss_ratio_throttle: 0.5 }).loss_ratio_throttle, 0.5);
  assertEquals(normalizeGuaranteePoolConfig({ period_budget_cents: -5 }).period_budget_cents, 0);
});

Deno.test("periodKey: UTC YYYY-MM", () => {
  assertEquals(periodKey(Date.UTC(2026, 6, 10, 23, 0, 0)), "2026-07");
  assertEquals(periodKey(Date.UTC(2026, 0, 1, 0, 0, 0)), "2026-01");
});
