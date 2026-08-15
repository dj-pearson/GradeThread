---
slug: condition-check-on-a-listing
title: Condition Check on a listing
category: extension
visibility: public
audience: buyer
sort_order: 30
pillar_path: /condition-grading
summary: An independent read of a listing's condition from its own photos, how many photos it uses, and the three ways to trigger one.
faq:
  - q: Is this the same grade the seller would get?
    a: It uses the same rubric on the seller's own listing photos. Those are usually styled rather than flat, so confidence tends to be lower than a proper submission would produce.
  - q: Does it run automatically?
    a: Only if you turn that on. It is off by default because each run spends a Vision call, and a setting that quietly spends things should not default to on.
---

Condition Check reads a marketplace listing's own photos and gives you an
independent condition assessment. It is the buyer's half of the product: the
seller says "excellent condition", and this says what the pictures actually
show.

## Triggering one

**Click the extension.** On a listing page, open the popup and run the check.

**Alt+G.** The keyboard shortcut, for when you are moving quickly through
candidates.

**Right-click an image.** "Grade this image" runs against that specific picture.
This exists because the gallery detector cannot always find every photo on every
site, and a right-click is a reliable way to point at the one you meant.

It does not run automatically unless you switch that on in the options. The
default is off, because each run spends a Vision call, and a setting that quietly
spends things should not be on by default.

<!-- SCREENSHOT: the overlay on an eBay listing showing a score and factors (as of 2026-08-15) -->

## How many photos it uses

Anonymously, up to **four**. Signed in on a paid buyer plan, up to **eight**.

The cap matters more than it sounds. Condition lives in details, and four photos
of a jacket often means the front, the back and two styled shots, none of which
show a cuff. Eight usually reaches the close-ups.

The client knows its own cap before it extracts the gallery, so it collects the
right number rather than sending four and never learning it could have sent
eight. The server enforces the real cap regardless, so the number cannot be
raised from the browser.

Photos served at two sizes are collapsed to one, so a gallery of eight thumbnails
and eight full-size versions is eight photos rather than sixteen.

## Reading the result

The same shape as any GradeThread report: an overall score on the 1.0 to 10.0
scale, a tier, the five factors with their published weights, and a confidence
figure.

Expect lower confidence than a proper submission. Listing photos are styled to
sell rather than shot flat under even light, and the care label is usually not
photographed at all, which removes the fabric information the heaviest factor
depends on.

That is not a defect, it is the honest consequence of assessing somebody else's
photos. A low-confidence read is still useful as a check on a seller's
description; it is not a certificate.

## What it is for

**Sanity-checking a description.** A listing that says "excellent" over photos
showing visible pilling is a listing to walk away from.

**Comparing candidates.** Six of the same jacket at six prices is the normal
situation, and the compare tray exists for exactly that. See
[The compare tray](/help/extension/the-compare-tray).

**Building a picture of a seller.** Repeated reads of the same seller start to
say something about how they describe things. See
[Seller memory](/help/extension/seller-memory).

## What it is not

Not a certificate. A certificate is produced from photos shot for grading, at
the required angles, with the label legible, and it can be shared as proof. A
Condition Check is a private read for your own decision.

Not authenticity. Nothing here decides whether the item is genuine.

Not something the seller sees. The read happens in your browser against a public
page. Nothing is sent to them and nothing is attached to their account.

## When a read disagrees with the seller

The interesting case, and the one the feature exists for.

A read materially below the stated condition usually means one of three things.
The seller is describing generously, which is common and rarely malicious. The
photos are hiding something, which is worth asking about. Or the photos are
simply poor, in which case the read's confidence will be low and you should
weigh it accordingly.

Ask before assuming. A message saying "could you photograph the cuffs and the
underarms" costs nothing and resolves nearly all of these. A seller who answers
promptly with more photos is usually a seller worth buying from.

## What it costs

Anonymously it is free within a capped quota, enforced on the server.

Signed in on a paid buyer plan the cap is higher and the read is deeper. There is
no per-read charge to think about while shopping, which is deliberate: a feature
you have to ration is a feature you stop using at the moment it would have helped.
