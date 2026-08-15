---
slug: when-a-batch-stalls
title: When a batch stalls
category: autolister
visibility: public
audience: seller
sort_order: 30
pillar_path: /flipdesk/autolister
summary: How to tell a slow batch from a dead one, what happens automatically to a batch whose worker went away, and what to do about the items that never made it.
faq:
  - q: Will a dead batch recover on its own?
    a: Yes, in most cases. A batch whose worker stopped reporting is reclaimed after a while and picked up again, so the usual correct action is to wait once and then look.
  - q: Should I start a second batch for the same items?
    a: No. Wait for the first to be reclaimed or finish. Two batches on the same items produce two drafts each, and you then have to work out which to keep.
---

Batches run on the server and occasionally something goes wrong out there. This
is how to tell what, and what to do.

## Slow is not stalled

Batches work in slices, so progress arrives in steps rather than continuously. A
minute or two between items changing status is normal.

The signal that matters is not whether the number moved recently; it is whether
the worker is still reporting. A running worker says so at intervals, and that
heartbeat is what distinguishes a batch working on something slow from a batch
nobody is working on.

Before doing anything, refresh and look once more. Most batches that look stuck
are working.

## What happens automatically

A batch whose worker stops reporting for long enough is **reclaimed**: released
back to the queue and picked up again.

This is the normal recovery for the normal failure, which is a worker being
restarted mid-batch during a deploy. Nothing is lost, because items that already
have drafts are not redone.

So the usual correct action for a batch that has genuinely stopped is to wait
once, then look again. Most of the time it has resumed on its own and the items
that were pending are now done.

<!-- SCREENSHOT: a batch that was reclaimed, showing the resumed progress (as of 2026-08-15) -->

## When it does not recover

Three things worth checking, in this order.

**Are the items actually ready?** Items missing photos are skipped rather than
drafted. A batch that "did nothing" quite often did exactly what it should and
skipped everything, and the per-item reason says so.

**Did the whole batch fail rather than the items?** A batch-level failure is a
different state from a pile of failed items, and it usually means a
configuration problem rather than a content one.

**Is anything else in the app misbehaving?** Check the
[system status page](/status) before assuming the batch is the problem. If
grading and publishing are also failing, the batch is a symptom.

## Do not start a second batch

The tempting move is to start again with the same items. Do not.

Two batches over the same items produce two drafts each, and you then have to
work out which one to keep, per item, for every item. That is a worse afternoon
than the one you were trying to avoid.

Wait for the reclaim, or deal with the failures individually.

## The items that never made it

Whatever happened, the items themselves are fine. A batch is a queue of work
over your inventory, not a container holding it. An item that was never drafted
is still catalogued, still photographed and still graded.

Draft it in the composer, or fix whatever caused the skip and re-run just the
failures. The batch remembers what it already did, so re-running failures does
not regenerate drafts you may have already edited.

## If it is genuinely stuck

Open a ticket with the batch and roughly when you started it. Batch state is
recorded on the server, so the answer to "what actually happened to this one" is
usually a short look rather than an investigation, and it is the kind of question
that is answerable in one reply.

## What to include if you report one

Three things make a stalled batch answerable in one reply rather than three.

The batch itself, roughly when you started it, and how many items it had. Batch
state is recorded on the server, so with those three the answer is usually a
short look at what the worker did and when it stopped reporting.

What is not useful is a screenshot of the spinner, because the interesting part
is on the other side of it.
