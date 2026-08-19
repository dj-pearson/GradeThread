---
title: Turning the Claude connector on, and proving it works
aliases: [MCP_ENABLED, MCP_OAUTH_ENABLED, connector launch, US-9123, US-9127]
type: runbook
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/routes/mcp.ts
  - services/edge-functions/src/lib/oauth-metadata.ts
  - services/edge-functions/src/middleware/mcp-auth.ts
  - services/edge-functions/src/routes/oauth.ts
reviewed: 2026-08-19
tags: [ops, connector, launch, runbook]
summary: The two flags that gate the connector, the order to flip them in, and the checks that prove each step before the next one.
---

# Turning the connector on

> Everything the connector needs is built and tested. It is dark in production
> behind two environment variables, on purpose. This is the order to open it in,
> and what to check after each step — each check is a thing you can see, not a
> thing you assume.

## The two flags

| Variable | What it opens | Default |
|---|---|---|
| `MCP_ENABLED` | `/mcp` itself. Off means **404**, not 503 — an endpoint that is not open should not advertise that it is coming. | off in production |
| `MCP_OAUTH_ENABLED` | `/oauth/*`, `/api/oauth/*` and both discovery documents. Off means **404** on all of them. | off |

Both live in Coolify's environment for the edge service. Neither needs a
migration; the schema they use is already applied (00619, 00620).

They are separate on purpose. `MCP_ENABLED` alone gives you a working connector
for **API-key** callers, which is the whole flow minus the browser sign-in. That
is the smaller, safer thing to open first.

## Order, and why

### 1. `MCP_ENABLED=true`, OAuth still off

Opens `/mcp` to anyone holding a GradeThread API key on Pro or Business.

**Check, in this order:**

```bash
# 404 before, 200-shaped JSON-RPC after. An unauthenticated call must still 401.
curl -sS -X POST https://functions.gradethread.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' -i | head -20
```

- **401 with a `WWW-Authenticate: Bearer` header** — correct. Unauthenticated
  callers get a challenge, not a tool list.
- **404** — the flag has not reached the running container. Redeploy, do not
  keep flipping.
- **A tool list with no credential** — stop. That is the one outcome that means
  something is wrong, and it means the auth middleware is not mounted.

Then with a real Pro-plan API key, `tools/list` should return the read tools and
the sandbox tools, and a Free-plan key should get the sandbox tools only once it
calls one — the plan gate is in the dispatcher, not in the listing, so a free
seller SEES the full list and is refused on the paid ones. That is deliberate:
an empty list is not an answer to "should I upgrade".

### 2. `MCP_OAUTH_ENABLED=true`

Opens the browser sign-in flow. Do this only after step 1 answers.

**Check:**

```bash
curl -sS https://functions.gradethread.com/.well-known/oauth-protected-resource | head
curl -sS https://functions.gradethread.com/.well-known/oauth-authorization-server | head
```

Both must return JSON. The second must advertise
`"code_challenge_methods_supported": ["S256"]` and no `plain` — Anthropic's
connector review checks for exactly that.

Then the real thing, which is US-9123:

## US-9123: verifying against real clients

Three clients, and they exercise different halves. Do all three; passing one
does not predict the others.

### Claude Code (the loopback-redirect path)

```bash
claude mcp add --transport http gradethread https://functions.gradethread.com/mcp
```

It opens a browser, you sign in, you land on `/connect/claude`, you approve.

**What to watch for:**
- The consent screen names the CLIENT by its host, lists the scopes in plain
  words, and lets you switch `submit` off.
- Turning `submit` off and connecting anyway must work, and the connection must
  then refuse a publish.
- Claude Code redirects to `http://localhost:<a port it picks>`. If that is
  rejected, the loopback exemption in `isAllowedRedirectUri` has regressed and
  the connector cannot be added from a terminal at all.

### claude.ai (the hosted-callback path)

**Settings → Connectors → Add custom connector**, paste
`https://functions.gradethread.com/mcp`.

This one comes back to `https://claude.ai/api/mcp/auth_callback`, a fixed URL,
so it exercises the exact-match branch rather than the loopback one.

### The Messages API connector (the LEGACY era)

This is the one most likely to surprise you: Anthropic's own API connector still
speaks the **2025-11-25** handshake — `initialize`, `Mcp-Session-Id`, the lot.
The server is dual-era for exactly this reason. If it fails while the other two
pass, the problem is era detection, not authorization.

## The checks that matter, whichever client

Run these as a seller, in a conversation, and read the answers rather than the
status codes:

1. **"What is unlisted from last week?"** — a read. Should just work.
2. **"Grade the Carhartt jacket."** — must PREVIEW first, name the cost, and
   wait. If anything is graded on the first call, stop and file it.
3. **On a modern client, that preview should also raise a real yes/no prompt.**
   Answering no must refuse, and must not be retried.
4. **"Publish it."** — must show title, price, quantity and eBay's cut before
   doing anything. Then change the price in FlipDesk and confirm the OLD
   confirmation: it must be refused, telling you to preview again.
5. **"Drop everything 60%."** — must be REFUSED even if you confirm. Anything
   over 25% is not something the connector will do on its own.
6. **Disconnect it** from Settings → API keys, then ask it to do anything. It
   must fail immediately, not at the end of the hour.

Check 6 is the one people skip and the one that matters most. Revocation that
takes effect "eventually" is not revocation.

## Rolling back

### The stop button: the `claude_connector` feature flag

**Admin → Feature flags → `claude_connector` → off.** Every replica closes
`/mcp` within the 30-second flag cache TTL, with no deploy. That is the
rollback plan; the env var below is the slower one.

Verified end to end on 2026-08-19 against a seeded stack: an authenticated
`tools/list` went **200 → 404 → 200** across a flag toggle and back, inside
the TTL each way.

> ⚠ **Do not test it the way I first did.** An UNAUTHENTICATED probe returns
> **401**, not 404, whether the connector is on or off — the auth middleware
> runs before the gate, so an anonymous caller gets a credential challenge
> either way. This is pre-existing and shared with `MCP_ENABLED`. Test with a
> real API key, or you will conclude the switch is broken when it is working.

### The slower one: the env vars


Set either flag to `false` and redeploy. Nothing is left half-open: both gates
return 404 rather than an error, tokens already issued stop resolving the moment
`/mcp` is closed, and no data is written that needs unwinding. Existing grants
survive a flag round-trip, so turning it back on does not force everyone to
reconnect.

## What is NOT yet decided

`US-9127` still owns the launch copy, the changelog entry, the support macros
and the directory submission. This runbook covers only making it work; making it
findable is that story's.

## Related

- [[connector-plan-gating]] — which plans get it and what the allowance is.
- [[deploy]] — the DB → edge → frontend order these flags sit inside.
- `vault/30-platform/claude-connector.md` — the protocol research: the dual-era
  requirement, the redirect rules, and what the directory review checks.
