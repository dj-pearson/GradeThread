# @gradethread/sdk

Official JavaScript/TypeScript SDK for the [GradeThread](https://gradethread.com)
**Grade-as-a-Service API** — embed AI-powered clothing condition grading into your
marketplace, resale app, or internal tooling.

Zero dependencies. Works in Node 20+ and the browser.

## Install

<!-- sdk-install:start (generated from src/lib/sdk-release.ts) -->
The SDK is not published to npm yet, and the GradeThread repository is
private, so there is no install command that works for an outside customer
today. Until it is published, call the HTTP API directly: the endpoints,
scopes, auth header and request examples are on the developers page at
<https://gradethread.com/developers>. Email
[support@gradethread.com](mailto:support@gradethread.com?subject=JavaScript%20SDK%20access)
and we'll let you know when the package is available.

Once it is published this becomes `npm install @gradethread/sdk`, and the
examples below work unchanged.
<!-- sdk-install:end -->

## Quick start

```ts
import { GradeThread } from "@gradethread/sdk";

const gt = new GradeThread({ apiKey: process.env.GRADETHREAD_API_KEY! });

// 1. Try it free in the sandbox — deterministic sample grade, no credits spent:
const sample = await gt.sandbox.grades.create({ title: "Vintage denim jacket" });
console.log(sample.grade_report?.overall_score); // e.g. 8.5

// 2. Grade a real garment (spends credits):
const job = await gt.grades.create({
  title: "Vintage denim jacket",
  garment_type: "outerwear",
  garment_category: "jacket",
  brand: "Levi's",
  images: [
    { image_type: "front", url: "https://example.com/front.jpg" },
    { image_type: "back", url: "https://example.com/back.jpg" },
    { image_type: "label", url: "https://example.com/label.jpg" },
    { image_type: "detail", url: "https://example.com/detail.jpg" },
  ],
});

// Grading is async — poll until status === "completed":
const result = await gt.grades.get(job.id);
console.log(result.status, result.grade_report?.grade_tier);
```

## Authentication

Create an API key in your GradeThread dashboard (**Account → API keys**, Business
plan). Keys are shown once and can be scoped to `read`, `submit`, and
`webhook_manage`. Pass it as `apiKey`; the SDK sends it in the `X-API-Key` header.

```ts
const gt = new GradeThread({
  apiKey: "gt_sk_...",
  baseUrl: "https://functions.gradethread.com", // optional override
});
```

## API

| Method | Description | Scope |
| --- | --- | --- |
| `grades.create(input, { idempotencyKey? })` | Submit a garment for grading | `submit` |
| `grades.batch(garments, { idempotencyKey? })` | Submit many garments as one batch | `submit` |
| `grades.getBatch(id)` | Batch status and per-garment results | `read` |
| `grades.get(id)` | Fetch a submission + grade report | `read` |
| `grades.list({ page, limit, status })` | List grades, paginated | `read` |
| `items.list({ status, brand, category, search, listed, limit, cursor, ... })` | Inventory, cursor-paginated | `read` |
| `items.get(id)` | One item with its photos | `read` |
| `listings.list({ marketplace, status, limit, cursor, ... })` | Each item's latest listing | `read` |
| `sales.list({ sold_after, sold_before, marketplace, status, limit, cursor })` | Sales, with totals over the whole match | `read` |
| `usage.get()` | This key's usage this month against its quota | `read` |
| `priceGuide.list()` / `priceGuide.get(slug)` | Resale value range and sell-through by grade band | `read` |
| `sandbox.grades.create(input?)` | Free mock submit (no credits) | `submit` |
| `sandbox.grades.get(id)` | Free mock fetch | `read` |
| `sandbox.priceGuide.list()` / `sandbox.priceGuide.get(slug)` | Free sample price guide | `read` |
| `webhook.set(url \| null)` | Set or clear the grade-completion webhook; the first set returns `signing_secret` once | `webhook_manage` |
| `webhook.get()` | Read the webhook URL and whether it has a signing secret | `webhook_manage` |
| `webhook.rotateSecret()` | Mint a new signing secret, returned once | `webhook_manage` |
| `webhook.deliveries({ limit })` | Recent deliveries: status, attempts, last response code | `webhook_manage` |

Cursor-paginated lists return `{ data, meta }`; pass `meta.next_cursor` back as
`cursor` for the next page.

## Retries and idempotency

`grades.create` and `grades.batch` send an `Idempotency-Key` header, a fresh
UUID per call that is reused on that call's own retries, so a retry after a
timeout replays the first response instead of charging again. Pass
`{ idempotencyKey }` yourself to carry that protection across a crash or a
restart of your own process.

The client retries up to `maxRetries` times (default 2):

- a `429`, on any request, waiting for `Retry-After`;
- a `5xx` or a network error, on reads and on the two keyed submissions only;
- a `409 IDEMPOTENCY_IN_PROGRESS`, which means the first attempt is still running.

A `5xx` that comes back with `Idempotent-Replay: true` is not retried. The API
stores a `5xx` only when grading already reached the charge, so the same key
can only replay it. Check `grades.list()` and your credit balance before
submitting again with a new key.

Other writes (`webhook.set`, `webhook.rotateSecret`, `sandbox.grades.create`)
are not re-sent after a `5xx` or a dropped connection, since the first attempt
may have landed. Set `maxRetries: 0` to turn retries off.

## Webhooks

There is one webhook per account, and each finished grade sends one
`grade.completed` event however many API keys you have. The call that first
sets a URL returns a `signing_secret` starting `whsec_`. It is shown once, so
store it then; `webhook.rotateSecret()` gives you a new one.

Deliveries use the [Standard Webhooks](https://www.standardwebhooks.com/)
format. Every POST carries:

| Header | Value |
| --- | --- |
| `webhook-id` | Event id, the same on every retry (and `id` in the body). Use it to drop repeats. |
| `webhook-timestamp` | Unix seconds when the attempt was signed. |
| `webhook-signature` | `v1,` + base64 HMAC-SHA256 of `{webhook-id}.{webhook-timestamp}.{raw body}`, keyed by the base64-decoded part of the secret after `whsec_`. |

`verifyWebhook` checks the signature and rejects a timestamp more than five
minutes off. Give it the raw body, not re-serialised JSON:

```ts
import express from "express";
import { verifyWebhook } from "@gradethread/sdk";

app.post("/hooks/gradethread", express.text({ type: "*/*" }), async (req, res) => {
  if (!(await verifyWebhook(req.body, req.headers, process.env.GT_WEBHOOK_SECRET!))) {
    return res.status(400).end();
  }
  const event = JSON.parse(req.body);
  // event.id, event.event === "grade.completed", event.data.grade_report
  res.status(204).end();
});
```

Answer with any 2xx within 10 seconds. Anything else is retried after 5 min,
15 min, 1 h, 3 h and 8 h, then marked failed; `webhook.deliveries()` shows each
one. A webhook set before signing secrets existed has no `whsec_` secret and
sends only the deprecated `X-GradeThread-Signature` header until you call
`webhook.rotateSecret()`.

## Errors

Any non-2xx response throws a `GradeThreadError` with `.status`, `.code` (when
the API sends one, such as `IDEMPOTENCY_KEY_REQUIRED`) and `.details`:

```ts
import { GradeThread, GradeThreadError } from "@gradethread/sdk";

try {
  await gt.grades.create(/* ... */);
} catch (err) {
  if (err instanceof GradeThreadError) {
    console.error(err.status, err.code, err.message, err.details);
  }
}
```

## Rate limits

Limits are enforced per API key in a 60-second window, with separate read/write
budgets by plan (Business: 240 reads/min, 40 writes/min). Exceeding a budget
returns `429` with a `Retry-After` header, which the client waits out before
retrying. See the
[developer docs](https://gradethread.com/developers) for the full reference.

## License

MIT © Pearson Media LLC
