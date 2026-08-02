---
title: The authority machine is built and switched off
aliases: [content engine dormant, activation not greenfield]
type: learning
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-08-01
tags: [growth, content, strategy, agent]
summary: A strategic review found most of the growth surface already shipped but unseeded and unscheduled — so the highest-ROI work is activation, and estimating it as greenfield is how it stays off.
---

# The authority machine is built and switched off

A 2026-06-11 review asked what would make GradeThread the cited standard for
used-clothing condition. The finding was not a missing feature list:

> **The authority machine is largely BUILT but switched off or under-activated.
> Most of the return is activating dormant systems, not greenfield work.**

The blog and social engine is the worked example: database, admin CRUD, AI
generation, SSR, JSON-LD, OG images, RSS, sitemaps, webhook dispatch, a
self-refilling topic bank and a scheduler tick — **all shipped, and none of it
running**, because the knowledge keys were unseeded and the scheduler was never
turned on. Likewise the condition index shipped with a handful of hardcoded
catalog entries rather than a DB-driven one.

## Why this is worth a note rather than a story list

The story maps live in `prd.json` and should not be duplicated here (see
[[CONTRACT]]). What does not survive in a backlog is the **shape of the
mistake**:

- Dormant-but-built work gets estimated like new work, so it loses to features
  that look cheaper, and stays off.
- A dormant system passes every test it has. Nothing is broken; it simply never
  runs.

That is the same family as [[shipped-but-unwired]] — a module nothing calls —
one level up: a system that *is* wired, and that nobody started.

**Before proposing a growth feature, check whether it exists and is idle.** The
cheapest wins were seeding content knowledge, turning the scheduler on, and
expanding a catalog that was already rendering.

## Two claims that were wrong, and were checked

Exploration agents produced two findings that did not survive verification, both
worth recording because they will be re-derived:

- **The referral programme is fully wired user-facing** — page, endpoints and the
  `?ref=CODE` signup path all exist. Referral stories are *amplification*, not
  build.
- **`SearchAction` is correctly gated** in the JSON-LD builder. It was reported as
  a policy violation; it is not.

## Related

- [[shipped-but-unwired]] — the same failure one level down
- [[seo-geo-strategy]] — where the activated surface is aimed
- [[content-publishing]] — the fan-out contract the engine uses
- [[INDEX]]
