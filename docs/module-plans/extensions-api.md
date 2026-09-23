# Browser extensions, SDK & public API

Health: **needs-work**

The extensions are in good shape. All 82 extension test files plus the selector verifier pass (ran `node scripts/test-extensions.mjs`), and the extension-specific work that is left is already in the open backlog. The public API is the weak half. Any logged-in user can raise their own API key's rate tier or clear its quota through a leftover database policy. Customers can't verify webhook signatures in prod. Each API key gets its own copy of every webhook. And the SDK the docs tell people to `npm install` has never been published to npm.

## Actions

### 1. Close the api_keys self-upgrade hole: users can set their own rate_tier, monthly_quota, scopes and expiry

Impact: high | Effort: S | Story: none

**Why:** The database policy "Users can update own API keys" (supabase/migrations/00322_api_keys_webhook_url_idempotent.sql:23-25, USING auth.uid() = user_id, no column limit) lets any signed-in user PATCH their own api_keys row through the public database API (PostgREST). That row now holds rate_tier and monthly_quota (00409_api_key_quotas.sql:10-12), and api-key-auth.ts:140-144 trusts rate_tier as-is ('enterprise' gives the top per-minute tier), while api-key-auth.ts:149 treats a null monthly_quota as unlimited. The policy was added for PATCH /api/v1/webhook (00005 comment), but that route now writes with the service-role key (api-v1.ts:1155-1158), so nothing needs the policy. Separately, nothing in the code ever sets monthly_quota, and POST /api/keys inserts new keys without one (routes/api-keys.ts:289-297). So an owner or admin with a capped key can delete it and make a new key with no cap. The INSERT policies (00001:292, 00042:441) also let clients write rate_tier and monthly_quota directly. That is only harmless today because API_KEY_PEPPER stops them from computing a usable key_hash.

**Steps:**
- Load the migrations skill. Write an idempotent migration that drops "Users can update own API keys". If any client path still needs to update a column, use column-level privileges instead: REVOKE UPDATE ON api_keys FROM authenticated, then GRANT UPDATE (name) only.
- Do the same for INSERT: either drop the client INSERT policies (keys are only minted in routes/api-keys.ts) or add a WITH CHECK that rate_tier and monthly_quota are null.
- Move quota and tier to the account (a users or api_accounts column that only the service role can set), or copy the owner's cap onto every new key in POST /api/keys, so deleting a key and making a new one can't escape a quota.
- Prove it on the local Postgres 16 stack described in CLAUDE.md: add a check-*.mjs --dsn script that, as an authenticated JWT, tries to UPDATE rate_tier and INSERT with monthly_quota and expects 42501 or zero rows. Break the policy on purpose once and watch the check go red.
- Before closing, confirm on prod that the policy is gone. Local grants can't answer that (per the US-3350 note).

### 2. Give webhooks a secret customers can actually get, and sign a timestamp

Impact: high | Effort: M | Story: none

**Why:** lib/webhook-delivery.ts:15 and :191 sign every delivery with api_keys.key_hash. In prod that value is HMAC(API_KEY_PEPPER, key) (lib/api-key.ts:49-61; vault/10-ops/env-reference.md:399 says the pepper is prod-fatal), so a customer can't compute it from their key. No endpoint returns it either: GET /api/keys selects everything except key_hash (routes/api-keys.ts:40). The public docs still tell customers to verify with 'that key's hash' (lib/openapi-spec.ts:414, :865; src/pages/marketing/developers.tsx:400), which in practice can't be done. The signature covers only the body, with no signed timestamp header and no event id (WebhookPayload at webhook-delivery.ts:7-11), so a captured delivery can be replayed. Rotating a key (api-keys.ts:348-356) also changes the signing secret silently.

**Steps:**
- Add an account-level webhook_secret (whsec_ prefix, random, encrypted at rest like other secrets). Show it once and give it its own rotate endpoint, separate from API key rotation.
- Sign `${timestamp}.${body}` and send X-GradeThread-Timestamp and X-GradeThread-Event-Id (or adopt Standard Webhooks, since lib/standard-webhook.ts already verifies that scheme for inbound hooks).
- Update openapi-spec.ts, developers.tsx and the SDK README, and add a verifyWebhook(rawBody, headers, secret) helper to sdk/gradethread-js/src/index.ts with a tolerance window.
- Add services/edge-functions/src/tests/webhook-delivery_test.ts. It should pin the signature and fail if key_hash is ever used as the secret again. No test covers webhook-delivery.ts today.

### 3. Deliver each webhook once per account, keep retries through a restart, and log attempts

Impact: high | Effort: M | Story: none

**Why:** PATCH /api/v1/webhook writes the same URL onto every key the user owns (api-v1.ts:1155-1158), and notifyWebhooks then POSTs once per key with a webhook_url (webhook-delivery.ts:149-193). So a customer with 3 keys gets 3 identical grade.completed events for one grade, each signed differently. Keys created after the PATCH get no webhook_url (api-keys.ts:289-297), which contradicts 'Applies to ALL of your API keys' (openapi-spec.ts:411). Retries are in-process sleeps of 5s, 30s and 120s (webhook-delivery.ts:4), and every push to main restarts the edge (open US-2609), so any retry in flight at deploy time is lost. No delivery row is written, so neither the customer nor support can see what was sent.

**Steps:**
- Move webhook_url to one row per account (a new api_webhooks table, or a users column) and send one delivery per grade.
- Persist each attempt in a webhook_deliveries table (event_id, status, attempts, next_attempt_at, last_status_code). Let a jobs-* cron retry due rows, following the durable-jobs skill's claim/heartbeat contract.
- Add tests for one-delivery-per-grade and for resuming a retry after a restart. Add a tenant-isolation case for any new read endpoint (tenant-isolation skill).

### 4. Publish the SDK for real: build it, cover the API, send Idempotency-Key, and test it

Impact: high | Effort: M | Story: none

**Why:** The docs say `npm install @gradethread/sdk` (developers.tsx:445, sdk/gradethread-js/README.md:12, linked from api-keys.tsx:606), but registry.npmjs.org returns {"error":"Not found"} for that name (checked 2026-09-22). package.json points main, types and exports at ./src/index.ts, so plain Node can't import it even after publishing. The SDK wraps 6 of the 17 /api/v1 routes (index.ts:181-213; missing: grades/batch, batch status, items, listings, sales, usage, price-guide). It never sends Idempotency-Key, so an SDK retry of grades.create charges twice today, and every SDK create call would fail with 400 IDEMPOTENCY_KEY_REQUIRED once the operator sets API_IDEMPOTENCY_REQUIRED=true (middleware/api-idempotency.ts:130-140). It has no tests and appears in no verify lane or CI workflow (grep of package.json, scripts/verify.mjs and .github/workflows finds nothing).

**Steps:**
- Add a tsc build to dist/ (ESM plus .d.ts) and point main, types and exports at dist.
- Make grades.create and grades.batch auto-generate an Idempotency-Key (crypto.randomUUID) and reuse it on retry. Add a small retry for 429 and 5xx that honors Retry-After.
- Add the missing methods, and a parity test that parses apiV1Routes like tests/openapi-spec_test.ts:27 does and fails when a route has no SDK method or explicit exclusion.
- Add vitest tests using the injectable fetch, and add the SDK to verify:web.
- Until it's on npm, change developers.tsx and the README to say how to install from the repo, so the docs stop pointing at a 404. Then publish (operator step).

### 5. Add webhook settings to the dashboard: set URL, send a test event, see recent deliveries

Impact: medium | Effort: S | Story: none

**Why:** developers.tsx:396 says the webhook can be set via PATCH '(or in your dashboard)', but src/pages/api-keys.tsx only mentions webhooks as a scope label (line 61). There is no field for the URL, no test send and no delivery history, so a customer can't tell whether their endpoint receives anything.

**Steps:**
- Add a Webhooks card to src/pages/api-keys.tsx backed by new session-auth routes in routes/api-keys.ts (owner/admin role check like the others at lines 29-36).
- Include 'Send test event' (a signed ping using the new secret) and a list of the last 20 rows from webhook_deliveries (depends on the delivery and secret actions above).
- Add a vitest page test next to src/test/api-keys-gate.test.tsx.

### 6. Cut per-request database work in API key auth

Impact: low | Effort: S | Story: none

**Why:** Every /api/v1 and MCP request does a key lookup, an unconditional UPDATE of last_used_at, and a users lookup (middleware/api-key-auth.ts:95-99, :110-117, :126-130), plus a COUNT over api_usage_events when a quota is set (:152-156). That is a write on every read call and three or four round trips before the handler runs.

**Steps:**
- Only write last_used_at when the stored value is more than about 60s old. Filter with .lt on the column so it stays one statement, and don't use .or(), per the US-1552 note.
- Cache the resolved identity (key id, owner plan, scopes) in memory for about 30s, keyed by key_hash, and clear it on delete or rotate in routes/api-keys.ts.
- Measure p50 latency on GET /api/v1/grades before and after against the local stack with PostgREST.

### 7. Close stale story US-2727; its fix is already in prod

Impact: low | Effort: S | Story: US-2727

**Why:** prd.json still lists US-2727 (listed_at NOT NULL breaks the extension writeback INSERT) as open at priority 5. But supabase/migrations/00634_listings_listed_at_nullable.sql:28 drops the NOT NULL, PENDING_MIGRATIONS.md:7076 records '✅ APPLIED 2026-08-20: 00634', and the story's own notes describe the fix as landed. A stale high-priority story pulls agents back to finished work.

**Steps:**
- Read the remaining acceptance criteria with `node scripts/prd-story.mjs show US-2727`.
- If any criterion needs a prod check, run it. Otherwise close with `prd-story.mjs done US-2727`, and file the two separate findings in its notes (silent early return at listing-kit.tsx:381, listings.ebay_drift missing from migrations) if they aren't filed yet.

## Risks

- The api_keys UPDATE policy finding comes from the migration tree. Prod privileges can't be checked locally (CLAUDE.md, US-3350), so confirm on prod that the policy and the table grant both exist before calling it exploitable there.
- Changing the webhook secret or signature format breaks any customer who worked around the problem by reading key_hash through the database API. Ship the new headers alongside the old signature for a while before dropping it.
- Three extension packages still ship. extension/ and extension-condition/ can only be retired after the operator unpublishes their store listings (US-1872 AC5, gated by scripts/lib/extension-retirement-gate.cjs). Until then every shared fix has to land in three places.
- Most extension lister flows are 'awaiting live verification' (verify-lister-selectors output: revise, relist and sold-sync are enabled on no platform). Real value depends on the operator stories US-3058 and US-3071 and on selector fixtures (US-3063), not on more code.
- Cross-posting from the web app is still unreachable in production per open US-2718 (priority 8). Until that ships, connect-extension.tsx improvements have limited reach.
