// Periodic DB integrity scan (US-504).
//
// Calls the data_integrity_scan() RPC (migration 00097) and reports any anomaly
// class with a non-zero count to the error tracker + metrics, so orphans /
// drift / stuck rows surface instead of silently accumulating.

import { supabaseAdmin } from "./supabase.ts";
import { requireJobSecret } from "./job-auth.ts";
import { acquireJobLock } from "./job-lock.ts";
import { captureException, logEvent, recordMetric } from "./observability.ts";
import { recordCertificateIntegrityShare } from "./cert-integrity-backfill.ts";

export interface IntegrityAnomaly {
  anomaly: string;
  count: number;
}

export async function runIntegrityScan(): Promise<IntegrityAnomaly[]> {
  const { data, error } = await supabaseAdmin.rpc("data_integrity_scan");
  if (error) {
    captureException(error, { route: "integrity-scan.rpc" });
    throw new Error(`integrity scan failed: ${error.message}`);
  }
  const rows = ((data ?? []) as Array<{ anomaly: string; count: number }>).map((r) => ({
    anomaly: r.anomaly,
    count: Number(r.count),
  }));
  const anomalies = rows.filter((r) => r.count > 0);
  for (const a of anomalies) {
    recordMetric("integrity.anomaly", a.count, { anomaly: a.anomaly });
  }
  if (anomalies.length > 0) {
    captureException(
      new Error(`Data integrity scan found anomalies: ${anomalies.map((a) => `${a.anomaly}=${a.count}`).join(", ")}`),
      { level: "warn", route: "integrity-scan" },
    );
  } else {
    logEvent("info", "integrity.clean", {});
  }
  return anomalies;
}

export async function handleIntegrityScanCron(c: {
  req: { header: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("integrity-scan", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const anomalies = await runIntegrityScan();
    // US-490: ride the same recurring tick to track the signed / hash-only /
    // unverifiable certificate share. Best-effort — a count failure is reported
    // but must not fail the anomaly scan that already ran.
    let certificates = null;
    try {
      certificates = await recordCertificateIntegrityShare();
    } catch (err) {
      captureException(err, { route: "integrity-scan.cert-share" });
    }
    return c.json({ ok: true, anomalies, certificates });
  } catch (err) {
    captureException(err, { route: "integrity-scan.cron" });
    return c.json({ error: "Integrity scan failed" }, 500);
  } finally {
    await lock.release();
  }
}
