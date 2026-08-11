// US-2447: the host hang-watchdog checks in here.
//
// `/opt/gradethread/edge-watchdog.sh` (source of truth: scripts/ops/edge-watchdog.sh)
// runs every minute and is the ONLY thing that ends an edge hang — Docker's
// `restart: unless-stopped` fires on process exit, and a hang never exits. It
// has always lived only on the host, so nothing in a checkout could tell whether
// it was still installed and the only report of its absence was the next outage.
// On 2026-08-09 an outage ran at least ~8 minutes against a documented ~60s cap
// with no way to say whether the watchdog fired late, failed, or was gone.
//
// This endpoint records the last time it was heard from. /health/ready serves
// that as `checks.features.hostWatchdog`, so the external uptime probe — which
// runs on GitHub's infrastructure, outside everything it checks — can report a
// missing watchdog during NORMAL operation instead of during an incident.
//
// THE LIMITATION IS DELIBERATE AND WORTH STATING. The heartbeat travels through
// the very service the watchdog protects, so it cannot report during the outage
// it exists to bound. It answers a steady-state question ("is the watchdog still
// installed?"), which is the question that was unanswerable. A monitor that
// catches the outage itself already exists and is independent: uptime.yml.
//
// Mounted as POST /api/jobs/watchdog-heartbeat, OUTSIDE the /api/* JWT groups,
// gated by X-Internal-Job-Secret like every other cron entrypoint.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { logEvent } from "../lib/observability.ts";

/** system_settings key holding the epoch-ms of the last heartbeat. */
export const WATCHDOG_HEARTBEAT_KEY = "ops.edge_watchdog_last_seen";

/** Actions the script reports. Anything else is recorded as "unknown". */
const KNOWN_ACTIONS = new Set([
  "healthy",
  "restarted",
  "restart_failed",
  "inspect_failed",
  "no_healthcheck",
  "none",
]);

export async function watchdogHeartbeatHandler(c: Context) {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let action = "unknown";
  let container: string | null = null;
  try {
    const body = await c.req.json();
    if (typeof body?.action === "string" && KNOWN_ACTIONS.has(body.action)) {
      action = body.action;
    }
    if (typeof body?.container === "string") container = body.container.slice(0, 120);
  } catch {
    // A body-less heartbeat still counts. The timestamp is the payload that
    // matters; refusing one over a malformed body would mean a watchdog that IS
    // running reports as absent, which is the failure this endpoint exists to
    // stop reporting falsely in either direction.
  }

  const nowMs = Date.now();
  const { error } = await supabaseAdmin.from("system_settings").upsert(
    {
      key: WATCHDOG_HEARTBEAT_KEY,
      value: nowMs,
      value_type: "number",
      default_value: 0,
      description:
        "US-2447 epoch-ms of the last host edge-watchdog check-in. Served as " +
        "/health/ready checks.features.hostWatchdog. Written only by " +
        "POST /api/jobs/watchdog-heartbeat.",
      category: "ops",
    },
    { onConflict: "key" },
  );
  if (error) {
    logEvent("error", "watchdog.heartbeat_write_failed", { message: error.message });
    return c.json({ error: "Could not record heartbeat" }, 500);
  }

  // A restart is the watchdog doing its job, which means an outage just
  // happened and nothing else logs it — the container it restarted lost its own
  // logs to the restart. Record it at warn so it shows up in a search for
  // "why was there a gap at 19:22".
  if (action === "restarted" || action === "restart_failed") {
    logEvent("warn", "watchdog.container_restart", { action, container });
  }

  return c.json({ ok: true, recordedAt: nowMs, action });
}
