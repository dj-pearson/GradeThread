# PENDING MIGRATIONS — apply BEFORE pushing this branch to origin

**Two pending: 00510 and 00511.** Prod is at **00509** — the operator confirmed
on 2026-08-01 that 00507, 00508 and 00509 are all applied.
`EXPECTED_SCHEMA_VERSION` is **00511** and the highest migration in the tree is
`00511_submissions_protected_columns_guard.sql`, so the edge boot guard expects
00511 and prod is two behind.

Why the entries stayed marked HELD after they were applied: this file is edited
by hand and nothing flips the marker when the SQL runs. The session-start hook
reads these ⏳ markers, so a stale one tells every future session the branch is
frozen when it is not — which is exactly what happened here, and what happened
once before (see the US-2017 note in prd.json). **When you apply a migration,
flip its marker in the same sitting.**

---

## ⏳ HELD: 00511_submissions_protected_columns_guard.sql (US-2376 submissions guard, 2026-08-01)

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

## ⏳ HELD: 00510_prompt_versions_service_role_writes.sql (US-2348 prompt writes, 2026-08-01)

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
