---
title: Edge hang versus edge crash-loop
aliases: [no available server, 503 functions, unhealthy not down]
type: runbook
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/main.ts
  - services/edge-functions/src/lib/lifecycle.ts
  - services/edge-functions/src/middleware/access-log.ts
  - scripts/ops/edge-watchdog.sh
  - scripts/ops/host-schedules.json
  - services/edge-functions/src/routes/jobs-watchdog-heartbeat.ts
reviewed: 2026-09-02
tags: [edge, incident, outage, ops]
summary: Two edge failure modes with opposite signatures — a dying process that restarts itself, and a live process that never will. Telling them apart is the whole job; the hang recurred 2026-08-09 and ran far longer than the watchdog is meant to allow.
---

# Edge hang versus edge crash-loop

> **Re-reviewed 2026-09-02.** Drift flagged `main.ts` for the cross-listing
> batch. All of it is route mounting -- new handlers and their middleware lines
> -- and nothing touches boot order, the health endpoints, or the top-level
> awaits this note is about. The hang-versus-crash signatures below are
> unchanged.


The edge service fails in two ways that look similar from the browser and behave
in **opposite** ways on the host. Diagnose which one you have before doing
anything else.

> [!note] There is a THIRD state, and it is not a failure: a deploy
> A routine deploy produces the same 503 in a browser. `installShutdownHandlers`
> (`lib/lifecycle.ts`) catches SIGTERM, stops claiming new work immediately, and
> drains in-flight requests for **8 seconds** (`SHUTDOWN_DRAIN_MS`) before
> exiting — inside Docker's 10s grace period, deliberately, because a drain that
> outlasts the grace window gets SIGKILLed having already stopped claiming.
>
> **Tell it apart by the clock and the log, not by the status code.** A drain
> emits `edge.shutdown_begin` then `edge.shutdown_end` with `drained` and
> `in_flight`, and it is over in under ten seconds. A hang logs *nothing at all*
> and does not end. If you are inside a minute of a deploy, wait before opening
> an incident.

| | Crash-loop | Hang |
|---|---|---|
| Process | exits repeatedly | **stays alive** |
| Docker | restarting | `Up … (unhealthy)` |
| `restart: unless-stopped` | fires | **never fires** (it triggers on exit) |
| Coolify UI | visibly churning | says **"running"** |
| Logs | a boot error each cycle | **nothing at all** |
| Browser | intermittent 502 | steady **503 "no available server"** |
| Duration | until fixed | until fixed (a DEPLOY's 503 clears in <10s) |

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
watchdog at `/opt/gradethread/edge-watchdog.sh` is *believed* to run every minute
and restart on unhealthy.

> [!warning] The ~60s cap is UNVERIFIED, and the one measurement we have
> contradicts it (US-2447 AC4)
> This paragraph used to state the cap as fact. It is not established.
>
> The single measured occurrence (below, 2026-08-09) ran **at least ~8 minutes**.
> Treat ~60s as a design intention, not a number to plan recovery against, until
> an operator has confirmed the script is present and induced an unhealthy
> container to time it. Anything downstream that assumes a one-minute ceiling —
> an SLO, a retry budget, a status-page promise — is resting on this sentence.

### The script is in the repo now, and it reports in (US-2447 AC3)

The sentence this section used to carry — *"nothing in the checkout can tell you
whether it is still installed"* — was true and is the reason the 2026-08-09
outage could not be explained. Three states looked identical from outside: the
watchdog fired late, the watchdog failed, the watchdog was uninstalled months
ago. The only thing that ever reported the answer was the next outage, which is
the moment nobody can go and look.

| Piece | Where |
|---|---|
| The script | `scripts/ops/edge-watchdog.sh` |
| Its schedule, as data | `scripts/ops/host-schedules.json` |
| Its check-in | `POST /api/jobs/watchdog-heartbeat` (job-secret gated) |
| What it reports as | `GET /health/ready` → `checks.features.hostWatchdog` |
| Who reads that | `scripts/ops/uptime-check.mjs`, from GitHub runners |

**Prod will report `unconfigured` until an operator installs it**, and that is
the correct output rather than a rollout wart: the true state today *is* unknown,
and an entry saying so is strictly better than the silence it replaces. Install
with `install -m 0755` to the path above plus the exact `crontabLine` in the
manifest; the script needs `FLIPDESK_INTERNAL_JOB_SECRET` in its environment or
it runs fine and stays invisible here.

> [!important] Measured 2026-08-12: prod reports `unconfigured`. No watchdog is
> checking in.
>
> `GET https://functions.gradethread.com/health/ready` returns, in `features`:
>
> ```
> hostWatchdog: "unconfigured: no host watchdog has ever checked in — an edge
> hang would not be capped (install scripts/ops/edge-watchdog.sh, US-2447)"
> ```
>
> So the answer is one of: the script is not on the host, it is on the host but
> not on cron, or it is running without `FLIPDESK_INTERNAL_JOB_SECRET`. All three
> mean the same thing operationally — **an edge hang is currently uncapped.**
>
> **This is AC1 answered from outside, which AC1 said was impossible.** Its
> wording — "from outside there is no way to distinguish a late watchdog from an
> absent one, so this cannot be inferred" — was true when it was written and was
> made false by AC3's own heartbeat. The distinction that remains genuinely
> unanswerable from outside is *late versus on time*; **absent versus installed**
> is now a single unauthenticated GET. Worth noting as a pattern: an AC that
> declares something unknowable is worth re-reading after the story ships the
> thing that makes it knowable.
>
> **It says nothing about 2026-08-09.** The heartbeat shipped after that
> incident, so "has ever checked in" means "since the heartbeat existed". It
> cannot retroactively establish whether the watchdog was installed during the
> outage below. It does make the *next* one diagnosable, which is the whole point.

**Two limits worth stating rather than discovering.** The heartbeat travels
*through* the service the watchdog protects, so it cannot report during the very
outage it exists to bound — it answers the steady-state question ("is the
watchdog still installed?"), which is the one that was unanswerable. And it still
does not verify the ~60s cap: that is a timing claim, and AC2 asks for it to be
proven by inducing an unhealthy container on a non-production copy, not by
reading a crontab.

The feature entry is informational and **cannot** fail readiness. Gating `ready`
on it would pull the edge — grading, payments, webhooks — out of rotation to
protest a missing safety net, causing the outage the net exists to shorten.

**The watchdog is a safety net, not a fix** — the spin itself is still unfixed.
Do not let its existence retire this note.

### What WOULD notice, independently of the watchdog (US-2447 AC5)

`.github/workflows/uptime.yml` runs `scripts/ops/uptime-check.mjs` against
`${EDGE_URL}/health/ready` from GitHub-hosted runners, and alerts through
`UPTIME_ALERT_WEBHOOK` plus a GitHub issue. That is genuinely independent: it
runs outside every piece of prod infrastructure, so a host that is wedged
entirely still gets caught.

**But it cannot validate a ~60s cap, and that is a cadence fact rather than a
bug.** It is scheduled `*/10 * * * *`, GitHub cron cannot go below five minutes,
and it is best-effort — a scheduled run can be late or dropped under load. So an
outage shorter than the poll interval is invisible to it by construction.

The practical consequence, which the 2026-08-09 table already shows: the early
symptom is `http=000` (a hang to timeout), not a 503. **A monitor that alerts
only on a bad status code misses the opening minutes.** `uptime-check.mjs`
treats a timeout as a failure, which is the right behaviour and worth not
regressing.

#### ⚠ 2026-08-09: it recurred, and the outage was far longer than 60s

A second dated occurrence, recorded because the numbers do not match what the
paragraph above promises. Measured from outside, against the public hostname —
no host access was involved, so this is what a caller sees:

| time (UTC) | observation |
|---|---|
| ~19:06 | `/health/ready` answers normally, `schema` reads `00577` |
| 19:19 | first failure: request hangs to a 25s timeout, `http=000` |
| 19:22 | `http=000` on `/health` **and** `/health/ready`; `gradethread.com` 200; `api.gradethread.com` 401 (i.e. answering) |
| 19:27 | fast **503** with body exactly `no available server`, TCP+TLS in ~30ms |
| 19:39 | back to 200, `schema` `00577` `match` |

**Two things worth carrying forward.**

1. **The early symptom was a TIMEOUT, not a 503.** The first probes returned
   `http=000` after hanging for the full curl timeout; only later did it settle
   into the clean fast 503 this note describes. So *"steady 503"* is the mature
   signature, not the first one — a monitor that only alerts on 503 can miss the
   opening minutes, and a human probing early sees a hang and may conclude the
   whole host is gone.
2. **The observed outage was at least ~8 minutes of confirmed failure**, inside a
   window bounded by healthy reads ~33 minutes apart. That is well beyond the
   ~60s the watchdog is supposed to cap it at. This note cannot say *why* — from
   outside there is no way to tell whether the watchdog fired late, did not fire,
   or is no longer installed, and **an operator should check that it is still
   present and on cron** rather than assume the cap holds.

The rest of the signature matched this note exactly: the marketing site and
Supabase stayed up throughout, so the funnel looked alive while grading, payments
and webhooks were dead — which is the failure mode the section above says cost
four weeks the first time.

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
