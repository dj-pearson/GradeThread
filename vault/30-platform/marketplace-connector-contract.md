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
reviewed: 2026-07-19
tags: [marketplaces, oauth, contract, security]
summary: Every marketplace connector shares one kill-switch, PKCE, token-encryption and refresh shape; new connectors copy it rather than inventing one.
---

# Marketplace OAuth connector contract

Depop, Etsy and Whatnot each ship a client whose header re-derives the same
lifecycle. The shape is the contract; the per-marketplace deltas are small.
**A new connector implements this, then documents only what it does differently.**

## The five invariants

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

**5. Connection lifecycle only — the publish path still 503s.** Being able to
*connect* an account is not being able to *list* to it. These two ship
separately and the second is the larger piece of work.

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
