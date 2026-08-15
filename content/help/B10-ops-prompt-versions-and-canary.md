---
slug: ops-prompt-versions-and-canary
title: "Operator: prompt versions and the canary"
category: troubleshooting
visibility: internal
audience: operator
sort_order: 110
pillar_path: /grading/methodology
summary: Why a grading prompt is never swapped in place, the three stages every version passes through, and what the golden set is protecting.
faq:
  - q: Can a prompt change go straight to everyone?
    a: No. Shadow, then the eval gate, then canary. A prompt that changes grades is a prompt that changes what every published certificate meant, so the sequence is not optional.
  - q: What is the golden set for?
    a: A fixed set of garments with known correct grades. It is how a change is measured rather than eyeballed, and it is why "it seemed better" is not an argument.
---

Internal. The procedure lives in the `grading-engine` skill, which must be
loaded before editing any grading code. This is the shape and the reasoning.

## Why versions rather than edits

A grading prompt is not application code. Changing it changes what a grade
means, retroactively, for everybody comparing a new certificate against an old
one.

So prompts are versioned and a new version is a new thing, never an edit to the
running one. That makes a regression attributable and reversible, and it makes
"was this graded before or after the change" an answerable question.

## The three stages

**Shadow.** The new version runs alongside the live one on real submissions
without publishing anything. The comparison is free and nobody is affected.

**The eval gate.** The shadow output is measured against the golden set. A
version that has not cleared the gate does not proceed, regardless of how good
it looked.

**Canary.** A small share of live traffic, watched. If it holds, it widens.

Skipping a stage is the failure mode this exists to prevent, and the stage most
often skipped under pressure is the middle one, because the shadow output
usually looks fine.

## The golden set

A fixed collection of garments with known correct grades.

It exists so that a change is measured rather than assessed by eye. "It seemed
to handle denim better" is an impression; a movement against the golden set is a
number, and only one of those can be argued with.

Rules about what may enter the golden set and how it is kept representative are
in the `grading-engine` skill. Adding a case because a version failed it is the
specific thing that must not happen.

## Exemplar privacy

Few-shot exemplars come from real submissions, which belong to real customers.

The handling rules are in the skill and they are not optional. A grading prompt
that leaks a customer's garment into another customer's assessment context is a
privacy incident, not a quality issue.

## Rounding stays in lockstep

Rounding happens in more than one place, and all of them must agree. A version
change that alters rounding in one site and not the others produces grades that
disagree with themselves between the report, the certificate and the API.

The skill names the sites. Check all of them.

## What to watch during a canary

Not only the mean. A version that moves the average slightly can be moving one
band a long way.

Watch the distribution by band, the confidence distribution, and the review-queue
rate. A change that quietly pushes more submissions under the threshold has made
the queue somebody else's problem rather than improved anything.

## Rolling back

A canary that does not hold rolls back to the previous version, and that is a
normal outcome rather than a failure worth avoiding.

Versioning exists so that rolling back is one action. A change shipped in a way
that cannot be rolled back has given up the main benefit of the whole scheme.

## What never goes in a prompt

Anything that would make a grade depend on who submitted it: the seller's plan,
their level, their history, their standing.

A grade that varies with the submitter is a grade that means different things for
different people, which is the single property this product exists to remove. It
would also be undetectable from outside, which makes it worse than an ordinary
bug.

The model sees the garment and the metadata about the garment. It does not see
the account.

## Related

- The `grading-engine` skill: the full lifecycle, the golden-set rules, the
  rounding sites, exemplar privacy.
- [[grading-prompt-channels]] in the vault.
- [[grading-scale-and-weights]] for the weights a prompt must keep producing.
