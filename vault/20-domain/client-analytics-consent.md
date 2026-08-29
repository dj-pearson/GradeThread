---
title: Client analytics consent regime
type: contract
status: current
source_of_truth: vault
code_refs:
  - src/lib/consent-regime.ts
  - android/app/src/main/java/com/gradethread/app/platform/telemetry/ConsentRegime.kt
  - android/app/src/main/java/com/gradethread/app/platform/telemetry/GeoService.kt
  - android/app/src/main/java/com/gradethread/app/platform/telemetry/Telemetry.kt
  - ios/GradeThread/Telemetry/ConsentRegime.swift
  - ios/GradeThread/Telemetry/Telemetry.swift
reviewed: 2026-08-28
tags: [privacy, consent, telemetry, analytics, android, ios, contract]
summary: One consent rule for every GradeThread client - product analytics is opt-in everywhere except the United States, failing safe to opt-in when the country is unknown, with crash reporting deliberately outside the toggle.
---

# Client analytics consent regime

Decided 2026-08-25 (owner). Web decided it first in US-2513, Android ported it in
US-2897, and iOS followed in US-2914 (2026-08-28). **All three clients now
implement the same rule.**

## The rule

**Product analytics (PostHog) is opt-in in every country except the United
States, and an unresolved country is treated as opt-in.**

| Signal | Regime | Analytics on a fresh install |
|---|---|---|
| Country resolves to `US` | opt-out | on, with a visible way to turn it off |
| Any other resolved country | opt-in | off until the seller turns it on |
| Country unknown, VPN, Tor (`T1`), `XX`, network failure, lookup timeout | opt-in | off |

Two properties are load-bearing and neither is an implementation detail:

**It fails safe.** The strict answer is the default, and the permissive one is
reached only by positively resolving a US-style jurisdiction. Getting this
backwards means analytics runs by default for exactly the sellers most likely to
be covered by GDPR, and it would look like it was working.

**The toggle's copy names no default, and that is deliberate.** Android's
subtitle reads "Product analytics only. Crash reports are always sent." It says
what the switch controls, never whether it starts on - because the answer depends
on where the seller is, and a fixed sentence would be false for half of them. The
switch a seller sees on first open already reflects the resolved regime, so the
screen and the behaviour agree without the copy having to make a claim.

**The stored choice is tri-state.** Absent means *never asked* and the regime
decides. An explicit `false` is never overridden by an opt-out jurisdiction. An
explicit `true` is honoured in an opt-in one. The bug this replaced read a
missing key as consent.

## Crash reporting is outside the toggle, on purpose

Sentry starts synchronously and unconditionally wherever a DSN exists. Crash
reporting is operational rather than product analytics, it is declared
**non-optional** in the Play Data safety form and the App Store privacy label,
and a crash in the first second of a cold start is the one most worth having.
The Settings copy says so in words: "Product analytics only. Crash reports are
always sent."

That declaration is deliberate rather than an omission. Making crash reporting
optional would mean shipping a build where the first-launch crash - the class of
crash that has no other reporter - is the one nobody sees.

## Geo comes from the Pages site, never the API host

`https://gradethread.com/geo.json` is a Cloudflare Pages Function reading
`request.cf.country` at the edge. No third-party IP-geolocation service is
involved, which would itself be a privacy problem.

> [!warning] `functions.gradethread.com` can only ever answer "unknown"
> The edge service runs on Coolify behind no Cloudflare edge, so `request.cf`
> does not exist there. Pointing a client at the API host fails **safe** - every
> seller treated as opt-in - so it would look correct while the location rule
> silently never applied. See the DNS split in [[deploy]].

Nothing is sent: a plain GET, no body, no identifier, no cookie. The country
comes from the network path the request already takes. Android holds the answer
for the life of the process and never writes it to disk, because a cached
country is a location on disk.

## Where the clients legitimately differ

Differences are allowed; undocumented ones are not.

| | Web | Android | iOS |
|---|---|---|---|
| Location-aware regime | yes (US-2513) | yes (US-2897) | yes (US-2914) |
| Global Privacy Control honoured | yes | n/a - no browser signal exists | n/a |
| "Your Privacy Choices" affordance | shown under opt-out | n/a - the toggle is always visible in Settings, so the right is never harder to exercise than the banner makes it | n/a |
| Granular categories | yes (cookie banner) | no - one analytics toggle, because there is one non-essential collector | no |

`ios/APP_STORE_SUBMISSION.md` now carries the rule and what to answer in App
Store Connect, and `android/PLAY_STORE_SUBMISSION.md` no longer says iOS is the
odd one out. Two store documents describing one product differently is the
failure that produced the correction below, so both were changed in the commit
that made them true rather than after it.

The iOS port lives in `ios/GradeThread/Telemetry/ConsentRegime.swift` and its
test cases mirror `ConsentRegimeTest.kt` one for one, so a divergence between
the clients reads as "they disagree" rather than as a bug in whichever was read
last. Two things it had to get right that the other clients had already met:
the stored choice is tri-state, so "never asked" is distinguishable from "said
no" (`?? true` was the defect and `?? false` would have been a different one),
and the Settings toggle re-reads after the regime resolves rather than at view
construction - a one-shot read renders whatever was true before the answer
arrived and stays there, which on Android showed "off" while analytics came on a
moment later.

## Existing sellers were not silently switched, because there are none

US-2897 AC3 asked whether sellers already collected under the old default should
be grandfathered or asked. Neither: **the Android app has never been submitted to
Play.** Every operator blocker in `PLAY_STORE_SUBMISSION.md` section 0 that needs
a Console is still open (US-2913), so there is no installed base and no collected
population to migrate.

The answer if that had not been true is worth recording anyway, because US-2914
faces the same question on a client that has already been through App Review: data collected without consent in
an opt-in jurisdiction was never lawfully consented, so grandfathering it
preserves the defect rather than respecting a choice. The tri-state store makes
the migration a no-op in the honest direction - an installed seller who never
touched the toggle has no stored key, so the regime simply starts deciding.

## A correction that should not be repeated

US-2897 was filed claiming "Android sends analytics by default while iOS asks
first", and `PLAY_STORE_SUBMISSION.md` said the same. **Both were wrong.**
`Telemetry.swift` reads `object(forKey:) ?? true` and its own comment says
"Opt-out, on by default". Both mobile clients behaved identically, and the real
gap was between mobile and web.

The false claim survived from a document into a story because nobody opened the
Swift file. Read line 49 before trusting any summary of it, this note included.

## Related

- [[extension-telemetry-consent]] — the browser extension's two independent opt-in toggles, and why a consent is never widened in place
- [[buyer-legal-and-privacy]] — the buyer surfaces read this same regime rather than carrying their own
- [[signup-consent-capture]] — terms acceptance, which is a separate record from this toggle
