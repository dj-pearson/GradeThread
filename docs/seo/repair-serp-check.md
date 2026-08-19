# US-9011 — who actually holds the repair SERPs

Ran 2026-08-18. Five terms, checked one at a time, results recorded as returned.

## What this is and is not

This is a **search-API sample, not a rank-tracker snapshot.** It returns the
results a search for the term surfaces, in order, and that is enough to answer
the question the gate asks — *who occupies this space* — but a given URL's exact
Google position is not established here and should not be quoted from this note.
39 results across the five terms.

## The verdict

**Path 1 is NOT blocked. The kill condition is not met, and it is not close.**

The story's fear was that Tide, Persil, Good Housekeeping, Real Simple and
Martha Stewart hold every slot. Across all 39 results, **exactly one** major
publisher appears: Fox News, on an AMP real-estate URL, for the zipper term.
Not one of the five named publishers appears anywhere.

What holds these SERPs instead is small sites, brand blogs and user-generated
content.

## Term by term

### `how to fix a broken zipper` (50,000/mo, Low)

| # | Result | Type |
|---|---|---|
| 1 | Oxfam GB | charity / NGO blog |
| 2 | Quora | UGC |
| 3 | TikTok | UGC |
| 4 | REI Expert Advice | retailer blog |
| 5 | Instructables | community |
| 6 | iFixit | community |
| 7 | YouTube | UGC |
| 8 | Fox News (AMP) | **major publisher** |

Major publishers 1 of 8. UGC 4 of 8.

### `how to sew on a button` (50,000/mo, Low)

| # | Result | Type |
|---|---|---|
| 1 | Brother USA support | brand |
| 2 | Art of Manliness | independent blog |
| 3 | Megan Nielsen Patterns | small craft blog |
| 4 | Thread Theory | small craft blog |
| 5 | Happiest Camper | small craft blog |
| 6 | North London Waste Authority (PDF) | local government |
| 7 | Univ. of Wisconsin digital library | archive |

Major publishers 0 of 7. A **council waste authority PDF** and a **university
library scan** are both on page one. Neither is a serious answer to the query.

### `how to fix a hole in jeans` (5,000/mo)

| # | Result | Type |
|---|---|---|
| 1 | Ariat | clothing brand |
| 2 | Heather Handmade | small craft blog |
| 3 | Levi's | clothing brand |
| 4 | The Cozy Cuttlefish | small craft blog |
| 5 | MadamSew | brand blog |
| 6 | Collingwood-Norris | small craft blog |
| 7 | North London Waste Authority (PDF) | local government |
| 8 | grad-programs.info.ncsu.edu | **hijacked university URL, spam** |

Major publishers 0 of 8. Two clothing brands rank, which matters: it shows a
site with a real clothing relationship is not structurally excluded here.

### `how to fix a snag in a sweater` (5,000/mo)

| # | Result | Type |
|---|---|---|
| 1 | Park Lane **Jewelry** | off-topic brand blog |
| 2 | Craftsuprint | small craft site |
| 3 | OppoSuits | novelty-suit brand blog |
| 4 | AskAndy forum | UGC forum |
| 5 | Instructables | community |
| 6 | Thrifty Frugal Mom | small blog |
| 7 | YouTube | UGC |
| 8 | Facebook group post | UGC |
| 9 | Wikipedia, "Snag (textiles)" | reference |

Major publishers 0 of 9. **A jewellery company holds the top slot for a sweater
repair query.** That is the single clearest displaceable result in the whole
check.

### `how to unshrink clothes` (5,000/mo)

| # | Result | Type |
|---|---|---|
| 1 | Speed Queen **Thailand** | appliance brand, wrong-country subfolder |
| 2 | Oxfam GB | charity / NGO blog |
| 3 | ZIPS dry cleaners | service brand |
| 4 | Steel City | shop blog |
| 5 | Masari Shop | shop blog |
| 6 | NZ immigration govt (PDF) | **hijacked government URL, spam** |
| 7 | NZ immigration govt (PDF) | **hijacked government URL, spam** |

Major publishers 0 of 7. Three of seven slots are a wrong-locale page and two
spam PDFs on the same hijacked government domain.

## Thin results, counted

Six of 39 slots are plainly not the best available answer: the jewellery site on
a sweater query, Speed Queen's Thailand page for a US search, three hijacked-PDF
spam results, and a London waste-authority leaflet. A seventh, the Wisconsin
library scan, is an archive rather than an article.

That is the displaceability AC2 asks about, and it is unusually high.

## The finding the story did not ask for, which matters more

**Not one of the 39 results is a resale, grading or secondhand-clothing site.**
The two closest are Oxfam, a charity shop, and Levi's.

That cuts both ways and both directions are load-bearing:

- **In favour.** There is no incumbent to displace. No competitor in
  GradeThread's category has claimed this space, and the sites holding it are
  reachable.
- **Against.** Google does not currently read these queries as belonging to
  anything resale-shaped, and the visitor behind them is not a seller. Someone
  searching `how to sew on a button` wants to sew a button. The traffic is real
  and the intent is not adjacent to grading, listing or selling.

So the gate clears on authority and the risk moves entirely onto the axis the
strategy note already flagged: **topical dilution**. At 295,750/mo against a
seller surface of about 157,000, this content would become the majority of the
site, and every one of the 39 results above shows what neighbourhood it would be
filed in. `/care/` containment (US-9015) is not a nicety in that light; it is
the condition on which the rest of Path 1 should be allowed to proceed.

## Recommendation

1. **Do not record Path 1 as blocked.** AC3's condition is not met.
2. **Proceed, but with US-9015 promoted ahead of US-9013 and US-9014.** Build
   the containment before the volume, not after it. The containment is cheap now
   and expensive once a hundred care pages exist.
3. **Start with `how to fix a snag in a sweater` and `how to unshrink clothes`**,
   not with the two 50,000/mo terms. They have the weakest incumbents (a
   jewellery site, a wrong-locale appliance page, two spam PDFs) and they sit
   closest to condition, which is the only bridge from repair intent back to the
   product. A snag and a shrunk garment are both condition defects with a
   resale consequence; a button is not.
4. **Do not write the button page at all yet.** 50,000/mo of the purest
   non-adjacent intent in the set, held by craft blogs that are better at it
   than we would be.
