---
slug: when-a-site-stops-working
title: When a site stops working
category: extension
visibility: public
audience: all
sort_order: 90
pillar_path: /flipdesk
summary: What a marketplace redesign breaks, how to find out which part in about ten seconds, and what to send so it can be fixed quickly.
faq:
  - q: Why does the extension break when a marketplace redesigns?
    a: Because it finds fields by looking for them on the page. A redesign moves them, and a field that has moved is a field that cannot be found.
  - q: What should I send in a ticket?
    a: The selector report from the popup. It names the host, the version and which specific selectors missed, and it deliberately contains no page content and no full URL.
---

Marketplaces redesign their forms without notice, and a redesign moves the
fields the extension looks for. This is how to tell what broke and what to send.

## What breaking looks like

**The overlay does not appear.** The extension did not recognise the page as a
listing.

**A condition check returns nothing.** It could not find the photo gallery.

**A lister run stops part way.** A form field it needed was not where it was.

**A delist does nothing.** The menu it opens is not the menu that is there now.

All four are the same underlying cause. Nothing is corrupted and no data is
lost; the extension is looking for something that has moved.

## Check selectors

The popup has a **Check selectors** action. Open the marketplace page in
question, run it, and it tests every selector for that platform against the live
page and hands back a report.

The report names the host, the selector version, and a verdict per selector. That
tells you, in about ten seconds, whether the problem is one field or the whole
adapter.

It deliberately contains **no page content and no full URL**, because it is
written to be pasted into a ticket or a message. Controls that only exist after
an interaction, like a menu item inside a menu that has not been opened, are
reported as such rather than as misses.

<!-- SCREENSHOT: a selector report with two misses highlighted -->

## What to do meanwhile

**For listing:** do it manually on the channel. The draft is in FlipDesk, so it
is a copy and paste rather than rewriting.

**For delisting:** end it by hand and mark it in FlipDesk, so the item's state
stays honest.

**For condition checks:** try the right-click "Grade this image" on a photo. It
does not depend on the gallery detector, so it often works when the automatic
extraction does not.

## Reporting it

Open a ticket with the selector report, the marketplace, and what you were trying
to do.

That combination is usually enough to fix it without a conversation, because the
report says which selector missed and the adapter is one file. What is not useful
is a screenshot of the overlay not appearing, because the interesting part is
what the page looks like underneath.

## Why this is a permanent feature of the design

The channels that need the extension are the channels with no seller API. There
is no supported interface to build against, so the only available approach is to
work with the page a human would see.

That approach breaks when the page changes. The alternative is not a more robust
extension; the alternative is not supporting those channels at all.

What can be done, and is, is failing loudly rather than guessing. A field the
extension cannot find is reported as missing. It does not fall back to "the third
input on the page", because that keeps matching after a redesign and types a
price into whatever now sits there, which is worse than not working.

## Checking before you need it

If you cross-post regularly, running Check selectors on your usual channels once
a month costs a minute and turns a surprise mid-run into something you already
knew.

## Why fail loudly is the right default

There is a tempting alternative to reporting a missing field: fall back to
something positional, like the third text input on the page.

That is worse than not working. A positional selector keeps matching after a
redesign and quietly types into whatever now sits in that position, so a price
lands in a description field, or a title lands somewhere invisible, and the
listing goes live wrong.

So the extension does not guess. A field it cannot find is reported as missing
and the run stops. That is a worse afternoon and a much better outcome.

## Recovering an interrupted run

An interrupted cross-post leaves some channels done and some not. The item's
listing records show which succeeded, so the correct next step is visible rather
than guessed.

Finish the remainder by hand and mark them, or wait for a fix and re-run only the
channels that failed. Do not re-run the whole batch: the channels that already
succeeded would get a second listing, and two live listings for one garment is
the problem cross-posting exists to avoid.
