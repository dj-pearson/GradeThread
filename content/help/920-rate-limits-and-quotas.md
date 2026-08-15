---
slug: rate-limits-and-quotas
title: Rate limits and quotas
category: integrations
visibility: public
audience: developer
sort_order: 30
pillar_path: /developers
summary: The two different ceilings, why a 429 is not a failure, and the backoff mistake that turns a brief limit into a long outage.
faq:
  - q: What is the difference between a rate limit and a quota?
    a: A rate limit is how fast, and it resets in seconds. A quota is how much, and it resets with your billing period. Hitting the first is a pause; hitting the second needs credits.
  - q: Should I retry a 429 immediately?
    a: No. Immediate retries are what turn a two-second limit into a ten-minute one. Back off exponentially with jitter.
---

There are two ceilings and they behave completely differently. Confusing them is
the commonest integration bug we see.

## Rate limit: how fast

How many requests you may make in a window. It resets in seconds.

Hitting it returns **429**. That is not a failure and not an error in your
request; it is the server saying "not this second". The correct response is to
wait and try again.

## Quota: how much

How many grades your plan and credits allow. It resets with your billing period,
or when you buy more credits.

Hitting it is not a 429 and waiting will not help. You need allowance, which
means either the next period or a top-up.

## Backing off properly

The single mistake that turns a brief limit into a long outage is retrying
immediately.

**Exponential backoff.** Wait, then wait twice as long, and so on. A fixed
one-second retry against a rate limit is indistinguishable from an attack and
will keep you limited indefinitely.

**With jitter.** Add randomness. Without it, everything that failed together
retries together, and the thundering herd re-triggers the limit at exactly the
same moment.

**With a cap.** Both on the delay and on the number of attempts. Something that
retries forever is something nobody notices is broken.

**Respect a Retry-After header** when one is present. It is the server telling
you the answer rather than making you guess it.

<!-- SCREENSHOT: an example of a 429 response body -->

## Designing for the quota

Two habits keep the quota from surprising you.

**Watch the remaining allowance** rather than discovering it at zero. The app
shows it, and it is worth surfacing wherever your integration reports its own
health.

**Do not grade the same garment twice.** Cache the result against your own
identifier. A retry loop without an idempotency key is the most expensive way to
find out you had one, because each duplicate is a real credit.

## Batch work

If you are grading many items, pace them rather than firing everything at once.

A steady stream inside the limit finishes sooner than a burst that triggers a
limit and then backs off, because the backoff costs more time than the pacing
would have. This is the least intuitive thing on this page and the most
reliably true.

## The public endpoints

The public read endpoints, certificates and the like, are also capped per address
and fail closed rather than open when the limiter itself has trouble.

That means a public read can be refused during an incident rather than being
served unlimited. It is the safer failure and it is worth handling in a
client-side integration rather than assuming those endpoints always answer.

## When you need more

If your legitimate volume exceeds the limits, open a ticket with the shape of
your traffic: how many, how often, and in what pattern.

That is a solvable conversation. Working around a limit by rotating keys is not,
and is the sort of thing that gets an integration switched off.

## Telling the two apart in your logs

Log the status and the error field separately, and the distinction becomes
obvious in production rather than during an incident.

A cluster of 429s is a pacing problem and your backoff will handle it. A quota
error is a business problem and no amount of retrying fixes it: somebody has to
buy credits or wait for the period to roll.

An integration that treats both as "the API is down" will page somebody at three
in the morning for a billing question.

## A sensible default

Exponential backoff starting at one second, doubling, with jitter, capped at
about a minute, and no more than five attempts.

That handles an ordinary rate limit invisibly and gives up on a genuine outage
fast enough that somebody finds out.
