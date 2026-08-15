---
slug: webhooks
title: Webhooks
category: integrations
visibility: public
audience: developer
sort_order: 40
pillar_path: /developers
summary: Being told when a grade lands instead of asking, verifying that a delivery is genuinely from us, and why your handler must tolerate the same event twice.
faq:
  - q: Do I have to verify the signature?
    a: Yes. An unverified endpoint accepts anything anybody posts to it, and your URL will not stay secret. Verification is the only thing that makes the payload trustworthy.
  - q: Can the same event arrive twice?
    a: Yes, and your handler must cope. At-least-once delivery is the honest guarantee; exactly-once is not something a network can promise.
---

A webhook tells you when a grade finishes, instead of you asking repeatedly. For
anything user-facing it is the right integration, because there is no gap between
the result existing and your product knowing.

## Setting one up

Register an HTTPS endpoint. We POST a JSON payload to it when something happens.

Use a path nobody would guess. That is defence in depth rather than security on
its own: the signature is what makes a delivery trustworthy, and the obscure path
only reduces the noise.

<!-- SCREENSHOT: the webhook configuration with a registered endpoint (as of 2026-08-15) -->

## Verify the signature

Every delivery is signed. Verify it before you trust a single field.

An endpoint that skips verification will process anything anybody posts to it,
and your URL will not stay secret forever: it ends up in a log, a proxy, an error
report, a screenshot. Verification is the only thing standing between that and
somebody telling your system a garment scored 10.

Compare using a constant-time comparison rather than string equality. It is one
function call and it removes a class of timing attack entirely.

## Respond fast

Return 2xx quickly, then do the work.

If your handler grades, resizes, emails and updates three systems before
responding, it will eventually take long enough to time out, and a timeout looks
like a failure and triggers a redelivery. Now you are doing the slow work twice.

Acknowledge, enqueue, return. The work happens after.

## Handle duplicates

The same event can arrive more than once. That is the honest guarantee that a
network can support, and designing for exactly-once delivery means designing for
something that does not exist.

Each event carries an identifier. Record the ones you have processed and ignore
repeats. Alternatively make the handler idempotent by construction, so applying
it twice is the same as applying it once, which is better where you can manage
it.

## Retries

A delivery that fails or times out is retried on a backoff schedule.

Persistent failure eventually stops the retries, so an endpoint that has been
down for a day has missed things. That is the argument for keeping a polling
fallback for anything you cannot afford to miss: webhooks are the fast path, not
the only path.

## Testing

Point a webhook at a request-capture service and look at a real delivery before
you write the handler. It is faster than guessing at the shape from
documentation.

Then build against the sandbox, which delivers the same event shapes without
spending credits.

## What to log

The event identifier, the type, and whether you had seen it before. Not the whole
payload as a matter of routine, because payloads accumulate and some carry
customer detail.

When something goes wrong, the identifier is what makes it answerable, and a log
that says "processed event X, duplicate of one seen at Y" answers most questions
without anybody having to reproduce anything.

## Keep polling as a fallback

Webhooks are the fast path. They are not a guarantee, because your endpoint can
be down for longer than the retry schedule lasts.

A slow reconciliation job that sweeps for results you never received costs almost
nothing and closes that gap entirely. Run it hourly, or daily, depending on how
much a missed grade costs you.

The combination is what production integrations end up with everywhere: push for
latency, pull for completeness.

## Rotating the signing secret

Treat it like an API key. Store it as a secret, rotate it if anybody who had it
leaves, and never log it.

A leaked signing secret is worse than a leaked API key in one specific way: it
lets somebody tell your system things happened that did not, and your system will
believe them because the signature checks out.
