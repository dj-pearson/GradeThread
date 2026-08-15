---
slug: ops-the-review-queue
title: "Operator: the grading review queue"
category: troubleshooting
visibility: internal
audience: operator
sort_order: 100
pillar_path: /transparency
summary: What lands in the human review queue, what a reviewer may and may not change, and why the queue is never cleared for speed.
faq:
  - q: Can a reviewer set the overall score directly?
    a: No. They adjust factor scores and the overall recomputes through the fixed weights. A reviewer who could type the total could produce a grade the rubric does not support.
  - q: What if the queue is long?
    a: It gets worked. The threshold does not move to shorten it, because a threshold that moves under load is a threshold that means nothing.
---

Internal. This is the operating rule for the queue, not a runbook; the procedure
lives in the `grading-engine` skill and should be loaded before touching any
grading code.

## What lands here

Any grade whose confidence came in below the published threshold of 0.75.

Confidence measures how much of the assessment rests on evidence rather than
inference. It goes down on dark, folded or angled photographs, on an unreadable
care label, and when the visible evidence disagrees with itself.

Most held grades are held because of the photographs rather than because the
garment was genuinely ambiguous. That is worth remembering when the queue is
long: the correct response is usually to review, not to conclude the threshold
is wrong.

## What a reviewer sees

The photographs, the proposed factor scores, and the written summary.

Not who submitted it, and not what they hoped for. Neither is evidence about the
garment, and both would bias a judgement that has to be about the garment alone.

## What a reviewer may change

Individual factor scores. The overall recomputes through the same fixed weights.

**A reviewer cannot type an overall score directly.** That is a deliberate
constraint, not a missing feature: somebody who can override the arithmetic can
produce a grade the published rubric does not support, and the rubric being
inescapable is the entire reason a grade is worth anything.

## The threshold does not move

0.75 is published, alongside the factor weights, and for the same reason.

A threshold nobody can see is a threshold that gets raised quietly when the queue
gets long, and the first time that happens the accuracy figures on
[the transparency report](/transparency) stop describing anything real.

If throughput is the problem, the answer is reviewers or better guidance to
sellers on photographs. It is not the threshold.

## What a review changes downstream

A reviewed grade publishes with that fact recorded, and the certificate says a
human checked it. That is a stronger claim than an unreviewed grade, and buyers
read it as one.

Reviewed outcomes also feed the published agreement figures, which is what makes
those figures a measurement rather than an assertion.

## Working the queue

Oldest first, unless something is time-sensitive for an obvious reason.

Consistency matters more than speed. Two reviewers applying the rubric slightly
differently produce a corpus where the grade depends on who happened to pick it
up, which is precisely the property the published rubric exists to remove.

When a case is genuinely unclear, the rubric is the tie-breaker, not instinct.
The criteria for each band are published, and a reviewer whose judgement
disagrees with the published criteria should change the judgement rather than the
criteria.

## When the photographs are unusable

Confirm at the proposed grade with the low confidence intact, rather than
guessing at a better number.

A reviewer cannot see more than the photographs contain either. Publishing a
confident-looking grade from unusable evidence is the exact outcome the
confidence threshold exists to prevent, and a reviewer doing it by hand is worse
than the model doing it, not better.

## What a long queue actually means

Almost always one of two things, and they need different responses.

**Photograph quality across the board.** If the held share rises without a
prompt change, sellers are submitting worse evidence. The fix is guidance, not
review capacity: better prompts in the capture flow, and pointing people at
[The photos we need](/help/grading/the-photos-we-need).

**A prompt version pushing more submissions under the threshold.** That is a
canary that should not have widened, and it is covered in the prompt versions
article. Watch the review-queue rate during a canary for exactly this reason.

Adding reviewers fixes the symptom of both and the cause of neither.

## Related

- The `grading-engine` skill: the full contract, rounding lockstep, prompt
  version lifecycle, golden set rules, exemplar privacy.
- [[grading-scale-and-weights]] in the vault: the weights and what they mean.
- The admin reviews surface in the app is where the work happens.
