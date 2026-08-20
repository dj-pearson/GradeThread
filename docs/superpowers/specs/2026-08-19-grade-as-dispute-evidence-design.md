# Grade as dispute evidence: turning the grade report into an eBay INAD defense

Date: 2026-08-19
Status: approved design, not yet built
Epic: see prd.json (filed alongside this document)

## The problem

An eBay "item not as described" case is the reseller's largest uncontrolled
loss. Today a seller fights one with a screenshot and a defensive paragraph.

GradeThread holds something no competitor has: an independent, dated,
cryptographically signed condition report with a per-defect flaw map. It is
sitting unused at the exact moment it would be worth the most.

The eBay feature gap list in `vault/30-platform/flipdesk-reseller-gaps.md` has
one P3 item left, so this is not a parity problem. It is a differentiation one.

## What already exists

- **The flaw map.** `DetectedIssue` in `services/edge-functions/src/lib/ai-grading.ts`
  carries `defect_type`, `severity`, `repairability`, `size_bucket`, `area_pct`,
  `location`, `is_intentional` and a normalized `bbox`.
- **Server-side annotated photos.** `lib/defect-annotations.ts` composites a
  garment photo with numbered callout boxes and a legend using imagescript, and
  already pulls the certificate number.
- **A signed certificate.** `grade_reports` carries `content_hash`,
  `content_signature` and `integrity_version`, plus `certified_content_updated_at`
  where NULL genuinely means never revised
  ([[certificate-revision-provenance]]). Publicly checkable at `/verify`.
- **A Post-Order v2 client.** `lib/ebay-postorder.ts`. Return file upload is an
  extension of it, not a new integration.
- **A payment-dispute evidence route.** `POST /payment-disputes/:id/evidence` in
  `routes/flipdesk-ebay.ts`, which already sniffs magic bytes and strips EXIF
  before forwarding.

## What is missing

Returns have no evidence path at all, and an INAD arrives as a return far more
often than as a payment dispute.

And there is no record of what a listing said. `listings` has a description
column and no history, so "I disclosed it" is not provable from our own data. A
seller who revised after the complaint looks identical to one who disclosed up
front.

## Components

| Piece | Job |
|---|---|
| `listing_publications` table | One timestamped row per publish and per revise: listing id, channel, description, aspect map, price, timestamp |
| snapshot funnel | The single function every eBay description or aspect write calls |
| `lib/complaint-match.ts` | Buyer complaint text against the flaw map. Returns matched defects or nothing |
| `lib/dispute-evidence.ts` | Pure. Grade report plus publication snapshot plus match produces the evidence plan: photos, flaws, citations, verdict |
| evidence sheet renderer | Reuses the `defect-annotations.ts` compositor for the summary image |
| `ebay-postorder.ts` file upload | Attach evidence to a return |
| `POST /ebay/returns/:id/evidence` | New route |
| `post-sale.tsx` review surface | Read the draft, edit it, submit |

## The core rule: the draft may never assert a defect that is not in the report

The matcher is AI, because a buyer writes "there is a mark on the sleeve" and the
report says stain, left cuff, minor, permanent. That match is semantic.

But every defect the draft cites is validated against the report by the pure
layer before the seller sees it, and an unvalidated citation is dropped rather
than softened. The model proposes, deterministic code decides what survives.
Same split as the grading pipeline.

## Three verdicts, all of them useful

- **Contradicted.** The complaint names a flaw the report documented and the
  listing disclosed. Worth fighting, and the draft says exactly where and when.
- **Not covered.** The report has nothing on it. The draft says so and suggests
  the seller consider refunding. No argument is manufactured.
- **Supported.** The report agrees with the buyer. Say so. A seller who fights
  this loses and pays shipping both ways.

## The honesty constraint

We never claim this wins the case. eBay decides. The claim is that the seller
submits dated, signed, specific evidence in one click instead of a screenshot
and a paragraph. The repo already enforces a UI-honesty rule for deferred
features; this is that rule pointed at an outcome we do not control.

## The snapshot

`vault/30-platform/ebay-description-freshness.md` records that an eBay
description is frozen text: no active content, no off-eBay links, so it cannot
change on its own. Snapshotting at every write is therefore complete coverage
rather than sampling.

The risk is how many writes there are: `publishOffer`,
`publishOfferByInventoryItemGroup`, `updateOfferFields`, `updateOfferPrice`,
`createOrReplaceInventoryItem`, the aspect gap-fill revise, the forced resync,
and the scheduled credentials-refresh cron in `routes/jobs-credentials-refresh.ts`.
A missed door means the evidence cites a description that was never live, which
is worse than no evidence because it is asserted under a signature.

So the snapshot write lives in one funnel, and a source guard fails the build if
any eBay write path reaches the wire without it. This repo has the scar for this
exact shape twice, in `lib/pending-delists.ts` and in the
`EXTENSION_DELIST_PLATFORMS` drift.

**Consecutive identical snapshots collapse.** The credentials-refresh cron
re-pushes unchanged text often. An unchanged push bumps `last_confirmed_at` on
the existing row instead of writing a duplicate, which is also the stronger
statement: this exact text was live and confirmed from date A through date B.

**The caveat travels with the evidence.** Our snapshot is what GradeThread
published. A seller editing directly in Seller Hub changes eBay's copy and not
ours, and `GetMyeBaySelling` returns no description, so we cannot always detect
it. The sheet says "published by GradeThread on DATE" and never "the listing
read this at the time of sale" unless the live text was independently confirmed
to match. Claiming the second while only knowing the first is manufacturing
evidence, which is the thing this feature exists to be better than.

**Retroactivity.** This covers listings published after it ships and nothing
before. A dispute on an older item falls back to the grade-report-only argument
and the surface labels it as the weaker case. Coverage grows from day one and
the seller can see it growing.

## Phasing

1. **The snapshot, alone and first.** It consumes nothing and blocks nothing,
   but coverage cannot be backfilled honestly, so every day it is not live is a
   day of evidence lost permanently. Ship it before the rest is built.
2. **The pure core.** Matcher, evidence plan, verdicts. Server-only, no eBay
   writes.
3. **Returns.** Post-Order file upload, the route, the review surface.
4. **Payment disputes.** The same pack on the route that already exists.

## Risks

**The grade report can prove the buyer right.** If the report documents a stain
the listing never disclosed, submitting it hands eBay the case against our own
user, under our signature. A naive attach-the-evidence button does this
cheerfully.

So the pack checks the disclosure before offering anything. A documented flaw
absent from both the snapshot description and the aspect map turns the verdict
to supported, the pack refuses to auto-assemble, and the seller is told plainly.
Better to lose one dispute than to lose it while paying us.

**A confident matcher makes a seller fight a case they should settle.** They
lose, pay return shipping both ways, and take a defect on their account, on our
advice. Ambiguity resolves to "not covered" and never to "contradicted", and the
seller always sees the cited defect text and its photo so the judgement is
theirs.

## Testing

- `complaint-match.ts` and `dispute-evidence.ts` are pure and get real deno
  coverage.
- The test that matters most: a matcher stub that invents a defect, asserting
  the citation is dropped rather than softened.
- A source guard over every eBay write path asserting it goes through the
  snapshot funnel.
- Snapshot dedupe: an unchanged re-push writes no row and bumps
  `last_confirmed_at`.
- A `tenant-isolation_test.ts` case for the returns evidence route.
- The US-1108 migration triple for `listing_publications`.
- A small labelled set of complaint-and-report pairs with expected verdicts, so
  a prompt change that starts calling stretches "contradicted" fails a gate
  instead of shipping.

## Out of scope

Prevention and INAD-rate coaching, non-eBay dispute surfaces, and auto-submission
on any timer.
