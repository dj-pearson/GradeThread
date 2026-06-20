// US-931: newsletter deliverability threshold evaluation (pure).
//
// The newsletter_analytics RPC returns raw program metrics; this maps them to
// deliverability flags + an overall status the dashboard renders and the
// enforcement path (admin-newsletter.ts) acts on. Kept pure (no supabase/env) so
// the route and its test share one source of truth and the test needs no DB.
//
// Thresholds default to industry deliverability norms but the bounce/complaint
// cutoffs are operator-tunable via the settings registry (seeded in 00278) and
// passed in here, so a deploy is never needed to retune them.

export interface DeliverabilityThresholds {
  /** complaints / sent above this is critical (default 0.1%). */
  complaintRate: number;
  /** bounces / sent above this is critical (default 2%). */
  bounceRate: number;
  /** unsubscribes / sent above this is a warning (default 0.5%). */
  unsubRate: number;
  /** open rate below this is a (low-engagement) warning (default 10%). */
  lowOpenRate: number;
}

export const DEFAULT_DELIVERABILITY_THRESHOLDS: DeliverabilityThresholds = {
  complaintRate: 0.001,
  bounceRate: 0.02,
  unsubRate: 0.005,
  lowOpenRate: 0.1,
};

export type DeliverabilitySeverity = "warning" | "critical";

export interface DeliverabilityFlag {
  metric: "complaintRate" | "bounceRate" | "unsubRate" | "openRate";
  severity: DeliverabilitySeverity;
  value: number;
  threshold: number;
  message: string;
}

/** The subset of program metrics the evaluation reads. */
export interface DeliverabilityMetrics {
  sent: number;
  openRate: number;
  bounceRate: number;
  complaintRate: number;
  unsubRate: number;
}

export interface DeliverabilityEvaluation {
  status: "ok" | "warning" | "critical";
  /** A bounce/complaint breach crossed its critical threshold. */
  shouldAutoPause: boolean;
  flags: DeliverabilityFlag[];
  thresholds: DeliverabilityThresholds;
}

const pct = (r: number) => `${(r * 100).toFixed(2)}%`;

/**
 * Evaluate program deliverability against the (tunable) thresholds. A bounce or
 * complaint breach is CRITICAL and sets shouldAutoPause; high unsub / low open
 * are WARNING only. With no sent volume there's nothing to judge (status 'ok').
 */
export function evaluateDeliverability(
  metrics: DeliverabilityMetrics,
  thresholds: DeliverabilityThresholds = DEFAULT_DELIVERABILITY_THRESHOLDS,
): DeliverabilityEvaluation {
  const flags: DeliverabilityFlag[] = [];

  if (metrics.sent <= 0) {
    return { status: "ok", shouldAutoPause: false, flags, thresholds };
  }

  if (metrics.complaintRate > thresholds.complaintRate) {
    flags.push({
      metric: "complaintRate",
      severity: "critical",
      value: metrics.complaintRate,
      threshold: thresholds.complaintRate,
      message:
        `Complaint rate ${pct(metrics.complaintRate)} exceeds ${pct(thresholds.complaintRate)} — sender reputation at risk.`,
    });
  }

  if (metrics.bounceRate > thresholds.bounceRate) {
    flags.push({
      metric: "bounceRate",
      severity: "critical",
      value: metrics.bounceRate,
      threshold: thresholds.bounceRate,
      message:
        `Bounce rate ${pct(metrics.bounceRate)} exceeds ${pct(thresholds.bounceRate)} — clean the list before the next send.`,
    });
  }

  if (metrics.unsubRate > thresholds.unsubRate) {
    flags.push({
      metric: "unsubRate",
      severity: "warning",
      value: metrics.unsubRate,
      threshold: thresholds.unsubRate,
      message:
        `Unsubscribe rate ${pct(metrics.unsubRate)} exceeds ${pct(thresholds.unsubRate)} — content/frequency may be off.`,
    });
  }

  if (metrics.openRate < thresholds.lowOpenRate) {
    flags.push({
      metric: "openRate",
      severity: "warning",
      value: metrics.openRate,
      threshold: thresholds.lowOpenRate,
      message:
        `Open rate ${pct(metrics.openRate)} is below ${pct(thresholds.lowOpenRate)} — subject lines/deliverability may be suffering.`,
    });
  }

  const hasCritical = flags.some((f) => f.severity === "critical");
  const status: DeliverabilityEvaluation["status"] = hasCritical
    ? "critical"
    : flags.length > 0
    ? "warning"
    : "ok";

  return { status, shouldAutoPause: hasCritical, flags, thresholds };
}
