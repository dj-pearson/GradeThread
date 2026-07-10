// US-1827: portfolio alert detection + sell guidance (pure). No DB.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  detectValuationAlert,
  bestTimeToSell,
  normalizePortfolioAlertConfig,
  DEFAULT_PORTFOLIO_ALERTS_CONFIG,
} = await import("../lib/portfolio-alerts.ts");

const CFG = DEFAULT_PORTFOLIO_ALERTS_CONFIG; // move 15%, min 2000c

// ── detectValuationAlert ────────────────────────────────────────────────────

Deno.test("alert: low/none confidence never alerts", () => {
  const v = detectValuationAlert(
    { estimateCents: 10000, confidence: "low", peakEstimateCents: 1000, lastAlertEstimateCents: 1000 },
    CFG,
  );
  assertEquals(v.kind, null);
});

Deno.test("alert: sub-min estimate never alerts", () => {
  const v = detectValuationAlert(
    { estimateCents: 1500, confidence: "high", peakEstimateCents: 100, lastAlertEstimateCents: 100 },
    CFG,
  );
  assertEquals(v.kind, null);
});

Deno.test("alert: first-ever valuation is not a peak event, but sets the peak", () => {
  const v = detectValuationAlert(
    { estimateCents: 10000, confidence: "high", peakEstimateCents: null, lastAlertEstimateCents: null },
    CFG,
  );
  assertEquals(v.kind, null);
  assertEquals(v.newPeakCents, 10000);
});

Deno.test("alert: a new all-time high fires 'peak'", () => {
  const v = detectValuationAlert(
    { estimateCents: 12000, confidence: "high", peakEstimateCents: 10000, lastAlertEstimateCents: 11000 },
    CFG,
  );
  assertEquals(v.kind, "peak");
  assertEquals(v.newPeakCents, 12000);
});

Deno.test("alert: a >=15% rise from last-alerted fires 'rise'", () => {
  const v = detectValuationAlert(
    { estimateCents: 11600, confidence: "medium", peakEstimateCents: 12000, lastAlertEstimateCents: 10000 },
    CFG,
  );
  assertEquals(v.kind, "rise");
  assertEquals(Math.round(v.changePct!), 16);
});

Deno.test("alert: a >=15% drop fires 'drop'", () => {
  const v = detectValuationAlert(
    { estimateCents: 8000, confidence: "high", peakEstimateCents: 12000, lastAlertEstimateCents: 10000 },
    CFG,
  );
  assertEquals(v.kind, "drop");
  assertEquals(v.changePct, -20);
});

Deno.test("alert: a small move below threshold does not fire", () => {
  const v = detectValuationAlert(
    { estimateCents: 10500, confidence: "high", peakEstimateCents: 12000, lastAlertEstimateCents: 10000 },
    CFG,
  );
  assertEquals(v.kind, null);
});

// ── bestTimeToSell ──────────────────────────────────────────────────────────

Deno.test("guidance: up + solid confidence + fast-selling → sell_now", () => {
  assertEquals(bestTimeToSell({ trend: "up", confidence: "high", medianDaysToSell: 20 }), "sell_now");
});

Deno.test("guidance: up but slow / low-confidence → hold", () => {
  assertEquals(bestTimeToSell({ trend: "up", confidence: "high", medianDaysToSell: 90 }), "hold");
  assertEquals(bestTimeToSell({ trend: "up", confidence: "low", medianDaysToSell: 10 }), "hold");
  assertEquals(bestTimeToSell({ trend: "up", confidence: "medium", medianDaysToSell: null }), "hold");
});

Deno.test("guidance: down → watch; flat → hold; unknown/none → unknown", () => {
  assertEquals(bestTimeToSell({ trend: "down", confidence: "high", medianDaysToSell: 10 }), "watch");
  assertEquals(bestTimeToSell({ trend: "flat", confidence: "high", medianDaysToSell: 10 }), "hold");
  assertEquals(bestTimeToSell({ trend: "unknown", confidence: "high", medianDaysToSell: 10 }), "unknown");
  assertEquals(bestTimeToSell({ trend: "up", confidence: "none", medianDaysToSell: 10 }), "unknown");
});

Deno.test("config: garbage → defaults", () => {
  assertEquals(normalizePortfolioAlertConfig(undefined), DEFAULT_PORTFOLIO_ALERTS_CONFIG);
  assertEquals(normalizePortfolioAlertConfig({ move_threshold_pct: -5 }).move_threshold_pct, 0);
});
