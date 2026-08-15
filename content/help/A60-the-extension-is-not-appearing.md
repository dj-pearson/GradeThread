---
slug: the-extension-is-not-appearing
title: The extension is not appearing
category: troubleshooting
visibility: public
audience: all
sort_order: 70
pillar_path: /flipdesk
summary: Six things to check when the overlay does not show up, ending with the selector report that turns a guess into an answer.
faq:
  - q: What is the fastest way to find out what broke?
    a: Open the popup and run Check selectors on the page in question. It tests every selector against the live page and names the misses, which is a ten-second answer instead of an afternoon.
  - q: Why does it stop working after a marketplace redesign?
    a: Because it finds fields by looking for them. A redesign moves them, and a field that has moved is a field that cannot be found.
---

Work down this list. The first four take seconds and catch most cases.

## 1. Is it a supported site

The extension runs on eBay, Poshmark, Grailed, Mercari, Depop and Vinted, and
nowhere else.

That is by design rather than by omission: the permissions list those sites one
at a time, so there is no wildcard giving it access anywhere else. On any other
site it will do nothing, correctly.

## 2. Is it a listing page

Most features need a listing detail page. Scan mode works on search and category
grids, and the condition check needs an actual item.

A seller's shop front, a saved-search page or a category landing page is none of
those.

## 3. Is the icon pinned

An unpinned extension still works and hides its badge, and the badge is how it
tells you it has something to say about this page.

Pin it. This resolves a surprising share of "it does nothing" reports.

## 4. Did the page finish loading

Marketplace pages load in stages. The extension waits for the parts it needs, and
on a slow connection that can be a few seconds after the page looks ready.

Give it a moment before concluding it has failed.

## 5. Is it turned off for this site

Per-site opt-out is a setting, and it is easy to forget having used it.

Check the options page. The opt-out is reversible from the same place, which
matters because the easiest way to lose a feature permanently is to switch it off
somewhere with no obvious way back.

## 6. Run Check selectors

The real diagnostic, and it takes ten seconds.

Open the popup on the page in question and run it. It tests every selector for
that platform against the live page and returns a report naming the host, the
selector version, and which specific selectors resolved or missed.

That tells you whether one field moved or the whole adapter is out of date, which
is the difference between a small fix and a rebuild.

<!-- SCREENSHOT: a selector report showing two misses (as of 2026-08-15) -->

The report deliberately carries no page content and no full URL, because it is
written to be pasted into a ticket. Controls that only exist after an
interaction, such as an item inside a menu that has not been opened, are reported
as such rather than counted as failures.

## Why a redesign breaks it

The channels that need an extension are the ones with no seller API. There is no
supported interface, so the only approach available is working with the page a
human sees, and that changes when the page does.

What can be done, and is, is failing loudly. A field the extension cannot find is
reported missing rather than falling back to something positional like "the third
input", because a positional selector keeps matching after a redesign and types a
price into whatever moved there.

## Reporting it

Send the selector report, the marketplace, and what you were trying to do.

Those three make it fixable without a conversation, because the report names the
selector and the adapter is one file. A screenshot of nothing appearing does not,
since the interesting part is the page underneath.

## Checking before you need it

If you cross-post regularly, run Check selectors on your usual channels once a
month.

It costs a minute and converts a surprise in the middle of a listing run into
something you already knew about and planned around. Marketplaces do not announce
redesigns, so the alternative is finding out at the worst moment.

## What a partial failure looks like

Sometimes the overlay appears and one feature does not work.

That is usually a single selector rather than the whole adapter, and the report
will show exactly that: most resolving, one or two missing. It is the cheapest
kind of breakage to fix and the most useful kind to report, because the
diagnosis is already done.
