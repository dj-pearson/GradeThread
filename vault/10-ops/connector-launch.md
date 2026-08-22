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
  - services/edge-functions/src/routes/health.ts
reviewed: 2026-08-22
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
| `MCP_ENABLED` | `/mcp` itself. Off means **404**, not 503 — an endpoint that is not open should not advertise that it is coming. That 404 is *inside* the route handler and is **not observable from outside** (see step 1); read `features.connector` on `/health/ready` instead. | off in production |
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
# Did the flag actually reach the container? THIS is the question /mcp cannot
# answer — see the warning below. `live` means serving; `off:` names the switch.
curl -sS https://functions.gradethread.com/health/ready | jq .features.connector
```

> [!warning] `/mcp` cannot tell you whether the flag landed (US-2687)
> This step used to read "404 before, 200-shaped JSON-RPC after", and treated a
> 404 as proof the flag had not reached the container. **You will never see that
> 404 from outside.** `main.ts` mounts `mcpAuthMiddleware` *before*
> `app.route("/mcp", mcpRoutes)`, while the kill switch's 404 lives inside the
> route handler — so an unauthenticated call is answered 401 by the middleware
> before the kill switch is ever consulted. Dark and live are indistinguishable
> at that endpoint.
>
> Following the old instruction, you would flip `MCP_ENABLED`, get a 401, read
> it as "correct — unauthenticated callers get a challenge", and move to step 2
> with the connector still dark. That is why the readiness field exists: it
> reports both switches, and it distinguishes *three* states, because
> `isFeatureEnabled` fails OPEN and a missing rule would otherwise read as
> "live".

Then the endpoint itself, which is still worth calling — just not as evidence
about the flag:

```bash
curl -sS -X POST https://functions.gradethread.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' -i | head -20
```

- **401 with a `WWW-Authenticate: Bearer` header** — expected, in both states.
  Read `features.connector` above for the one you are actually in.
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
>
> Since US-2687 there is a probe that needs no key at all:
> `curl -sS .../health/ready | jq .features.connector` names which switch is
> off, or reports `live`. Use it to confirm the toggle landed, then the
> authenticated `tools/list` to confirm what a caller actually gets.

### The slower one: the env vars


Set either flag to `false` and redeploy. Nothing is left half-open: both gates
return 404 rather than an error, tokens already issued stop resolving the moment
`/mcp` is closed, and no data is written that needs unwinding. Existing grants
survive a flag round-trip, so turning it back on does not force everyone to
reconnect.

## Launch copy, ready to paste

Written now rather than at launch, because copy written in a hurry on the day is
copy nobody reviewed. Both of these are DATA — they go in through the admin
consoles, not through a deploy.

### The changelog entry (US-9127 AC2)

**Admin → Changelog → New entry.** Category **feature**, audience **flipdesk**,
status **draft** until the flags are on.

> **Title:** Run your store from a conversation with Claude
>
> **Summary:** Connect GradeThread to Claude and ask for what you want: what is
> unlisted, what a jacket should sell for, drafts written for today's haul, a
> listing published. On Pro and Business.
>
> **Body:**
>
> GradeThread now works inside Claude. Connect it once and you can ask for
> things instead of clicking through them:
>
> - "What did I photograph yesterday that still is not listed?"
> - "Write listings for everything I graded this morning."
> - "What should the Carhartt jacket be priced at?"
> - "Put it live."
>
> **Nothing that costs money or reaches a marketplace happens without you saying
> yes.** Grading, publishing, repricing and ending listings all show you exactly
> what will happen first — the items, the prices, what eBay takes — and then wait.
> If a price changes between showing you and you agreeing, it asks again.
>
> There are limits it will not cross even when you do say yes. It will not move a
> price more than 25%, and it will not price anything below what you paid for it.
> Those belong in FlipDesk, where you are looking at the listing.
>
> Included on **Pro** (500 actions a month) and **Business** (2,000). Reading
> costs nothing and is not counted. You can try the sample tools on any plan,
> including Free, before deciding.
>
> Setup and the full tool list: [gradethread.com/developers](https://gradethread.com/developers).
> Disconnect any time from Settings → API keys.

### The five support macros (US-9127 AC3)

**"I cannot connect it."**

> Two things to check first. The connector is on Pro and Business — if you are on
> Free or Starter you will get as far as the sign-in and then be told the plan
> does not include it. And if you are pasting the URL by hand, it is
> `https://functions.gradethread.com/mcp` exactly, with no trailing slash.
>
> If you are using Claude Code and the browser never comes back, tell us and we
> will check the redirect on our side — that one is ours, not yours.

**"Claude says it does not have the tool."**

> That is almost always one of two things. Either the connection was made
> read-only — on the approval screen there is a switch for grading, listing and
> pricing, and if it was left off the connector genuinely cannot do those. Or the
> plan does not include the connector.
>
> Disconnect it in Settings → API keys and connect again, leaving all the
> switches on. Nothing is lost by reconnecting.

**"It refused to publish."**

> It will say why, and the reason is usually fixable in a minute — a missing
> item specific eBay requires, no business policies set up, or the eBay
> connection needing a refresh.
>
> One case looks like a refusal and is not: if you approved a publish and then
> changed the price, the approval stops being valid on purpose. Ask Claude to
> show you the listing again and approve the new numbers. That is the connector
> protecting you from publishing at a price you did not see.

**"It says I have hit a limit."**

> There are two, and they are different. A short one — 20 publishes an hour, 50
> price changes, 20 listings ended — which is there to stop a runaway loop and
> clears within the hour. And a monthly one: 500 actions on Pro, 2,000 on
> Business, resetting on the 1st.
>
> Reading never counts against either. If you are hitting the monthly one
> regularly, Business is the fix and we can prorate the upgrade.

**"How do I turn it off?"**

> Settings → API keys → Connected applications → Disconnect. It stops
> immediately, not at the end of the day, and any access it was given stops
> working the moment you press it.
>
> Every action it ever took is in your account's audit log; ask us if you want to
> see it.

## Directory policy re-check (US-9127 AC6)

Run **2026-08-19**, against the 27 registered tools. Re-run it before submitting,
because the answer is a property of the code and the code moves.

```bash
# The list this was run against:
cd services/edge-functions && node -e "
const fs=require('fs');
const files=fs.readdirSync('src/lib').filter(f=>f.startsWith('mcp-')&&f.endsWith('.ts'));
const all=[];
for(const f of files){
  const s=fs.readFileSync('src/lib/'+f,'utf8');
  for(const m of s.matchAll(/name: \"(gradethread_[a-z_]+)\"/g)) all.push(m[1]);
}
console.log(all.sort().join('\n'));
"
```

### "Transferring financial assets" — the named violation

**No connector tool creates a charge, and none returns a payment URL.** Checked
rather than assumed:

- `grade-billing.ts`'s `runPaymentPrecedence` has three outcomes: included
  monthly grade, credit debit, or `checkoutRequired`.
- The connector's grading path handles that third outcome by **refusing** —
  "Payment required for {tier} grade — not enough grading credits. Buy a credit
  pack or upgrade your plan." It does not open a checkout and it does not charge.
- That is **stronger than the shape US-9127 anticipated.** The story expected the
  tool to return a Stripe checkout URL; it returns a refusal with instructions
  instead, which leaves the payment entirely outside the conversation.

The only value that moves is a debit against a pre-purchased credit balance
inside our own system — ordinary metered usage, the same shape as an API call
consuming quota, not a transfer between parties.

> **What must stay true.** If a tool is ever given a checkout URL to return, that
> is a change to re-check against the policy before it ships, not a convenience.
> If one is ever given the ability to charge directly, the connector is no longer
> submittable.

### The rest of the surface

- **No tool sends email, SMS or any outbound message.** Nothing in the registry
  reaches a messaging path.
- **No tool reads or writes another tenant's data.** Every one is scoped on the
  authenticated tenant, with a cross-tenant case in the isolation lane and a
  guard that refuses to let a tool ship without one.
- **No tool returns credentials.** The audit redactor drops anything
  credential-shaped rather than summarising it, and tool results pass through
  `sanitizeDeep` before they leave.
- **The three sandbox tools touch no account data at all** — asserted by a test
  that reads their import list as a whitelist, so a future edit cannot quietly
  give them a database client.

### For the reviewer account (AC5)

An empty account and an account full of real customer records are both named
rejection causes. Seed one with SAMPLE inventory: a handful of items with photos,
one or two graded, one draft listing, no live listings and no real buyer data.
The sandbox tools work on any plan, but a reviewer will want to see the real ones
answer, so the account needs **Pro or Business**.

## What is NOT yet decided

The copy above is written and reviewable. What US-9127 still owns is work that
needs a person with production access, an Anthropic org, or a lawyer:

- **Publishing** the changelog entry and loading the macros (both are admin-UI
  data, both are above, ready to paste).
- **Counsel review of the legal copy** (AC4). The documents themselves are
  written and shipped: `privacy.tsx` §5 covers where connector data goes,
  `terms.tsx` §8 covers who is answerable for what the connector does, and the
  AUP gained one bullet against scripting a client to approve its own
  confirmations. All three are **agent-drafted and nobody has reviewed them**,
  which is recorded with the claims most worth a lawyer's eye in
  [[subscription-copy-review-register]]. The sourced claim to re-read first if
  Anthropic's terms move: the Messages API MCP connector is not eligible for
  zero-data-retention, so tool definitions and results are retained under
  standard policy.
- **One open drafting decision:** the OAuth consent screen links to neither the
  Terms nor the AUP. The browser extension's clickwrap does link out, and that
  link is why the AUP has a section about it at all. Whether an approval screen
  granting write access to a seller's store needs the same is a call, not a bug.
- **Directory submission** (AC5) — needs a Team or Enterprise org, an Owner
  role, a production HTTPS URL, and a test account holding SAMPLE data and no
  production records. An empty or real-data reviewer account is a named
  rejection cause.

AC6, the policy re-check, is **done** and its result is the section above:
no connector tool creates a charge and none returns a payment URL. That is a
thing to keep true, not a thing to decide.

## Related

- [[connector-plan-gating]] — which plans get it and what the allowance is.
- [[deploy]] — the DB → edge → frontend order these flags sit inside.
- `vault/30-platform/claude-connector.md` — the protocol research: the dual-era
  requirement, the redirect rules, and what the directory review checks.
