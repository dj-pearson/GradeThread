---
title: Thrift Radar — crowdsourced sourcing intelligence
type: contract
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/routes/flipdesk-scout.ts
  - services/edge-functions/src/lib/scout-decision.ts
  - src/pages/flipdesk/scout.tsx
reviewed: 2026-08-07
tags: [radar, flipdesk, scout, privacy, consent, contract]
summary: Radar turns Prospect scans into venue-level supply intelligence; contribution and viewing are separate consents, no precise coordinate survives venue resolution, and the k-anonymity floor is a server-side guarantee rather than a display preference.
---

# Thrift Radar — crowdsourced sourcing intelligence

Radar is the network layer over the existing Prospect scan: every in-field scan
already carries brand, an estimated grade and a buy/pass verdict
([[grading-scale-and-weights]] for the grade, `lib/scout-decision.ts` for the
verdict), so adding **where** turns a private tool into a live map of secondhand
supply. Epic US-1860; built by US-1861…US-1867.

This note is the part that is a **rule** rather than a plan. The stories describe
what to build; what follows constrains how, and does not expire when they close.

## The eight rules

**1. Two consents, never one.** Viewing Radar and contributing to Radar are
separate decisions. Opening the map must never enrol the viewer as a contributor,
and the contribution toggle must be reachable and revocable without giving up the
map. A single "Radar" switch collapses a read into a write and is refused.

**2. Contribution is opt-in and defaults OFF.** On every client. A scan emits a
Radar event only while the toggle reads true; revoking stops emission and drops
anything still batched on the device — the same corollary
[[extension-telemetry-consent]] arrived at, for the same reason: a later opt-in
must not ship activity from the period the user said no to.

**3. Never widen an existing toggle to cover Radar.** Location is a new kind of
data, so it gets a new toggle, new storage key and new lines in the privacy
policy and the iOS App Privacy declarations. Folding it under an existing
insights/telemetry switch makes a sentence someone already read become false,
retroactively. This is [[extension-telemetry-consent]] rule 1 applied to a second
surface, and it is the rule most likely to be "optimised away" by a story that
just wants a scan to carry a lat/lng.

**4. No precise coordinate survives venue resolution.** Coordinates exist for
exactly one purpose — picking the venue — and the analytical row keeps the
`venue_id` (or, while unresolved, a coarse geohash cell), never the raw fix. A
retained coordinate trail is a movement history of a named person, which is a
different product from the one anyone consented to.

**5. The contributor key is rotating and de-identified.** The analytical path
carries no readable `user_id`. Use the salted-digest approach
[[garment-passport-privacy]] already established (`minimizeLinkageRef()`, salt
from env) with rotation, so contributions can be counted as distinct without
being re-joined to a person or followed across windows.

**6. The k-anonymity floor is enforced server-side.** A venue × window aggregate
is served only above K distinct contributors (configurable, default 3). Below the
floor the endpoint returns nothing — not a redacted payload the client is trusted
to hide. K is a privacy guarantee, so lowering it is a policy change, not a
tuning knob, and a below-floor venue needs a test proving the response is empty.
The UI's honest empty state ("not enough data here yet") is a consequence of the
server's silence, not a substitute for it.

**7. The personal layer is free, opt-in-independent, and must work at n=1.** A
user's own sourcing history per venue is their own data: it requires no
contribution consent, is available on every plan, and must be useful with zero
network data anywhere near them. This is the cold-start answer — a Radar that is
blank until strangers show up never gets the strangers. Network layers (map
hotness, venue detail, route planner) are Pro+, gated at the aggregates endpoint
and not only in the UI; see [[buyer-platform]] for why an advertised allowance
nothing reads is decoration.

**8. Contribution is fire-and-forget.** A Radar write that fails, times out or is
rate-limited must never slow or degrade the scan result the user is standing
there waiting for. The scan is the product; Radar is a by-product.

## What the code looks like today

`POST /api/flipdesk/scout/prospect` accepts **photos and a cost, and no location
at all**. That matters for sequencing: Radar's first commit is the one that adds
a coordinate to a request that never had one, so the consent gate, the
"coordinates are not retained" promise and the toggle all have to land in that
same change. There is no earlier point where the data is already flowing and the
privacy work can be retrofitted quietly.

Every scout route is already tenant-scoped the standard way
(`c.get("workspaceOwnerId") ?? c.get("userId")`, US-268) — the personal layer
inherits that and needs its own `tenant-isolation_test.ts` cases.

## Two traps specific to these tables

- `radar_scan_events` deliberately has **no `user_id` column**, which makes it
  invisible to `rls-guard_test.ts`'s discovery regex. A deny-all table nothing
  looks at passes by never being examined, and a later commit could drop its RLS
  with nothing going red — so register it in **both** `SERVICE_ROLE_ONLY` and
  `SERVICE_ONLY_FORCED`. Full rule: [[service-role-tables]].
- Retention pruning and the rollup are the only things that keep rule 4 true over
  time. An aggregate that is recomputable from retained raw events is a raw event
  store wearing a rollup's name.

## Related

- [[extension-telemetry-consent]] — the consent rules Radar inherits, one surface earlier
- [[garment-passport-privacy]] — the salted-hash de-identification pattern
- [[service-role-tables]] — why an owner-less table must be registered twice
- [[buyer-platform]] — an allowance is inert until a call site refuses
- [[grading-scale-and-weights]] — the estimated grade a Radar event carries
- [[ralph-learnings]] — the working log that points here
- [[INDEX]]
