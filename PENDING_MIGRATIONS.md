# PENDING MIGRATIONS — apply BEFORE pushing this branch to origin

**Two pending: 00515 and 00516 — the branch is FROZEN until both are applied.** Prod
measured at **00514** on 2026-08-03: `/health/ready` returned
`schema {expected:"00513", applied:"00514", status:"ahead"}`, the database's own
answer through the service-role client rather than someone's recollection.
`EXPECTED_SCHEMA_VERSION` is now **00516** and the highest migration in the tree
is `00516_debit_grade_credits_idempotency.sql`, so the tree is two ahead of prod.
Apply in number order: 00515 then 00516.

Unlike the last two, this one is **not** inert: the FlipDesk inventory table
calls `flipdesk_listing_page` on every render. Apply it before pushing.

> [!note] Why that read said `expected: "00513"` and it was still correct
> The running edge image was built from the commit that carried
> `EXPECTED_SCHEMA_VERSION = "00513"`. `status: "ahead"` means the DATABASE is
> newer than the image expects, which the boot guard treats as a warning and
> serves through — a newer DB still serves an older edge. The next Coolify
> deploy picks up the 00514 bump and the two line up at `match`.
>
> The reverse of that ordering is the dangerous one, and it nearly happened:
> a concurrent agent pushed 00513 with its version bump on 2026-08-02, ahead of
> the hold. Had the edge redeployed before the SQL was applied, the guard would
> have seen a CONFIRMED BEHIND in production, exhausted its ~40s grace window,
> exited non-zero, and Coolify's restart loop would have crash-looped the whole
> service (Traefik "no available server" on every route — see
> `vault/10-ops/edge-hang-vs-crash-loop.md`). Applying the SQL closed that
> window. Keeping migrations held until they are applied is what prevents it.

Why entries have gone stale here before: this file is edited by hand and nothing
flips the marker when the SQL runs. The session-start hook reads these ⏳
markers, so a stale one tells every future session the branch is frozen when it
is not — which has happened twice (see the US-2017 note in prd.json). **When you
apply a migration, flip its marker in the same sitting.**

---

## ⏳ HELD: 00516_debit_grade_credits_idempotency.sql (US-2289 AC2 double-charge defence, 2026-08-03)

**Risk: LOW, and it cannot change existing behaviour.** The new parameter is
TRAILING and defaults to NULL, so every existing 4-arg caller behaves exactly as
before. The old 4-arg overload is dropped in the same file — left in place it
would silently keep winning for those callers and they would stay on the
pre-idempotency body.

**What it does.** `debit_grade_credits` gains `p_idempotency_key`. When a key is
supplied and a ledger row already carries it, the function debits NOTHING and
returns the current balance. The storage was already there and unused: 00216
added `grade_credit_transactions.idempotency_key` and a partial unique index on
it, and the grading path never set it.

**Why.** A reclaimed batch-grading job re-entered the charge path, so one garment
could be debited up to 5 times (MAX_GRADE_JOB_ATTEMPTS). The ROOT fix already
shipped — the job row carries its submission_id, so a reclaim resumes instead of
restarting — and this is the second line for any path that bypasses it. The edge
now passes `grade-batch-job:{jobId}`, keyed on the JOB because that is what a
reclaim re-runs.

**Verified against a real database before being written down** (applied to the
local stack, exercised in a transaction, rolled back): the same key three times
debits ONCE (balance 10 → 7 → 7 → 7, exactly one ledger row); a different key
debits normally; and a call with NO key debits every time, which is what keeps
the existing callers correct.

**Apply:**

1. Run `supabase/migrations/00516_debit_grade_credits_idempotency.sql`.
2. `NOTIFY pgrst, 'reload schema';` — the RPC signature changed.
3. Redeploy the edge (boot guard expects 00516).

**Verify:** grade one item. The balance should drop by exactly the tier cost, and
`grade_credit_transactions` should show one `grade_debit` row carrying an
`idempotency_key` of `grade-batch-job:…` for batch grades.

---

## ⏳ HELD: 00515_flipdesk_listing_page.sql (US-2168 AC3 server-side row selection, 2026-08-03)

**⚠️ THE LISTINGS PAGE NOW DEPENDS ON THIS.** An earlier draft of this entry said
nothing called it yet; that is no longer true. `src/pages/flipdesk/listings.tsx`
calls `flipdesk_listing_page` for every render of the inventory table, so on a
database without this migration the table shows an error instead of rows.

**Order matters.** Cloudflare Pages auto-deploys the frontend on push. Apply
this BEFORE pushing, or the inventory table is broken for the window between
the Pages deploy and the migration.

It adds one collation and four functions; it changes no table, no column and no
existing function, so there is nothing to back out of.

**What it adds:**

- `public.natural_ci` — an ICU collation (`en-u-kn-true-ks-level1`) that matches
  JavaScript's `localeCompare(numeric:true, sensitivity:"base")`, so a
  server-side column sort orders identically to the client sort it replaces.
- `flipdesk_filter_matches(jsonb, jsonb)` — SQL mirror of `evalQuery()`.
- `flipdesk_listability_score(jsonb)` / `flipdesk_max_comp_price(jsonb)` — SQL
  mirrors of the two computed sort keys.
- `flipdesk_listing_page(...)` — one page of the listings table, filtered,
  searched, sorted and counted server-side. It also returns `soldAgg` (over the
  whole FILTERED set) and `buyerCounts` (over the whole ACCOUNT), because both
  are numbers the page used to derive from every row and would otherwise
  silently become per-page numbers. `p_columns` carries the page's own column
  list so the wire is not widened to all 61 columns.

**SECURITY INVOKER on purpose.** `items_full` is `security_invoker = on` (00010),
so RLS scopes these to the calling seller. They are granted to `authenticated`
and are called from the BROWSER, not the edge — the opposite of US-2393's case,
and the reason the guard question does not arise here. Making
`flipdesk_listing_page` `SECURITY DEFINER` would turn it into a cross-tenant
read; do not.

**Verified before being written down:** the parity harness
(`src/test/listing-page-sql-parity.test.ts`) seeds a corpus, reads the rows back
out of `items_full`, and runs BOTH the TypeScript `selectListingRows` and this
SQL over those same rows — 73 cases covering 8 tabs, 4 sort presets, 24 column
sorts, 6 searches, 5 sold-filter windows and 18 advanced filters, the Sold
aggregate strip, the repeat-buyer counts, and a paging check that no row is
dropped or repeated. All 73 match on row ids **and order**. Re-run with:

```
LISTING_PARITY_DB=1 npx vitest run src/test/listing-page-sql-parity.test.ts
```

**Apply:**

1. Run `supabase/migrations/00515_flipdesk_listing_page.sql`.
2. `NOTIFY pgrst, 'reload schema';` — new RPCs; PostgREST 404s them until it
   reloads.
3. Redeploy the edge (boot guard expects 00515).
4. Then push.

**Verify:** open FlipDesk → Inventory. The table should list items, the header
should read "N items", tab switching and search should still work, and paging
should move through the set. If the function is missing the table errors rather
than rendering a wrong subset, which is the intended failure direction.

---

## ✅ APPLIED: 00514_admin_metrics_service_role_guard.sql (US-2393 admin System 500, 2026-08-02 · applied — measured 2026-08-03)

**This one fixed a LIVE outage** — the admin System tab had been returning 500 —
**and it was independent of 00513.** Applied 2026-08-03.

**What it does.** Recreates `admin_system_metrics()` and
`admin_revenue_metrics()` with one line changed each: the guard becomes
`auth.role() = 'service_role' or public.is_admin()` (the 00207/00227 pattern).
Nothing else about either function changes — the bodies are
`pg_get_functiondef()` output, generated rather than retyped, so the diff cannot
carry a behaviour change alongside the fix.

**Why.** Both are called from `GET /api/admin/dashboard/system` through
`supabaseAdmin`, the service-role client. `is_admin()` identifies the caller via
`auth.uid()`, which is NULL for a service-role JWT — it has no `sub`. So the
guard raised 42501 on *every* call and the route has been answering **500** ever
since US-1565 moved that page behind the edge admin boundary. Confirmed against
a real database on 2026-08-02, not inferred: `set local role service_role;
select public.admin_system_metrics();` → `ERROR: admin_system_metrics: admin
role required`.

**Security: nothing is given up.** The route is already gated by the edge admin
middleware (JWT + role + AAL2 + audit) — that is exactly what US-1565 moved it
there for — and an authenticated non-admin is still refused by the `is_admin()`
half. Both directions were verified locally after applying: service-role
succeeds, and an authenticated non-admin still raises 42501.

**Risk: LOW.** `CREATE OR REPLACE FUNCTION` only, re-runnable, no schema change.

**Apply:**

1. Run `supabase/migrations/00514_admin_metrics_service_role_guard.sql`.
2. `NOTIFY pgrst, 'reload schema';` (function bodies changed).
3. Redeploy the edge (boot guard expects 00514).

**Verify:** open the admin **System** tab. It should render queue depth,
processing time, storage and subscription numbers instead of failing to load.

---

## ✅ APPLIED: 00513_admin_dashboard_aggregates.sql (US-2390 exact admin KPIs, 2026-08-02 · applied — measured 2026-08-03)

**What it does.** Adds three read-only aggregate functions and nothing else — no
table, column, index or enum is touched, so there is no data migration and
nothing to back out of:

- `admin_dashboard_aggregates(timestamptz)` — all-time average grade, the graded
  report count, and month-to-date revenue.
- `admin_dashboard_daily_series(timestamptz[])` — per-bucket submission /
  new-user / revenue counts for the dashboard's 30-day charts.
- `admin_platform_analytics(timestamptz[], int)` — funnel, plan mix, top users,
  cohort retention and the 90-day grade-volume trend.

All three are `SECURITY DEFINER` with the 00207/00227 guard
(`auth.role() = 'service_role' or is_admin()`), and both `authenticated` and
`service_role` get EXECUTE.

**Risk: LOW.** `CREATE OR REPLACE FUNCTION` only. Re-running is a no-op. Nothing
existing is altered, so applying it cannot affect any surface other than the
admin dashboard.

**⚠️ ORDER MATTERS, and the frontend is the reason.** The client half of this
commit stops reading `raw` from `GET /api/admin/dashboard/summary` and reads a
new `analytics` object instead. Cloudflare Pages auto-deploys the frontend the
moment this is pushed, but the edge redeploys separately — so between the push
and the Coolify deploy, the new admin dashboard talks to the OLD edge and the
Analytics tab renders zeros (an empty funnel, no cohorts, no top users). The
KPI cards and charts keep working. It is cosmetic and self-healing, but it is
visible, so apply and redeploy the edge promptly after pushing.

**Apply:**

1. Run `supabase/migrations/00513_admin_dashboard_aggregates.sql` against prod.
2. `NOTIFY pgrst, 'reload schema';` — **required**, these are new RPCs and
   PostgREST will 404 `/rpc/admin_dashboard_aggregates` until it reloads.
3. Redeploy the edge on Coolify (its boot guard now expects 00513).
4. Then OK the push.

**Verify after applying** — as the operator, on the admin dashboard: Average
Grade shows a number and reads "Across all grades"; the Analytics tab's funnel,
plan mix, top users and cohort table are populated. If the RPCs are missing the
summary endpoint returns 500 rather than rendering wrong numbers, which is the
intended failure direction.

---

## ✅ APPLIED: 00512_job_lock_holder_release.sql (US-2311 job-lock holder check, 2026-08-02 · applied — measured 2026-08-02)

> [!note] How 00510–00512 were confirmed, and what that evidence does NOT cover
> Flipped on 2026-08-02 from a live measurement, not from someone remembering.
> `GET https://functions.gradethread.com/health/ready` returned
> `schema {expected:"00512", applied:"00512", status:"match"}` — the US-1566
> block reading `applied_migrations` through the service-role client, i.e. the
> database's own answer rather than a config file.
>
> **The limit of that evidence.** `applied` is the recorded MAX. It proves 00512
> landed and that nothing above it is expected. It does **not** individually
> prove 00510 and 00511, because a mid-sequence gap is invisible to a maximum —
> that is US-2009's whole subject, and the blind spot that let 00005 never land
> while the watermark moved on regardless. Section 1 of
> `scripts/prod-diagnostics.sql` answers it properly by listing gaps.
> **If that query reports a gap at 00510 or 00511, flip the heading back and
> apply the file.** Every migration here is idempotent, so re-running one that
> did land costs nothing.
>
> **Why flipping was safe either way.** All three were already on `origin/main`
> before this. The hold was blocking future pushes of unrelated work, not
> holding these back — so the code-ahead-of-schema risk the gate exists to
> prevent had already resolved one way or the other, and the doc was simply
> out of date. Precedent: the same measurement cleared 00475/00476 on
> 2026-07-18 (recorded on US-1880).

- **Apply order.** After 00511. Idempotent: `DROP FUNCTION IF EXISTS` then
  `CREATE OR REPLACE FUNCTION`, the whole file in one transaction. Verified safe
  to re-run — `DROP FUNCTION` matches the declared signature exactly and ignores
  defaults, so a second run does **not** drop the new two-arg function.
- **What it does.** Replaces `release_job_lock(p_job text)` with
  `release_job_lock(p_job text, p_holder text default null)`, whose DELETE adds
  `AND (p_holder is null or holder = p_holder)`. The `holder` column and the
  `try_acquire_job_lock` parameter that fills it have both existed since 00094;
  nothing ever passed a value.
- **Why.** The old release was an unconditional DELETE, so a run whose lease
  expired — and whose lock was then legitimately stolen by the next tick — went
  on to delete the NEW holder's live lock when it finished. The tick after that
  acquired freely and ran concurrently. Worked example on `autolister-reclaim`
  **as it was before this commit** (300s lease, `*/5` schedule, so lease ==
  interval exactly): tick 1 acquires at 0:00, tick 2 steals at 5:00, tick 1
  releases at 5:30 and destroys tick 2's lock, tick 3 acquires at 10:00 alongside
  the still-running tick 2. Mutual exclusion does not degrade there, it
  disappears. The same commit raises that lease to 600s (and six others like it),
  so the example describes a configuration this change removes — the holder check
  is the fix, the lease bump is defence in depth.
- **Risk: LOW.** Strictly narrows a DELETE, and the SQL is wrapped in
  `begin`/`commit` so there is no window in which the function is missing.
  **Apply-order, both directions:**
  - *SQL first, old edge still live* — safe. The deployed build sends only
    `p_job`, which binds to the new two-arg function through its default and
    behaves exactly as today.
  - *New edge first, SQL not yet applied* — degraded, not corrupting, and it
    should not be reachable. The new build sends `{p_job, p_holder}`, which
    PostgREST cannot bind to the old one-arg function (PGRST202); `job-lock.ts`
    catches it and logs `job.release_failed`, so locks expire on lease instead of
    releasing early. The boot guard makes a confirmed-behind DB fatal, so the
    only way to reach this is the fail-OPEN branch where the guard cannot read
    the tracker at all.
- **Why the one-arg function is dropped rather than kept alongside.** Two
  overloads where one has a defaulted second argument makes a *one-arg*
  named-argument call from PostgREST ambiguous (`function is not unique`;
  reproduced). Dropping it is what keeps the old edge working, not what breaks
  it.
- **⚠ The grant trap — the one thing to actually watch.** `DROP FUNCTION`
  discards the ACL, and a re-created function is a brand-new object that inherits
  nothing. `CREATE OR REPLACE` (what every other migration here does) preserves
  the ACL, so this hazard is unique to this file. Privileges would otherwise come
  only from the **applying role's** `alter default privileges`: apply as
  `postgres` and `service_role` gets EXECUTE back, apply as any other superuser
  and it does not — every `release_job_lock` call from the edge then returns
  42501 and locks only ever expire on lease. The migration therefore names the
  grant explicitly (`grant execute ... to service_role`) instead of relying on
  that, alongside the restated `REVOKE ALL ... FROM public, anon, authenticated`.
  If you apply by hand, do not stop after the `CREATE`. Verify after:
  `select proowner::regrole, proacl from pg_proc where proname = 'release_job_lock';`
- **CLIENT reads/writes.** None. `job_locks` is service-role only; grepped `src/`,
  `ios/`, `android/` and `functions/` for `job_locks` / `release_job_lock` — no
  matches anywhere, so a frontend auto-deploy changes nothing.
- **After applying:** `NOTIFY pgrst, 'reload schema';` **is** required and is
  load-bearing here — PostgREST caches function signatures, so without it the new
  edge's two-arg call is rejected even against a correctly migrated DB.

---

## ✅ APPLIED: 00511_submissions_protected_columns_guard.sql (US-2376 submissions guard, 2026-08-01 · applied — measured 2026-08-02)

- **Apply order.** After 00510. Idempotent: `CREATE OR REPLACE FUNCTION`,
  `COMMENT ON FUNCTION`, `DROP TRIGGER IF EXISTS` then `CREATE TRIGGER`. Safe to
  re-run.
- **What it does.** Adds a BEFORE UPDATE trigger on `public.submissions` that
  raises if an `authenticated`-role caller changes any grading-lifecycle column:
  `status`, `payment_status`, `service_tier`, `authenticity_addon`,
  `refunded_at`, `flagged`, `flag_reason`, `moderation_status`,
  `grading_started_at`, `grading_lease_until`, `grading_attempts`,
  `superseded_at`, `superseded_by_submission_id`. Exact counterpart to
  `guard_users_protected_columns` (00331), including the
  `auth.role() <> 'authenticated'` short-circuit that lets the service-role edge
  client and SECURITY DEFINER paths through untouched.
- **Why.** "Users can update own submissions" (00451) is USING-only — no
  `WITH CHECK`, no column list — and the only other trigger on the table just
  stamps `updated_at`. So a seller holding their own JWT could PATCH their own
  row and set `status='completed'`, clear `refunded_at`, unset `flagged`, or
  reset `superseded_at` to pull a retaken submission back into the active count
  the monthly quota is measured against. This is US-2376's AC4 for the
  submissions half.
- **Risk: LOW-MEDIUM.** It removes a capability, so the risk is a legitimate
  writer being blocked. Verified there is none: no web, iOS or Android client
  writes `public.submissions` at all (the SPA's only two writes were the admin
  ones this same commit moved to the edge), and every server path — the grading
  pipeline, the stuck/abandoned sweeps, the admin routes — uses the service-role
  client, which the short-circuit exempts. Seller-editable fields (title,
  description, brand, garment_type/category, style_attributes,
  verified_capture_opt_in) are deliberately NOT in the list and stay writable.
- **CLIENT reads/writes.** None new. Nothing in the frontend reads or writes any
  column this touches, so the frontend deploying first changes nothing.
- **⚠ The 00076 failure mode, and how it was ruled out.** PL/pgSQL resolves
  `NEW.<field>` at RUNTIME, so a trigger naming a column that doesn't exist
  throws `42703` on EVERY update of the table — that is exactly what 00076 did to
  `public.users` for 255 migrations. This one was exercised against a live DB, not
  reasoned about: `supabase db reset` from zero on the local stack (2026-08-01),
  then, per column, an UPDATE under `request.jwt.claims = {"role":"authenticated"}`.
  All thirteen raised; a title-only UPDATE **succeeded**, which is the load-bearing
  case — it forces the whole OR-chain to evaluate to false, so every one of the
  thirteen field references provably resolves. A service-role UPDATE setting
  `status='failed'` also succeeded.
- **After applying:** `NOTIFY pgrst, 'reload schema';` is not strictly required
  (no table/column/RPC shape change), but run it anyway with 00510's.
- **Deploy order.** No ordering constraint of its own — safe before or after the
  frontend. Follow 00510's sequence and apply this straight after it.

---

## ✅ APPLIED: 00510_prompt_versions_service_role_writes.sql (US-2348 prompt writes, 2026-08-01 · applied — measured 2026-08-02)

- **Apply order.** After 00509. Idempotent: three `DROP POLICY IF EXISTS` and
  one `COMMENT ON TABLE`. Safe to re-run.
- **What it does.** Revokes the RLS INSERT/UPDATE/DELETE policies on
  `ai_prompt_versions` that 00003 granted to every `is_admin()` caller. No
  replacement policy is created: with RLS on and no permissive policy for a
  command, that command is denied for every non-service role, and the edge's
  service-role client bypasses RLS entirely. The SELECT policy is deliberately
  KEPT — the admin UI still lists prompts directly.
- **Risk: MEDIUM — this one is order-sensitive.** It removes a capability the
  frontend currently uses. Cloudflare Pages auto-deploys the frontend on push,
  and the SAME commit repoints all four writes at
  `/api/admin/grading/prompts`, so the frontend is fine either way. What is NOT
  fine is applying the SQL while an OLD frontend build is still live: prompt
  create/edit/delete/deactivate would fail with an RLS error until the new
  build lands. The window is small and the surface is admin-only, but prefer
  SQL AFTER the frontend deploy here, which is the opposite of the usual order.
- **New edge routes in the same commit.** `PATCH /api/admin/grading/prompts/:id`
  and `DELETE /api/admin/grading/prompts/:id` do not exist in the deployed edge
  yet. Until the edge redeploys, the new frontend's edit and delete buttons 404.
  So: frontend deploy → edge redeploy → SQL is the safe sequence, and the edge
  redeploy must not lag.
- **CLIENT reads/writes.** Reads are untouched. Writes move entirely to the
  edge.
- **After applying:** `NOTIFY pgrst, 'reload schema';` — policies changed, and
  PostgREST caches them.
- **Deploy order.** frontend → edge → SQL (00508, 00509, then 00510).

---

## ✅ APPLIED: 00509_ebay_shipping_labels.sql (US-2160 buy eBay labels, 2026-07-31 · applied 2026-08-01)

- **Apply order.** After 00508. Idempotent: `ADD COLUMN IF NOT EXISTS`,
  `COMMENT ON COLUMN`, `CREATE INDEX IF NOT EXISTS`. Safe to re-run.
- **What it does.** Three columns. `marketplace_connections.logistics_access_denied`
  (boolean, default false) mirrors the existing `negotiation_access_denied` — a
  sticky flag set when a connection's token 403s a `/sell/logistics` call, so
  the label surfaces gate cheaply instead of re-probing eBay. `sales.ebay_shipment_id`
  and `sales.label_purchased_at` record a label bought in FlipDesk; the shipment
  id is what a reprint and a void need. The label PRICE goes into the existing
  `sales.shipping_cost`, so Finances and the per-item P&L need no change.
- **Risk: LOW.** Three new nullable/defaulted columns and one partial index. No
  existing column, view, enum or policy changes. `logistics_access_denied` has a
  `NOT NULL DEFAULT false`, so the rewrite is metadata-only on Postgres 11+.
- **CLIENT reads/writes.** The SPA does NOT read these columns directly — the
  ship dialog calls the edge (`/api/flipdesk/logistics/*`). A frontend deploy
  ahead of the SQL degrades to the capability probe failing closed, which HIDES
  the "Buy a label" block entirely (`useEbayLogisticsCapability` returns
  unavailable on a non-OK response). The manual tracking-number path is
  untouched. So the frontend-first ordering is safe here, not just tolerable.
- **After applying:** `NOTIFY pgrst, 'reload schema';` — PostgREST must learn
  the new columns or the label routes 400 at the API layer.
- **Deploy order.** SQL (00508 then 00509) → edge redeploy (its boot guard now
  expects 00509) → frontend.
- **NOT a blocker for the feature being off.** `sell.logistics` is a limited-
  release eBay scope that is deliberately absent from the default consent list
  (same posture as `sell.negotiation`, US-1967). Until the prod keyset is
  granted it and `EBAY_SCOPES` names it, `/capabilities` reports
  `feature_unavailable` and no label UI renders. The migration is still needed
  first so the edge boots.

---

## ✅ APPLIED: 00508_marketplace_event_item_link.sql (US-2156 automation triggers, 2026-07-31 · applied 2026-08-01)

- **Apply order.** After 00507. Idempotent: `ADD COLUMN IF NOT EXISTS`,
  `COMMENT ON COLUMN`, `CREATE INDEX IF NOT EXISTS`. Safe to re-run.
- **What it does.** Adds one nullable column,
  `marketplace_event_notifications.item_external_id` (the eBay legacy item id
  the offer/return happened on), plus a partial index for the automation
  lookup. The ledger already records WHICH event; this records WHAT it happened
  to, so the new `offer_received` and `return_opened` automation triggers can
  join it to `listings.platform_listing_id`.
- **Risk: LOW.** New nullable column on a service-role-only table. It is NOT
  part of the table's unique dedup key, so the US-1055 poll's idempotency is
  unchanged. Existing rows stay null and simply produce no automation match.
- **CLIENT reads/writes.** None. The SPA never touches this table — it is
  service-role-only (deny-all to anon/authenticated, classified in
  `SERVICE_ROLE_ONLY` in `rls-guard_test.ts`). So a frontend deploy ahead of
  the SQL changes nothing on the web app.
- **What breaks if the edge deploys first.** The poll's insert would name a
  column PostgREST doesn't know, so `claimMarketplaceEvent` fails-closed and
  offer/return/dispute notifications go quiet until the SQL lands. Apply the
  SQL first.
- **After applying:** `NOTIFY pgrst, 'reload schema';` — PostgREST must learn
  the new column or every insert naming it 400s at the API layer.
- **Deploy order.** SQL → edge redeploy (its boot guard now expects 00508) →
  frontend.

---

## ✅ APPLIED: 00507_autolister_handoff_sessions.sql (US-2374 phone → desktop handoff, 2026-07-31)

- **Apply order.** After 00506. Idempotent: `CREATE TABLE IF NOT EXISTS`,
  `CREATE INDEX IF NOT EXISTS`, `DROP POLICY`/`CREATE POLICY`,
  `DROP TRIGGER`/`CREATE TRIGGER`. Safe to re-run.
- **What it does.** Adds `public.autolister_handoff_sessions` — one row per
  batch the mobile app parks for the desktop AutoLister, holding the staged
  photo list and the grouping as JSONB. Owner-readable + owner-deletable via
  RLS; every write goes through the service-role edge client.
- **Risk: LOW.** New table only. Nothing existing reads or writes it, and no
  column, view or enum changes.
- **CLIENT reads/writes.** The SPA does NOT query this table directly — the
  AutoLister page calls the edge (`GET/POST/DELETE
  /api/flipdesk/autolister/sessions*`). So a frontend deploy ahead of the SQL
  degrades to the "Waiting from your phone" card never appearing (the list call
  500s and TanStack Query keeps an empty array), NOT a broken page. The iOS
  "Send to desktop" button fails with its own error banner until the table
  exists.
- **After applying:** `NOTIFY pgrst, 'reload schema';` — PostgREST must learn
  the new table or every edge call against it 404s at the API layer.
- **Deploy order.** SQL → edge redeploy (its boot guard now expects 00507) →
  frontend. The edge is what actually needs the table.

---

## ✅ APPLIED: 00506_items_full_quality_score.sql (US-2170 sortable quality score, 2026-07-30)

- **Apply order.** After 00505. Idempotent `CREATE OR REPLACE VIEW` (no DROP, so
  the analytics RPCs that SELECT from items_full are never observably absent).
- **What it does.** Exposes `listings.quality_score` (00476) as a new LAST column
  `quality_score` on the `items_full` view, so the inventory table can sort by
  the Listing Quality Score. Body is verbatim from 00438 plus the one column.
- **CLIENT reads/writes.** The SPA now reads `quality_score` off items_full rows
  (`ItemFullRow`, listings.tsx Quality column). If the frontend deploys before
  this applies, the column is simply absent → the row reads it as `undefined` and
  the Quality column sorts as "unscored"; it does NOT 42703 (the value is read
  from the already-selected row set, not a new filter). Low blast radius, but
  apply in order anyway.
- **If it stays unapplied.** Sorting by Quality is inert (all rows unscored)
  until applied; nothing breaks.
- **`NOTIFY pgrst, 'reload schema';`** after applying (the view changed).

---

## ✅ APPLIED: 00505_grading_roi_period_filter.sql (US-2234 AC3 grading-ROI presets, 2026-07-30)

- **Apply order.** After 00504. Idempotent (DROP FUNCTION IF EXISTS the 0-arg
  overloads, then CREATE OR REPLACE the 1-arg versions; grants; footer).
- **What it does.** Adds `p_period_start date default null` to
  `flipdesk_grading_roi()` and `flipdesk_grading_roi_summary()` so the Grading-ROI
  analytics tab can honour period presets like its siblings. Filters exactly like
  `flipdesk_sell_through` (sale_date/list_date `>= p_period_start`).
- **CLIENT reads/writes — SAY IT LOUD.** The SPA now CALLS these RPCs WITH
  `p_period_start` (`src/lib/flipdesk-analytics-server.ts` fetchGradingRoi /
  fetchGradingRoiSummary, driven by `analytics.tsx` GradingRoiReport). If the
  frontend auto-deploys before this migration is applied, the argless overload is
  gone and the new call passes an arg the old function never had → the Grading-ROI
  tab errors. ~~Apply 00505 to prod BEFORE the push.~~ (done — applied 2026-07-31.)
- **If it stays unapplied.** The Grading-ROI tab breaks once the frontend deploys
  (see above). Until the frontend deploys, prod is unaffected.
- **`NOTIFY pgrst, 'reload schema';`** after applying (functions changed).

---

## ✅ APPLIED: 00504_listings_is_active_lockstep.sql (US-2176 is_active lockstep, 2026-07-30)

- **Apply order.** Follows 00503. Idempotent (CREATE OR REPLACE FUNCTION, DROP
  TRIGGER IF EXISTS then CREATE TRIGGER, a guarded backfill DO block) — safe to
  re-run.
- **What it does.** Makes `listings.is_active` a derived mirror of
  `listing_status`: a BEFORE INSERT/UPDATE trigger (`trg_listings_sync_is_active`)
  sets `is_active := listing_status IN ('active','relisted')`, so the column is
  no longer independently writable, and a never-published draft is no longer born
  `is_active=true`. A backfill corrects existing rows where the two disagree and
  `RAISE NOTICE`s the corrected row count.
- **CLIENT reads/writes.** No NEW client read of a new column — `is_active` and
  `listing_status` already exist. The same commit DROPS the redundant
  `.eq("is_active", true)` from the storefront query
  (`content-public.ts loadStorefrontListings`), which keeps the authoritative
  `.eq("listing_status","active")` — so the storefront is correct whether or not
  the trigger has been applied yet. Nothing 42703s if this lands unapplied.
- **If it stays unapplied.** No breakage: existing code already writes `is_active`
  in lockstep by hand, so behaviour is unchanged until the trigger takes over
  enforcement. The backfill is the only thing that needs prod to run.
- **`NOTIFY pgrst, 'reload schema';`** after applying (a function + trigger changed).
- **Verification.** US-1108 triple green (`schema-version_test.ts` 18/18) AND
  db-lane verified — `npm run verify:db` re-applied the whole tree from zero
  (2026-07-30, green), so 00504 provably applies on a fresh schema.

---

## How this file works

The standing rule (US-1108, plus a direct instruction from the user): **a commit
containing a migration is committed locally but NOT pushed until the operator has
applied the SQL to prod.** Pushing runs ahead of the schema — Cloudflare Pages
auto-deploys the frontend the moment the branch lands, and the next Coolify edge
deploy boot-guards on `EXPECTED_SCHEMA_VERSION`.

So every held migration gets a section here before its commit, and the sections
are deleted once the operator confirms the apply.

### Adding a held migration

Add one `## ⏳ HELD: NNNNN_name.sql (US-#### short title, YYYY-MM-DD)` heading —
the exact shape matters, `.claude/hooks/session-context.mjs` parses it to warn at
the start of every session — then say:

- **Apply order.** Which migration it must follow, and why if that isn't obvious.
- **What it does**, in one paragraph. Objects created or altered.
- **Whether the CLIENT reads or writes anything new.** Say this LOUDLY if so.
  The SPA auto-deploys on push, so a client that writes a column the schema
  doesn't have yet breaks the moment the branch lands — that is the failure this
  whole file exists to prevent. Name the file and the code path.
- **Whether anything breaks if it stays unapplied.** A feature that degrades to
  its empty state is safe to push early; one that 42703s is not.
- **`NOTIFY pgrst, 'reload schema';`** whenever a table, column, or RPC changed.
- **Risk**, and whether it was exercised against a live DB (usually not — the
  `verify:db` lane needs Docker).

### Applying

1. Run the SQL in `NNNNN` order — `scripts/apply-prod-migrations.sh`, or by hand.
   Every migration is idempotent, so re-running the tail is safe.
2. `NOTIFY pgrst, 'reload schema';`
3. Redeploy the edge on Coolify.
4. Then push, and delete the section from this file.

### Clearing a section

Deleting the section is the whole job — this file is a queue, not an archive. The
reasoning is not lost: it lives in the migration's own header, in the story's
`prd.json` note, and in any vault note the migration's `code_refs` point at.

One more step, and it is easy to miss: a story whose `prd.json` note still calls
the migration HELD now says something false. `prd-lint` catches that (it warns on
any note claiming a hold for a migration already on `origin/main`), and because
notes are append-only the fix is to APPEND a `STATUS CORRECTION` line rather than
edit the original sentence.
