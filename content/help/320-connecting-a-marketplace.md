---
slug: connecting-a-marketplace
title: Connecting a marketplace
category: marketplaces
visibility: public
audience: seller
sort_order: 10
pillar_path: /flipdesk
summary: Why eBay connects differently from every other channel, what each permission is actually for, and what reconnect required means.
faq:
  - q: Why does only eBay ask me to authorise anything?
    a: Because only eBay has an official seller listing API. The other channels have none, so FlipDesk uses the browser extension against your own logged-in session instead.
  - q: What does "reconnect required" mean?
    a: Your eBay authorisation has expired or lost a permission it needs. Reconnecting takes a few seconds and nothing is lost while it is disconnected.
---

There are two completely different mechanisms behind the word "connect", and
knowing which one a channel uses explains everything about how it behaves.

## eBay: an official API

eBay has a seller API, so FlipDesk talks to it directly. You authorise once, and
after that listings are created, published, revised and ended by the server,
without a browser being open.

Connect from Marketplaces. You are sent to eBay to sign in and approve, and you
come back. The authorisation belongs to the workspace rather than to you
personally, so a team member can publish without each of them connecting their
own account.

## What each permission is for

The consent screen names several scopes and they are not decorative.

**Inventory.** Create and update the item records behind your listings. Without
it nothing can be listed at all.

**Account.** Read your business policies: postage, returns, payment. These live
on your eBay account and are referenced rather than recreated.

**Fulfilment.** Read orders so a sale can appear in FlipDesk without you typing
it, and attach tracking when you ship.

**Browse.** Read public listing data for comps.

**Taxonomy.** Read eBay's category tree and the item specifics each category
requires, which is what lets the composer ask for the right fields.

Some features need a permission eBay grants only to approved applications.
Sending offers to watchers is one; if you see it reported as unavailable rather
than failing, that is why, and it is a restriction on our side rather than
something wrong with your account.

<!-- SCREENSHOT: the Marketplaces page with eBay connected (as of 2026-08-15) -->

## Business policies first

Connect eBay before you try to publish, and set your business policies on eBay
before that.

A listing needs a postage policy, a returns policy and a payment policy. They
live on your eBay account, FlipDesk reads them, and a publish without them fails
with an eBay error that is accurate but not friendly.

Doing it in the other order is the commonest first-time stumble. See
[eBay business policies](/help/marketplaces/ebay-business-policies).

## Reconnect required

Authorisations expire, and occasionally eBay grants a narrower set of
permissions than requested.

When that happens the connection shows "reconnect required" rather than failing
silently. Nothing is lost: your listings stay live, your items stay put, and
reconnecting takes a few seconds. Only new operations wait.

The distinction that matters is between "this feature is not available on this
deployment" and "this connection needs refreshing". The message says which,
because the first is not something you can fix and the second is.

## Everything else: the extension

Poshmark, Mercari, Grailed and Vinted have no seller listing API. There is
nothing to authorise, because there is no endpoint to authorise against.

Instead the browser extension fills each site's own sell form in a tab you are
already logged into. That means the browser has to be open, the extension has to
be installed, and the plan has to be a paid one.

It also means "connecting" those channels is just being logged into them
normally. There is no separate step and no token.

What is actually supported today is listed in
[Publishing a listing](/help/flipdesk/publishing-a-listing), and it is worth
reading before you plan around a channel: Facebook Marketplace is not enabled,
and Grailed can list but can never automatically delist.

## Disconnecting

Owners and admins only, and it does not delete anything. Your items, grades and
recorded listings stay; what stops is FlipDesk's ability to act on that channel.

Reconnecting later picks up where it left off.

## One connection, whole workspace

The eBay authorisation belongs to the workspace. Every member publishes through
it, and it outlives the person who originally approved it.

That is what makes team selling work without four separate eBay accounts, and it
is also the reason disconnecting is restricted to owners and admins. A
connection that can create and edit live listings is a real permission, and it
should not be revocable by whoever happens to be logged in.
