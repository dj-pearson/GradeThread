---
title: eBay visual search on thrift clothing
type: learning
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/lib/scout-identify.ts
  - services/edge-functions/src/lib/ebay-client.ts
reviewed: 2026-08-20
tags: [ebay, scout, comps, identification, measurement]
summary: Measured on production - eBay search_by_image names the exact style from a garment photo with no tag visible, and returns confident nonsense from a measurement or defect macro.
---

# eBay visual search on thrift clothing

`POST /buy/browse/v1/item_summary/search_by_image` was measured against
production on 2026-08-20 with 24 real photos from two of Dj's own shoots. This
note is what came back. It exists because [[states-that-look-normal|a
provider nobody has measured]] is not a provider, and because the failure mode
here is the dangerous kind: wrong answers arrive looking exactly like right ones.

Story: US-2758. The seam it feeds is US-2756.

## The one-sentence version

It is very good, and only on photos of a garment. Point it at a ruler, a care
label or a hole in some fabric and it answers with total confidence about the
wrong thing.

## What it got right

The strongest results came from photos with **no brand tag visible at all**,
which is the Google Lens behaviour Dj asked for.

A gray half-zip pullover, flatlay on a hanger, no tag in frame. Five of five
results were Lululemon, and three of them named the same specific style:

```
Lululemon Women Lavender Grey Rest Less 1/2 Zip Swirl Scroll Thumbhole Shirt 6
Lululemon Womens M Gray Jacquard Half Zip Pullover Thumbhole Sweater Paisley
Lululemon Restless Long Sleeve Shirts Women's 8 Gray Half Zip Pullover Stretch
```

The garment in the photo has exactly that swirl jacquard and those long ribbed
thumbhole cuffs. That is an exact product identification from silhouette,
pattern and cuff detail, with nothing to read.

Other whole-garment shots landed the brand five times out of five: Ted Baker on
a quarter-zip, Madewell on a blue crew sweater, Theory on a linen popover
(three of five). A Faherty polo photographed front-on with its collar tag
legible returned "Faherty Reserve Mens Movement Polo" at ranks one and two --
the tag in that photo reads FAHERTY RESERVE / the MOVEMENT POLO, so it had both
the silhouette and the words.

A brand-tag macro on its own works too, provided the **wordmark** is legible.
The same polo's tag close-up returned Faherty at rank one.

## What it got wrong, and how confidently

Five photo types returned junk, and none of it looked like junk:

| photo | what came back |
|---|---|
| hem tag, sunburst logo only, no wordmark | Athleta leggings |
| button macro, brand faintly embossed | generic polo shirts |
| care and composition label | a midi dress, joggers, a mini skirt |
| tape measure across a hem | mens dress pants |
| red fabric with two moth holes | **red fabric by the yard** |

That last one is the clearest illustration. The photo is a defect close-up; the
frame contains red fabric and nothing else; eBay returned red fabric sold by the
yard. It is not malfunctioning. It is answering the question the photo asks.

Two more degradations worth knowing:

- **Props push the right answer down.** The same Faherty polo, same angle, with
  a yardstick laid across the chest, fell from rank one to rank five -- and
  disappeared from the top five entirely once compressed.
- **Orientation and crumpling cost the brand.** The back of that polo, laid
  sideways and rumpled with no tag showing, returned generic polos: right
  category, no brand.

## The risk case

A teal sleeveless athletic tank, flatlay, ruler across it, **no brand mark
anywhere in the photo**, returned five Lululemon tanks. That may be right. There
is no way to tell from the photo, and eBay expressed no doubt.

This is why `matchedTitle` cannot be trusted as brand truth. `hintsProvider`
already reasons about this correctly -- it only prefills from a barcode, on the
grounds that "a keyword's top hit is somebody else's listing title" -- and
`ebayImageProvider` currently takes `items[0].title` unconditionally. A
confident wrong brand prices the item against the wrong comps.

## Latency

Measured wall-clock on the search call alone. The app token is a separate
~650ms and is fetched once, so it is cacheable and is not in these numbers.

| payload | median | worst | n |
|---|---|---|---|
| 1.6 - 2.7 MB straight off the camera | 1519ms | 2029ms | 8 |
| 1600px / q75, the same 8 photos | 1011ms | 1322ms | 8 |
| 1600px / q75, 16 different garments | 935ms | 1511ms | 16 |

Compression is most of the win, and 1600px/q75 is what
`PhotoCompressor.compressOffMain()` already produces on iOS, so the phone is
sending the right size today.

It also costs a little accuracy: the Faherty-plus-ruler shot held rank five at
2.6 MB and lost the brand entirely at 361 KB. Strong signals survived
compression unchanged; only the marginal one did not.

Against `EXPERIMENTAL_TIMEOUT_MS = 1500`, the worst case sits right on the
limit. Expect roughly one call in ten to fall through to hints, which is the
designed behaviour and costs the seller nothing but the timeout.

## What follows from this

1. **Gate on photo role before calling.** The route knows which photo is a
   front, a label or a detail. Sending a detail shot to visual search is not a
   degraded call, it is a call whose answer is actively misleading. This is the
   single highest-value thing to add and it did not exist when the seam was
   built.
2. **Treat the returned brand as a hint needing corroboration**, not as fact.
   Where visual search and a legible tag disagree, the tag wins.
3. Sandbox is useless for this and must never be used to evaluate it -- it
   carries almost no inventory, so every call returns zero matches whatever the
   quality. Confirmed directly: the same eight photos returned 0 results each on
   sandbox and 5/5 relevant results on production.

## Reproducing

Throwaway spike, not in the repo. It reads `EBAY_APP_ID` / `EBAY_CERT_ID` from
the environment, prints neither, and makes no accuracy judgement of its own --
the "is this the same garment" call is a human one, made by looking at each
photo beside its results.

HEIC decodes on the Windows box through WIC
(`System.Windows.Media.Imaging.BitmapDecoder`, PresentationCore) with no
ImageMagick and no ffmpeg, which is how the iPhone shoot became testable.
