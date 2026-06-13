# Content Publishing — Webhook Fan-out Contract & Channel Wiring

When a blog or social post is published (from the dashboard **or** the autonomous
scheduler), the edge service fires an **outbound webhook** to a downstream
automation (Make.com) which fans the content out to the real social channels
(LinkedIn, X, Facebook, Threads, …). The edge service never talks to a social
API directly — it only emits a signed, versioned event. This doc is the
field-by-field contract for those events plus how to wire up a new channel.

- Dispatcher: `services/edge-functions/src/lib/content-webhook.ts`
- Blog publish site: `services/edge-functions/src/routes/content-blog.ts` (`POST /:id/publish`)
- Social publish site: `services/edge-functions/src/routes/content-social.ts` (`POST /:id/publish`)
- Scheduler (autonomous publish): `services/edge-functions/src/routes/content-scheduler.ts` — see [CONTENT_SCHEDULER.md](./CONTENT_SCHEDULER.md)
- Target URLs + observability: `/admin/content/settings` (configure URLs, test fire, retry log)

---

## Events

| Event | Format | Fired when | Target setting |
|---|---|---|---|
| `blog.published` | — | A blog post transitions to `published` | `make_webhook_blog` |
| `social.published` | `long` | A social post with a non-empty `long_body` is published | `make_webhook_social_long` |
| `social.published` | `short` | A social post with a non-empty `short_body` is published | `make_webhook_social_short` |

A single social post can fire **both** `long` and `short` events (one per
non-empty body) — they go to separate Make.com scenarios because LinkedIn/Facebook
(long form) and X/Threads (short form) have different copy and channel
connections. The two fire concurrently; one failing never blocks the other.

If the matching target URL is unset in `content_settings`, the dispatch is a
no-op (logged, not an error) — so you can enable channels one at a time.

---

## Transport

Every request (real publish **and** test fire) is an HTTP `POST` with a JSON body:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-Content-Event` | `blog.published` or `social.published` |
| `X-Content-Format` | `long` / `short` (social only; omitted for blog) |
| `X-Content-Signature` | hex HMAC-SHA256 of the **raw request body** keyed with `CONTENT_WEBHOOK_SIGNING_SECRET` (omitted only if the secret is unset) |

**Delivery / retries** (`dispatchContentWebhook`): up to **3 attempts** at `0s`,
`5s`, `30s` with a `10s` per-attempt timeout. A `2xx` response is success; any
non-2xx or network error retries. Every attempt is written to
`content_webhook_log`. If all 3 attempts fail, an ops alert fires (see
[Failure handling](#failure-handling)) and the row stays retryable from the
dashboard.

### Verifying the signature downstream

The signature is computed over the exact bytes of the request body. In a Make.com
custom-webhook + filter (or any receiver):

```
expected = hex( HMAC_SHA256( CONTENT_WEBHOOK_SIGNING_SECRET, raw_request_body ) )
accept if  expected == X-Content-Signature  header
```

Reject anything where they don't match (and drop requests missing the header
once the secret is configured). The same secret signs test fires, so a scenario
that verifies the signature still accepts the test payload.

---

## Payload contracts

All payloads are `{ event, timestamp, … , data }`. `timestamp` is ISO-8601 UTC
(the publish time). Test fires add a top-level `test: true` (see
[Test fires](#test-fires)); real publishes never include that key.

### `blog.published`

```jsonc
{
  "event": "blog.published",
  "timestamp": "2026-06-13T17:42:09.123Z",
  "data": {
    "id": "9f1c…",                       // blog_posts.id (uuid)
    "url": "https://gradethread.com/blog/<slug>",   // canonical, already absolute
    "title": "How to grade a used Patagonia jacket",
    "excerpt": "One-paragraph summary…",  // string | null
    "hero_image_url": "https://…/hero.webp", // string | null (OG/social card image)
    "primary_keyword": "grade used clothing", // string | null
    "tags": ["grading", "patagonia"],     // string[] (may be empty)
    "product_focus": "gradethread"        // "gradethread" | "flipdesk" | "both"
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `data.id` | `string` (uuid) | Stable id; use to dedupe in the scenario. |
| `data.url` | `string` | **Absolute** canonical post URL. Append UTM downstream (below). |
| `data.title` | `string` | Post headline; use as the share text lead. |
| `data.excerpt` | `string \| null` | Short summary for the post body. |
| `data.hero_image_url` | `string \| null` | Absolute image URL for the channel's image attachment / OG card. |
| `data.primary_keyword` | `string \| null` | For hashtag/keyword derivation. |
| `data.tags` | `string[]` | Topic tags; may be empty. |
| `data.product_focus` | enum | Route to the brand voice / channel set. |

### `social.published` (`long` and `short`)

```jsonc
{
  "event": "social.published",
  "format": "long",                       // "long" | "short" — also in X-Content-Format
  "timestamp": "2026-06-13T17:42:09.123Z",
  "data": {
    "id": "3a8e…",                        // social_posts.id (uuid) — SAME id for long & short
    "body": "Full post copy already sized for the platform…",
    "hashtags": ["grading", "reselling"], // string[], without the leading '#'
    "cta_url": "https://gradethread.com/?utm_source=social&utm_medium=social&utm_campaign=<campaign>", // string | null
    "product_focus": "flipdesk"           // "gradethread" | "flipdesk" | "both"
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `format` | `"long" \| "short"` | `long` → LinkedIn/Facebook scenario; `short` → X/Threads scenario. |
| `data.id` | `string` (uuid) | Same id across the long/short events from one post — dedupe per `(id, format)`. |
| `data.body` | `string` | **Post verbatim.** Already written to the format's length; don't re-summarize. |
| `data.hashtags` | `string[]` | Lowercased, **no `#` prefix**, deduped, ≤ 5. Add the `#` per channel convention. |
| `data.cta_url` | `string \| null` | Pre-built CTA link carrying neutral UTM params (see below). |
| `data.product_focus` | enum | Route to brand voice / channel set. |

---

## UTM source rewriting (applied downstream)

The edge service emits **channel-neutral** UTM params and the Make.com scenario
**rewrites `utm_source` per channel** during fan-out. This keeps attribution
correct without the edge having to know the channel map.

- `social.published` → `data.cta_url` is built by `buildSocialCtaUrl()`
  (`content-ai-social.ts`) as:

  ```
  https://gradethread.com/<path>?utm_source=social&utm_medium=social&utm_campaign=<campaign>
  ```

  where `<path>` is `/?focus=flipdesk` for `product_focus:"flipdesk"`, else `/`,
  and `<campaign>` is the topic slug (or an explicit `utm_campaign` override).

- `blog.published` → `data.url` is the bare canonical URL with **no** UTM params,
  so the scenario can append the full set.

**Downstream rule — the scenario rewrites `utm_source` (and appends it for blog)
to the channel it is posting to:**

| Channel | `utm_source` | `utm_medium` |
|---|---|---|
| LinkedIn | `linkedin` | `social` |
| X (Twitter) | `twitter` | `social` |
| Facebook | `facebook` | `social` |
| Threads | `threads` | `social` |
| Pinterest | `pinterest` | `social` |
| Instagram | `instagram` | `social` |

Implementation in Make.com: parse `cta_url` (or `url`), `Set query string`
`utm_source` to the channel name, keep `utm_medium=social` and the existing
`utm_campaign`, then use the rewritten URL in that channel's post/CTA. Leaving
`utm_source=social` is acceptable but loses per-channel attribution in PostHog /
GA. The neutral default exists precisely so a half-configured scenario still
produces a valid, trackable link.

---

## Configuration & secrets

Set in `services/edge-functions/.env` (Coolify env for prod):

| Var | Purpose | Required |
|---|---|---|
| `CONTENT_WEBHOOK_SIGNING_SECRET` | HMAC key for `X-Content-Signature` (`openssl rand -hex 32`). | Recommended — without it requests are unsigned. |
| `CONTENT_ALERT_WEBHOOK` | Slack/PagerDuty URL pinged on terminal delivery failure. Falls back to `MONITOR_ALERT_WEBHOOK`. | Optional |
| `PUBLIC_SITE_URL` | Canonical site root for building `url`/`cta_url`. | Yes (defaults to `https://gradethread.com`). |

The three **target URLs** are **not** env vars — they live in
`content_settings` (row id 1) and are edited at `/admin/content/settings`:
`make_webhook_blog`, `make_webhook_social_long`, `make_webhook_social_short`.
This lets you point/repoint scenarios without a redeploy; a changed URL even
takes effect on a **retry** of a previously-failed log row.

---

## How to add a channel

1. **Build the Make.com scenario.** Start with a **Custom webhook** trigger →
   copy the generated webhook URL.
2. **Register the URL.** Paste it into the matching field at
   `/admin/content/settings` (`blog`, `social_long`, or `social_short`).
3. **Verify the signature** (recommended): add a filter right after the trigger
   that recomputes the HMAC over the raw body with
   `CONTENT_WEBHOOK_SIGNING_SECRET` and compares to `X-Content-Signature`; stop
   on mismatch.
4. **Filter out test fires:** add `test` *(exists / is true)* → route to a
   no-op/notification branch so test fires never reach the live channel.
5. **Rewrite UTM:** for each social channel module, rewrite `utm_source` on
   `cta_url` (or append the full UTM set on blog `url`) to the channel name (see
   the table above).
6. **Map the post:** social channels use `data.body` verbatim + `#` +
   `data.hashtags`, attach `data.hero_image_url` (blog) where supported, and link
   the rewritten URL.
7. **Connect the channel** (LinkedIn/X/etc. OAuth in Make.com) and add the
   create-post module. Branch on `product_focus` and `format` if a channel only
   wants one product or one length.
8. **Test fire** from `/admin/content/settings` → "Test webhook" for that target.
   The fire mirrors the **exact** real payload shape (plus `test:true`) so Make.com
   maps every field correctly. Confirm the run in Make.com and the
   `succeeded:true` row in the webhook log.
9. **Activate** the scenario. The next real publish fans out automatically.

> **Important — map fields from a payload that has every field set.** Make.com
> infers the data structure from the *first* request it sees. The test fire was
> deliberately built to carry the full field set (`body`, `hashtags`, `cta_url`,
> `product_focus`, …) so real publishes don't go out with unmapped/empty fields.
> Always test-fire before the first real publish.

---

## Test fires

`POST /api/content/settings/webhooks/test` `{ "target": "blog" | "social_long" | "social_short" }`
(wired to the "Test webhook" buttons on the settings page). It sends a payload
**identical in shape** to a real publish for that target, plus a top-level
`test: true`, signs it with the same secret/headers, logs the attempt to
`content_webhook_log`, and returns `{ succeeded, http_status, response_body,
latency_ms, error }`.

Use this to prove a channel is wired end-to-end **before** trusting the autonomous
scheduler — downstream scenarios must filter on `test:true` so these never post
to a live channel.

---

## Observability & failure handling
<a id="failure-handling"></a>

- **Log:** every attempt (real, retry, and test) lands in `content_webhook_log`
  with `event, format, target_url, payload, attempt_no, http_status,
  response_body, succeeded, error`. Surfaced at `/admin/content/settings` (last
  50) and `/admin/content/analytics` (webhook health).
- **Retry:** `POST /api/content/settings/webhooks/:logId/retry` re-fires a logged
  payload against the *current* target URL (one-click in the dashboard).
- **Alerting (US-487):** a dispatch that exhausts all 3 attempts records a
  `content_webhook.delivery_failed` metric, reports to the error tracker, and
  POSTs a Slack/PagerDuty-shaped alert to `CONTENT_ALERT_WEBHOOK`
  (→ `MONITOR_ALERT_WEBHOOK` fallback). A webhook failure **never** rolls back the
  publish — the post is live regardless; only its distribution is retried.

---

## Going live — end-to-end checklist (operator)

The code path is complete; turning on a real channel is a one-time human setup
(Make.com scenario + social-channel OAuth):

1. Set `CONTENT_WEBHOOK_SIGNING_SECRET` (and optionally `CONTENT_ALERT_WEBHOOK`)
   in Coolify; redeploy the edge service.
2. Build **one** scenario (start with `social_short` → X, the lowest-risk channel)
   following [How to add a channel](#how-to-add-a-channel).
3. **Test fire** `social_short`; confirm `succeeded:true` in the log and the run
   in Make.com (still gated behind the `test:true` filter — no live post yet).
4. Remove the test gate's stop / wire the live X module; publish one real social
   post from `/admin/content/social` (autopilot can stay **off**).
5. Confirm the post appears on X with the correct copy, hashtags, and a
   `utm_source=twitter` CTA link → **AC2 satisfied** (one channel end-to-end).
6. Repeat for `social_long` (LinkedIn) and `blog`, then enable autopilot per
   [CONTENT_SCHEDULER.md](./CONTENT_SCHEDULER.md).
