---
title: DNS and routing — api vs functions
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/main.ts
  - scripts/ops/edge-watchdog.sh
reviewed: 2026-08-21
tags: [ops, dns, edge, routing]
summary: Two hostnames serve two different systems; calling an app route on the Supabase host 404s silently.
---

# DNS and routing

> **Re-reviewed 2026-08-20.** Drift flagged `main.ts`, which changed to mount
> the US-2697 sold-sync intake and its auth + workspace middleware. That is a
> new ROUTE on the existing edge app, not a new hostname or a change to which
> host serves what - so the split this note exists to protect (`api.*` is Kong
> and Supabase routes only; every `/api/*` app route lives on `functions.*`)
> is untouched. Every mount added was under `/api/flipdesk/`, which is already
> on the right side of that line.

Two hostnames, two entirely separate systems. Mixing them up produces a **silent
404** rather than an error that explains itself, which is what makes this worth a
contract note.

| Host | System | Serves |
|---|---|---|
| `api.gradethread.com` | Supabase (self-hosted), fronted by Kong | **Only** Supabase routes — REST, auth, storage, realtime |
| `functions.gradethread.com` | Deno/Hono edge service on Coolify | **Every** `/api/*` route, without exception — 147 mounts across 34 prefixes as of 2026-08-17 |

The rule is the whole prefix, not a list. This row used to name five prefixes
(`grade`, `payments`, `webhooks`, `flipdesk`, `jobs`), which read as exhaustive
and was not: `/api/content/public` was added on 2026-08-16 and a reader checking
this table would have concluded content routes did not live on the edge. If you
need the current set, `grep -oE 'app\.route\("/api/[a-z/-]+"' services/edge-functions/src/main.ts`
answers it in a second and cannot go stale the way a copied list does.

> [!note] One `/api/jobs/*` endpoint is not called over the public host at all
> `/api/jobs/watchdog-heartbeat` (US-2447) is called by the host watchdog script
> from *inside* the box, so `scripts/ops/edge-watchdog.sh` defaults `EDGE_URL` to
> `http://localhost:8787`. That is deliberate: the watchdog must keep working
> when Traefik has pulled the backend out of the pool, which is precisely the
> state it exists to end. It is the one caller that should NOT be pointed at
> `functions.gradethread.com`.

## The failure mode

Requesting `/api/grade/...` against `api.gradethread.com` returns 404. Kong has no
such route and answers as though the endpoint does not exist — there is no hint
that the request reached the wrong service entirely. The same request against
`functions.gradethread.com` works.

This bites hardest in client config: one wrong base URL turns every edge call into
a 404 that reads like a deployment failure.

## Rules

- Frontend Supabase client → `api.gradethread.com` (via `VITE_SUPABASE_URL`).
- Anything hitting a Hono route → `functions.gradethread.com`.
- A new Hono route is reachable at `functions.*` only. Adding it does not make it
  available on `api.*`, and no Kong config will change that.

## Related

- [[INDEX]]
- Deploy order and rollback move here in US-2051.
