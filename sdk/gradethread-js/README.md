# @gradethread/sdk

Official JavaScript/TypeScript SDK for the [GradeThread](https://gradethread.com)
**Grade-as-a-Service API** — embed AI-powered clothing condition grading into your
marketplace, resale app, or internal tooling.

Zero dependencies. Works in Node 18+ and the browser.

## Install

```bash
npm install @gradethread/sdk
```

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
| `grades.create(input)` | Submit a garment for grading | `submit` |
| `grades.get(id)` | Fetch a submission + grade report | `read` |
| `grades.list({ page, limit, status })` | List grades, paginated | `read` |
| `sandbox.grades.create(input?)` | Free mock submit (no credits) | `submit` |
| `sandbox.grades.get(id)` | Free mock fetch | `read` |
| `webhook.set(url \| null)` | Set the grade-completion webhook | `webhook_manage` |

## Errors

Any non-2xx response throws a `GradeThreadError` with `.status` and `.details`:

```ts
import { GradeThread, GradeThreadError } from "@gradethread/sdk";

try {
  await gt.grades.create(/* ... */);
} catch (err) {
  if (err instanceof GradeThreadError) {
    console.error(err.status, err.message, err.details);
  }
}
```

## Rate limits

Limits are enforced per API key in a 60-second window, with separate read/write
budgets by plan (Business: 240 reads/min, 40 writes/min). Exceeding a budget
returns `429` with a `retry_after_seconds` hint in `meta`. See the
[developer docs](https://gradethread.com/developers) for the full reference.

## License

MIT © Pearson Media LLC
