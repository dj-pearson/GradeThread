---
title: "ADR: Prospect stays phone-only, and the web says so"
type: decision
status: accepted
source_of_truth: vault
code_refs: []
reviewed: 2026-08-25
tags: [decision, sourcing, ios, parity, prospect]
summary: Prospect is not built on the web because its value is being in a shop holding the item; the web names it on the Sourcing page and points at the app instead, and the server endpoint already exists so reversing this is a page rather than a feature.
---

# ADR: Prospect stays phone-only, and the web says so

> **Decision: Prospect is not built on the web. The web Sourcing page names it,
> explains it in one line, and points at the iOS app. The endpoint
> `/api/flipdesk/scout/prospect` already exists and stays, so if this call is
> ever reversed the work is a page, not a feature.**

Established by US-2878, inside the US-2856 "make GradeThread teachable" epic.

---

## 1. What Prospect is

The in-store "should I buy this?" scan (US-1107). Photograph an item and its
brand/size tag; the app identifies it, counts how many comps exist, shows the
going rate, and forecasts how fast it sells. Enter what the seller would pay and
it returns a buy/skip verdict. No typing.

It ships in `ios/GradeThread/Prospect/` and is a top-level row in the iOS Tools
hub. It has never existed on the web.

## 2. The decision, and the reason

Prospect is worth using in exactly one situation: **standing in a shop, holding
an item you have not bought yet, deciding in under a minute.** Every part of the
design serves that — camera-first, no typing, one number at the end.

A desktop browser is never in that situation. A seller at a laptop has already
bought the thing.

So a web Prospect would be Snap to Value with a different name, and the web
already has Snap to Value. Building it would add a fourth comp-adjacent tool to
a product that already confuses people with three.

## 3. What this decision does NOT rest on

It is worth being precise, because the obvious reason is the wrong one.

This is **not** "the server does not support it". `/api/flipdesk/scout/prospect`
exists, is authed, is plan-gated, and runs the same identify-then-comp pipeline
the phone calls. A web client could call it today. The reason is about where the
seller is standing, not about what is built.

That has a consequence worth writing down: **reversing this is cheap.** If a
desk-bound use ever appears — a seller working from a photo somebody texted
them, a consignment intake queue — the work is a page and a form, not a feature.
Nothing here needs to be undone first.

## 4. What the web does instead

The Sourcing page (`/dashboard/flipdesk/sourcing`) carries a row naming
Prospect, saying in one sentence what it does, and saying it is on the phone.

Two things about that row:

- It is **not** a locked or teased feature. It is not a plan gate and must never
  be styled as one. A seller reading it should think "I should get the app",
  not "I should upgrade".
- It is the **first** phone-only treatment in this product. There was no
  existing pattern to match when US-2878 asked for one — the nearest thing,
  billing's "managed in the iOS app" card (US-807), is about where a
  subscription is administered, not about a feature that only exists on a
  phone. `PhoneOnlyRow` in `src/components/flipdesk/phone-only-row.tsx` is the
  pattern now, and the next phone-only surface should use it rather than
  inventing a second one.

## 5. The naming problem this also closes

GradeThread has three comp-adjacent tools with three invented names, and a new
seller cannot tell them apart:

| Tool | What it is | Where |
|---|---|---|
| **Snap to Value** | Photograph a garment you already have. Get a condition read and a price. | Web + iOS |
| **Scout** | Search eBay for listings priced below what they are worth, to buy and flip. | Web + iOS |
| **Prospect** | Photograph an item in a shop, before you buy it. Get comps and a buy/skip call. | iOS only |

The distinction that actually separates them is **do you own it yet**:
Snap to Value is for what you have, Prospect is for what you are considering,
and Scout is for finding things to consider. Each surface's one-line description
in `src/lib/surfaces.ts` is written to carry that, and
`src/test/prospect-phone-only.test.ts` fails if any of the three stops saying
which side of that line it sits on.

## 6. Related

- [[sync-source-of-truth]] — the provenance model these clients share.
- The surface registry (`src/lib/surfaces.ts`, US-2876) records Prospect with
  `web: null`, which is how a client gap stays visible rather than becoming an
  oversight.
