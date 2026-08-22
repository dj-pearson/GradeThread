# GradeThread Public API (v1)

The public REST API lets you submit garments for AI condition grading and read
back results programmatically. It is a paid feature — see **Access** below.

- **Base URL:** `https://functions.gradethread.com/api/v1`
- **Auth:** `X-API-Key: gt_sk_…` header on every request
- **Content type:** `application/json`
- **Full machine-readable spec:**
  <https://functions.gradethread.com/api/v1/openapi.json> — served without a
  key, and it is the COMPLETE surface. This page describes the grading
  endpoints in prose; the spec covers all 16 paths including the ones listed
  under *Not yet written up* below.

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
| `read` | `GET /grades`, `GET /grades/:id` |
| `submit` | `POST /grades` |
| `webhook_manage` | `PATCH /webhook` |

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

### Not yet written up

The API serves **16** paths; the four above are the ones documented in prose.
These twelve are live, in the OpenAPI spec linked at the top, and have no
prose section here yet. They are listed by name rather than left invisible,
because an endpoint a paying customer cannot find is, to them, an endpoint
that does not exist:

| Path | What it is |
| --- | --- |
| `POST /grades/batch`, `GET /grades/batch/{id}` | Submit and poll a batch of garments |
| `GET /items`, `GET /items/{id}` | Inventory items |
| `GET /listings` | Marketplace listings |
| `GET /sales` | Sales |
| `GET /usage` | Your key's consumption against the rate tier |
| `GET /price-guide`, `GET /price-guide/{slug}` | Condition-adjusted price guide |
| `GET /sandbox/grades`, `GET /sandbox/grades/{id}` | Sandbox grading — no credit spend |
| `GET /sandbox/price-guide`, `GET /sandbox/price-guide/{slug}` | Sandbox price guide |

`src/test/public-api-doc-coverage.test.ts` holds this list to the spec: a new
path must be documented or named here, and the count can only go down.

## Observability

Throttling (`rate_limit.exceeded`) and scope rejections (`api_v1.scope_denied`)
are emitted as tagged metrics in the edge log stream, so undersized limits and
key-probing abuse are visible operationally.
