# Terms of Service — update brief (August 2026)

**Status: DRAFT FOR COUNSEL REVIEW. Nothing here is live.** The published Terms
at `src/pages/legal/terms.tsx` are unchanged and still carry their April 1, 2026
effective date. Nothing in this file has been wired to a page, and it should not
be until counsel has signed off on the wording.

This is the engineering half of US-2528: what shipped since the Terms were
written, where the current text is silent, and draft language a lawyer can cut
apart. The story closes on sign-off, not on this file existing.

## Why now

Four paid or account-affecting products shipped after April 1, 2026. The Terms
mention none of them. Searching `terms.tsx` for "buyer plan", "in-app purchase",
"App Store", "Google Play", "extension" and "consignment" returns nothing.

The Acceptable Use Policy carries the same April 1, 2026 date and was reviewed in
the same pass; the gaps below that touch conduct (extension automation,
consignment) likely need a matching AUP line.

## Gap 1 — Buyer subscriptions are a second paid product

**What shipped.** A buyer-side subscription with its own plan, its own price, its
own Stripe subscription id, its own cancellation and its own dunning clock. It is
separate from the seller (FlipDesk) subscription: one account can hold both, and
cancelling one does not touch the other.

**What the Terms say now.** §3 "Plans, billing, and refunds" describes a single
subscription in the singular — "Paid subscriptions are billed in advance through
Stripe... You may cancel your subscription at any time from Billing."

**The gap.** A buyer who cancels "their subscription" from the seller Billing
page has not cancelled the buyer one, and the Terms give them no reason to know
that. The cancellation clause also points at a single page.

**Draft language (§3, new bullet).**

> **Two separate subscriptions.** GradeThread sells a seller subscription
> (FlipDesk) and a buyer subscription. They are independent: you may hold either
> or both, each is billed and renewed on its own schedule, and cancelling one has
> no effect on the other. Each is cancelled from its own billing page — the
> seller subscription from Billing, the buyer subscription from Buyer billing.

## Gap 2 — Store-billed subscriptions, where Apple and Google own the money

**What shipped.** In-app purchase on iOS (StoreKit) and on Android (Google Play
Billing). A subscription bought in either app is billed by the store, renewed by
the store, and cancelled and refunded by the store. GradeThread's own billing
screen deliberately hides every Stripe control for those accounts and points the
seller at the store, because the server refuses those operations.

**What the Terms say now.** §3 states that subscriptions are "billed in advance
through Stripe" and that cancellation happens in the app. For a store-billed
subscriber both sentences are false.

**The gap.** Refunds are the sharp end: §3 says fees are non-refundable "except
where required by law or expressly stated by us", but for a store purchase the
refund decision is Apple's or Google's under their policies, and we cannot grant
or refuse one.

**Draft language (§3, new bullet).**

> **Subscriptions purchased through an app store.** If you subscribe inside the
> GradeThread iOS or Android app, your subscription is sold and billed by Apple
> or Google under that store's terms, not by us through Stripe. Renewal,
> cancellation and refunds for those subscriptions are handled entirely by the
> store, through your account settings there; we can neither charge nor refund
> them, and any refund is granted or refused under the store's own policy. Your
> entitlements inside GradeThread are the same either way.

## Gap 3 — The Lister browser extension automates the user's own session

**What shipped.** A browser extension that lists to Poshmark, Mercari, Grailed,
Vinted and Facebook Marketplace by driving the seller's own logged-in tab. Those
platforms have no public write API. The product already discloses this per
channel, in the seller's own words, at `src/lib/marketplace-disclosure.ts` — and
the Terms should not contradict it.

**The four facts the product already states, verbatim from that module:**

1. The platform's terms restrict third-party automation. Plenty of sellers use
   tools like this one, and the platform can still limit an account it decides
   is automated.
2. The actions run in the seller's own browser, in the tab they are already
   signed in to. Nothing about that platform runs on GradeThread's servers.
3. GradeThread's servers never receive the platform password or session cookie.
   The extension has no permission to read a cookie on any site.
4. The seller's account, the seller's responsibility. If the platform limits it,
   GradeThread cannot appeal on their behalf.

**What the Terms say now.** §8 covers "third-party integrations" generically —
"Your use of those services remains governed by their own terms" — which is true
but does not describe automation of the user's own session, or who carries the
risk of it.

**Draft language (new §8.1).**

> **Browser-extension listing.** Some marketplaces provide no public listing
> interface. For those, the optional GradeThread Lister browser extension fills
> in and submits a listing in a tab you are already signed in to on your own
> device. It runs in your browser, not on our servers, and it never transmits
> your marketplace password or session cookie to us. Those marketplaces'
> terms restrict third-party automation, and each may restrict, suspend or
> terminate an account it determines is automated. You use the extension on your
> own account and at your own risk; we cannot appeal a marketplace's decision on
> your behalf. Do not use it in a way that violates the marketplace's terms.

**AUP note for counsel — CORRECTED 2026-08-14, and now believed to be a
non-issue.** The original version of this note said the AUP's "scraping"
prohibition could be argued against our own extension and was worth a carve-out.
On re-reading the clause that is wrong, and the correction is here rather than
deleted so the reasoning is visible:

> Do not access **the Service** through automated means except through
> documented APIs and within published rate limits;
> Do not scrape, harvest, or systematically copy content from **the Service**;

Both are scoped to *the Service* — GradeThread. The Lister extension automates
the seller's own signed-in eBay/Poshmark/Mercari session and reads *marketplace*
pages; it does not automate GradeThread, and where it does talk to GradeThread it
does so through our documented API. So there is no self-contradiction to resolve
and **no carve-out is needed**. Raised and withdrawn here so counsel is not
billed for a conflict that does not exist.

The scoping is asserted by `src/test/legal-extension-disclosure-parity.test.ts`,
so if either clause is ever broadened past "the Service" the question comes back
on its own.

## Gap 4 — Consignment: holding third-party goods and paying third parties

**What shipped.** Consignment mode: a seller lists goods belonging to a
consignor, records an agreed split, and pays the consignor out through Stripe
Connect. So the platform is now involved in goods GradeThread's customer does not
own and in money moving to someone who is not GradeThread's customer.

**What the Terms say now.** Nothing. §4 ("Your content and licenses") assumes the
user owns what they upload; there is no clause on ownership of the goods, on the
consignment agreement between seller and consignor, or on payout obligations.

**The questions this raises, which are a lawyer's rather than an engineer's:**

- Is GradeThread a party to the seller/consignor arrangement, or purely a
  record-keeper and payment facilitator? The product behaves as the latter, and
  the Terms should say so if that is the intent.
- Who warrants that consigned goods are authentic, owned, and lawful to sell?
- Stripe Connect makes GradeThread a platform paying out to third parties; that
  usually carries its own terms obligations towards the payee.
- Does the consignor need to accept anything at all today? Currently they do not.

**Draft language (new §3.1), deliberately narrow — this is the clause most in
need of a lawyer:**

> **Consignment.** If you use consignment features, you are solely responsible
> for your arrangement with the consignor, including ownership and authenticity
> of the goods, the agreed split, taxes, and any consumer-law duty owed to the
> buyer. GradeThread records the terms you enter and facilitates payment to the
> consignor through Stripe Connect; we are not a party to your consignment
> agreement, do not take title to any item, and do not guarantee any payment
> between you and a consignor.

## What engineering will do once counsel signs off

1. Update `src/pages/legal/terms.tsx` with the approved wording and move the
   effective date.
2. Update `src/pages/legal/aup.tsx` in the same commit if any conduct rule
   changes, and move its date too.
3. Keep §8.1 consistent with `src/lib/marketplace-disclosure.ts` — the in-product
   disclosure and the Terms must not describe the extension differently. A guard
   test asserting that the Terms carry the same four extension facts should ship
   with the copy.
4. The material-change notice in §18 governs how existing users are told.

## Provenance

Written 2026-08-14 against the code as it stood at that date. The four products
were confirmed in the source, not assumed: buyer subscription columns and routes,
StoreKit and Play billing verification routes, the extension's per-channel
mechanism table, and the consignment payout path through Stripe Connect.

---

**Drift guard (added 2026-08-14).**
`src/test/legal-extension-disclosure-parity.test.ts` exists so the extension
language counsel writes cannot drift from what the product already tells sellers
in `src/lib/marketplace-disclosure.ts`. Today the Terms carry no extension
section, and the guard asserts that absence is still tracked as open work rather
than passing silently. The moment a section lands it starts checking that the
four disclosed facts are all present — counsel is free to rephrase them, the
guard matches on the claim rather than the wording. It also fails if the Terms
and the AUP effective dates diverge, which is AC4.
