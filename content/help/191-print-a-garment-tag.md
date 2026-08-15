---
slug: print-a-garment-tag
title: Print a garment tag
category: certificates
visibility: public
audience: seller
sort_order: 20
pillar_path: /scan
summary: Producing a printable QR tag for a garment, what the code on it resolves to, and why a tag attached to the wrong garment is the failure the whole design has to guard against.
faq:
  - q: Does the tag stop working after somebody scans it?
    a: No. The printed tag is reusable and keeps working for whoever holds it until you reissue or revoke it. For a garment that ships, use the single-use claim link instead.
  - q: I printed a tag and then sold a different item. Can I reuse it?
    a: No. Print a fresh tag for the other garment and reissue the old one, which revokes it. A tag carries a specific garment's history, so moving it moves the wrong history.
---

A garment tag is a small printed square: a QR code, and a short code underneath
it in case the QR will not scan. It is bound to one garment's passport, and it
is what makes a hand-off in person work without either side typing anything.

## Making one

Open the graded item and find the Physical Passport Tag panel, below your
passport link.

1. Press **Generate tag**. The QR and the short code appear.
2. Press **Print tag**. A small print window opens with the code, the QR and one
   line of instructions already laid out. Send it to any printer.
3. Attach it to the garment. A swing tag through a buttonhole or a belt loop
   survives handling better than anything adhesive.

Allow pop-ups for the site or the print window will not open. That is the usual
reason the button appears to do nothing.

<!-- SCREENSHOT: the Physical Passport Tag panel showing a generated QR and short code (as of 2026-08-15) -->

## What the code resolves to

Scanning the QR opens a public page at `/t/<code>`. It looks up the tag, finds
the garment behind it, and offers two things: view the passport, or claim the
item.

**Viewing needs nothing.** No account, no sign-in. Anyone holding the garment
can read its full grade and ownership history on the spot, which is the point of
putting a tag on it.

**Claiming needs an account.** The tag is what authorises a claim; the account is
what signs it. Before that rule existed, anyone who scanned a rack in a shop
could take ownership of the chain anonymously, and nothing on the transfer said
who had done it.

The short code exists for the scan that fails: a cracked camera, a bad print, a
phone that will not focus. It can be typed at [the scan page](/scan) and lands in
the same place.

## The reusable tag and the single-use link

Two handoffs sit next to each other in the app, and they are for different
situations.

**The printed tag** is reusable and stays with the garment. Whoever holds it can
scan it. It keeps working until you reissue or revoke it. Right for a market
stall, a shop rail, a swap, anything handed over face to face.

**The claim link** works once and expires after 30 days. Right for a garment that
ships: you send it to one buyer, they claim, the link is spent. Creating a second
link does not cancel the first, so only make another if the first is genuinely
lost.

Pick by whether the garment and the person are ever in the same room.

## The wrong-garment failure

This is the one worth designing your own routine around, because the system
cannot catch it for you.

A tag carries a specific garment's passport. Grades, listings, sales, ownership
transfers. Attach that tag to a different jacket and the next person to scan it
reads a true history of the wrong item, with nothing on the page to suggest
anything is off. It is worse than no tag, because it is confidently wrong.

Four habits keep it from happening:

**Tag at the moment of grading.** The garment is in your hands and the passport
is on your screen. Every minute between generating and attaching is a minute the
tag can drift to the wrong pile.

**One tag per garment, printed one at a time.** A sheet of eight identical-looking
tags on a bench is exactly the situation this fails in.

**Write the item name on the tag by hand** before you attach it. Two seconds, and
it makes a mismatch visible without a scan.

**Reissue when you are unsure.** Reissuing prints a new code and revokes every
tag issued before it, so a tag you cannot account for stops resolving. A revoked
tag says "this is invalid", which is a safe answer. A tag on the wrong garment
says something false, which is not.

If you find a mistagged garment after it has left you, reissue immediately. The
old tag dies, and the person holding it gets an honest error instead of somebody
else's history.
