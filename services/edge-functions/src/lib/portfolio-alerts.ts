// US-1827: portfolio value-alert detection + best-time-to-sell guidance (PURE).
//
// Unit-tested, no DB. detectValuationAlert fires at most one alert per item per
// run and measures a move from the LAST-ALERTED value (not the previous run) so a
// slow drift eventually alerts once, never every run. bestTimeToSell turns the
// valuation trend + confidence + platform sell-through into a legible label — a
// suggestion, never a guarantee.

export interface PortfolioAlertConfig {
  /** % change from the last-alerted value that fires a significant-move alert. */
  move_threshold_pct: number;
  /** Items valued under this (cents) are too small to alert on. */
  min_estimate_cents: number;
}

export const PORTFOLIO_ALERTS_SETTING_KEY = "buyer.portfolio_alerts";

export const DEFAULT_PORTFOLIO_ALERTS_CONFIG: PortfolioAlertConfig = {
  move_threshold_pct: 15,
  min_estimate_cents: 2000,
};

function coerceNonNegInt(raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  return 0;
}

export function normalizePortfolioAlertConfig(raw: unknown): PortfolioAlertConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    move_threshold_pct: coerceNonNegInt(r.move_threshold_pct, DEFAULT_PORTFOLIO_ALERTS_CONFIG.move_threshold_pct),
    min_estimate_cents: coerceNonNegInt(r.min_estimate_cents, DEFAULT_PORTFOLIO_ALERTS_CONFIG.min_estimate_cents),
  };
}

export interface AlertInputs {
  estimateCents: number | null;
  confidence: "high" | "medium" | "low" | "none";
  peakEstimateCents: number | null;
  lastAlertEstimateCents: number | null;
}

export type AlertKind = "peak" | "rise" | "drop";

export interface AlertVerdict {
  kind: AlertKind | null;
  /** Signed % change from the last-alerted value (null when there was none). */
  changePct: number | null;
  /** The new peak to persist (>= old peak), for the caller to store. */
  newPeakCents: number | null;
}

/**
 * Decide whether an item's valuation warrants an alert. PURE. A low/none
 * confidence or sub-threshold estimate never alerts (no crying wolf on a guess).
 * Precedence: a new all-time PEAK beats a plain move. A move is measured from the
 * last-alerted value so it fires once per meaningful step, not every run.
 */
export function detectValuationAlert(inputs: AlertInputs, config: PortfolioAlertConfig): AlertVerdict {
  const est = inputs.estimateCents;
  const none: AlertVerdict = { kind: null, changePct: null, newPeakCents: inputs.peakEstimateCents };
  if (est == null || est < config.min_estimate_cents) return none;
  if (inputs.confidence === "low" || inputs.confidence === "none") return none;

  const newPeak = Math.max(est, inputs.peakEstimateCents ?? 0);

  // New all-time high (strictly above the prior peak, and there WAS a prior peak
  // to beat — the first-ever valuation isn't a "peak" event).
  if (inputs.peakEstimateCents != null && est > inputs.peakEstimateCents) {
    return { kind: "peak", changePct: null, newPeakCents: newPeak };
  }

  // Significant move from the last-alerted value.
  if (inputs.lastAlertEstimateCents != null && inputs.lastAlertEstimateCents > 0) {
    const changePct = ((est - inputs.lastAlertEstimateCents) / inputs.lastAlertEstimateCents) * 100;
    if (Math.abs(changePct) >= config.move_threshold_pct) {
      return { kind: changePct > 0 ? "rise" : "drop", changePct, newPeakCents: newPeak };
    }
  }

  return { kind: null, changePct: null, newPeakCents: newPeak };
}

// ── best time to sell (pure guidance) ───────────────────────────────────────

export type SellGuidance = "sell_now" | "hold" | "watch" | "unknown";

/**
 * Turn the valuation trend + confidence + platform sell-through into a legible
 * suggestion. PURE. 'sell_now' when value is up on solid confidence and the
 * category moves quickly; 'hold' when trending up but slow; 'watch' when
 * declining; 'unknown' when we can't say. Never a guarantee.
 */
export function bestTimeToSell(input: {
  trend: "up" | "down" | "flat" | "unknown";
  confidence: "high" | "medium" | "low" | "none";
  medianDaysToSell: number | null;
}): SellGuidance {
  if (input.confidence === "none" || input.trend === "unknown") return "unknown";
  const sellsFast = input.medianDaysToSell != null && input.medianDaysToSell <= 30;
  if (input.trend === "up") {
    return input.confidence !== "low" && sellsFast ? "sell_now" : "hold";
  }
  if (input.trend === "down") return "watch";
  return "hold"; // flat
}
