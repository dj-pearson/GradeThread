---
title: YouTube grading shorts — production runbook
type: runbook
status: current
source_of_truth: vault
code_refs:
  - src/lib/seo/grading-videos.ts
  - src/components/marketing/guide-video.tsx
reviewed: 2026-08-07
tags: [seo, geo, video, youtube, content]
summary: How to shoot, publish and wire the "how to grade a {garment}" shorts so each one appears on its guide page with a VideoObject and a visible transcript.
---

# YouTube grading shorts — production runbook

US-1689 / plan §6.8 (see [[seo-geo-strategy]]). Ten shorts are **scripted and
wired**; none are **shot**. Filming and uploading is the only part of this a
human has to do, and this note is the whole of that job.

## Why these exist

AI answer engines increasingly retrieve and cite video transcripts, and reseller
YouTube is a large sub-community that the written guides do not reach. Each
short embeds on its matching `/grading/guides/{garment}` page, which adds a
multimedia signal to that page and puts a second, differently-shaped copy of the
rubric in front of a different audience.

## What is already built

| Piece | Where |
|---|---|
| The ten scripts (beats: timestamp, shot, spoken line) | `GRADING_SHORTS` in `src/lib/seo/grading-videos.ts` |
| Title, description and tags | **Derived**, not stored — `shortTitle` / `shortDescription` / `shortTags` |
| The on-page embed + visible transcript | `src/components/marketing/guide-video.tsx` |
| `VideoObject` structured data | `garmentGuideJsonLd()` in `src/pages/marketing/marketing-jsonld.ts` |

Nothing renders yet. `publishedShort()` is the single gate: it returns a short
only once **both** `youtubeId` and `uploadDate` are set. The embed and the
`VideoObject` both go through it, so a page can never carry markup for a video
that does not exist. That is the same no-fake-markup rule that keeps a
placeholder `SearchAction` or an invented `aggregateRating` off this site.

## Shooting one

1. Open the script for the garment in `GRADING_SHORTS`. Each is five beats:
   hook, three checks, grade call. The three checks are lifted from that guide's
   own `steps`, so the video and the page teach the same rubric.
2. Shoot **vertical, 9:16**. The embed frame is 9:16 — a 16:9 upload letterboxes
   into a strip on mobile.
3. Use a real garment with the flaw the script names. A short that says "blown
   underarm seam" over a clean jacket is the one thing that makes the series
   look fake.
4. **Read the script verbatim.** That is what makes the on-page transcript
   accurate for free: `shortTranscript()` derives it from the beats. If you
   ad-lib, re-take or trim a beat, paste the real transcript into the short's
   `transcript` field — it overrides the derived one.
5. Keep it under the scripted `durationSeconds`. All ten are 40–48s, inside
   YouTube's 60s Shorts cap.

## Publishing one

1. Upload to the GradeThread channel as a Short.
2. Title, description and tags come from the code, not from your head — run them
   out of `shortTitle()`, `shortDescription()` and `shortTags()` and paste. They
   are derived precisely so the series cannot drift off the GradeThread Scale;
   hand-typing a title defeats the guard.
3. Add captions. YouTube's auto-captions are close enough on a scripted read,
   but check the grade numbers — "a nine" mis-transcribed as "an eye" is exactly
   the sentence an answer engine would have quoted.
4. Fill in `youtubeId` and `uploadDate` (ISO `YYYY-MM-DD`) on that short in
   `grading-videos.ts` and ship. The embed, the transcript and the `VideoObject`
   all appear on the guide page in that deploy.
5. Set `VITE_SOCIAL_YOUTUBE` to the channel URL once the channel is public, so
   the channel joins `Organization.sameAs` (US-1677). Config-gated — it is
   omitted entirely until set, never a placeholder.

## Picking the next batch

`guidesWithoutShorts()` returns the guide slugs with no script yet. Choose for
**distinct failure modes**, not search volume: a cashmere short that repeats the
knit-sweater short is a wasted upload. The current ten were picked that way —
structure (denim jacket), hide (leather), pilling (knit), fibre value
(cashmere), print (graphic tee), fleece (hoodie), sheerness (leggings), blowout
(jeans), moth damage (wool coat), down leakage (puffer).

## Judging them

Per [[seo-distribution-and-measurement]], these are a **distribution** bet, not
a page-count bet. The signal to watch is whether the guide pages carrying an
embed gain impressions and citations against the ones that do not — not YouTube
view counts, which are not the point.

## Related

- [[seo-geo-strategy]] — §6.8, the bet this runbook executes
- [[seo-distribution-and-measurement]] — how the bet gets judged
- [[content-publishing]] — the general content workflow
- [[INDEX]]
