---
slug: the-rest-api
title: The REST API
category: integrations
visibility: public
audience: developer
sort_order: 20
pillar_path: /developers
summary: The shape of the API, why grading is asynchronous, and the idempotency habit that stops a retry costing you twice.
faq:
  - q: Is grading synchronous?
    a: No. You submit and then either poll or receive a webhook. Assessment takes real time, and an HTTP request held open for it is a request that times out at somebody's proxy.
  - q: What happens if my retry duplicates a submission?
    a: Nothing, if you sent an idempotency key. The stored response is replayed rather than a second grade being run and a second credit spent.
---

The API does what the app does: take photographs of a garment, return a
condition assessment. This is its shape and the two habits worth having before
you write the first call.

## Authentication

A key in the request header. That is the whole scheme; there is no OAuth dance
and no session to maintain.

Keys are minted in the app. See
[API keys and the sandbox](/help/integrations/api-keys-and-the-sandbox).

## Grading is asynchronous

You submit photographs and get back an identifier. The assessment happens, and
you learn the result either by polling or by webhook.

It is not synchronous, and it will not become synchronous. A grade takes real
seconds, and an HTTP request held open that long is a request that dies at
somebody's load balancer, proxy or CDN, at a point in the chain you do not
control and cannot see.

**Webhooks** are the right integration for anything user-facing, because there
is no delay between the result existing and you knowing.

**Polling** is fine for batch work, where a few seconds of latency costs nothing
and not running a public endpoint is simpler.

See [Webhooks](/help/integrations/webhooks).

## Idempotency

Send an idempotency key with anything that spends a credit.

The reason is that networks fail after the server has acted. Your request
succeeded, the response never arrived, and your retry logic sends it again. With
an idempotency key the stored response is replayed; without one you have graded
the same garment twice and spent two credits.

Generate one per logical operation, not per HTTP attempt. All the retries of one
submission must carry the same key or the mechanism does nothing.

## Errors

Errors return a status and a body carrying an `error` field. Read the field
rather than the status alone: several conditions share a status and differ in
what you should do about it.

**4xx** means the request was wrong. Retrying it unchanged will fail again,
which makes an automatic retry on 4xx a loop rather than a recovery.

**429** means slow down. Back off exponentially rather than immediately.

**5xx** means try again, with backoff and a cap.

## Photographs

The same rules that govern the app govern the API, because it is the same
assessment. Flat, evenly lit, front, back, care label, at least one detail.

Sending a single styled product shot produces a low-confidence grade, and no
amount of correct API usage compensates for it. See
[The photos we need](/help/grading/the-photos-we-need).

## Versioning

The API is versioned, and a breaking change means a new version rather than a
changed one. Pin the version you built against rather than tracking the latest,
so a release cannot rewrite your integration on a Tuesday.

## The sandbox first

Build against the sandbox, which spends nothing and returns realistically shaped
responses. Switch the key when it works.

Full endpoint reference is at [the developer docs](/developers); this article is
the orientation, not the specification.

## Start with one garment

Before building anything, send one garment through by hand against the sandbox
and read the whole response.

It takes ten minutes and it answers the questions that otherwise get answered
badly in code: what the shape is, which fields are optional, what an error
actually looks like, and how long a grade really takes.

## What to store on your side

The identifier, your own reference, and the result. Not a copy of the photographs
unless you need them for another reason.

Storing the result against your own identifier is what lets you skip re-grading
something you already sent, which is the cheapest saving available and the one
most integrations miss.

## Where the time actually goes

Integrations that feel slow are almost never slow because of the assessment.

They are slow because they poll every few seconds when a webhook would have told
them, because they upload full-resolution photographs when a sensible size would
do, or because they grade the same garment repeatedly having stored nothing.

All three are on your side of the wire, and all three are worth checking before
concluding the API is the bottleneck.
