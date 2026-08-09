---
title: Edge hang versus edge crash-loop
aliases: [no available server, 503 functions, unhealthy not down]
type: runbook
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/main.ts
  - services/edge-functions/src/middleware/access-log.ts
reviewed: 2026-08-09
tags: [edge, incident, outage, ops]
summary: Two edge failure modes with opposite signatures — a dying process that restarts itself, and a live process that never will. Telling them apart is the whole job.
---

# Edge hang versus edge crash-loop

The edge service fails in two ways that look similar from the browser and behave
in **opposite** ways on the host. Diagnose which one you have before doing
anything else.

| | Crash-loop | Hang |
|---|---|---|
| Process | exits repeatedly | **stays alive** |
| Docker | restarting | `Up … (unhealthy)` |
| `restart: unless-stopped` | fires | **never fires** (it triggers on exit) |
| Coolify UI | visibly churning | says **"running"** |
| Logs | a boot error each cycle | **nothing at all** |
| Browser | intermittent 502 | steady **503 "no available server"** |

## The hang: alive, unhealthy, and removed from the load balancer

**"no available server" is Traefik's message, not ours.** It means Traefik has
removed the backend, which happens after Docker marks the container unhealthy on
three failed probes. The container is still running — so nothing restarts it,
and the outage is indefinite.

Root cause on 2026-07-20: the Deno **main thread hung in a synchronous JS spin**.
The signature is `state=R`, `wchan=0`, `syscall=running`, CPU burn equal to the
hang duration, **zero errors logged**, and RSS/swap/OOM all normal.

### Why this note exists at all

This ran for roughly **four weeks** and was read as a traction problem. Sentry
held 559 × HTTP 503 across 10 users and 425 × `Failed to fetch
(functions.gradethread.com)`. The marketing site and Supabase stay up during an
edge hang, so the funnel looks alive while the product is dead — and paid ads
running in that window measured a broken funnel.

**Check health, not status. Test the public hostname, not a local URL.** A
`docker exec … curl localhost:8787/health` returning `000` is the confirmation.

Confirming the spin from the host (SSH details in [[deploy]] — they are not
repeated here):

```bash
docker ps                      # expect "Up … (unhealthy)"
ps -o pcpu,stat -p <deno_pid>  # expect state R and CPU pinned
cat /proc/<pid>/task/*/stat    # per-thread jiffies: one thread eating them all
```

### Recovery and the safety net

`docker restart <container>` brings it back in about 15 seconds. A host cron
watchdog at `/opt/gradethread/edge-watchdog.sh` runs every minute and restarts on
unhealthy, capping the outage at ~60s.

**The watchdog is a safety net, not a fix** — the spin itself is still unfixed.
Do not let its existence retire this note.

### Finding the culprit route

Since the access-log middleware landed, the request that blocked the loop is
identifiable: it is the **last `http.request.start` with no matching
`http.request` completion**. Correlate on `correlationId`.

## The crash-loop: a detached rejection is fatal

Deno treats an **unhandled promise rejection as fatal**. That is the trap,
because a rejection can escape a `try/catch` that looks complete.

The worked example: `denomailer`'s SMTP client runs an internal connection
read-loop that rejects **independently of the awaited `send()`/`close()`** when
the far end drops the socket mid-protocol. `deliverEmail`'s try/catch only covers
the awaited call, so the detached rejection escaped, killed the process, and
Coolify restarted it. Since every completed grade fires a best-effort lifecycle
email, any SMTP hiccup took the whole container down and killed in-flight grades.

`main.ts` now installs global `unhandledrejection` and `error` handlers **before
`Deno.serve`** that `preventDefault()`, log, and `captureException`.

> **A long-running server must never die from a detached best-effort task.**

Note what the guard does and does not do: a failing SMTP config still fails to
deliver mail (it retries through the outbox). The guard only stops that failure
from being fatal.

The other crash-loop cause is a boot-time schema assertion — see
[[edge-runtime-invariants]] for why that guard has a grace window.

## Related

- [[incident-response]] — the surrounding on-call procedure
- [[edge-runtime-invariants]] — replicas, deploy ordering, the boot schema guard
- [[uptime-monitoring]] — the synthetic checks that should catch an unhealthy backend
- [[dns-and-routing]] — why `functions.` and `api.` fail differently
- [[moc-ops]]
