# GradeThread Public API (v1)

The public REST API lets you submit garments for AI condition grading and read
back results programmatically. It is a paid feature — see **Access** below.

- **Base URL:** `https://functions.gradethread.com/api/v1`
- **Auth:** `X-API-Key: gt_sk_…` header on every request
- **Content type:** `application/json`
- **Full machine-readable spec:**
  <https://functions.gradethread.com/api/v1/openapi.json> — served without a
  key, and it is the COMPLETE surface. Every one of the 16 paths it declares
  has a section on this page.

## Access

API access is gated to the **Business** FlipDesk plan. Create and manage keys in
the dashboard under **Settings → API Keys** (workspace owner / admin only). Each
workspace may hold up to **10** keys. Keys are shown once at creation — store the
secret securely; only its prefix is retained server-side.

If your plan later drops below Business, existing keys keep authenticating but
are throttled at the lower plan's rate tier (see below).

## Response envelope

Every response uses the same envelope:

```json
{ "data": <result | null>, "error": { "message": "...", "details": [ ... ] } | null, "meta": <object | null> }
```

`error` is `null` on success; `data` is `null` on error. `details` carries
field-level validation messages where applicable.

## Scopes

Each key carries one or more scopes; a call to an endpoint outside the key's
scopes returns **403** with `error.message` naming the missing scope.

| Scope | Grants |
|---|---|
| `read` | Every `GET`: grades, batch status, items, listings, sales, usage, price guide, and the sandbox reads |
| `submit` | `POST /grades`, `POST /grades/batch`, `POST /sandbox/grades` |
| `webhook_manage` | `PATCH /webhook` |

A read-only integration needs `read` alone. Note that the **sandbox obeys the
same scopes as production**. That is deliberate: a key that works against the
sandbox works against the live API without a second conversation about
permissions.

## Rate limits

Limits are **per API key** (not per user — two keys never share a budget) and
**per minute**, with reads and writes metered separately so a status-poll loop
can't exhaust your submit budget. The submit/write path is kept tighter because
each submission spends an AI grade.

| Plan | Read (GET) / min | Write (POST·PATCH) / min |
|---|---|---|
| Business | 240 | 40 |
| (downgraded) Pro | 120 | 20 |
| (downgraded) Starter | 60 | 10 |
| (downgraded) Free | 30 | 5 |

Every response carries:

- `X-RateLimit-Limit` — the budget for this request's class
- `X-RateLimit-Remaining` — requests left in the current window
- `X-RateLimit-Reset` — Unix epoch seconds when the window resets

Over-limit requests get **429** with a `Retry-After` header (seconds) and the
standard envelope (`meta.retry_after_seconds`). Back off until the reset, ideally
honoring `Retry-After`.

> Rate limits are enforced by a distributed counter and fail **closed**: if the
> counter store is briefly unavailable, the API is still throttled (per-replica
> fallback) rather than opened up. Treat 429s as expected backpressure.

## Endpoints

### `POST /grades` — submit a garment (scope: `submit`)

Body: `title`, `garment_type`, `garment_category`, optional `brand` /
`description` / `tier` (`standard` | `premium` | `express`), and an `images`
array. Each image is `{ image_type, url | base64, content_type? }`. Required
types: `front`, `back`, `label`, and at least one `detail*`. Returns **202** with
`{ id, status: "processing", tier, payment_method }`.

Payment follows the same precedence as the web flow (included grade → credits).
If neither covers it, the call returns **402** (the API can't run an interactive
checkout) and the submission is rolled back.

### `GET /grades/:id` — fetch one grade (scope: `read`)

Returns the submission and, once complete, its `grade_report`.

### `GET /grades` — list grades (scope: `read`)

Query: `page` (default 1), `limit` (default 20, max 100), optional `status`.
`meta` carries `page`, `limit`, `total`, `total_pages`, `has_next`, `has_prev`.

### `PATCH /webhook` — set/clear the result webhook (scope: `webhook_manage`)

Body `{ "webhook_url": "https://…" | null }`. The URL is validated for SSRF
safety at set-time and again at delivery-time. `null` clears it.

### Sandbox

Four paths mirror the real ones and return **deterministic sample data**. They
spend no credits, write nothing, and never touch your inventory. Use them to
build and test your integration end to end before the first real garment.

Every sandbox response carries `meta.sandbox: true`. Auth, scopes and the
response envelope are identical to production, so the only thing that changes
when you switch over is the path.

#### `POST /sandbox/grades` — mock a submission (scope: `submit`)

Accepts any JSON body and returns a sample grade immediately. Nothing is
validated, nothing is charged.

#### `GET /sandbox/grades/:id` — mock a result (scope: `read`)

Returns a sample grade for **any** id. It is deterministic: the same id always
returns the same body, so you can write assertions against it. This is what to
poll after `POST /sandbox/grades` to exercise your read path.

#### `GET /sandbox/price-guide` — mock catalog (scope: `read`)

Fixed sample items, same shape as the live catalog below.

#### `GET /sandbox/price-guide/:slug` — mock value bands (scope: `read`)

Sample bands for any slug, same shape as the live entry below.

### `GET /usage` — your consumption against quota (scope: `read`)

```json
{ "quota": 500, "used": 137, "remaining": 363, "exceeded": false,
  "resets_at": "2026-09-01T00:00:00.000Z" }
```

`quota: null` means unlimited, and `remaining` is then `null` too. The window is
the calendar month in UTC, so `resets_at` is the start of the next one.

This is the **monthly grade quota**, which is a different thing from the
per-minute rate limits above. A key can be well inside its rate limit and out of
quota, or the reverse. Check this endpoint before a bulk run; check the
`X-RateLimit-*` headers to pace one.

### Batch grading

#### `POST /grades/batch` — submit up to 50 garments (scope: `submit`)

Body: `{ "garments": [ ... ] }`, where each entry is the same object
`POST /grades` takes. Returns **202** with `{ id, status, item_count }`.

Validation is **all or nothing**: one invalid garment rejects the whole batch,
so a typo never leaves you half-charged. Grading itself is not. Each garment
runs in the background and is charged individually, and a `grade.completed`
webhook fires per garment.

> **Send an `Idempotency-Key` header.** A retry without one re-enqueues every
> garment in the batch and charges for all of them again. This is the single
> most expensive mistake available on this API.

Prefer image URLs over base64 in a batch; 50 base64 garments make a body large
enough to be its own problem.

#### `GET /grades/batch/:id` — poll a batch (scope: `read`)

```json
{ "id": "...", "status": "partial", "item_count": 50,
  "succeeded_count": 48, "failed_count": 2, "error": null,
  "results": [
    { "id": "...", "status": "completed", "grade_id": "...", "error": null }
  ] }
```

`status` is `pending`, `running`, `completed`, `failed` or `partial`. **Read
`partial` carefully**: some garments graded and some did not, and the
per-garment `results[].error` is the only place that says which. Treating
`partial` as failure throws away work you paid for; treating it as success loses
the failures.

A batch id belonging to another account returns **404**, not 403.

### Inventory

These read your FlipDesk inventory. All money is **integer cents**, never a
float. They are **keyset-paginated**: pass `meta.next_cursor` back as `cursor`
for the next page. Offset paging is not offered on purpose, because it skips
rows when inventory changes mid-walk, which for a live seller is most of the
time.

#### `GET /items` — list items (scope: `read`)

Query: `status`, `brand`, `category`, `search` (text in the title), `listed`
(boolean), `created_after` / `created_before` (ISO 8601), `limit` (1 to 100,
default 25), `cursor`.

Returns `{ items: [ ... ] }`, each carrying `id`, `item_number`, `title`,
`brand`, `size`, `category`, `status`, `list_price_cents`, `grade`,
`grade_label`, `listed`, `photo_count`, `created_at`.

#### `GET /items/:id` — one item, with photos (scope: `read`)

Everything in the summary plus `description`, `color`, `style`, `notes`,
`container`, `location_bin`, `purchase_price_cents`, `purchase_date`,
`source_name`, `target_price_cents`, `measurements`, `certificate_url`,
`has_required_photos`, `listing`, `sale`, `photos[]` and `updated_at`.

Photo URLs are **signed and short-lived**, so fetch the bytes promptly or
refetch the item. Do not store the URL. An item that does not exist and an item
belonging to someone else both return **404**, which is deliberate: a 403 would
confirm the id is real.

#### `GET /listings` — list listings (scope: `read`)

One row per item, carrying that item's **most recent** listing. Query:
`marketplace`, `status`, `min_price_cents`, `max_price_cents`, `min_days_live`,
`min_watchers`, `limit`, `cursor`.

Each row: `listing_id`, `item_id`, `title`, `brand`, `size`, `marketplace`,
`status`, `price_cents`, `url`, `listed_at`, `days_live`, `watchers`, `views`,
`grade`. An item that has never been listed has a null `listing_id`.

#### `GET /sales` — list sales (scope: `read`)

Query: `sold_after`, `sold_before`, `marketplace`, `status`, `limit`, `cursor`.

**Defaults to `status=completed`.** Cancelled and refunded sales are not
revenue, so they are out unless you ask for them by name. Each row carries
`sale_price_cents`, `fees_cents`, `tax_cents`, `shipping_cost_cents`,
`net_profit_cents`, `purchase_price_cents`, `sold_at` and `days_to_sell`.

`meta.totals` rolls up **the page you were returned**, not the whole query, and
says so via `totals.page_only`. To total a period, walk every page and sum it
yourself.

### Price guide

The Resale Condition Index: what an item is worth at each condition grade.

#### `GET /price-guide` — catalog (scope: `read`)

Returns `{ items: [ ... ] }` of `slug`, `brand`, `label`, `currency`,
`headlineMedianCents`, `totalSampleSize`, `refreshedAt`. Use the `slug` below.

#### `GET /price-guide/:slug` — value bands for one item (scope: `read`)

```json
{ "slug": "...", "brand": "...", "label": "...", "currency": "USD",
  "refreshedAt": "...", "totalSampleSize": 412, "sellThroughScope": "...",
  "bands": [
    { "band": "high", "label": "...", "gradeRange": "8.5-10.0",
      "valueLowCents": 6500, "valueMedianCents": 8200,
      "valueHighCents": 11000, "valueSampleSize": 96,
      "sellThrough": 0.61, "medianDaysToSell": 14 }
  ] }
```

Three bands (`high`, `mid`, `low`), each tied to a `gradeRange`. That tie is
what makes this a condition-adjusted guide rather than a price average. Check
`valueSampleSize` per band before quoting one: a band computed from a handful of
sales is a number, not evidence. An unknown slug returns **404**.

## Observability

Throttling (`rate_limit.exceeded`) and scope rejections (`api_v1.scope_denied`)
are emitted as tagged metrics in the edge log stream, so undersized limits and
key-probing abuse are visible operationally.
