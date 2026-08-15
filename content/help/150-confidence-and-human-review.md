---
slug: confidence-and-human-review
title: Confidence and human review
category: grading
visibility: public
audience: all
sort_order: 50
pillar_path: /grading/methodology
summary: What the confidence score measures, the threshold that sends a grade to a person, and why a held grade is the system working rather than failing.
faq:
  - q: Why is my grade under review?
    a: The model's confidence came in below the threshold, so a person looks at it before it publishes. The commonest cause is a photo that hid something, not a garment that was genuinely hard to call.
  - q: Does a reviewed grade look different to a buyer?
    a: The certificate says the grade was checked by a human reviewer. That is a stronger claim than an unreviewed one, not a weaker one.
---

Every grade carries a confidence score alongside the number. Confidence is not
a second opinion on the garment; it is the model's own assessment of how much
the photos actually told it.

## What confidence measures

How much of the judgement rests on evidence versus inference.

Four clear, well-lit photos of a garment with an obvious, visible condition
produce high confidence. The model can see the fabric surface, the seams, the
hardware and the label, so almost nothing is being guessed.

A folded garment shot in low light with an unreadable label produces low
confidence. The score may still be about right, but it is standing on less.

Confidence goes down when:

- Photos are dark, blurry, small in frame or angled
- Folds or a hanger hide part of the garment
- The care label cannot be read, so the fabric is unknown
- The visible evidence disagrees with itself, for instance a pristine front and
  a heavily worn back
- Something in one photo hints at a flaw that no photo actually shows

## The threshold

Below **0.75**, the grade is held for human review rather than published.

That number is fixed and published, like the factor weights, and for the same
reason: a threshold that moves is a threshold that can be moved to whatever
produces the convenient answer.

A reviewer sees the same photos and the model's proposed scores, and either
confirms the grade or adjusts it. The published grade is then the reviewed one.

## Why holding it is the right behaviour

A low-confidence grade published immediately is the worst outcome available. It
looks exactly like a confident grade, carries the same certificate, and is
wrong more often. The buyer has no way to tell the two apart, which is exactly
the trust problem grading exists to fix.

So the system would rather be slower than be confidently wrong. That is a
deliberate trade and it is the reason the accuracy figures on the
[transparency report](/transparency) are worth reading: they are measured
against expert reviewers, on the published grades.

## What to do when yours is held

Usually, nothing. It goes to a person and comes back.

If you would rather not wait, the fastest fix is almost always more photos.
Look at what the report says it was unsure about, shoot that, and resubmit.
Nine times in ten it is the label, the back, or a flaw that was mentioned but
never pictured.

[The photos we need](/help/grading/the-photos-we-need) is the checklist.

## The counterintuitive bit

Photographing a flaw raises confidence.

Sellers instinctively leave the snag out of frame, expecting a better grade. It
does not work like that. The flaw costs a fraction of a point in whichever
factor it belongs to. Hiding it does not remove that cost; it removes the
model's ability to be sure about anything near it, which drops confidence and
holds the whole grade.

Then the buyer finds the snag anyway. A photographed flaw is a line in your
description; an unphotographed one is a return.

## What review is not

It is not a quality complaint process. If you disagree with a published grade,
that is a dispute, which is a different mechanism with a different route. See
[Disputes and regrades](/help/grading/disputes-and-regrades).

It is also not a queue you can pay to skip. Review exists to protect the
meaning of the number on the certificate, and a grade that could be pushed
through faster for money would not be worth much to a buyer.

## Why the threshold is published

The same reason the factor weights are. A threshold nobody can see is a
threshold that can be moved when the queue gets long, and the first time that
happens the accuracy figures stop meaning anything.

At 0.75 the split is deliberately conservative: it holds more grades than the
strict minimum would, and the cost of that lands on us as review time rather
than on a buyer as a wrong certificate.

## What a reviewer actually does

They see the photos, the model's proposed factor scores, and its written
summary. They do not see who submitted it or what the seller hoped for, because
neither is evidence about the garment.

They can confirm the grade unchanged, or adjust individual factors, which
recomputes the overall through the same fixed weights. What they cannot do is
type a different overall number directly, because a reviewer who can override
the arithmetic is a reviewer who can produce a grade the rubric does not
support.
