---
title: Buyer platform — legal posture and personal data
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/buyer-pii.ts
  - services/edge-functions/src/tests/buyer-pii_test.ts
  - services/edge-functions/src/routes/account.ts
  - src/lib/buyer-legal-surfaces.ts
  - src/lib/__tests__/buyer-legal-surfaces.test.ts
  - src/pages/legal/privacy.tsx
  - src/pages/legal/__tests__/privacy-buyer.test.tsx
  - extension-unified/SUBMISSION.md
reviewed: 2026-09-05
tags: [buyer, privacy, legal, consent, contract]
summary: Buyer personal data is enumerated in one register that the export iterates; legally-sensitive buyer copy is either behind an operator kill-switch that defaults off or bound to a fixed disclosure, and both are asserted rather than described.
---

# Buyer platform — legal posture and personal data

> **Re-reviewed 2026-09-02, and the privacy policy gained a section that matters
> more than most.** US-3038 adds the Fit & Measurement Index to
> `src/pages/legal/privacy.tsx` as its OWN section, and the reason is recorded in
> the code comment: it is the only sharing on that page that is ON by default,
> and the existing aggregate clause permits INTERNAL use of de-identified data,
> not publishing an aggregate on a public page. Reading the second into the
> first would have been the stretch US-2643 exists to forbid. The consent is the
> section itself, with the Settings toggle pointing at it.
>
> `extension-unified/SUBMISSION.md` also changed: the version record now says
> 1.0.9 to match what the stores actually serve. The data-collection disclosures
> in it are unchanged and still true -- the extension sends no install identifier
> to the site (see [[extension-funnel-attribution]]).


The buyer product sells confidence, which makes two of its obligations sharper
than the seller product's: it holds data that describes the person rather than
their inventory, and it says things ("this looks genuine", "you're covered")
that read as claims. [[buyer-platform]] owns identity and entitlement;
[[buyer-economy]] owns the money. This note owns what we hold about a buyer and
what we are allowed to say to one.

## The register is the mechanism, not the list

`BUYER_PII_TABLES` (`lib/buyer-pii.ts`) enumerates every table holding buyer
personal data, and **both export paths iterate it**. That ordering is the whole
point. The export previously named seller tables by hand, so a buyer who filed a
subject-access request received a file containing none of their measurements,
closet, saved searches, watchlist, reward ledger or guarantee claims — with
nothing in it to indicate the omission.

> [!warning] "The export iterates it" was true of ONE export for months
> There are two: `GET /api/account/export` streams the self-serve download, and
> `assembleUserExport()` builds the archive the admin compliance queue hands to a
> subject. Only the first iterated the register, so the FORMAL path — the one a
> written request goes through — returned LESS than the same person got from
> their own settings page (US-2648). A register fixes a hand-written list only
> where something iterates it, and nothing compared the two until
> `data-export_test.ts` began comparing them as SETS in both directions.

Each table was individually careful: RLS on, an owner-scoped policy, a cascade
to `auth.users`. Nobody owned the **set**, and both of the obligations that
actually bite — access, and being able to state a classification — are
properties of the set.

Three rules follow, and each exists because the shortcut fails silently:

- **A buyer table is added by adding a register entry.** `buyer-pii_test.ts`
  discovers buyer-domain tables straight out of `supabase/migrations/`, so an
  unregistered one fails the build rather than quietly missing the export. A
  curated "tables to check" list would miss exactly the table someone added
  without thinking about it.
- **The declared erasure shape is asserted against the FK.** An entry saying
  `cascade` about a column keyed `ON DELETE SET NULL` is the US-2005 failure
  reproduced: `{deleted:true}` returns and the rows remain. There is exactly one
  `unlink` today — `grade_outcomes.buyer_user_id`, because a grade confirmation
  is also a measurement of our accuracy and of the seller's record, so it is
  de-identified rather than destroyed. That is stated in the policy, not implied.
- **`sensitive` means the exposure harms the person, not the business.** Body
  measurements and the listings a buyer asked us to check are sensitive;
  a reward balance is not. None of it is a GDPR Art. 9 special category — we
  hold none.

## Consent is resolved once, and reused

The buyer surfaces do not carry their own consent model. The privacy card in
buyer settings reads `useConsentRegime()` (the geo signal from `/geo.json`, via
[[extension-telemetry-consent|the same fail-safe default]]: opt-in everywhere we
are unsure, opt-out only where we positively resolve a US-style jurisdiction),
labels its control from that resolution, and reopens the **same**
`<CookieConsent>` manager through the existing event bus.

A buyer-only consent store would be a second answer to a question that already
has one, and the two would drift on exactly the axis nobody watches — which
jurisdiction gets the strict banner.

What the card fixes is reachability, not policy: the consent manager, the export
and the deletion all already existed, and all three lived on seller-shaped
surfaces a buyer-first account never visits.

## Legally-sensitive copy has exactly two postures

`BUYER_LEGAL_SURFACES` (`src/lib/buyer-legal-surfaces.ts`) names each surface
that makes a claim, and every entry is one of:

| Posture | Held honest by |
|---|---|
| `kill-switch` | An operator env flag, **compared against `"true"`** so an unset flag is off. The flag is the pending-legal-review list. |
| `disclaimer` | A fixed, server-authored disclosure the model cannot write, whose phrases the test finds in the file that authors them. |

The test reads the named files as text, including across the project boundary
into the Deno service — the same trick as `buyer-plan-limits-parity.test.ts`,
because the web bundle cannot import Deno source.

Two things it deliberately refuses:

- **`Deno.env.get(F) !== "false"` is rejected outright.** It reads almost
  identically to the correct form and ships the surface **open** on a fresh
  deployment. A gate that defaults on is not a gate.
- **There is no `reviewed: true` field.** No code change can establish that a
  human read something, and a boolean claiming it did would be worse than no
  boolean at all. The operator who flips a kill-switch is the record.

## A disclosure change travels with the code

The extension section of `privacy.tsx` said "Results are not stored on our
servers" — true when written, false from the moment US-1808 shipped an endpoint
that writes a listing row keyed to the buyer's account and keeps it 90 days.
Nothing failed, because prose has no compiler; that page is the URL submitted to
both extension stores, so the stale sentence was a failed review waiting to be
found by a reviewer instead of by us.

The four artefacts that must agree in one commit are the ones
[[extension-telemetry-consent]] already names, plus this note's register. The
guard is `privacy-buyer.test.tsx`, which asserts the retired sentence **cannot
come back** as well as asserting the replacement is present — a test that only
checks for the new wording passes fine alongside a reverted paragraph.

> [!note] The same gap opened again on the seller side (2026-08-10)
> US-2482 (repeat the seller's own share / follow / offer actions) and US-2481
> (queue work on a phone, drain it on the desktop) both shipped with
> `SUBMISSION.md` updated and `privacy.tsx` untouched, which is the identical
> failure one story later and on the half of the page a store reviewer reads
> first. Both are now disclosed, and `privacy-buyer.test.tsx` asserts the four
> load-bearing phrases: the human check is never answered, the engagement tool
> has its **own** consent rather than the cross-posting one, the queue holds an
> instruction and never a password, cookie or session, and unpicked work expires
> after 7 days. The rule to take from this is narrower than "update the policy":
> **a behaviour that runs in the seller's browser on somebody else's site, or a
> new server-side row about the seller's account, is a privacy-page edit in the
> same commit** — a store listing alone is not the disclosure.

## Related

- [[buyer-platform]] — identity, entitlements, and the ToS boundary the ingest endpoint enforces
- [[buyer-economy]] — credits, claims and buyer-facing visibility
- [[extension-telemetry-consent]] — the two opt-in toggles, and why a consent is never widened in place
- [[garment-passport-privacy]] — the seller-side pseudonymity contract
- [[INDEX]]

## 2026-09-05: one permission added to SUBMISSION.md, no disclosure moved

`extension-unified/SUBMISSION.md` changed for US-3062: the side panel
needs the `sidePanel` permission, and the submission-kit guard refuses a
permission with no justification in that file (US-1874 shipped `alarms`
unjustified exactly that way).

The justification states the limits that keep it outside this note's
subject: the panel renders GradeThread's own page, reads no page content,
makes no network request of its own, and is enabled only on hosts already
in host_permissions. So NO new data reaches a server and no buyer
disclosure changed. Nothing this note asserts has moved -- re-read to
confirm, which is the only reason the date below moved.
