---
slug: a-photo-rotated-wrong
title: A photo is rotated wrong
category: troubleshooting
visibility: public
audience: seller
sort_order: 30
pillar_path: /how-it-works
summary: Why a photo that looked right on your phone lands sideways, what to do about it, and why the thumbnail sometimes lags behind the fix.
faq:
  - q: Why does it look correct on my phone and wrong here?
    a: Phones often record the image one way and add a note saying which way up it should be displayed. Anything that reads the pixels and ignores the note gets it sideways.
  - q: I rotated it and the small preview is still wrong.
    a: The preview is a separate cached image. Give it a moment and reload. If it persists, that is worth reporting, because a stale thumbnail is a real bug rather than something you should have to work around.
---

A photograph that looked upright in your camera roll can arrive sideways. It is
a specific, well-known problem and it has a specific cause.

## Why it happens

Phone cameras frequently do not rotate the image when you turn the phone. They
record the pixels one way and attach a note saying which way up it should be
shown.

Every viewer that respects the note shows it correctly. Anything that reads the
pixels and ignores the note shows it sideways. That is why the same file can
look right in your gallery and wrong somewhere else, without anything being
corrupted.

## What to do

Rotate it in GradeThread. There is a rotate control on the photo, and the
rotated version is what publishes and what is assessed.

Do it here rather than in another app. Editing elsewhere and re-uploading leaves
you with two files that can disagree, and the one you fixed is not necessarily
the one that got used.

<!-- SCREENSHOT: the photo editor with the rotate control -->

## Does it affect the grade

Not materially. The assessment does not depend on the garment being the right way
up.

What it does affect is you: a sideways photo is harder to judge coverage from,
so you are more likely to think you have a good front shot when the framing is
actually poor.

It affects the listing considerably more. A sideways thumbnail in a search result
is a listing people scroll past.

## When the small preview lags

After rotating, the large image updates immediately and the small preview
occasionally does not.

Previews are generated separately and cached, so the cached one can outlive the
change for a short time. Reloading usually clears it.

If a preview stays wrong after a reload and a few minutes, report it. A stale
thumbnail that never catches up is a genuine bug, not something you should be
working around by deleting and re-uploading the photo.

## Preventing it

**Take grading photos in one orientation.** Portrait for everything, or landscape
for everything. Consistency makes a sideways one obvious immediately rather than
three steps later.

**Check the set before submitting.** The upload step shows what you added, and
ten seconds there is cheaper than a regrade.

**Do not screenshot to fix it.** Screenshotting a rotated photo and uploading the
screenshot does correct the orientation and also throws away resolution, which
costs you in the fabric assessment. Use the rotate control.

## If everything you upload is sideways

That points at the camera or the export path rather than at any one photograph.

Check whether the phone is set to a fixed orientation, and whether the photos are
coming through an app that re-encodes them. Anything that strips the orientation
note while leaving the pixels alone produces exactly this.

## Order and orientation are different problems

A photo in the wrong place in the sequence is not the same as one that is
sideways, and the fixes are different controls.

Order matters for listing photos, because the first is the thumbnail everywhere.
Order does not matter for grading photos, only coverage.

If both are wrong, fix the rotation first. Reordering a set you are about to
rotate means doing the ordering twice.

## Why we do not silently correct it

It would be possible to detect a sideways garment and rotate it automatically.

It is not done because the detection would be a guess, and a guess applied
silently to somebody's listing photograph is worse than a control they can see.
A garment photographed at an angle deliberately, or a flat-lay that genuinely
reads sideways, would both be "corrected" into something the seller did not
choose.
