---
title: Turning QuickBooks Online on
type: runbook
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/lib/qbo-client.ts
  - services/edge-functions/src/routes/qbo.ts
  - services/edge-functions/src/lib/env-validation.ts
reviewed: 2026-09-07
tags: [ops, quickbooks, connector, finance]
summary: The four env vars, the Intuit-side setup they have to match, and how to prove the connector is live - the code has been complete since US-2997/US-2998 and is switched off only because these are unset.
---

# Turning QuickBooks Online on

**The code is done and has been since US-2997 and US-2998.** OAuth with refresh,
the account mapping, the one-way push, the sync log, the reconnect wording and
the hourly token sweep all shipped. The connector is off for exactly one reason:
`QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` and `QBO_REDIRECT_URI` are unset on the
edge, so `qboConfigured()` is false and every `/api/flipdesk/qbo/*` route answers
**503** with "QuickBooks is not switched on for this server."

Nothing in this runbook can be done from a dev box. It needs an Intuit developer
account and the Coolify edge environment, both of which are the owner's.

## The contract, in one line

The direction is **GradeThread to QuickBooks, one way, forever**. Two-way sync
between two systems that both think they own a transaction is how books get
corrupted, and the UI says which direction it runs. See
[[books-and-taxes]] for what actually gets pushed and why the ledger, not the
sales table, is the source.

## 1. The Intuit app

At <https://developer.intuit.com>, create an app with the **Accounting** scope
(`com.intuit.quickbooks.accounting`). That is the only scope requested and it is
the only one the push needs.

Note the client id and client secret. **Sandbox and production keys are
different pairs**, and so are the company files behind them: nothing falls back
from one to the other, and the environment is stored on the connection row
precisely so a seller can see which one they are connected to.

## 2. The redirect URI, which is the step that goes wrong

Add this to the Intuit app's redirect URIs, character for character:

```
https://functions.gradethread.com/api/flipdesk/qbo/oauth/callback
```

**`functions.`, not `api.`** — `api.gradethread.com` is Kong and hosts only
Supabase routes, so every Hono path 404s there ([[dns-and-routing]]).

It must match what you put in `QBO_REDIRECT_URI` **exactly**: scheme, host, path,
and the presence or absence of a trailing slash. Intuit's rejection does not say
which part is wrong, so a mismatch reads as a generic consent failure and can
cost an afternoon.

## 3. The four env vars, on the EDGE service in Coolify

| Var | Value |
|---|---|
| `QBO_CLIENT_ID` | from the Intuit app |
| `QBO_CLIENT_SECRET` | from the Intuit app; sent as HTTP Basic on every token call |
| `QBO_REDIRECT_URI` | the URL above, matching Intuit character for character |
| `QBO_ENVIRONMENT` | `production`, or `sandbox` while testing |

The first three are a **feature group** (`quickbooks`) in
`env-validation.ts`. `QBO_ENVIRONMENT` is deliberately outside it: it defaults to
`production`, and requiring it would report a correctly configured connector as
broken. Full table in [[env-reference]].

Frontend and edge deploy separately, and this is edge-only — see
[[deploy]]. Redeploy the edge after setting them; the vars are read at call time
but the container has to restart to see them.

## 4. Prove it, rather than assuming it

```bash
# The feature group, without signing in. This is the only check that says
# whether the CONTAINER can see the vars, which is the actual question.
curl -s https://functions.gradethread.com/health/ready | jq '.features.quickbooks'
```

Then, signed in, the status route reports both halves:

```bash
# configured:true is the env; connected:false until somebody runs the consent
# flow. environment says which company file a sync would reach.
curl -s -H "Authorization: Bearer $TOKEN" \
  https://functions.gradethread.com/api/flipdesk/qbo/status
```

Finally, connect one account from **Money → Tax & filing → QuickBooks**, map the
accounts, and push. The mapping is saved before anything is pushed on purpose: a
sale that lands in the wrong QBO account is a mess an accountant unpicks by hand
with no undo, so an unmapped account blocks its own documents and nothing else.

## 5. The cron that keeps it connected

`qbo-token-refresh`, hourly (`0 * * * *`), `POST /api/flipdesk/qbo/oauth/refresh`
with `X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET`. It is in the Coolify
cron list already ([[launch-checklist]]); confirm it is enabled.

It is not optional in practice. An access token lasts an hour and a live request
refreshes it on demand, so a busy seller stays connected without it. **The
refresh token is the reason it exists: it lasts 100 days and rolls on every
refresh.** A seller who does not sync for a quarter comes back to a dead
connection, and the sweep is what clears `is_active` and writes the reconnect
wording where the status card reads it, instead of failing quietly once an hour
for ever.

## Rolling back

Unset the three vars and redeploy. Every route returns to 503 and the card says
the connector is not switched on. Existing `qbo_connections` rows are untouched,
so setting the vars again restores the connections without a re-consent — until
their refresh tokens age out.

## Related

- [[books-and-taxes]] — what is pushed, the mapping, and the idempotency rules.
- [[env-reference]] — every env var, including these four.
- [[dns-and-routing]] — why the redirect URI is on `functions.`, not `api.`.
- [[deploy]] — the edge deploys on its own.
