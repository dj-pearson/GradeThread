---
title: Guards that cannot fail
type: learning
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-18
tags: [testing, ci, agent, verification]
summary: This repo's most common defect is not a broken check but a check that passes for the wrong reason; here are the seven shapes it took and the one habit that catches all of them.
---

# Guards that cannot fail

Across a long audit-and-fix session on 2026-07-18, the single most common
defect class in this repo was **not** broken code and **not** a missing test. It
was a check that ran, went green, and was measuring something adjacent to the
thing it claimed to protect.

Every instance below shipped. Every one looked healthy on a dashboard. Several
had been green for months while the property they existed to defend was broken.

This note exists so the eighth instance gets recognised instead of rediscovered.

## The seven shapes it took

1. **The gate that hid the other gates.** CI ran `lint` first with default step
   semantics, so three style errors meant type-check, tests, coverage, build and
   the bundle guard never ran. The run was red — for lint — while the frontend
   went unverified for a day. *(US-1998)*

2. **The regex that could not match the thing.** The RLS guard tested
   `/\buser_id\b/`, which cannot match `seller_user_id` — the character before
   `user_id` is an underscore, a word character, so no boundary exists. 21 tables
   were silently exempt from a check whose stated promise was "a new zero-policy
   table fails until a human classifies it". *(US-2008)*

3. **The hand-maintained list that stopped growing.** The JSON-LD parity test
   imported 16 page components by name while the route registry held 213. Adding
   a page and forgetting the prerenderer produced a green CI — which is how the
   flagship data report and two calculators shipped their structured data to the
   SPA only, invisible to every non-JS crawler. *(US-2044)*

4. **The test that covered the half that was never broken.** After fixing a
   partial-refund clawback, the added tests exercised the pure arithmetic — which
   had always been correct. The actual bug lived in an unexported handler, so
   reverting the fix left all 4,181 tests green while a customer kept both the
   credits and the money. *(US-2033 → US-2040)*

5. **The suite that skipped in silence.** Seventeen tenant-isolation cases were
   gated on a fixture the seed script never emitted, including *"viewer cannot
   pay for a grade (drains owner credits)"*. The job was green. The tests were
   labelled as though the wiring had landed. *(US-2039)*

6. **The assertion pinned to today's state.** A pricing test asserted "the
   purchase guarantee is the one not-live feature". Shipping that feature broke
   the test, and the obvious fix — swap in the next unshipped feature's name —
   would have relocated the same problem to the next person. *(US-2073)*

7. **The fixture that omitted the field under test.** A byte-equality guard
   between the SPA and SSR JSON-LD builders passed, not because the builders
   agreed, but because its fixture never supplied the one field where they
   differed. *(US-2071)*

## The habit that catches all of them

**Break it on purpose and watch it fail.**

Before trusting a guard, reintroduce the exact defect it claims to prevent and
confirm it goes red — then restore. Every fix in that session was verified this
way, and it caught more real problems than the audits did, including three cases
where the *fix* was wrong rather than the code:

- a `_headers` edit aimed at prerender markers that the build consumes, so it
  would have matched nothing and silently done nothing;
- a parity assertion comparing a `JsonLd[]` against a string, which "failed" on
  routes that were already correct;
- a test that built its own grouping map and asserted on that, never touching
  the code it named.

A guard you have not watched fail is a guard you do not know works. That is the
whole of it.

## Corollary: audit findings are hypotheses

Four confidently-argued findings from that session — each with file:line
citations — did not survive reading the code:

- a batch described as unbounded had carried a `.max(200)` cap all along;
- "counts by fetching ids" turned out to be ids that *derive storage paths*, so
  the proposed `head: true` fix would have **broken account deletion** — the
  exact GDPR failure another story had just fixed;
- a page listed as having four unbounded queries was already a correct
  `.in()` cascade, and the `select("*")` count was a shallow signal;
- "37 tests skip" was 17 when measured.

Roughly a 15% false-positive rate, and one would have introduced a bug. Treat an
audit finding — including one from an agent — as a lead to verify, never as a
conclusion to act on.

## Related

- [[grading-scale-and-weights]] — the rounding rule that shipped wrong twice is
  shape #6 in production: a value duplicated across four sites with nothing
  asserting they agreed.
- [[seo-public-route-registry]] — the lockstep registry that shape #3 failed to
  guard.
