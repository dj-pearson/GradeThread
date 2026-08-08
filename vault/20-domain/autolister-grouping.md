---
title: AutoLister photo grouping — why it is bounded
aliases: [mega group, one giant group, dHash, auto-group]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/autolister-grouping.ts
  - src/lib/reconcile-cluster.ts
reviewed: 2026-08-08
tags: [flipdesk, autolister, photos, contract]
summary: A 600-photo dump once became one group; the two causes were independent and neither is a bug in isolation, which is why the bounds are explicit constants rather than a tuned threshold.
---

# AutoLister photo grouping — why it is bounded

A seller's 600-photo dump collapsed into a **single group**. Two causes, each
harmless alone, compounding:

1. **No EXIF, so no time.** HEIC, Live Photo and export pipelines strip EXIF, so
   every photo is timeless. The filename-sequence pass then sees one contiguous
   600-long run and seeds it as one cluster.
2. **Unbounded transitive union.** The visual pass merged clusters transitively
   with no limit, and **dHash on garment photos is background-dominated** —
   same-background shots sit within a distance of 10, so the merge chains
   everything into one component.

The insight worth keeping: **filename contiguity carries no boundary information
once the run exceeds a plausible per-item shot count.** A run of 8 is evidence.
A run of 600 is the absence of evidence, wearing the same shape.

## The bounds

In `src/lib/autolister-grouping.ts`:

- `MAX_AUTO_GROUP_PHOTOS` (12) — caps **both** sequence-run seeding and visual
  merges. Time-gap clusters are exempt, because a real timestamp is real
  evidence and does not need the guard.
- `VISUAL_MERGE_ORDINAL_WINDOW` (3) — merges only clusters near each other in
  shooting order.

`applyBoundedVisualMerge` applies them **closest-pair-first**, so the merges that
happen are the best-supported ones rather than whichever the iteration order
reached first.

## The unbounded pass still exists, deliberately

`reconcile-cluster.ts`'s `applyVisualSecondPass` keeps the original unbounded
transitive union, and `reconcile.tsx` still uses it. That is **opt-in** and works
on embed-endpoint pairs rather than dHash, where transitive chaining is the
wanted behaviour.

> Do not "fix" reconcile to match AutoLister. Two grouping paths differing is
> the correct state here, and the note exists partly so the difference does not
> read as drift to the next person who greps for `applyVisualSecondPass`.

## The rescue path when EXIF is gone

Bounds stop the mega-group; they do not reconstruct the missing boundaries. The
manual tools in `autolister.tsx` are the recovery, and they all follow the
**displayed** order rather than any stored order:

- the Ungrouped grid sort (shooting / name / date / upload),
- "Group every N",
- shift-click range select.

Sort first, then group. Grouping against a display order the seller has not
looked at is the same mistake as trusting a filename run.

## Related

- [[image-intake]] — why the EXIF is missing in the first place
- [[listing-photos]] — what happens to the photos once they are grouped into an item
- [[autolister-handoff]] — what crosses from phone to desktop before any of this runs
- [[INDEX]]
