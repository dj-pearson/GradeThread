---
title: "ADR: no server-side marketplace automation, ever"
type: decision
status: accepted
source_of_truth: vault
code_refs: []
reviewed: 2026-08-10
tags: [decision, marketplaces, extension, security, competitive]
summary: GradeThread servers never hold a marketplace password or session cookie for a no-API channel and never solve a CAPTCHA; the cost is that extension channels need the seller's browser open, which US-2481 softens rather than removes.
---

# ADR: no server-side marketplace automation, ever

> **Decision: every no-API marketplace action runs in the seller's own browser,
> in the seller's own session. GradeThread's servers never hold a marketplace
> password or session cookie, and GradeThread never solves or bypasses a CAPTCHA.
> This is a bright line, not a default. It costs us a feature competitors
> advertise, and we pay that cost knowingly.**

Established by US-2476, inside the US-2472 marketplace-coverage epic. Extends
[[adr-poshmark-via-extension]], which made the same call for one marketplace
(Poshmark, via US-715) before there was competitive pressure to reverse it. This
note generalises it to every channel and states the price.

---

## 1. Why this ADR exists at all

The earlier decision was easy: Poshmark had no API, the alternative was an
enterprise Rithum seat we could not afford, and nobody was asking us to do
otherwise. That is not the situation now.

We are closing a coverage gap against three competitors, and one of them —
**Nifty** — sells exactly the thing this ADR refuses. A contributor under
pressure to match a feature list will find the cloud-session model sitting
there, obviously cheaper to build than a content script per marketplace, and
already proven in-market. The decision needs to be written down **with its cost
stated** so that reversing it requires arguing against the cost, not just
noticing the gap.

An ADR that only lists the upside of the choice we made is not a decision
record. It is a rationalisation, and it does not survive contact with a
deadline.

---

## 2. The three competitor models

| | **Crosslist** | **Vendoo** | **Nifty** |
|---|---|---|---|
| How it reaches no-API channels | Browser extension + official APIs where they exist | Browser extension | **Cloud-run sessions on their servers** |
| What the seller hands over | Nothing. Actions run in their tab. | Nothing. Actions run in their tab. | **Marketplace login, stored and replayed server-side** |
| Seller's browser must be open | Yes | Yes | **No — that is the product** |
| Who is the actor if a marketplace objects | The seller, automating their own account | The seller | **The vendor, operating the seller's account** |
| EU coverage | Does not serve EU customers | Partial | Partial |
| Engagement automation (share/follow/offer) | Limited | Limited | **Headline feature, ~$25/mo** |

The important row is the fourth one. In the extension model the seller is a
person automating their own account in their own browser — the thing every
marketplace's terms tolerate in practice even where they discourage it. In the
cloud model the vendor is operating an account it does not own, from
infrastructure the marketplace can identify, using credentials it was handed.
Those are different legal positions, not different implementations of one
position.

---

## 3. What we reject, and why

### 3.1 We do not store marketplace credentials or session cookies

**Not for Poshmark, Mercari, Grailed, Vinted, Facebook Marketplace, or any
future no-API channel.**

- **It makes GradeThread the actor.** Every marketplace's terms forbid access
  by "automated means or an interface not provided by us". A seller automating
  their own account is a seller with an account problem. GradeThread replaying
  stored cookies from a datacentre is GradeThread with a CFAA problem, a
  breach-of-contract problem, and — if any access control was worked around —
  a DMCA §1201 problem.
- **It turns one breach into every seller's breach.** A credential store for
  five marketplaces across the whole customer base is a target with no
  compensating benefit. Today there is nothing to steal, because there is
  nothing stored: the extension has no `cookies` permission and cannot read one
  even on the machine where the session lives.
- **It cannot be made honest to a seller.** Our whole trust position — the same
  one that lets us grade a garment and have anyone believe the number — is that
  we say what we actually do. "We hold your Poshmark login on our servers" is
  not a sentence a seller reads and feels better about, so the cloud model
  arrives with a disclosure problem that never goes away.
- **It is fragile in the way that costs the seller, not us.** Server-side
  sessions get flagged and banned; the seller loses the account, we lose a
  support ticket.

### 3.2 We do not solve, bypass, or outsource CAPTCHAs

No GradeThread code, and no third-party service GradeThread pays, attempts a
CAPTCHA. When a run hits one, the run **pauses and tells the seller to finish it
themselves**.

This is a separate line from 3.1 and is drawn separately on purpose. A CAPTCHA
is a marketplace explicitly saying "prove a human is here." Answering it
programmatically is not a grey area about automation policy — it is
circumventing an access control, which is where the legal exposure stops being
theoretical. It stays refused even in the extension model, where the seller's
own browser is doing the work.

---

## 4. The cost we accept

**Extension channels require the seller's desktop browser to be open.** That is
a real gap, it is the gap Nifty sells against, and pretending otherwise is how
this decision gets reversed later by someone who discovers the gap on their own.

Concretely, what a seller gives up:

- Cross-listing to Poshmark/Mercari/Grailed/Vinted/Facebook cannot happen while
  they are sourcing at a thrift store with only a phone.
- A delist after a sale on another channel waits until the browser next opens.
  Between the sale and the drain, the item is live in two places.
- Share and follow runs are bounded by desktop time.

**US-2481 addresses this and deliberately does not remove it.** The seller
queues work from mobile; the desktop extension drains the queue the next time
it is open. The server holds *what to do* — an item id, an action, a target
channel — and never a credential, so the bright line in §3.1 is intact. The
mobile UI states plainly that the work runs when the desktop browser next
opens, because telling a seller a job is done when it is queued would trade the
honesty this whole ADR is protecting for a nicer-looking screen.

What we do **not** accept as a fix: a headless browser in our cloud that the
seller "logs into once". That is §3.1 with extra steps.

---

## 5. Where the line is enforced

The bright lines are not self-enforcing prose. They hold because:

- The extension manifest requests **no `cookies` permission** and is not
  host-permitted on `gradethread.com`, so it structurally cannot read a
  marketplace cookie or GradeThread's own auth state.
- No edge route accepts a marketplace password or cookie for an extension-tier
  channel. `services/edge-functions/src/lib/cross-listing-sale.ts` resolves
  those platforms to `DelistMethod 'extension'` — a queue entry, not a call.
- `src/lib/__tests__/marketplace-mechanism.test.ts` pins every advertised
  channel to a mechanism that actually exists, so a channel cannot be quietly
  promoted to a server-side claim.
- Per-channel disclosure copy (US-2475) is generated from
  `MARKETPLACE_MECHANISM` and unit-tested for completeness, so a new platform
  cannot ship without an on-screen risk statement.

---

## 6. What would have to change for this to be reopened

Not "a competitor has it" and not "a customer asked". Reopen only if:

- A marketplace publishes a **sanctioned server-side write API** (or a
  sanctioned partner programme) for the channel in question — in which case the
  channel stops being a §3 case entirely and becomes an API-tier integration,
  the way Depop and Etsy did.
- Or a marketplace publishes explicit written permission for a third party to
  operate a seller's account from its own infrastructure.

Neither of those is a reversal of this ADR. They are the ADR working: the line
is about acting *without* sanction, not about server-side integration as such.

| Field | Value |
|---|---|
| Decision date | 2026-08-10 |
| Decision | **Extension-only for no-API channels; no stored credentials; no CAPTCHA solving** |
| Story | US-2476 (epic US-2472) |
| Supersedes | Nothing — extends [[adr-poshmark-via-extension]] to every channel |
| Re-evaluation trigger | A sanctioned write API or written operator permission from the marketplace |

## Related

- [[adr-poshmark-via-extension]] — the same call for one marketplace, made before the pressure existed
- [[closing-a-coverage-gap]] — the repeatable process this ADR constrains
- [[cross-listing]] — the channel-reach model
- [[INDEX]]
