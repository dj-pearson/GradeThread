---
slug: connecting-the-extension
title: Connecting the extension to your account
category: extension
visibility: public
audience: all
sort_order: 20
pillar_path: /flipdesk
summary: How the link-up works, what changes once it is connected, and what happens to your reads if you never connect at all.
faq:
  - q: What happens to my anonymous reads when I connect?
    a: They stay. Your recent reads and your seller history live on your machine and are not uploaded when you sign in.
  - q: Can I connect more than one browser?
    a: Yes. Each browser connects separately, because the connection is per install, and each keeps its own local history.
---

The extension works without an account. Connecting one raises what it can do,
and takes about ten seconds.

## How to connect

Open the extension popup and choose to connect, or go to the connect page inside
GradeThread. Either way you end up on a page in your signed-in session that
hands the extension a token.

That is the whole flow. There is no password typed into the extension, which is
deliberate: an extension that asked for your password would be asking you to
trust it with something it does not need.

<!-- SCREENSHOT: the popup before and after connecting (as of 2026-08-15) -->

## What changes

**A deeper read.** Anonymously the condition check uses up to four of a
listing's photos. On a paid buyer plan it uses up to eight. Same feature, more
evidence, which shows up mostly as higher confidence rather than a different
number.

**Flip mode**, if the account has FlipDesk. The seller's question about the same
listing: resale range, margin after fees, break-even, days to sell, buy or pass.

**The Lister and delisting**, on an active paid FlipDesk plan. Cross-posting
drafts to Poshmark, Mercari, Grailed and Vinted from your own logged-in tabs.

**A higher quota** on the condition check.

## What does not change

Your local history. Recent reads and seller memory live in the browser's own
storage, and connecting does not upload them.

That is worth being explicit about because it is the natural assumption. Signing
in to a service usually means your history syncs. Here it does not: the reads are
a record of what you looked at, kept on your machine, and there is no server-side
copy to sync.

## Signing out

Disconnect from the popup. The extension drops the token and falls back to
anonymous behaviour: the condition check still works at the anonymous cap, the
seller tools stop.

Your local history survives disconnecting, for the same reason it survives
connecting. It was never anywhere else.

## Several browsers, several connections

The connection is per install. A work laptop and a home desktop connect
separately, and each keeps its own recent reads and its own seller memory.

They will not agree with each other, and that is correct rather than a sync bug:
each is a record of what you looked at in that browser.

## If the connection stops working

Entitlements refresh periodically. If the extension seems to have forgotten your
plan, reconnecting from the popup is the fix and it is fast.

If it happens repeatedly, that is worth a ticket, because a token that keeps
lapsing usually means something about the account rather than the extension.

## Why a token and not a password

The extension never sees your password, and that is a design decision rather
than an accident of convenience.

Connecting works by opening a page in your ordinary signed-in session, which
hands the extension a scoped token. The extension stores that token and sends it
with requests. It cannot do anything your account cannot do, and it cannot be
used to change your password or your email.

The practical consequence is that disconnecting is complete. Dropping the token
ends the extension's access entirely, without touching your account, and without
you needing to change anything.

## What entitlements mean

The token carries what your account is allowed to do: whether it is
authenticated at all, whether it has an active paid FlipDesk plan, and which
buyer plan applies.

The extension reads those to decide what to show. The server checks the same
things independently on every request, so a modified extension cannot grant
itself the seller tools by claiming to have them. The client-side check exists to
avoid showing you a button that would fail, not to enforce anything.
