---
slug: installing-the-browser-extension
title: Installing the browser extension
category: extension
visibility: public
audience: all
sort_order: 10
pillar_path: /flipdesk
summary: What the extension does, exactly which four permissions it asks for and why, and what you get without an account at all.
faq:
  - q: Do I need an account to use it?
    a: No. The condition check works anonymously with a capped quota. An account raises the cap and unlocks the seller tools.
  - q: Why does it want access to marketplace sites?
    a: Because it reads the listing you are looking at. It lists the sites explicitly rather than asking for all sites, so it has no access anywhere else.
---

The extension puts an independent condition read on a marketplace listing while
you are looking at it. Install it, and eBay, Poshmark, Grailed, Mercari, Depop
and Vinted listings gain a second opinion that is not the seller's.

## Installing

From the Chrome Web Store, or from the connect page inside GradeThread, which
links to the same listing.

Once installed you get a toolbar icon. Pin it: the badge on it is how the
extension tells you it has something to say about the page you are on, and an
unpinned icon hides that.

## The four permissions

The install prompt names them, and none is decorative.

**storage.** Keeps your settings and your recent reads on your own machine.
Everything the extension remembers lives here rather than on a server.

**activeTab.** Reads the listing page you are actually looking at, when you act
on it. It is the narrow version of the permission: not every tab, the one in
front of you.

**alarms.** Runs periodic housekeeping, like refreshing entitlements.

**contextMenus.** Adds the right-click "Grade this image" item.

Plus the marketplace sites themselves, listed one at a time rather than as a
wildcard. It has access to eBay, Poshmark, Grailed, Mercari, Depop, Vinted and
the Vinted country domains, and nothing else. There is no permission to read your
banking, your email or any other site, because it was never requested.

<!-- SCREENSHOT: the Chrome install prompt showing the four permissions (as of 2026-08-15) -->

## What works with no account

The condition check. Open a listing, and you get an independent read of the
garment's condition from the listing's own photos.

It is quota-capped rather than unlimited, and the cap is enforced on the server
rather than in the browser, so it cannot be raised by fiddling with the
extension.

Anonymously, a read uses up to **four** of the listing's photos. Signed in on a
paid plan, it uses up to **eight**, which is a deeper read of the same listing
rather than a different feature.

## What an account adds

**A higher photo cap.** Eight instead of four.

**Flip mode**, for FlipDesk accounts: the seller's question about the same
listing, meaning resale range, margin after fees and buy-or-pass.

**The Lister**, for active paid FlipDesk plans: cross-posting your own drafts to
Poshmark, Mercari, Grailed and Vinted from your logged-in tabs.

[Connecting the extension](/help/extension/connecting-the-extension) covers the
link-up, which takes about ten seconds.

## Firefox and other browsers

The extension is built to the MV3 standard, so it works in Chrome and in
Chromium browsers such as Edge, Brave and Arc.

## Turning it off somewhere

Per-site opt-out is in the options page, and it is reversible from the same
place. If you would rather the extension did nothing on one marketplace, that is
a setting rather than an uninstall.

Uninstalling removes everything it stored, because everything it stored was on
your machine.

## What it never asks for

Worth saying explicitly, because permission prompts are read quickly and worried
about afterwards.

It does not ask for access to all sites. The host list is written out one
marketplace at a time, so there is no wildcard that would let it read your bank,
your email or your work systems. Adding a marketplace later means a new version
and a new prompt.

It does not ask for your browsing history, your bookmarks, your downloads, your
cookies as a category, or your identity. None of those appears in the manifest,
which is a file anybody can read on the store listing.

It does not ask for a password. The account link is done by handing the extension
a token from a page you are already signed into, which is a deliberate design
choice rather than a convenience: an extension that wanted your password would be
asking for something it has no use for.

## Updating

Chrome updates extensions on its own. A version that adds a permission pauses
until you approve it, which is the browser's behaviour rather than ours and is
the right one.
