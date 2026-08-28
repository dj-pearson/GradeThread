---
title: Marketplace OAuth connector contract
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/depop-client.ts
  - services/edge-functions/src/lib/etsy-client.ts
  - services/edge-functions/src/lib/whatnot-client.ts
  - services/edge-functions/src/lib/crypto-aes.ts
  - services/edge-functions/src/lib/token-refresh-race.ts
  - services/edge-functions/src/lib/rewards-engine.ts
reviewed: 2026-08-28
tags: [marketplaces, oauth, contract, security]
summary: Every marketplace connector shares one kill-switch, PKCE, token-encryption and refresh shape; new connectors copy it rather than inventing one.
---

# Marketplace OAuth connector contract

Depop, Etsy and Whatnot each ship a client whose header re-derives the same
lifecycle. The shape is the contract; the per-marketplace deltas are small.
**A new connector implements this, then documents only what it does differently.**

## The six invariants

**1. A kill switch, defaulting to off.** Every connector gates on
`<MARKETPLACE>_ENABLED`. Until an operator flips it *and* supplies credentials,
every route returns **503**. There are no fake connect flows before partner
approval — a half-working OAuth screen for an unapproved integration is worse
than an honest 503, because it invites a seller to connect an account that
cannot list.

**2. PKCE through a single-use `oauth_states` row** (migration `00175`). The
state row is consumed on callback, so a replayed callback fails.

**3. Tokens are AES-GCM encrypted in `marketplace_connections`, AAD-bound to
`user_id`** (US-352). The AAD binding is what makes a ciphertext copied onto
another tenant's row fail to decrypt — see [[key-rotation]] for the rotation
procedure and the `v2:<keyId>:` format.

**4. Refresh happens inline AND on a shared cron.** Inline covers the active
seller; the cron covers the fleet so tokens do not expire while an account sits
idle.

That second half was **not true until 2026-08-03** (US-2322). All three sweeps
selected connections expiring within 24 hours and then called a getter that only
refreshed inside 60 seconds, so every run decrypted every active connection and
renewed none of them. The getters now take `refreshWithinMs` and the sweep passes
its own horizon. A new connector that copies the sweep must copy that too, or it
inherits a cron that looks like a safety net and is not one.

**4a. The refresh is single-flighted, and a lost race is not a lost grant.**
Etsy, Whatnot and Depop all ROTATE the refresh token — each refresh returns a new
one and every connector persists it. Two of our own callers refreshing at once
therefore produced an `invalid_grant` for the loser, which every connector
classified as PERMANENT — `is_active: false` and a reconnect message, i.e. the
seller disconnected by our own concurrency with nothing wrong with their account.

> [!warning] Two of three document that the OLD token dies (US-2322 AC4, 2026-08-17)
> This section, `token-refresh-race.ts` and its test all used to state as fact
> that all three invalidate the previous refresh token on first use. Two of the
> three say so in their own docs; Etsy does not say either way, and nobody had
> asked before this.
>
> - **Whatnot — CONFIRMED, from the vendor's own docs.** developers.whatnot.com
>   → Getting Started → Authentication: *"The used refresh token will be
>   invalidated, and you should store the newly returned Refresh Token."*
>   Refresh tokens expire in 1 year. So the race is real on Whatnot.
> - **Depop — CONFIRMED, and this entry read "UNDOCUMENTED" for a day.** That was
>   wrong, and how it was wrong is worth more than the correction. It rested on
>   the *Authentication* concepts page, which names a "long-lived Refresh Token"
>   and stops. The answer lives in a page nobody had enumerated — How to Guides →
>   *Using OAuth Refresh Tokens*: *"You receive a **new Refresh Token** with every
>   successful refresh request. The **previous Access Token and Refresh Token are
>   immediately invalidated** and cannot be used again."* The new token inherits
>   the grant's original expiry, 1 year from consent. Depop rotates strictly and
>   single-use, so the race is real there too.
>
>   **Read the vendor's section list before concluding silence.** Opening the page
>   whose title matches the question and stopping is how a documented fact becomes
>   an "undocumented" one — and an absence written into a contract note gets read
>   as evidence by everyone after you.
> - **Etsy — STILL UNDOCUMENTED**, and re-checked after the Depop miss rather than
>   left on the first reading. The authentication page describes a 90-day refresh
>   token and a new one on each refresh, and says nothing about the old one's
>   fate; its refresh section describes only how to use the new token. The closest
>   thing to an answer is Etsy staff in open-api discussion #1351 (*"Each time you
>   use your access_token, the API provides a new refresh token"* and *"You should
>   not have issues with your refresh_token after 24 hours of non-use"*) — neither
>   states whether the previous token is revoked. Community reports of
>   `invalid_grant` / *"refresh_token is revoked"* exist but do not separate
>   rotation from expiry or genuine revocation.
>
> **This changes severity, not correctness.** `siblingRefreshWon` makes the race
> survivable whichever way the remaining unknown falls, which is why the fix did
> not wait for this answer. Practically: on Whatnot and Depop the defence is
> load-bearing and confirmed; on Etsy it may be belt-and-braces. Do not delete it
> there on the strength of a doc that is silent — silence is not a guarantee, and
> a provider can start rotating strictly without telling anyone.
>
> Settling Etsy needs a partner answer or a deliberate two-refresh experiment on a
> real connection, neither of which is available from the repo.

Two defences, in `lib/token-refresh-race.ts`:

- `singleFlightRefresh` collapses concurrent refreshes for one connection inside
  a replica. A rejected refresh is **not** cached, so a transient provider 503
  does not become a disconnect for everyone waiting behind it.
- `siblingRefreshWon` makes the race harmless across replicas: before
  deactivating, re-read the row, and if a sibling stored a **different** and
  still-valid token, use theirs and leave the connection active.

A cross-replica advisory lock was considered and deliberately not built —
`job_locks` belongs to the cron fleet, and a lock only makes the race rarer while
the re-read makes it survivable. eBay is exempt from all of this: it does not
rotate its refresh token.

The fleet sweep is **bounded and ordered** (`TOKEN_REFRESH_SCAN_CAP = 5_000`,
`.order("token_expires_at", { ascending: true })`) in all three clients. The
ordering is the load-bearing half, not the cap: PostgREST silently truncates a
read at `db-max-rows` and reports it only in a `Content-Range` header that
supabase-js does not surface, so an *unordered* sweep would drop an arbitrary
subset every tick — and the same soon-to-expire token could fall outside the
window run after run. Ordered by expiry ascending, the cap can only ever drop
connections expiring **latest**, which the next tick picks up anyway. Any new
connector's sweep must copy both, or its failure mode is a seller's listings
going stale with nothing logged.

**5. Connection lifecycle only — the publish path still 503s.** Being able to
*connect* an account is not being able to *list* to it. These two ship
separately and the second is the larger piece of work.

**6. A new connection grants `marketplace_connected` exactly once** (US-1849).
Every connector calls `grantMarketplaceConnectedReward(userId, "<marketplace>",
account)` at the tail of its `upsert<Marketplace>Connection`, on the INSERT path
only — the reconnect path returns before it, so reconnecting cannot re-earn. The
helper dedupes on `<marketplace>:<account>` and is best-effort: a grant failure
is swallowed and logged, because a rewards outage must never fail an OAuth
callback. `rewards-engine_test.ts` source-scans all five clients (ebay, depop,
etsy, shopify, whatnot) and fails if one stops granting.

> [!note] "Exactly once" has a second exception since US-1915
> `grantReward` now checks the per-mechanic kill-switch first, so an operator
> who has switched `marketplace_connected` off makes the grant a **no-op** — not
> an error, and not a deferral. Nothing is queued and re-enabling does not
> backfill, because no `reputation_events` row was ever written. The connector
> side of this contract is unchanged: it still calls the helper on the INSERT
> path only, and still swallows failures. See [[reward-ledger]].

## Per-marketplace deltas

| Marketplace | Delta |
|---|---|
| **Etsy** | Requires an `x-api-key` header alongside the bearer token — the only one that does |
| **Whatnot** | Auth URLs and scopes are **MODELED, not documented** — there is no public spec, so they are informed guesses and may be wrong |
| **Depop** | The original of the pattern; publish routes return 501 pending partner approval |

The Whatnot caveat is worth reading before debugging an auth failure there: a
401 may mean the modelled URL is simply wrong rather than that the credentials
are bad.

## Related

- [[cross-listing]] — which marketplaces are reachable by API at all, and why
- [[key-rotation]] — `EDGE_ENCRYPTION_KEY` rotation for the tokens above
- [[ebay-condition-and-policies]] — eBay is the mature integration this generalises from
- [[adr-poshmark-via-extension]] — the marketplaces deliberately NOT given a connector
- [[reward-ledger]] — the one-ledger rule the connect grant writes through
