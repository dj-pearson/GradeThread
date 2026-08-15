---
slug: embed-a-grade-badge
title: Embed a grade badge
category: certificates
visibility: public
audience: seller
sort_order: 30
pillar_path: /grading-standard
summary: The three copy-and-paste formats on a certificate, which one belongs on which surface, and the rule that a grade never appears in a marketplace photo gallery.
faq:
  - q: Which format do I use for an eBay or Poshmark listing?
    a: The plain text one, with the verify URL deleted and the certificate number put in its place. Marketplace descriptions strip HTML and forbid off-site links, so a grade line plus a number is the only version that both survives and stays within the rules.
  - q: Can I put the graded photo in my listing gallery?
    a: No. A marketplace treats a third-party grading mark among the listing photos as a policy problem, whether it is burned onto your photo or a separate generated image. Keep the grade in the description text.
---

Three formats sit on every certificate, under "Add this badge to your listing".
They carry the same grade and differ only in where they can survive.

## The three formats

**Script.** One line you paste into a page you control: your own shop, a Shopify
product page, a blog post. It renders a live card with the score, the tier and a
link through to the certificate. Because it renders at view time, a revised grade
shows through instead of leaving a stale number on your site.

**HTML image.** An image tag pointing at the badge, wrapped in a link. For places
that allow some HTML but will not run a script. Older marketplace description
editors are the usual case.

**Plain text.** A single line of words, for places that strip HTML entirely.
Read it before you paste it: as copied, it ends with a verify URL. On your own
site or in a message that is exactly what you want. In a marketplace description
it is a link, and links are the one thing a marketplace description must not
carry (see below). Delete the URL and put the certificate number in its place.

Copy any of them with the button beside the field. The certificate id is already
filled in, so there is nothing to edit.

<!-- SCREENSHOT: the three copy fields under "Add this badge to your listing" on a certificate (as of 2026-08-15) -->

## What the share card is, and why it is not on that list

Paste a certificate link into a message, a forum or a social post and a preview
appears with the garment photo and the grade. That is the share card. It is
generated for you and there is nothing to configure or copy. You do not place it
anywhere; it happens because you shared the link.

The graded photo, the one with the score and a scannable code burned in, is the
image that card uses. Download it for a social post or your own store. Do not
attach it to a marketplace listing.

## The rule about listing photos

**A grade never appears in a marketplace photo gallery.** Not burned onto your
own photo, and not as a separate generated card sitting beside your photos.

The reason is one-sided risk rather than taste. Several marketplaces treat a
third-party grading mark among the listing images as a policy matter, and eBay's
exposure is specifically about what is in the gallery. If it goes wrong, the
account loses every listing on it, not just the one. The description text carries
exactly the same information, so the upside of the image was small and the
downside was everything.

This was a real feature once. A switch existed to add a grade card to the
gallery, and it was removed rather than turned off, along with the code that
produced the image, so it cannot come back by accident.

## No links in a marketplace description either

An off-site URL in an eBay description reads as an offer to trade outside eBay,
and the observed result is a hidden listing. A bare domain counts. Publishing
through FlipDesk strips links out for you, including out of drafts saved before
the rule existed.

So on a marketplace, the badge is the plain-text format with the URL taken out:
a grade line and the certificate number a buyer can type at
[the verify page](/verify). The copy button does not do that edit for you, so do
it yourself before pasting. Publishing
also adds a structured `Condition Grade` item specific with the value
`GradeThread X.X`, which puts the grade in the field a buyer looks at next to
size and material.

## Which to use where

- **eBay, Poshmark, Mercari, Depop, Grailed, Vinted:** plain text, URL removed,
  certificate number in its place.
- **Your own shop or blog:** the script.
- **A page that allows HTML but not scripts:** the HTML image.
- **A social post or a message:** just paste the link and let the share card do
  the work.

## Accessibility and weight

The badge is an image, and its alternative text reads "GradeThread Verified
condition grade". A screen reader announces that rather than "image", which is
better than nothing and is honestly less than the badge shows: the number and
the tier are drawn in the picture, not in the text. If the grade itself matters
on your page, write it out beside the badge rather than relying on the image to
say it. On a marketplace this problem does not arise, because the text format is
all you should be pasting anyway.

If you are wiring the badge into a template, a theme, or anything with
parameters, [Embeds and badges](/help/integrations/embeds-and-badges) covers the
developer side: the widget, the options, and how the formats behave on a page you
control. This article is the copy-and-paste path; that one is the build path.
