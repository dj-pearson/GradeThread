# PENDING MIGRATIONS — apply BEFORE pushing this branch to origin

## ⏳ HELD: 00353_agentic_os_kernel.sql (US-1583, 2026-07-04)

**What:** the Agentic OS kernel — five NEW operator-only tables (agents,
agent_runs, agent_run_steps, agent_proposals, agent_memory) + four new enums
(agent_status, agent_run_status, agent_step_type, agent_proposal_status) +
updated_at triggers. RLS enabled, NO policies (service-role only).

**Risk: LOW.** Pure additive DDL — no existing table, view, or enum touched;
nothing client-side reads these tables yet (the runtime/UI stories follow).
The edge bumps EXPECTED_SCHEMA_VERSION to 00353, so the boot guard holds the
next edge redeploy behind this being applied.

**Apply order:** after 00350–00352. Then `NOTIFY pgrst, 'reload schema';`
and redeploy the edge.


## ⏳ HELD: 00349_draft_review_lifecycle.sql (US-1568/US-1569, 2026-07-03)

**What:** two changes in one transaction:
1. `listings.reviewed_at timestamptz` — the "a human reviewed this draft"
   marker (composer Save + bulk-edit save set it; regeneration clears it; the
   AutoLister drafts cockpit filters `reviewed_at IS NULL`).
2. `items_full` view recreated with three appended columns:
   `listing_needs_review`, `listing_reviewed_at`, `listing_title`
   (every pre-existing column reproduced in its exact 00306 position).

Idempotent (ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE VIEW); self-records
'00349'.

**Risk: MEDIUM — ⚠️ CLIENT-SIDE READS.** This commit's frontend:
- selects the three NEW view columns in the inventory table projection
  (`LISTINGS_COLUMNS` in listings.tsx) → the whole Inventory table (all tabs)
  **400s** the moment Cloudflare Pages auto-deploys, until 00349 is applied;
- filters the AutoLister drafts cockpit on `reviewed_at` → that page **400s**
  too;
- the composer/bulk-edit save writes `reviewed_at` → **saves fail**.

**Apply 00349 (after 00346–00348) BEFORE OKing the push.** Then
`NOTIFY pgrst, 'reload schema';` (REQUIRED here — new column + view) and
redeploy the edge (boot guard expects 00349).


## ⏳ HELD: 00348_autolister_carryover_backfill.sql (US-1567, 2026-07-03)

**What:** DML-only backfill (no schema change) repairing EXISTING AI-generated
AutoLister items whose Brand/Size/Color/Material/Style, attributes, title, and
description never carried from the aspect stores onto the item's own columns:

1. Fills blank `inventory_items.size/color/material/style` from
   `ebay_aspects` (Size / US Shoe Size / Color / Colour / Material / Type…).
2. Fill-only merge of attributes jsonb keys (department, size_type, pattern,
   fit, sleeve_length, features…) from the matching aspects.
3. Adopts the newest AutoLister draft's `listing_title` when the item still
   holds the "Item N"/"Untitled"/blank placeholder (mirrors
   shouldAdoptGeneratedTitle), and the draft description when the item has none.

STRICTLY FILL-ONLY: seller-typed values are never overwritten. Idempotent —
re-running changes nothing. Self-records '00348'.

**Risk: LOW.** Pure data fill on existing columns; no DDL, no enum, no RLS.
The paired edge change (`aspectCarryOver` in ai-listing.ts, EXPECTED_SCHEMA_VERSION
→ 00348) handles all FUTURE generations and only writes columns that already
exist — nothing client-side reads a new column, so the frontend auto-deploy is
safe even before this is applied; the backfill just makes OLD drafts whole.

**Apply order:** after 00346–00347. Then `NOTIFY pgrst, 'reload schema';`
(harmless for DML-only, keeps the runbook uniform) and redeploy the edge
(boot guard expects 00348).


## ⏳ HELD: 00352_measure_corrections.sql (US-1580, 2026-07-03)

**What:** `measure_corrections` operator table (correction-delta telemetry:
class/key/proposed/final/delta/confidence — no photo content; deny-all RLS,
service-role only). Idempotent; self-records '00352'.

**Risk: LOW** (new deny-all table). Client reads nothing; the editor posts to
the edge (boot-guarded on 00352). Apply after 00351, then
`NOTIFY pgrst, 'reload schema';`.

---

## ⏳ HELD: 00351_measure_card_requests.sql (US-1579, 2026-07-03)

**What:** `measure_card_requests` operator table (mailed-card fulfillment
queue; deny-all RLS, service-role only, owner_user_id convention; partial
unique index = one active request/seller) + `users.measure_card_version` /
`users.measure_card_source` profile columns. Idempotent; self-records '00351'.

**Risk: LOW** (new table + nullable user columns). Client reads NOTHING new
directly — the tools page talks to the edge (card-request routes boot-guarded
on 00351). Apply after 00350, then `NOTIFY pgrst, 'reload schema';`.

---

## ⏳ HELD: 00350_measurement_overlay_photo_type.sql (US-1577, 2026-07-03)

**What:** `ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'measurement_overlay';`
— the GENERATED card-free annotated measurements photo (listing-eligible,
never primary). Idempotent; self-records '00350'.

**Risk: LOW.** Client-side reads: the web photo pickers list the new type the
moment the frontend deploys — retagging a photo TO it 400s until applied
(same class as 00346). Edge writes it only post-boot-guard (version 00350).
NOTE: Ralph's 00348 (carry-over backfill) + 00349 (draft review lifecycle)
sit between — apply 00346 → 00350 IN ORDER, then NOTIFY pgrst.

---

## ⏳ HELD: 00347_measure_calibration.sql (US-1572, 2026-07-03)

**What:** `ALTER TABLE public.item_photos ADD COLUMN IF NOT EXISTS measure_calibration jsonb;`
— persisted MeasureCard calibration (homography/ppi/quality) so the editor
never re-runs detection. Idempotent; self-records '00347'.

**Risk: LOW** (nullable column add). Client-side reads: none yet — only the
edge writes/reads it (POST /api/flipdesk/measure/calibrate), and the edge
boot-guards on 00347 via EXPECTED_SCHEMA_VERSION in the same commit. Apply
together with 00346, then `NOTIFY pgrst, 'reload schema';`.

---

## ⏳ HELD: 00346_measurement_photo_type.sql (US-1571, 2026-07-03)

**What:** `ALTER TYPE public.flipdesk_photo_type ADD VALUE IF NOT EXISTS 'measurement';`
— the MeasureCard calibration-frame photo tag for the photo-measurement
pipeline (US-1570..1580). Idempotent; self-records '00346'.

**Risk: LOW** (single enum value add). But note the CLIENT-SIDE read:

- ⚠️ The same commit ships web UI that lets a seller TAG a photo
  `measurement` (photo-manager retag picker, AutoLister role picker). The
  moment this commit reaches origin, Cloudflare Pages auto-deploys — and
  picking "Measurement card (not listed)" 400s ("invalid input value for
  enum") until 00346 is applied to prod. **Apply 00346 BEFORE OKing the push.**
- The edge in this commit bumps `EXPECTED_SCHEMA_VERSION` to 00346 and adds
  two SQL-side `.neq("photo_type","measurement")` filters — safe because the
  boot guard holds the edge redeploy behind the applied migration.

**Apply order:** ensure 00343→00345 are applied first (see below / prior
sessions), then 00346, then `NOTIFY pgrst, 'reload schema';`. All idempotent —
re-running the tail is safe. Edge redeploy afterward at your convenience.

---

> ## 🚨 STATUS CHANGE 2026-07-02 22:19 CT — THE HELD COMMITS WERE PUSHED
> A `git pull` + push from this machine (user or the concurrent agent — reflog
> shows the pull at 22:19:14; I did not push) landed EVERYTHING on origin/main,
> including migrations **00339–00342**. Consequences RIGHT NOW:
>
> 1. **Cloudflare Pages auto-deployed the new frontend.** The web AutoLister
>    generate() inserts `item_photos.original_filename` (00339) — that column
>    does not exist on prod yet, so **AutoLister generation 400s in prod until
>    00339 is applied**. The "Internal (not listed)" photo type (00340) also
>    400s if a seller picks it.
> 2. **The edge is NOT redeployed** (manual Coolify), so 00341/00342 aren't
>    load-bearing yet — but the NEXT edge redeploy boot-guards on **00342**.
>
> **Fix (5 minutes, all idempotent):** apply 00339 → 00342 to prod
> (`scripts/apply-prod-migrations.sh` or run the four files in order), then
> `NOTIFY pgrst, 'reload schema';`. Then the edge can be redeployed whenever.


## 📌 CURRENT STATE — 2026-07-02 (bulk-intake epic session)

### 🔸 NEW + HELD LOCALLY (not pushed): `00339` (US-1539)

**`supabase/migrations/00339_item_photos_provenance.sql`** — adds nullable
`item_photos.original_filename text` (+ a belt-and-suspenders
`captured_at timestamptz`, which most DBs already have from 00066). Idempotent
(`ADD COLUMN IF NOT EXISTS`), self-record footer, `EXPECTED_SCHEMA_VERSION`
bumped **00338 → 00339** in the same commit. Apply to prod +
`NOTIFY pgrst, 'reload schema';` BEFORE the edge redeploy that follows the next
push (its boot guard will expect 00339). Low-risk: nullable columns, no code
reads them server-side yet — the web AutoLister writes them at generate().
**Per the standing rule, the commit carrying 00339 stays local until you apply
it and say "OK to push".**

### 🔸 ALSO NEW + HELD LOCALLY: `00340` (US-1549, user-requested)

**`supabase/migrations/00340_internal_photo_type.sql`** — `ALTER TYPE
flipdesk_photo_type ADD VALUE IF NOT EXISTS 'internal'` (seller-reference
photos: kept with the item, never sent to eBay/AI/public — enforcement is
edge-side code). `EXPECTED_SCHEMA_VERSION` bumped **00339 → 00340**. Apply with
00339 (both idempotent, any order), `NOTIFY pgrst, 'reload schema';`, then the
edge redeploy (boot guard expects 00340). Zero-risk: pure enum addition —
nothing reads the value until clients send it.

### 🔸 ALSO NEW + HELD LOCALLY: 00341 (US-1533)

**supabase/migrations/00341_garment_baselines.sql** - new garment_baselines table
(operator knowledge cache for grading expectation briefs; deny-all RLS, service-role
only). EXPECTED_SCHEMA_VERSION bumped **00340 -> 00341**. Apply with 00339+00340
(all idempotent), NOTIFY pgrst, then the edge redeploy. Zero-risk: new empty table;
the pipeline feature is OFF until you set GRADING_BASELINES=1 on the edge.

### 🔸 ALSO NEW + HELD LOCALLY: 00342 (US-1536)

**supabase/migrations/00342_peer_norm_indexes.sql** - two plain btree indexes
(submissions.garment_category + human_reviews.grade_report_id) supporting the
peer-norm sanity-check scan. EXPECTED_SCHEMA_VERSION bumped **00341 -> 00342**.
Apply with 00339-00341 (all idempotent), NOTIFY pgrst, then the edge redeploy.
Zero-risk: pure index additions.

### 🔸 ALSO NEW + HELD LOCALLY: `00343` (US-1560)

**`supabase/migrations/00343_rbac_router_scopes.sql`** — seeds the four new
RBAC scope families (ops/marketplace/support/growth:write) into
permission_scopes + grants all four to the `admin` role, so the new
requireScope() enforcement across all 48 admin routers lands with ZERO
behavior change. `EXPECTED_SCHEMA_VERSION` bumped **00342 → 00343**.
⚠️ MUST apply before the edge redeploy that carries this commit — an edge
build enforcing the new scopes against an unseeded DB would 403 admins on the
newly-guarded surfaces (the boot guard enforces this ordering mechanically).

### 🔸 ALSO NEW + HELD LOCALLY: `00344` (US-1565)

**`supabase/migrations/00344_admin_tasks_service_role_only.sql`** — drops the
12 admin client RLS policies on `admin_task_projects` / `admin_tasks` /
`admin_task_comments` (task-board CRUD now flows through the new
`/api/admin/tasks` edge router; deny-all + service-role only, registered in
rls-guard). `EXPECTED_SCHEMA_VERSION` bumped **00343 → 00344**.
⚠️ Ordering: apply WITH/AFTER 00343 and before the edge redeploy carrying this
commit. Note the frontend on Pages auto-deploys on push — after this push the
tasks/dashboard/system pages REQUIRE the new edge routes, so redeploy the edge
promptly after pushing.

### 🔸 ALSO NEW + HELD LOCALLY: `00345` (US-1421 code slice)

**`supabase/migrations/00345_negotiation_access_denied.sql`** — adds
`marketplace_connections.negotiation_access_denied` (mirrors
analytics_access_denied): set when a /sell/negotiation call 403s although the
deployment requests the scope (token predates the grant → reconnect required),
cleared on any successful negotiation call. `EXPECTED_SCHEMA_VERSION`
**00344 → 00345**. Additive column; no ordering hazard beyond apply-before-
edge-redeploy.

### Previously outstanding — apply to prod (already on origin)

Everything through migration **00338** is already ON `origin/main` (0230db73 was
pushed). What's outstanding is **applying to prod**, not pushing:

- **`00338_listings_marketplace_connection_id.sql`** (US-1507) — nullable
  `listings.marketplace_connection_id` FK + partial index; idempotent + self-record
  footer; `EXPECTED_SCHEMA_VERSION` is at **00338**. Legacy rows stay null (edge
  falls back to the primary connection). Safe to apply any time; MUST be applied
  before the next edge redeploy (boot guard expects 00338).
- If `00332`–`00337` haven't been applied yet either, apply them first — every
  migration is idempotent, so the simplest path is `scripts/apply-prod-migrations.sh`
  (or run 00332→00338 in order), then `NOTIFY pgrst, 'reload schema';`, then
  redeploy the edge.

**Held locally (NOT pushed):** 17e8b614 (autolister watchdogs) + this session's
US-1507/1509 completion commit — both code-only, no new migration. They stay local
until you apply 00338 (+ any earlier stragglers) and say "OK to push".

---

> Running package for the pre-launch loop. As of the latest push (af1b3d74), local main == origin/main and ALL committed stories are code-only (no migrations). Future migrations will be listed here for you to apply before the next push. At
> check-in, apply any migrations below to prod (DB → edge → frontend order per
> DEPLOY.md), redeploy the edge (Coolify), then give the OK to `git push`.

## 🔸 HELD (commit-only loop — NOT pushed): `00334` (US-1531)

**`supabase/migrations/00334_ai_enrichment_corrected_fields.sql`** — adds
`ai_enrichment_log.corrected_fields jsonb NOT NULL DEFAULT '{}'` (idempotent,
`ADD COLUMN IF NOT EXISTS`). `EXPECTED_SCHEMA_VERSION` bumped **00333 → 00334**.
Apply to prod (idempotent) + `NOTIFY pgrst, 'reload schema';` BEFORE pushing the
held US-1531 commit. No code reads the column yet (foundation chunk), so applying
it early is harmless.

---

## How to apply
1. Apply each migration SQL below to prod in listed order (they're idempotent).
   Or run `scripts/apply-prod-migrations.sh` if you prefer the scripted path.
2. Redeploy the edge service on Coolify so `EXPECTED_SCHEMA_VERSION` matches.
3. `NOTIFY pgrst, 'reload schema';` if any table/column/RPC changed.
4. Tell me "OK to push" — I'll `git push origin main`.

---

## ⚠️ STATUS UPDATE — commits PUSHED; migrations still must be APPLIED to prod

`origin/main` now includes US-1515 (`00332`) + US-1524 (`00333`). **Pushing to git
is NOT the same as applying the SQL to prod.** No immediate breakage from the push
alone (the edge only re-reads the schema version on a Coolify redeploy, and the new
iOS build isn't released yet) — BUT you must apply `00332` + `00333` to prod BEFORE:
  • redeploying the edge (its boot guard now expects `00333`; DB at `00331` →
    schema-guard failure after the ~40s grace window), and
  • releasing the new iOS build (US-1515 queries `updated_at` on sales/item_photos;
    missing column → PostgREST 400 on those syncs).
  • To fix the **Tag-rotation 400 now**, apply `00333` (independent of `00332`).

Apply order + steps below. Once applied, tell me and I'll push the remaining
code-only commit (US-1494).

---

## Original packaging note (apply `00332` then `00333`)

Apply IN ORDER (both idempotent, both end with the `applied_migrations` footer).
`EXPECTED_SCHEMA_VERSION` is bumped **00331 → 00333** (edge `schema-version.ts`).

**1. `supabase/migrations/00332_sales_item_photos_updated_at.sql`** (US-1515) —
adds `updated_at` (+ `set_updated_at` trigger + backfill + delta index) to
`public.sales` and `public.item_photos` so the iOS sync can delta them on EDITS.

**2. `supabase/migrations/00333_submission_images_owner_update.sql`** (US-1524) —
adds the missing per-user-folder UPDATE RLS policies (owner + workspace member) on
`storage.objects` for the private `submission-images` bucket. FIXES the reported
bug: rotating a **Tag / Certificate** photo returned HTTP 400 because the rotate
re-upload (`x-upsert`) is an UPDATE and that bucket had no UPDATE policy (only
INSERT/SELECT/DELETE). Public `item-photos` rotates fine (it has UPDATE).

**To apply (before I push the held commits):**
1. Apply `00332` then `00333` to prod — `scripts/apply-prod-migrations.sh` or run
   the SQL directly, in order.
2. `NOTIFY pgrst, 'reload schema';` (00332 adds columns).
3. Redeploy the edge (Coolify) so its boot guard sees `00333`.
4. Tell me "OK to push" — I'll push the held commits.

The US-1515 + US-1524 commits are **held locally, NOT pushed** until you apply
these — US-1515's iOS code queries `updated_at` (must exist first), and 00333 is a
pure prod-RLS fix (no code depends on it, but keep the schema-version in lockstep).

---

| US-1494 (iOS expense date integrity) | none | none | (held behind 00332/00333)

### Earlier stories this loop — code-only (already pushed, no schema changes)

| Story | Migration? | Schema bump? |
|-------|-----------|--------------|
| US-1505 (eBay specifics string[] normalize) | none | none |
| US-1506 (End-listing truthfulness) | none | none |
| US-1502 (grade → live eBay listing) | none | none |
| US-1503 (measurements → live listing) | none | none |
| US-1504 (price coherence) | none | none |
| US-1518 (photo thumbnail tier — edge job) | none | none |
| US-1522 (iOS UX dead-end sweep, 8 fixes) | none | none |
| US-1521 (iOS auth/signup polish) | none | none |
| US-1516 (iOS member-tenant item write) | none | none |
| US-1514 (iOS stale-read gating) | none | none |

`EXPECTED_SCHEMA_VERSION` unchanged at **00331**; latest migration file is
`00331_fix_users_guard_bogus_moderation_cols.sql`. Next migration, when one is
needed, is `00332`.

_This file is updated as the loop progresses — check it at every check-in._
