---
slug: reading-a-batch
title: Reading a batch
category: autolister
visibility: public
audience: seller
sort_order: 20
pillar_path: /flipdesk/autolister
summary: What each status on a batch means, why one failed item does not stop the rest, and how to tell working from stuck.
faq:
  - q: One item failed. Does the batch stop?
    a: No. Each item is worked independently, so a failure on one costs you that one. The batch finishes and tells you which.
  - q: The batch has not moved for ten minutes. Is it stuck?
    a: Probably not yet. A batch works items in slices, so gaps between visible progress are normal. Genuine stalls are covered in the next article.
---

A batch is a queue of items being worked one at a time on the server. This is
how to read what it is telling you.

## The batch statuses

**Queued.** Created, not yet picked up. Usually brief.

**Running.** A worker has it and is working through the items.

**Completed.** Every item reached a final state, which includes items that
failed. Completed means finished, not perfect.

**Failed.** The batch itself could not proceed, as opposed to individual items
failing. Rarer, and usually a configuration problem rather than a content one.

## The per-item statuses

The batch total is less useful than the per-item detail, which is why it is
shown.

**Pending.** Waiting its turn.

**Generating.** Being drafted now.

**Done.** A draft exists. This is the outcome you want.

**Skipped.** Deliberately not attempted, usually because the item was missing
something required, like photos.

**Failed.** Attempted and did not produce a draft. The reason is recorded per
item.

<!-- SCREENSHOT: a batch with a mix of done, skipped and failed items -->

## One failure does not stop the rest

Each item is worked independently. A failure on item seven does not stop items
eight through forty.

That is deliberate, and it is the right trade at this size. Stopping the batch
on a single bad input means one item with a missing photo costs you the other
thirty-nine, and you find out an hour later.

So the batch finishes, and the summary tells you how many succeeded, how many
were skipped and how many failed, with a reason on each.

## What "not moving" looks like

Batches work in slices rather than continuously, so visible progress arrives in
steps. A gap of a minute or two between items changing status is normal, not a
stall.

A worker also reports that it is alive at intervals. That heartbeat is what
distinguishes "working on something slow" from "stopped", and it is what lets a
genuinely dead batch be picked up and finished rather than sitting forever.

If nothing has changed for a long stretch, that is covered in
[When a batch stalls](/help/autolister/when-a-batch-stalls).

## What to do when it finishes

**Skim every draft.** Most need nothing. The ones that do are usually obvious:
a title that read oddly, a price that looks wrong for the item.

**Check the prices particularly.** A batch is exactly where one systematically
wrong price becomes forty wrong prices, and it is the field with the most money
attached.

**Deal with the failures.** The reason is per item. The commonest are missing
photos and a missing required item specific, and both are quick.

**Then publish.** Publishing is a separate, deliberate step, so nothing goes
live because a batch finished.

## Re-running

You can re-run failed items after fixing them, without redoing the ones that
succeeded. That is the point of the per-item status: the batch remembers what it
already did.

Re-running a whole batch that mostly succeeded regenerates drafts you may have
already edited, which is rarely what anybody wants. Fix and re-run the failures
only.

## Skipped is not failed

Worth separating, because the two look similar in a list and mean different
things.

Skipped means the batch decided not to try: the item was missing something it
needed, usually photos. Nothing went wrong, and the fix is on the item.

Failed means it tried and could not produce a draft. That is the one worth
reading the reason on, because it points at something in the item or the channel
configuration rather than at an obvious gap.

## The summary is the useful view

A finished batch shows counts before it shows rows: how many done, how many
skipped, how many failed.

Read those three numbers first. A run that is mostly done with two failures is a
two-minute job. A run that is mostly skipped means something systematic, usually
that the selection included items which were never photographed, and the fix is
one decision rather than twenty.
