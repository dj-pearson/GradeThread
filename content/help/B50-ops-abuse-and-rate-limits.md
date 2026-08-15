---
slug: ops-abuse-and-rate-limits
title: "Operator: abuse handling and rate limits"
category: troubleshooting
visibility: internal
audience: operator
sort_order: 150
pillar_path: /acceptable-use
summary: Why the public limiters fail closed, why specific thresholds are not published, and the principle behind every cap in the product.
faq:
  - q: Why are the numbers not written here?
    a: A published threshold is a threshold somebody sizes their behaviour to sit just under. The principle is public and useful; the exact figure is operational and is not.
  - q: What does fail closed mean for a limiter?
    a: If the limiter's own store is unreachable, requests are refused rather than allowed through unlimited. A limiter that fails open is not a limit, it is a suggestion.
---

Internal. This is the reasoning behind the caps, not the caps. Configuration
values live in [[env-reference]] and the capacity picture is in [[capacity]].

## Why the numbers are not here

A published threshold is a number somebody sizes their behaviour to sit just
beneath.

The principle behind a limit is genuinely useful to write down and does not help
anybody game it. The figure is operational, changes, and is best learned by
hitting it rather than by reading it.

That is also why the public-facing article on
[rate limits and quotas](/help/integrations/rate-limits-and-quotas) explains the
mechanism, the backoff strategy and the difference between a rate limit and a
quota, without listing values.

## Fail closed, not open

The public unauthenticated surfaces are capped per address, and the limiter
**fails closed**: if its own store is unreachable, requests are refused rather
than allowed through unmetered.

A limiter that fails open is not a limit. It is a suggestion that stops applying
at exactly the moment something is going wrong, which is the moment it was for.

The cost is that a store outage can refuse legitimate public reads. That is the
safer failure and it is deliberate.

## The origin bypass

The SSR workers front every visitor through a small number of addresses, so a
per-address cap would starve them within seconds of any traffic.

They carry an origin secret that bypasses the public limiter. That secret is a
value and lives where [[env-reference]] says, not here.

## Two different ceilings

Worth keeping distinct in your head, because customers conflate them constantly.

**Rate limits** are how fast, reset in seconds, and return 429. Hitting one is
not a failure.

**Quotas** are how much, reset with the billing period, and need allowance rather
than patience.

A support ticket saying "I keep getting rate limited" is often a quota question,
and the distinction changes the answer entirely.

## The principle behind every cap

Caps that can be raised are offered. Caps that can be lowered are not.

The clearest example is in the browser extension's engagement pacing: a seller
can slow it down and cannot speed it up past the ceiling, because the only reason
to go faster is to go faster than the channel tolerates, and the consequence
lands on the seller's account rather than on ours.

The same shape applies wherever a limit protects somebody from a third party's
enforcement rather than from us.

## Handling a genuine high-volume customer

Rate limits are negotiable with evidence. Ask for the shape of their traffic:
volume, frequency, pattern.

What is not acceptable is working around a limit by rotating keys or spreading
across accounts. That is the behaviour that gets an integration switched off, and
saying so early is kinder than switching it off later.

## Signals worth watching

Sudden volume from one address, sudden volume across many addresses with
identical shape, and quota exhaustion on accounts that have never been near it
before.

The second is the interesting one, because it is the shape that a naive per-address
limit does not catch and a per-account one does.

## Talking to somebody you have limited

Say what happened and what the path forward is.

Somebody who hit a limit legitimately and got a wall of nothing will assume the
product is unreliable rather than that they were fast. Somebody who hit a limit
and was told the shape of it can design around it, and usually will.

The only case where that does not apply is deliberate abuse, and it is rarer than
it feels.

## The acceptable use line

The published [acceptable use policy](/acceptable-use) is what a customer agreed
to, and it is the reference for anything enforcement-shaped.

Enforcement decisions should be traceable to something in it rather than to
somebody's judgement in the moment. If behaviour is a genuine problem and the
policy does not cover it, that is a gap in the policy to fix rather than a
decision to improvise.

## Related

- [[capacity]]: what the system is sized for.
- [[env-reference]]: where the configuration values live.
- [Rate limits and quotas](/help/integrations/rate-limits-and-quotas) is the
  public article; keep the two consistent in principle and never copy figures
  into it.
