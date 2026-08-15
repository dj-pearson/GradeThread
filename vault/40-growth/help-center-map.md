---
title: Help Center map — every article, its shelf and its visibility
type: reference
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-08-14
tags: [help-center, content, seo]
summary: The full inventory of help articles across all 14 categories, with the target query and visibility for each, so the content stories are a checklist rather than a judgement call.
---

# Help Center map

The article inventory. It exists so US-2586..US-2590 write to a list instead of
deciding what to write each time, and so a gap is visible as a missing row
rather than as an absence nobody notices.

Gating rules live in [[help-center-gating]] — this note is only the inventory.
Ten of these articles are also named by `src/lib/help-slugs.ts`, which is what
the in-product question-mark buttons point at; those are marked **(button)**.

Status: **written** rows exist in `content/help/`. Everything else is planned.

## Content rules for every article

- 600+ words. Below that it is an FAQ answer, and `/faq` already exists.
- One FAQ pair minimum. That is what Google renders as a drop-down under the
  result, and it is the cheapest rich-result there is.
- A named `pillar_path`, so the article is not an orphan in the link graph.
- ASCII body. The plain-characters rule applies: a curly quote in a code block
  is a runtime failure somewhere downstream.
- **Screenshots are marked, not embedded.** Nothing in this repo can take one.
  Each article that needs one carries a `<!-- SCREENSHOT: … -->` marker saying
  exactly what to capture; the admin editor is where they get added.

## getting-started

| Slug | Visibility | Target query | Status |
|---|---|---|---|
| create-your-account | public | how do I sign up for GradeThread | written |
| your-first-grade **(button)** | public | how to grade clothing photos | written |
| what-a-grade-means | public | what does a 8.5 condition grade mean | written |
| plans-and-credits | public | gradethread pricing credits | written |
| a-tour-of-the-dashboard | public | — (in-app orientation) | written |

## grading

| Slug | Visibility | Target query | Status |
|---|---|---|---|
| the-grading-scale | public | clothing condition grading scale 1 to 10 | written |
| the-five-factors | public | what affects a clothing condition grade | written |
| the-photos-we-need | public | what photos for clothing condition grading | written |
| lighting-and-background | public | how to photograph clothes for resale | written |
| confidence-and-human-review | public | why is my grade under review | written |
| disputes-and-regrades | public | dispute a clothing condition grade | written |
| what-grading-does-not-check | public | does condition grading check authenticity | written |
| reading-your-grade-report **(button)** | public | how to read a condition report | written |

## certificates

| Slug | Visibility | Target query | Status |
|---|---|---|---|
| share-a-certificate | public | share a clothing condition certificate | planned |
| print-a-garment-tag | public | — | planned |
| embed-a-grade-badge | public | embed condition grade in listing | planned |
| the-garment-passport | public | garment passport history | planned |

## flipdesk

US-2587. One article per step a person takes. The pipeline article covers all
THIRTEEN statuses, including the waiting state and the two endings, because the
board has thirteen columns even though the workflow has eleven steps.

| Slug | Visibility | Status |
|---|---|---|
| the-flipdesk-pipeline **(button)** | public | written |
| sourcing-and-adding-items | public | written |
| cataloguing-an-item | public | written |
| taking-measurements | public | written |
| photographing-for-a-listing | public | written |
| grading-an-item-in-flipdesk | public | written |
| comping-and-pricing | public | written |
| writing-a-listing-in-the-composer **(button)** | public | written |
| publishing-a-listing | public | written |
| when-it-sells | public | written |
| shipping-and-labels | public | written |

## marketplaces

`reconciling-payouts` lives here rather than under flipdesk, matching the
category `src/lib/help-slugs.ts` registers for it.

| Slug | Visibility | Status |
|---|---|---|
| connecting-a-marketplace **(button)** | public | written |
| ebay-business-policies | public | written |
| item-specifics-and-the-65-character-limit | public | written |
| condition-mapping | public | written |
| crosslisting | public | written |
| delisting-and-lifecycle | public | written |
| reconciling-payouts **(button)** | public | written |
| google-sheets-sync | members | written |

## autolister

| Slug | Visibility | Status |
|---|---|---|
| what-autolister-does | public | written |
| reading-a-batch | public | written |
| when-a-batch-stalls | public | written |

## extension

US-2588. Every privacy claim verified against the source, not the README.

| Slug | Visibility | Status |
|---|---|---|
| installing-the-browser-extension **(button)** | public | planned |
| connecting-the-extension | public | planned |
| condition-check-on-a-listing | public | planned |
| the-compare-tray | public | planned |
| seller-memory | public | planned |
| flip-mode | members | planned |
| scan-mode | public | planned |
| the-lister | members | planned |
| when-a-site-stops-working | public | planned |

## mobile

| Slug | Visibility | Status |
|---|---|---|
| the-iphone-app | public | planned |
| the-android-app | public | planned |
| shooting-photos-on-your-phone | public | planned |
| sharing-into-gradethread | public | planned |
| staying-signed-in | public | planned |

## buyers

| Slug | Visibility | Status |
|---|---|---|
| verify-a-certificate | public | planned |
| scan-before-you-buy | public | planned |
| the-buyer-guarantee | public | planned |
| alerts | public | planned |
| rewards-and-credits | public | planned |
| the-trust-score | public | planned |

## billing

| Slug | Visibility | Status |
|---|---|---|
| plans-credits-and-billing **(button)** | members | planned |
| upgrading-and-downgrading | members | planned |
| cancelling | members | planned |
| refunds-and-invoices | members | planned |
| a-failed-payment | members | planned |

## team

`inviting-your-team` covers roles and workspace ownership in one article. Two
separate planned notes were folded into it rather than split three ways: a
person asking "how do I add someone" wants the role table and the ownership
answer in the same place, not a trail of three.

| Slug | Visibility | Target query | Status |
|---|---|---|---|
| inviting-your-team **(button)** | members | add a team member gradethread | written |

## integrations

| Slug | Visibility | Status |
|---|---|---|
| api-keys-and-the-sandbox **(button)** | public | planned |
| the-rest-api | public | planned |
| rate-limits-and-quotas | public | planned |
| webhooks | public | planned |
| embeds-and-badges | public | planned |

## troubleshooting

| Slug | Visibility | Status |
|---|---|---|
| cannot-sign-in | public | planned |
| upload-failed | public | planned |
| a-photo-rotated-wrong | public | planned |
| the-grade-seems-wrong | public | planned |
| an-ebay-listing-is-stuck | public | planned |
| an-offer-will-not-send | public | planned |
| the-app-logged-me-out | public | planned |
| the-extension-is-not-appearing | public | planned |

## account

| Slug | Visibility | Status |
|---|---|---|
| securing-your-account | public | planned |
| exporting-your-data | members | planned |
| deleting-your-account | public | planned |

## internal (US-2590)

Every row here is `visibility: internal`. None contains a secret VALUE; each
names where the secret lives and links its vault runbook rather than restating
it, so there is one source of truth.

| Slug | Links to | Status |
|---|---|---|
| ops-the-review-queue | grading-engine skill | planned |
| ops-prompt-versions-and-canary | grading-engine skill | planned |
| ops-refunds-and-disputes | [[billing-refunds]] | planned |
| ops-key-rotation | [[key-rotation]] | planned |
| ops-incident-response | [[incident-response]] | planned |
| ops-abuse-thresholds | [[capacity]] | planned |

## Related

- [[help-center-gating]] — what each visibility means and how it is enforced
- [[seo-public-route-registry]] — why /help is not a registered static route
- [[copy-style-guide]] — the voice these articles are written in
