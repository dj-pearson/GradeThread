---
slug: ebay-business-policies
title: eBay business policies
category: marketplaces
visibility: public
audience: seller
sort_order: 20
pillar_path: /sell-used-clothes-ebay
summary: The three policies every listing needs, why they live on eBay rather than in FlipDesk, and the error you get when one is missing.
faq:
  - q: Why does FlipDesk not just set the postage itself?
    a: Because eBay owns them. A policy is an eBay object referenced by its id, and duplicating them here would create two versions of your returns terms that could disagree.
  - q: I have policies but publishing still fails. Why?
    a: Usually the policy does not cover the category or the postage service the listing needs. eBay's error names which one, and it is shown as eBay wrote it.
---

Every eBay listing references three policies, and they belong to your eBay
account rather than to FlipDesk. Setting them up once is a prerequisite for
publishing anything.

## The three

**Postage.** What you charge, which services you offer, how long you take to
dispatch. This is the one with the most options and the most impact: dispatch
time feeds eBay's search placement.

**Returns.** Whether you accept them, for how long, and who pays. A generous
returns policy raises conversion and raises returns, and which trade is right
depends on what you sell.

**Payment.** How you get paid. For most sellers this is a single option and is
set once.

## Why they live on eBay

A policy is an eBay object with an id, and a listing references that id.

FlipDesk reads your policies and lets you pick which to use, but it does not
create or store its own version. If it did, you would have two returns policies,
one on eBay and one here, and the day they disagreed you would have told a buyer
something your account does not honour.

The same reasoning runs through the whole marketplace integration: the channel
owns what the channel owns, and duplicating it locally is how sync bugs are
made.

## Setting them up

On eBay, in Seller Hub, under Business Policies. If you have never used them,
you may need to opt in to business policies first; eBay's own help covers that
and it takes a minute.

Create at least one of each. Most sellers end up with two or three postage
policies, because a coat and a t-shirt do not cost the same to send.

Then, in FlipDesk, pick the defaults you want new listings to use. Individual
listings can override.

<!-- SCREENSHOT: the policy pickers on the Marketplaces page -->

## The error when one is missing

Publishing without a required policy fails, and the message comes from eBay
rather than from us.

That is deliberate. eBay's errors are specific about which policy is missing or
which service is not covered, and a friendlier generic message would throw away
the part you need to fix it.

The commonest three:

**No policy of that type.** You have not created one. Create it on eBay and it
appears here.

**Policy does not cover the category.** A postage policy can be limited to
certain categories.

**Service not available for the destination.** Usually an international
destination the policy does not include.

## Dispatch time is a search input

Worth saying separately because it is easy to miss.

The handling time in your postage policy is a promise, and eBay measures whether
you keep it. Sellers who dispatch faster than promised place better in search
than sellers who do not, on listings they have not created yet.

Setting a generous handling time and beating it is strictly better than setting
a tight one and missing it occasionally.

## Changing a policy later

Changes on eBay apply to listings that reference the policy, without FlipDesk
needing to touch anything. That is the advantage of referencing rather than
copying.

The exception is a listing that names a specific override rather than the
default. Those keep what they were given, which is what an override is for.

## Two or three postage policies, not one

Most sellers start with a single postage policy and outgrow it quickly.

A coat and a t-shirt do not cost the same to send, and a single policy priced
for the coat loses you sales on the t-shirt while a single policy priced for the
t-shirt loses you money on the coat.

Two or three, named for what they are for, is the sensible middle. You pick per
listing, and the default covers the common case.
