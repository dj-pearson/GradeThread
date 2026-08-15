---
slug: embeds-and-badges
title: Embeds and badges
category: integrations
visibility: public
audience: developer
sort_order: 50
pillar_path: /developers
summary: Putting a grade on your own site, which format suits which surface, and why a badge belongs in the description rather than on a listing photo.
faq:
  - q: Can I put the badge on my marketplace listing photos?
    a: Don't. Several marketplaces treat overlaid graphics on listing images as a policy problem, and a removed listing costs more than the badge was worth. Put the grade in the description as text.
  - q: Does an embed update if the grade is revised?
    a: Yes. Embeds render the current grade, so a revision shows through rather than leaving a stale number on your site.
---

Three ways to show a grade outside GradeThread, for three different surfaces.

## The badge

A small image showing the score and tier. It links to the full certificate.

Right for a product page on your own shop, a sidebar, or anywhere you want a
compact trust mark that a reader can click for the detail.

## The embed

A richer block: score, tier, factor breakdown, and a link through.

Right for a product page where condition is a significant part of the decision.
It carries enough that a buyer does not need to leave, and a link for the one who
wants to.

## The share card

Not something you place; it is what appears when the certificate link is pasted
into a message, a forum or a social post. It is generated automatically and there
is nothing to configure.

<!-- SCREENSHOT: a badge and an embed side by side on a product page -->

## Not on listing photos

The one placement to avoid, and it is worth being blunt about.

Several marketplaces treat overlaid graphics on listing images as a policy
problem, and enforcement is inconsistent enough that you may get away with it for
months and then lose a listing.

The alternative costs nothing and works everywhere: state the grade as text in
the description and put the certificate link near the top. A buyer who cares
clicks it, which is more valuable than a graphic they cannot verify anyway.

## They stay current

An embedded grade renders the current value. If a grade is revised, by a dispute
or a regrade, your site shows the new one without you doing anything.

That is the correct behaviour and it is worth knowing about: you are embedding a
live reference rather than copying a number, so a revision reaches your site the
same way it reaches the certificate.

## Performance

Embeds are served from the edge and cached. A page with several on it is not
making several slow round trips.

Give the badge or embed explicit dimensions in your own layout so it does not
shift the page as it loads. Layout shift is a real ranking factor on your site
and it is entirely in your control.

## Accessibility

The badge is an image and needs alternative text. Say the score and the tier:
"GradeThread condition grade 8.2, Excellent" is useful to a screen reader in a
way that "grade badge" is not.

The embed carries its own semantics, so it needs nothing extra.

## Which to pick

**Badge** where space is tight and the grade is supporting evidence.

**Embed** where condition is central to the decision and you want the factor
breakdown visible.

**Neither, just a text link** on a marketplace listing, for the policy reason
above. That is not a lesser option: the link is what a hesitating buyer clicks,
and it is the part that actually converts.

## A pattern that works

On your own product page: the embed near the condition section, and a plain text
line stating the grade and tier in the copy itself.

The text line is there for the reader who never looks at widgets and for anything
that renders your page without them. The embed is there for the reader who wants
the factor breakdown without leaving.

## Do not screenshot it

The temptation is to screenshot an embed and use the image, which is faster than
integrating anything.

It is also a number that will never change again. A revised grade updates the
embed and does not update your screenshot, so the day a grade is corrected your
site is showing a figure the certificate no longer supports, and pointing at your
own image is not a defence.
