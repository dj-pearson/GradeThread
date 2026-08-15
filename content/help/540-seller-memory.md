---
slug: seller-memory
title: Seller memory
category: extension
visibility: public
audience: buyer
sort_order: 50
pillar_path: /transparency
summary: Your own pattern with one seller, built from your own reads, kept entirely on your device and never sent anywhere.
faq:
  - q: Is this a rating of the seller?
    a: No. It is a record of your own reads, phrased as your pattern rather than as a verdict. A handful of unconfirmed reads is not a basis for scoring somebody's honesty.
  - q: Does the seller know?
    a: No, and there is nothing to know. The seller's handle never leaves your device, and nothing is written to any reputation record on our side.
---

After two or more reads of the same seller, the overlay starts telling you
something the individual reads cannot: your own pattern with that person.

## What it says

Something of the shape "your four reads of this seller average 1.8 points below
their stated condition".

That is a statement about your reads, not a verdict on the seller. The wording
is deliberate, because the two are genuinely different claims and only one of
them is supportable from a handful of observations.

The popup also has a By seller view, which groups your recent reads by who was
selling.

<!-- SCREENSHOT: the overlay showing a seller pattern after several reads -->

## Where it lives

Entirely on your device.

The seller's handle is stored in your browser's own storage alongside each read.
It is **never attached to a grading request**, never sent in telemetry, and never
included in anything that leaves the machine. The comparison is computed locally
from what you already have.

Nothing is written to any reputation record on our side. There are tables in
GradeThread for seller reputation and buyer trust, and this feature deliberately
writes to neither, because a seller-adverse score needs a proper model and a
human-confirmed basis, and a few unconfirmed reads by one shopper is not that.

## Why it is not a public rating

The temptation with data like this is obvious: aggregate every shopper's reads
into a public seller score.

It is not built that way on purpose. A read from a listing's own styled photos
carries low confidence, and the discrepancy between a read and a stated condition
can come from the photos rather than from the seller. Turning that into a public
number would be publishing an accusation derived from a measurement that is not
strong enough to support it.

Your own pattern, kept to yourself, is a fair use of the same data. A public
score is not.

## What the "claimed" figure is

The comparison needs to know what the seller said, and that comes from the
discrepancy information the endpoint returns, which is a paid signal and is
therefore often absent.

When it is absent, nothing is recorded rather than a zero. That matters: storing
zero would let "no claim available" be averaged in as "claimed nothing", which
would drag every seller's apparent honesty downwards for a reason that has
nothing to do with them.

## Clearing it

Clear your recent reads from the options page, or clear the browser's storage
for the extension. Both remove it completely, because both are the only place it
was.

Uninstalling the extension removes it too, for the same reason.

## What two reads can and cannot tell you

Two reads is barely a pattern. Ten is a signal. The wording of the overlay
reflects that: it says what your reads averaged, and it does not tell you what to
conclude.

Interpret it as you would any small sample. A seller consistently a point below
their claim across ten reads is describing generously, and knowing that is worth
something when you are deciding whether to ask for more photos or simply pass.

A seller half a point below across two reads is noise.

## Why it changes how you shop rather than what you see

The feature does not filter listings or reorder anything. It adds a line to the
overlay when there is something to say.

That is intentional. A tool that quietly demoted certain sellers in your view
would be making a judgement on your behalf from data too thin to support it, and
you would have no way to notice it was happening.

Telling you your own pattern and letting you decide is the version of this that
can be defended.
