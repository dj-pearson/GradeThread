---
slug: writing-a-listing-in-the-composer
title: Writing a listing in the composer
category: flipdesk
visibility: public
audience: seller
sort_order: 80
pillar_path: /sell-used-clothes-ebay
summary: What the composer owns versus what the marketplace owns, how the grade reaches the text, and why a field can be locked once a listing is live.
faq:
  - q: Why can I not edit a field on a live listing?
    a: Some fields are fixed by the marketplace once a listing is published, and a few more become risky to change mid-sale. The composer locks those rather than letting a save fail at the far end.
  - q: Does editing here change the live listing?
    a: On a live item, saving queues a revision to the channel. On a draft, it changes only the draft. The composer says which mode it is in at the top.
---

The composer is the one editor for an item, whatever state it is in. Draft,
live, or closed, you edit it in the same place, and what changes is what the
save does.

## The two modes

**Draft.** Nothing is published. Everything is editable and saving affects only
your own copy.

**Live.** The listing exists on a marketplace. Saving queues a revision, which
is sent to the channel and can be rejected by it.

The header says which mode you are in, and it matters: in draft mode a mistake
costs nothing, and in live mode it is a change to something a buyer might be
looking at right now.

## What the composer owns

**Title.** The single biggest lever on whether anybody finds the listing.
Brand, item, size and the distinguishing detail, in the order people search.
Channels have different length limits and the composer shows the one that
applies.

**Description.** The body. The grade report's condition summary is offered here
because it is already an honest, specific account of the condition, which is the
part sellers find hardest to write.

**Price.** Carried from the comps stage, editable.

**Item specifics.** The structured fields a marketplace asks for: brand, size,
colour, material, style. Filled from what you catalogued rather than typed
again.

**Photos.** In the order you set. The first is the thumbnail everywhere.

<!-- SCREENSHOT: the composer in draft mode with specifics filled -->

## What the marketplace owns

Some things are not yours to set, and the composer does not pretend otherwise.

**Category.** eBay's category tree decides which specifics are required, and
changing it on a live listing is restricted.

**The condition value.** You pick from the marketplace's list, and the grade
suggests which. See
[Condition mapping](/help/marketplaces/condition-mapping).

**Business policies.** Postage, returns and payment come from policies held on
your marketplace account, not from here.

## Locked fields

On a live listing some fields grey out. Two reasons.

Some are fixed by the marketplace after publication, so an edit would be
rejected at the far end. Locking them here means you find out before you type
rather than after a save fails.

A few more are locked because changing them mid-sale is risky rather than
impossible: a category change on a listing with watchers can reset its search
placement. The composer explains which reason applies rather than just refusing.

## Item specifics and the 65-character limit

One trap worth knowing before it bites. eBay rejects any item specific value
longer than 65 characters, and it does so at publish time rather than while you
type.

The composer flags anything over the limit as you go, so the failure happens at
your keyboard rather than as a stuck offer half an hour later. The full story is
in
[Item specifics and the 65-character limit](/help/marketplaces/item-specifics-and-the-65-character-limit).

## What AI drafts, and what it does not

The composer can draft a title and description from the item and its grade. It
is a draft, and the good ones get edited.

It will not invent a flaw the grade did not find, and it will not claim
authenticity. Both are deliberate: a description that overstates condition is
the exact thing grading exists to stop, and a service that let its own copywriter
undo that would be working against itself.

## Saving

Draft mode saves silently and often. Live mode asks, because a revision goes out
to the channel, and tells you when the channel accepted it rather than assuming.
If a revision is rejected, the reason is shown and your draft keeps the change so
you can fix it rather than retyping.

## One editor, every state

There is one composer, and it is the same screen whether the item is a draft, a
live listing or a closed one.

That is deliberate. A separate editor for drafts and another for live listings
means two implementations of the same fields, and the day they disagree is the
day an edit silently does not apply. One editor with a mode is easier to trust.
