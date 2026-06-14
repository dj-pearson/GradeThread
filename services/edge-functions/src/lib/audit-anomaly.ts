// US-905: audit-log anomaly detection (pure logic).
//
// The scheduled scan (jobs-audit-anomaly.ts) pulls a window of admin_audit_log
// rows and runs these detectors against operator-configured thresholds. Keeping
// the classification + detection pure makes it unit-testable without a DB or a
// live clock — the job supplies the rows, the config, and the window bounds.
//
// Three configurable patterns:
//   • role_change_burst    — one admin makes >N role-change entries in the hour.
//   • mass_refund          — >N refund/credit entries platform-wide in the hour.
//   • off_hours_destructive — destructive actions outside business hours (UTC).

export interface AuditRowLite {
  id: string;
  admin_user_id: string | null;
  actor_role: string | null;
  action: string;
  target_type: string;
  created_at: string;
}

export interface AnomalyConfig {
  enabled: boolean;
  roleChangesPerHour: number;
  refundsPerHour: number;
  businessHoursStart: number; // UTC hour, inclusive (0-23)
  businessHoursEnd: number; // UTC hour, exclusive (0-23)
}

export interface AnomalyFinding {
  detector: "role_change_burst" | "mass_refund" | "off_hours_destructive";
  severity: "warning" | "critical";
  dedupeKey: string;
  actorUserId: string | null;
  eventCount: number;
  evidence: Record<string, unknown>;
}

// ── action classifiers ─────────────────────────────────────────────

export function isRoleChange(action: string): boolean {
  return action === "admin.change_role";
}

// Refund or credit grant/adjust — the money-movement actions a mass-refund
// fraud/compromise would produce. Matches the admin-billing.ts action names
// (admin.pack_refund, admin.refund_charge, admin.comp_credits,
// admin.credit_adjust, admin.bulk_comp_credits, admin.grade_refund_resolved).
export function isRefundOrCredit(action: string): boolean {
  return /refund|comp_credit|credit_adjust/i.test(action);
}

// Destructive / high-impact actions whose timing we care about. Deletes,
// cancels, refunds, suspensions, role changes, purges, revokes.
export function isDestructive(action: string): boolean {
  return /(?:^|[._])(delete|cancel|purge|wipe|revoke|suspend)/i.test(action) ||
    isRefundOrCredit(action) ||
    isRoleChange(action);
}

// UTC hour 0-23 of an ISO timestamp.
function utcHour(iso: string): number {
  return new Date(iso).getUTCHours();
}

export function isOffHours(iso: string, cfg: AnomalyConfig): boolean {
  const h = utcHour(iso);
  // Normal window is [start, end). Anything before start or at/after end is
  // off-hours. A degenerate/over-wide config (start>=end) treats everything as
  // off-hours, which is intentional fail-loud rather than silently never firing.
  return h < cfg.businessHoursStart || h >= cfg.businessHoursEnd;
}

// Stable per-window bucket key: the UTC hour the window falls in. The cron runs
// hourly, so this keys one finding per detector per hour — a re-run inside the
// same hour refreshes rather than duplicates.
export function hourBucket(windowEndMs: number): string {
  const d = new Date(windowEndMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  return `${y}${m}${day}T${h}`;
}

// ── detection ───────────────────────────────────────────────────────

export function detectAnomalies(
  rows: AuditRowLite[],
  cfg: AnomalyConfig,
  windowEndMs: number,
): AnomalyFinding[] {
  if (!cfg.enabled) return [];
  const findings: AnomalyFinding[] = [];
  const bucket = hourBucket(windowEndMs);

  // 1. Role-change burst per acting admin.
  const roleByActor = new Map<string, AuditRowLite[]>();
  for (const r of rows) {
    if (!isRoleChange(r.action) || !r.admin_user_id) continue;
    const list = roleByActor.get(r.admin_user_id) ?? [];
    list.push(r);
    roleByActor.set(r.admin_user_id, list);
  }
  for (const [actor, list] of roleByActor) {
    if (list.length > cfg.roleChangesPerHour) {
      findings.push({
        detector: "role_change_burst",
        severity: "critical",
        dedupeKey: `role_change_burst:${actor}:${bucket}`,
        actorUserId: actor,
        eventCount: list.length,
        evidence: {
          threshold: cfg.roleChangesPerHour,
          window: bucket,
          sample_audit_ids: list.slice(0, 20).map((r) => r.id),
        },
      });
    }
  }

  // 2. Mass refunds / credit grants platform-wide.
  const refunds = rows.filter((r) => isRefundOrCredit(r.action));
  if (refunds.length > cfg.refundsPerHour) {
    const actors = [
      ...new Set(refunds.map((r) => r.admin_user_id).filter((x): x is string => !!x)),
    ];
    findings.push({
      detector: "mass_refund",
      severity: "critical",
      dedupeKey: `mass_refund:${bucket}`,
      actorUserId: actors.length === 1 ? actors[0]! : null,
      eventCount: refunds.length,
      evidence: {
        threshold: cfg.refundsPerHour,
        window: bucket,
        distinct_actors: actors.length,
        sample_audit_ids: refunds.slice(0, 20).map((r) => r.id),
      },
    });
  }

  // 3. Off-hours destructive actions (aggregated for the window).
  const offHours = rows.filter(
    (r) => isDestructive(r.action) && isOffHours(r.created_at, cfg),
  );
  if (offHours.length > 0) {
    const actors = [
      ...new Set(offHours.map((r) => r.admin_user_id).filter((x): x is string => !!x)),
    ];
    findings.push({
      detector: "off_hours_destructive",
      severity: "warning",
      dedupeKey: `off_hours_destructive:${bucket}`,
      actorUserId: actors.length === 1 ? actors[0]! : null,
      eventCount: offHours.length,
      evidence: {
        business_hours_utc: `${cfg.businessHoursStart}:00-${cfg.businessHoursEnd}:00`,
        window: bucket,
        actions: [...new Set(offHours.map((r) => r.action))].slice(0, 20),
        sample_audit_ids: offHours.slice(0, 20).map((r) => r.id),
      },
    });
  }

  return findings;
}
