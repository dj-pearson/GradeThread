---
title: Counsel question — automated processing of listing data by a shopper's extension
type: reference
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/lib/listing-ingest.ts
  - services/edge-functions/src/lib/data-retention.ts
reviewed: 2026-09-05
tags: [legal, privacy, buyer, extension, marketplace, counsel]
summary: The single question to put to outside counsel covering all six ingest marketplaces, written as a sendable brief, plus what each possible answer unblocks.
---

# Counsel question — automated processing of listing data by a shopper's extension

**Why this exists.** [[market-condition-index-contract]] §6 says the go/no-go for
five of six marketplaces is an owner call that needs a legal reading, and that
the reading is "a specific question to put to counsel once, covering all six,
rather than six separate readings". US-2709 AC6 and AC7 are the only parts of
that spike still open, and US-2710 through US-2713 plus US-3064 all sit behind
them. Describing the question was not the same as writing one that can be sent,
so this is the written one.

**What this note is not.** It does not answer the legal question and must not be
read as an answer. Nothing here changes the safe default, which is that an
uncleared marketplace is **excluded** from the index.

---

## The brief (send this part)

### 1. Who we are and what the product does

GradeThread (Pearson Media LLC) grades the physical condition of used clothing
from photographs and returns a number on a 1.0 to 10.0 scale with a written
condition report. Sellers use it to describe what they are listing. Buyers use it
to check what they are being offered.

The surface in question is a **browser extension the shopper installs**. It does
not run on our servers against a list of URLs. It runs in the shopper's own
browser, on a page the shopper has opened themselves, while they are logged in to
that marketplace under their own account.

### 2. Exactly what happens on a check, mechanically

A shopper viewing one listing clicks our extension. Then:

1. The extension reads the image URLs already loaded into that page by the
   shopper's browser, plus the seller's own stated condition wording and the
   asking price.
2. It sends **one listing** to our server. There is no array form of the request
   and no queue: one click, one listing.
3. Our server **never fetches the listing page**. It does not request, receive,
   parse or store the page's HTML. It fetches only the image files whose URLs the
   shopper's browser had already loaded.
4. Our model assesses the garment's condition from those images and returns a
   number to the shopper.
5. The result is stored on a row private to that shopper and deleted **90 days**
   later. That deletion is unconditional and is published in our privacy policy.

Four limits are enforced in code rather than promised in a document: one listing
per request, an allowlist of marketplace hosts matched on the registrable
domain, the marketplace identity derived from the URL rather than from anything
the caller can set, and a per-shopper daily cap on the number of rows.

### 3. What we now want to do with it, which is the reason for the question

We want to keep a **statistic** derived from these checks after the underlying
row is deleted: the size of the gap between the seller's claimed condition and
our own assessment, accumulated across many checks.

The retained record would carry only: the marketplace name, the garment brand,
the garment category, a **price band** (not the price), the claimed condition as
a number, our assessed condition as a number, and the difference between them.

It would carry **no** listing URL, no image, no listing title, no listing
identifier, no seller name or handle, no buyer identifier, and no exact price. A
bucket publishes nothing at all until it holds at least 25 separate observations.

So the thing we would retain is a measurement of the distance between a public
claim and our own opinion. It is not listing content, and no individual listing
or seller can be recovered from it.

### 4. The marketplaces

Six, reached through eleven country domains:

| Marketplace | Domains | Our relationship with them |
|---|---|---|
| eBay | ebay.com, ebay.co.uk, ebay.ca, ebay.com.au | Commercial API partner |
| Poshmark | poshmark.com, poshmark.ca | None |
| Grailed | grailed.com | None |
| Mercari | mercari.com | None |
| Depop | depop.com | None |
| Vinted | vinted.com, vinted.co.uk | None |

### 5. The question

**Under each of those six marketplaces' terms of service, may a shopper's own
browser extension read the listing data described in section 2, and may we retain
the derived statistic described in section 3, indefinitely, after the source
record is deleted?**

Three parts, if it helps to separate them:

- **(a)** Does the reading in section 2 fall within what the terms permit a
  logged-in shopper (or software acting on that shopper's behalf) to do with a
  page they opened, or does it fall under a clause restricting automated access,
  scraping, data collection or robots?
- **(b)** Is the answer to (a) changed by the fact that the extension sends the
  image URLs to our server, given the server never fetches the page itself?
- **(c)** Does retaining the aggregate in section 3 beyond the life of the source
  record engage any separate restriction on use of marketplace data, including
  any clause about competing services, derived works or database rights?

### 6. What we will do with the answer

For any marketplace where the answer to any part is no, or is unclear, that
marketplace is **excluded from the aggregate** and the feature ships without it.
The per-listing check for the shopper is a separate question we are not asking
here and would continue unchanged.

We would rather have six clear answers, including negative ones, than one
permissive reading applied to all six.

---

## What each answer unblocks (internal, do not send)

| Answer | Effect |
|---|---|
| All six cleared | US-2710 builds the aggregate across all eleven hosts. |
| eBay only | US-2710 ships single-marketplace. The k-anonymity floor of 25 becomes harder to reach per bucket, so bucket widths in US-2710 have to widen. |
| None cleared | US-2710 through US-2713 close as won't-do. US-3064 loses its data source. The per-listing check is unaffected. |

The answer belongs back in [[market-condition-index-contract]] §6 as a
replacement for the recommendation table, with the date it was given.

## Related

- [[market-condition-index-contract]] — the contract this question serves
- [[buyer-platform]] — the anti-crawl enforcements quoted in section 2
- [[data-retention]] — the 90-day prune and its backstop
