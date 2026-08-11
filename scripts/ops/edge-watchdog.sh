#!/usr/bin/env bash
# US-2447: the edge-hang watchdog, in the repo.
#
# WHY THIS FILE EXISTS AT ALL. A script by this name is *believed* to run on the
# prod host at /opt/gradethread/edge-watchdog.sh, every minute, restarting the
# edge container when Docker marks it unhealthy. It has never been in version
# control. So on 2026-08-09, when the edge hung for at least ~8 minutes against
# a documented "~60s cap", nothing in a checkout could say whether the watchdog
# fired late, failed, or had stopped existing. From outside those three look
# identical, and the only thing that ever reports the answer is an outage.
#
# THE FAILURE MODE THIS GUARDS. `restart: unless-stopped` triggers on process
# EXIT. An edge hang is the opposite: the Deno main thread spins, the process
# stays alive, Docker marks the container unhealthy after three failed probes,
# Traefik pulls it from the pool and serves "no available server" — forever,
# because nothing ever exits. See vault/10-ops/edge-hang-vs-crash-loop.md.
#
# INSTALL (operator, on the host):
#   install -m 0755 edge-watchdog.sh /opt/gradethread/edge-watchdog.sh
#   # then, in `crontab -e`, EXACTLY this line — the schedule is part of the
#   # contract and scripts/ops/host-schedules.json is the copy a check reads:
#   * * * * * /opt/gradethread/edge-watchdog.sh >> /var/log/edge-watchdog.log 2>&1
#
# Safe to run by hand, and safe to run twice: it does nothing unless Docker
# itself reports the container unhealthy.

set -uo pipefail
# Deliberately NOT `set -e`. A watchdog that aborts on the first non-zero exit
# is a watchdog that stops watching the moment one docker call is slow. Every
# step below checks its own result.

CONTAINER="${EDGE_CONTAINER:-gradethread-edge}"
EDGE_URL="${EDGE_URL:-http://localhost:8787}"
# Seconds to wait for the heartbeat POST. Short on purpose: the heartbeat is
# best-effort telemetry and must never delay the restart it reports on.
HEARTBEAT_TIMEOUT="${WATCHDOG_HEARTBEAT_TIMEOUT:-5}"

log() { printf '%s edge-watchdog: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Docker's own verdict, not ours. `.State.Health.Status` is empty for a
# container with no healthcheck, which is a configuration problem rather than an
# unhealthy container — restarting on it would produce a reboot loop.
health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CONTAINER" 2>/dev/null)"
rc=$?

action="none"
if [ $rc -ne 0 ]; then
  log "docker inspect failed for '$CONTAINER' (rc=$rc) — not restarting anything"
  action="inspect_failed"
elif [ -z "$health" ]; then
  log "container '$CONTAINER' has no healthcheck; nothing to watch"
  action="no_healthcheck"
elif [ "$health" = "unhealthy" ]; then
  log "container '$CONTAINER' is unhealthy — restarting"
  if docker restart "$CONTAINER" >/dev/null 2>&1; then
    log "restart issued"
    action="restarted"
  else
    log "RESTART FAILED — the hang is not being capped; escalate"
    action="restart_failed"
  fi
else
  action="healthy"
fi

# The heartbeat. This is the half that makes the watchdog's ABSENCE visible
# without SSH: the edge records the last time it heard from this script, and
# /health/ready reports it as a feature, so the external uptime probe can say
# "no watchdog has checked in for an hour" during normal operation.
#
# It deliberately travels THROUGH the service being watched, and that limitation
# is the point rather than an oversight: a heartbeat cannot report during the
# very outage it exists to bound, because the endpoint is behind the same hung
# process. It answers the question this story is actually about — "is the
# watchdog still installed?" — which is a steady-state question.
if [ -n "${FLIPDESK_INTERNAL_JOB_SECRET:-}" ]; then
  curl -fsS --max-time "$HEARTBEAT_TIMEOUT" \
    -X POST "$EDGE_URL/api/jobs/watchdog-heartbeat" \
    -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"$action\",\"container\":\"$CONTAINER\"}" \
    >/dev/null 2>&1 || log "heartbeat POST failed (edge unreachable or secret rejected)"
else
  log "FLIPDESK_INTERNAL_JOB_SECRET unset — no heartbeat, so this watchdog is invisible to /health/ready"
fi

exit 0
