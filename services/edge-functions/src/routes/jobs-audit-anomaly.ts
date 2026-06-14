// US-905: scheduled audit-log anomaly scan.
//
// Pulls the last window of admin_audit_log rows and runs the configurable
// detectors (lib/audit-anomaly.ts) against thresholds read from the settings
// registry (deploy-free retuning). Fresh findings are upserted into
// admin_audit_anomalies (idempotent via dedupe_key — a re-run inside the same
// hour refreshes count/evidence rather than duplicating, and the ops alert
// fires once per window), an ops alert is dispatched (webhook + email, reusing
// the MONITOR_ALERT_* channels), and a SYSTEM audit row records the scan.
//
// Mounted in main.ts as POST /api/jobs/audit-anomaly-scan, OUTSIDE the /api/*
// JWT groups; the handler enforces X-Internal-Job-Secret itself (same pattern
// as the other Coolify crons). The /api/jobs/* middleware records the run in
// the cron-run ledger.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { getSetting } from "../lib/system-settings.ts";
import { writeSystemAuditLog } from "../lib/audit-log.ts";
import { sendAuditAnomalyAlertEmail } from "../lib/email.ts";
import { captureException, recordMetric } from "../lib/observability.ts";
import { fetchWithTimeout } from "../lib/circuit-breaker.ts";
import {
  type AnomalyConfig,
  type AnomalyFinding,
  type AuditRowLite,
  detectAnomalies,
} from "../lib/audit-anomaly.ts";

// Look back a bit further than one hour so an entry written near the window
// edge isn't missed, while keeping the row pull bounded.
const WINDOW_HOURS = 1;
const LOOKBACK_MS = (WINDOW_HOURS + 0.25) * 60 * 60 * 1000;
const ROW_CAP = 5000;

const DETECTOR_LABEL: Record<string, string> = {
  role_change_burst: "Burst of admin role changes",
  mass_refund: "Mass refund / credit activity",
  off_hours_destructive: "Off-hours destructive actions",
};

async function loadConfig(): Promise<AnomalyConfig> {
  const [enabled, roleChanges, refunds, bhStart, bhEnd] = await Promise.all([
    getSetting<boolean>("audit_anomaly_enabled", true),
    getSetting<number>("audit_anomaly_role_changes_per_hour", 5),
    getSetting<number>("audit_anomaly_refunds_per_hour", 10),
    getSetting<number>("audit_anomaly_business_hours_start", 7),
    getSetting<number>("audit_anomaly_business_hours_end", 20),
  ]);
  return {
    enabled,
    roleChangesPerHour: roleChanges,
    refundsPerHour: refunds,
    businessHoursStart: bhStart,
    businessHoursEnd: bhEnd,
  };
}

// Resolve an actor id → "Name <email>" label for the alert; best-effort.
async function actorLabel(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const { data } = await supabaseAdmin
    .from("users")
    .select("full_name, email")
    .eq("id", userId)
    .maybeSingle();
  const u = data as { full_name?: string | null; email?: string | null } | null;
  if (!u) return userId;
  return u.full_name || u.email || userId;
}

// Dispatch an ops alert via webhook + email. Returns true if ≥1 channel
// delivered. Reuses the shared MONITOR_ALERT_* channels (same as the AI-budget
// and ops-health alerts) so an existing ops setup just works.
async function dispatchAnomalyAlert(
  f: AnomalyFinding,
  label: string | null,
): Promise<boolean> {
  const summary = `${DETECTOR_LABEL[f.detector] ?? f.detector}: ` +
    `${f.eventCount} action(s) in window ${String(f.evidence.window ?? "")}` +
    (label ? ` by ${label}` : " (platform-wide)");
  const to = Deno.env.get("AUDIT_ALERT_EMAIL") ||
    Deno.env.get("MONITOR_ALERT_EMAIL") ||
    Deno.env.get("SMTP_ADMIN_EMAIL") || "";
  const webhook = Deno.env.get("AUDIT_ALERT_WEBHOOK")?.trim() ||
    Deno.env.get("MONITOR_ALERT_WEBHOOK")?.trim() || "";

  let delivered = 0;

  if (to) {
    try {
      const ok = await sendAuditAnomalyAlertEmail(to, {
        detector: f.detector,
        severity: f.severity,
        eventCount: f.eventCount,
        window: String(f.evidence.window ?? ""),
        actorLabel: label,
        summary: DETECTOR_LABEL[f.detector] ?? f.detector,
      });
      if (ok) delivered += 1;
    } catch (err) {
      captureException(err, { route: "audit-anomaly.alert.email", tags: { detector: f.detector } });
    }
  }

  if (webhook) {
    try {
      const res = await fetchWithTimeout(
        webhook,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `[GradeThread audit anomaly] ${summary}`,
            summary,
            severity: f.severity,
            detector: f.detector,
            event_count: f.eventCount,
          }),
        },
        5000,
      );
      if (res.ok) delivered += 1;
      else {
        captureException(
          new Error(`audit-anomaly alert webhook returned ${res.status}`),
          { route: "audit-anomaly.alert.webhook", tags: { detector: f.detector } },
        );
      }
      await res.body?.cancel();
    } catch (err) {
      captureException(err, { route: "audit-anomaly.alert.webhook", tags: { detector: f.detector } });
    }
  }

  if (delivered === 0) {
    recordMetric("audit_anomaly.alert_undelivered", 1, { detector: f.detector });
    captureException(
      new Error(
        `audit-anomaly raised "${f.detector}" but NO alert channel was ` +
          `configured/reachable — set AUDIT_ALERT_EMAIL/WEBHOOK or MONITOR_ALERT_*`,
      ),
      { level: "warn", route: "audit-anomaly.alert", tags: { detector: f.detector } },
    );
  }
  return delivered > 0;
}

// Upsert a finding. Returns {isNew} — only a NEW finding (first time we've seen
// this dedupe_key) triggers an alert, so an hourly re-run doesn't re-alert.
async function persistFinding(
  f: AnomalyFinding,
  nowIso: string,
): Promise<{ written: boolean; isNew: boolean }> {
  // Does an OPEN finding already exist for this dedupe window?
  const { data: existing } = await supabaseAdmin
    .from("admin_audit_anomalies")
    .select("id, alerted")
    .eq("dedupe_key", f.dedupeKey)
    .maybeSingle();
  const isNew = !existing;

  const { error } = await supabaseAdmin
    .from("admin_audit_anomalies")
    .upsert(
      {
        detector: f.detector,
        severity: f.severity,
        dedupe_key: f.dedupeKey,
        actor_user_id: f.actorUserId,
        event_count: f.eventCount,
        evidence: f.evidence,
        last_seen_at: nowIso,
      },
      { onConflict: "dedupe_key" },
    );
  if (error) {
    console.error(`[audit-anomaly] upsert failed for ${f.dedupeKey}:`, error.message);
    return { written: false, isNew };
  }
  return { written: true, isNew };
}

async function markAlerted(dedupeKey: string): Promise<void> {
  await supabaseAdmin
    .from("admin_audit_anomalies")
    .update({ alerted: true })
    .eq("dedupe_key", dedupeKey);
}

export async function handleAuditAnomalyCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const lock = await acquireJobLock("audit-anomaly-scan", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const cfg = await loadConfig();
    if (!cfg.enabled) {
      return c.json({ ok: true, skipped: true, reason: "disabled" });
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const sinceIso = new Date(nowMs - LOOKBACK_MS).toISOString();

    const { data: raw, error } = await supabaseAdmin
      .from("admin_audit_log")
      .select("id, admin_user_id, actor_role, action, target_type, created_at")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(ROW_CAP);
    if (error) {
      captureException(error, { level: "warn", route: "audit-anomaly.load" });
      return c.json({ error: "Failed to load audit rows" }, 500);
    }
    const rows = (raw ?? []) as AuditRowLite[];
    const truncated = rows.length >= ROW_CAP;

    const findings = detectAnomalies(rows, cfg, nowMs);

    let newCount = 0;
    let alertedCount = 0;
    for (const f of findings) {
      const { written, isNew } = await persistFinding(f, nowIso);
      if (!written) continue;
      if (!isNew) continue; // already flagged this window — don't re-alert
      newCount += 1;
      const label = await actorLabel(f.actorUserId);
      const delivered = await dispatchAnomalyAlert(f, label);
      if (delivered) {
        alertedCount += 1;
        await markAlerted(f.dedupeKey);
      }
      await writeSystemAuditLog({
        action: "audit_anomaly.flagged",
        targetType: "admin_audit_anomaly",
        targetId: null,
        details: {
          detector: f.detector,
          severity: f.severity,
          event_count: f.eventCount,
          alerted: delivered,
          dedupe_key: f.dedupeKey,
        },
      });
    }

    if (truncated) {
      console.warn("[audit-anomaly] row cap hit — window may be under-sampled");
    }
    return c.json({
      ok: true,
      scanned: rows.length,
      findings: findings.length,
      new: newCount,
      alerted: alertedCount,
      truncated,
    });
  } finally {
    await lock.release();
  }
}
