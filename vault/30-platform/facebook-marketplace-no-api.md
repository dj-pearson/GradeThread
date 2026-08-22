---
title: Facebook Marketplace has no API a reseller tool can use
type: decision
status: current
source_of_truth: vault
code_refs:
  - extension-unified/lister/facebook.js
  - src/lib/constants.ts
reviewed: 2026-08-22
tags: [marketplaces, facebook, extension, research, decision]
summary: Three Meta surfaces were examined and none lets a C2C reseller tool publish to Marketplace, so the browser extension is the only route; do not re-research without a new source.
---

# Facebook Marketplace has no API a reseller tool can use

**Decided 2026-08-20 (US-2746). Do not re-investigate this without a NEW
source.** Both primary pages were read in full. Re-reading them is how a
settled question turns back into an open one.

This note exists because the finding was settled inside a backlog story, and a
backlog story is archived into a 1.5 MB file nobody reads. The story's own
purpose was "so that nobody re-investigates it and no roadmap promises an
integration that cannot be built" — which fails the moment it is the only place
the answer lives.

## The three surfaces, and why each is not the one

**The Seller app** (announced 2026-07-24, about.fb.com) is a FIRST-PARTY Meta
app: US only, iOS, 18+, with a web experience in testing. It does
photo-to-listing itself. There is no integration surface on it at all — it is a
product, not a platform.

**The Commerce Platform** covers Shops and ads catalogues. It names Marketplace
as one of three selling surfaces, so "the Commerce API is not Marketplace" is
too strong a claim and is not the one made here. What it is not is the
**consumer C2C flow**: it is built around Graph API seller onboarding, catalog
and inventory, order management and finance reporting, described for "retailers
and ecommerce businesses", with Shops Ads using OFFSITE checkout. That is a
catalogue-and-feed model for a merchant with a product catalog. A reseller
listing one used garment does not have one.

**Marketplace Partnerships** is the real Marketplace listing API — Product Item
API plus Seller API — and it is the near miss. It was built so that ONLINE
CLASSIFIED AD SERVICES could distribute their existing C2C inventory onto
Marketplace. It is a partnership, not a signup.

## What follows

The **browser extension is the only route** to Facebook Marketplace for a US
seller tool. That work is real but ordinary: no partnership to pursue, no
approval to wait on. See [[closing-a-coverage-gap]] for the eight steps, and
`extension-unified/lister/facebook.js`, whose selectors are scaffolded and sit
at `enabled: false` pending a live check.

## The competitive signal, which is the more important half

Meta now ships **photo-to-listing AI generation and bulk listing itself, free,
inside Marketplace**. That is the same job AutoLister does.

It does **not** do condition grading. That is the part of the product Meta has
not copied and the part that is not a listing-speed race — which is worth
holding onto when deciding where effort goes, because matching Meta on listing
speed is competing with free.

## The one open question

Whether a used-goods reseller can qualify for Marketplace Partnerships at all.
The eligibility page sits behind a Meta business login, so it is an operator
read and nothing here can answer it. It is the only question worth spending
time on, and a positive answer is the only thing that reopens this decision.
