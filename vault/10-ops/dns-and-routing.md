---
title: DNS and routing — api vs functions
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/main.ts
reviewed: 2026-07-19
tags: [ops, dns, edge, routing]
summary: Two hostnames serve two different systems; calling an app route on the Supabase host 404s silently.
---

# DNS and routing

Two hostnames, two entirely separate systems. Mixing them up produces a **silent
404** rather than an error that explains itself, which is what makes this worth a
contract note.

| Host | System | Serves |
|---|---|---|
| `api.gradethread.com` | Supabase (self-hosted), fronted by Kong | **Only** Supabase routes — REST, auth, storage, realtime |
| `functions.gradethread.com` | Deno/Hono edge service on Coolify | **All** Hono routes: `/api/grade/*`, `/api/payments/*`, `/api/webhooks/*`, `/api/flipdesk/*` |

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
