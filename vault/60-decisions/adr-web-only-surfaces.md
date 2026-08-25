---
title: "ADR: Rewards, MeasureCard and Developers stay web-only"
type: decision
status: accepted
source_of_truth: vault
code_refs:
  - src/lib/surfaces.ts
reviewed: 2026-08-25
tags: [decision, ios, parity, rewards, measurecard, api]
summary: Three web surfaces are not built on iOS and the registry now says why; the story that raised this named four and two of its four already exist on iOS, so the measured gap is three and it includes one the story missed.
---

# ADR: Rewards, MeasureCard and Developers stay web-only

> **Decision: Rewards, MeasureCard and Developers are not built on iOS. The
> surface registry records `onlyReason` for each, so the gap is a decision in
> code rather than a silence. The Tools-hub rows that link them out are
> deliberately NOT part of this decision — see §4.**

Established by US-2879, inside the US-2856 "make GradeThread teachable" epic.
The mirror of [[adr-prospect-stays-phone-only]], which made the same kind of
call pointing the other way.

---

## 1. The story's list was wrong, and the correction matters

US-2879 named four web surfaces with no iOS equivalent: Rewards, MeasureCard,
Offers & Messages, and the in-app help reader. Measured on 2026-08-25 by
walking every `struct …View: View` under `ios/GradeThread` and checking each is
referenced from another file:

| Surface | Story said | Actually |
|---|---|---|
| Rewards | missing | **missing** |
| MeasureCard | missing | **missing** |
| Offers & Messages | missing | present — `Marketplaces/Negotiation/NegotiationInboxView.swift`, 666 lines, reachable from `MarketplacesView` and three places in `ContentView` |
| In-app help reader | missing | present — `Help/HelpSheet.swift`, built by US-2874 after this story was filed |
| Developers (API keys + sandbox) | not mentioned | **missing** |

So the real answer is **three**, and one of them is a surface the story did not
name.

**Why the story got it wrong is the useful part.** The registry's `ios` field is
the *Tools hub route*. `ios: null` means "not a row in the Tools hub", and
US-2876's comment on that field said it meant "iOS does not have this at all".
Eleven surfaces sit outside the hub. Reading `ios: null` as absence
over-reported the gap by a factor of four.

That is fixed: `iosElsewhere` now names the Swift file for each of those
eleven, and the guard checks the file exists.

## 2. The three, and why each stays web-only

**Rewards** (US-1851 — level, quarterly season track, earned credit). A screen
for reading a number you earned somewhere else. Nothing on it is an action.
Checking your level is a now-and-then thing, and a phone-sized copy of it would
be a second surface to keep in step for a payoff measured in glances.

**MeasureCard** (US-1579). Three things: a printable PDF, instructions for
shooting with the card, and a postal address form for a card we mail once.
A PDF download is worse on a phone. A postal address form is worse on a phone.
And the mailed-card request is a once-ever action per seller.

**Developers** (US-2554 — API keys and the grading sandbox). You use these
while writing code, which is not a phone activity. There is also a second
reason worth stating plainly: **an API key on a phone screen is a secret held
up in public.** A laptop in a café is not private either, but it is not a
device people hand across a table.

## 3. What the registry does now

Every genuinely single-client surface carries an `onlyReason`. Both directions
— Prospect's iOS-only reason lives in the same field, rather than a second
`webOnly` field that would have drifted from it.

`src/test/web-only-surfaces.test.ts` fails if a single-client surface has no
reason. A gap with no reason is indistinguishable from a gap nobody noticed,
and that ambiguity is what this closes: the next person either builds something
that was deliberately not built, or leaves unbuilt something that was simply
forgotten.

## 4. What this ADR deliberately does NOT decide

US-2879's AC2 asks for a row in the iOS Tools hub for each of these, opening
the surface **in an authenticated web view, not a cold Safari tab that asks
the user to sign in again.**

That is not built, and the reason is not reluctance:

**There is no authenticated web handoff in this product.** Nothing anywhere
takes an iOS session and produces a web session. `ASWebAuthenticationSession`
appears in `Marketplaces/EbayConnectionService.swift`, but that is eBay's OAuth
flow, not ours. `WKWebView` appears in `Auth/TurnstileView.swift`, for a
CAPTCHA widget. Neither signs a seller into gradethread.com.

Building one means minting a web session from a phone session: a one-time
token, an edge endpoint to issue it, a web route to redeem it, expiry, replay
protection, and a table to hold it. That is a security-sensitive feature with
its own migration, not a row in a list. It is filed as its own story rather
than smuggled into this one.

Until it exists, a Tools-hub row for these three would either lie (a cold
Safari tab that asks for a login is exactly what AC2 forbids) or need the
handoff first. The decision above stands on its own; the rows wait.

## 5. Related

- [[adr-prospect-stays-phone-only]] — the same call in the other direction, and
  where `PhoneOnlyRow` came from.
- The surface registry (`src/lib/surfaces.ts`, US-2876) is where these reasons
  live and where the drift was found.
