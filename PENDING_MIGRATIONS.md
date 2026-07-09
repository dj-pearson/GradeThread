# PENDING MIGRATIONS — apply BEFORE pushing this branch to origin

## ⏳ HELD: 00402_buyer_subscription.sql (US-1799 buyer subscription, 2026-07-08)

**What:** Adds a `buyer_plan` enum (`free`/`guard`/`connoisseur`) and the buyer
subscription column family to `public.users` — `buyer_plan` (DEFAULT 'free'),
`buyer_interval`, `buyer_subscription_status` (reuses the existing
`subscription_status` enum), `buyer_subscription_id`, `buyer_period_end`,
`buyer_cancel_at_period_end`. `CREATE OR REPLACE`s `guard_users_protected_columns()`
(over 00331) to also freeze these billing columns against browser self-update.
Bumps `EXPECTED_SCHEMA_VERSION` → **00402**. Self-records '00402'.

**Risk: LOW — additive columns + idempotent guard replace.** All default to a
free/none/no-sub state, so existing accounts are unaffected. **⚠️ CLIENT READ:**
`src/types/database.ts` gains `buyer_*` on `UserRow`; no shipped client code
SELECTs them yet (buyer billing UI US-1801), so a frontend deploy landing before
this migration is safe. **⚠️ Apply order:** after 00401;
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`, redeploy.

## ⏳ HELD: 00401_buyer_account_roles.sql (US-1796 buyer/seller roles, 2026-07-08)

**What:** Adds two additive boolean role flags to `public.users` — `is_seller`
(DEFAULT true, backfills every existing account) and `is_buyer` (DEFAULT false) —
plus a partial index `idx_users_is_buyer`. `CREATE OR REPLACE`s `handle_new_user()`
so a buyer-origin signup (`account_type='buyer'` in signup metadata) lands with
`is_buyer=true, is_seller=false` and NO seller/FlipDesk assumptions (free plan,
`none` status, no 14-day trial); the absent-key seller path is byte-for-byte
unchanged aside from `is_seller=true`. Bumps `EXPECTED_SCHEMA_VERSION` → **00401**.
Self-records '00401'.

**Risk: LOW — additive columns + idempotent trigger replace.** No RLS change; the
new flags are intentionally NOT in the US-347 self-update guard (in-app role
opt-in). **⚠️ CLIENT READ:** `src/types/database.ts` gains `is_seller`/`is_buyer`
on `UserRow`, but no shipped client code SELECTs them yet (added by the buyer
dashboard US-1802), so a frontend deploy landing before this migration is safe.
**⚠️ Apply order:** after 00400; `scripts/apply-prod-migrations.sh`, then
`NOTIFY pgrst, 'reload schema';`, redeploy edge.

## ⏳ HELD: 00400_gucci_brand_knowledge.sql (US-1728 Gucci, 2026-07-07)

**What:** DATA-ONLY seed of Gucci — 5 lines (GG Supreme, Guccissima, Marmont,
Ophidia, Web Stripe), a 6-digit `style_number` decoder (informational), and tells
that state the serial proves nothing and the KB must **never auto-authenticate**.
source_url + confidence + verified on every row. Bumps `EXPECTED_SCHEMA_VERSION`
→ **00400**. Self-records '00400'.

**Risk: LOW — additive INSERTs only.** Idempotent. **⚠️ CLIENT READ — none.**
**⚠️ Apply order:** after 00399; `scripts/apply-prod-migrations.sh`, redeploy.

## ⏳ HELD: 00399_louis_vuitton_brand_knowledge.sql (US-1727 Louis Vuitton, 2026-07-07)

**What:** DATA-ONLY seed of Louis Vuitton (NEW brand_knowledge row) — 5 canvases/
lines (Monogram, Damier Ebene, Damier Azur, Empreinte, Epi), a date-code
FORMAT decoder (2 letters + 4 digits; informational only, discontinued March 2021
→ microchip), and tells that state a date code proves nothing and the KB must
**never auto-authenticate**. source_url + confidence + verified on every row.
Bumps `EXPECTED_SCHEMA_VERSION` → **00399**. Self-records '00399'.

**Risk: LOW — additive INSERTs only.** Idempotent. **⚠️ CLIENT READ — none.**
**⚠️ Apply order:** after 00398; `scripts/apply-prod-migrations.sh`, redeploy.

## ⏳ HELD: 00398_coach_brand_knowledge.sql (US-1726 Coach, 2026-07-07)

**What:** DATA-ONLY seed of Coach (first LUXURY brand) — 5 lines/bags (Signature
canvas, Glovetanned leather, Willis, Rogue, Tabby), a boutique-vs-outlet
`style_number` decoder (`F`-prefix = factory/outlet), and `brand_knowledge` tells
that explicitly say **never auto-authenticate** (creed/serial is informational
only). source_url + confidence + verified on every row. Bumps
`EXPECTED_SCHEMA_VERSION` → **00398**. Self-records '00398'.

**Risk: LOW — additive INSERTs only.** Idempotent. **⚠️ CLIENT READ — none.**
**⚠️ Apply order:** after 00397; `scripts/apply-prod-migrations.sh`, redeploy.

## ⏳ HELD: 00397_ralph_lauren_brand_knowledge.sql (US-1725 Ralph Lauren, 2026-07-07)

**What:** DATA-ONLY seed of Ralph Lauren — 6 sub-lines as styles (Purple Label /
RRL / Polo Ralph Lauren / Polo Sport / Lauren / Chaps) with value-tier
fingerprints, and enriched `brand_knowledge` (sub-brand hierarchy + pony + RN
tells). NO decoder — RL has no reliable regular code; the value tier is read from
the label wording. source_url + confidence + verified on every row. Bumps
`EXPECTED_SCHEMA_VERSION` → **00397**. Self-records '00397'.

**Risk: LOW — additive INSERTs only.** Idempotent. **⚠️ CLIENT READ — none.**
**⚠️ Apply order:** after 00396; `scripts/apply-prod-migrations.sh`, redeploy.

## ⏳ HELD: 00396_the_north_face_brand_knowledge.sql (US-1724 TNF, 2026-07-07)

**What:** DATA-ONLY seed of The North Face — 7 styles (Nuptse down vs ThermoBall
synthetic vs Denali fleece; Osito, Apex, McMurdo, Summit Series), an `NF0A…`
`style_number` decoder, and enriched `brand_knowledge` (down-vs-synthetic +
Summit-Series-vs-mainline tells). source_url + confidence + verified on every
row. Bumps `EXPECTED_SCHEMA_VERSION` → **00396**. Self-records '00396'.

**Risk: LOW — additive INSERTs only.** Idempotent. **⚠️ CLIENT READ — none.**
**⚠️ Apply order:** after 00395; `scripts/apply-prod-migrations.sh`, redeploy
(boot guard → 00396).

## ⏳ HELD: 00395_patagonia_brand_knowledge.sql (US-1723 Patagonia, 2026-07-07)

**What:** DATA-ONLY seed of Patagonia into the 00389 KB tables — 7 styles
(Nano Puff/Down Sweater/Micro Puff puffer disambiguation by fill; Better Sweater/
R1/Retro-X fleeces; Baggies), a 5-digit `style_number` decoder, 4 persistent
colorways, and enriched `brand_knowledge` (insulation-type tell). Every fact
source_url + confidence + verified. Bumps `EXPECTED_SCHEMA_VERSION` → **00395**.
Self-records '00395'.

**Risk: LOW — additive INSERTs only** (no DDL). Idempotent.

**⚠️ CLIENT READ — none.** **⚠️ Apply order:** after 00394;
`scripts/apply-prod-migrations.sh`, then redeploy (boot guard → 00395).

## ⏳ HELD: 00394_carhartt_brand_knowledge.sql (US-1722 Carhartt, 2026-07-07)

**What:** DATA-ONLY seed of Carhartt + Carhartt WIP into the 00389 KB tables — 6
styles (Detroit vs Chore vs Active Jac silhouette fingerprints, Duck Bib, K87
tee, B01 dungaree), a classic `style_number` decoder (letter+digits, `B01`/`J140`/
`K87`), and enriched `brand_knowledge` (mainline-vs-WIP tell + Carhartt WIP as a
distinct pricier line). Every fact source_url + confidence + verified. Bumps
`EXPECTED_SCHEMA_VERSION` → **00394**. Self-records '00394'.

**Risk: LOW — additive INSERTs only** (no DDL). Idempotent (brand_knowledge
`ON CONFLICT DO UPDATE`, children `DO NOTHING`).

**⚠️ CLIENT READ — none** (server-side extraction/baselines only).

**⚠️ Apply order:** after 00393. Run `scripts/apply-prod-migrations.sh`, then
redeploy the edge (boot guard → 00394).

## ⏳ HELD: 00393_levis_brand_knowledge.sql (US-1721 Levi's, 2026-07-07)

**What:** DATA-ONLY seed of Levi's into the 00389 KB tables — 8 styles (fit
fingerprints: 501 button-fly vs 505 zip-fly vs 511 slim, 512/541/550/569 +
Trucker Jacket), a brand-scoped `lot_number` fit decoder (`5NN`), and enriched
`brand_knowledge` (Big-E/small-e red-tab era dating + back-patch/selvedge tells).
Every fact source_url + confidence + verified. Bumps `EXPECTED_SCHEMA_VERSION` →
**00393**. Self-records '00393'.

**Risk: LOW — additive INSERTs only** (no DDL). Idempotent (brand_knowledge
`ON CONFLICT DO UPDATE`, children `DO NOTHING`).

**⚠️ CLIENT READ — none** (server-side extraction/baselines only).

**⚠️ Apply order:** after 00392 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then redeploy the edge (boot guard → 00393).

## ⏳ HELD: 00392_adidas_yeezy_brand_knowledge.sql (US-1720 adidas & Yeezy, 2026-07-07)

**What:** DATA-ONLY seed of adidas + Yeezy into the 00389 KB tables — 6 styles
(Tiro/Tango Performance vs Firebird/Adicolor Originals-Trefoil; Yeezy Season +
Yeezy Gap Round Jacket), the adidas `article_number` decoder (2 letters + 4
digits, `GX1234`) seeded as PURE DATA, and enriched `brand_knowledge` (Trefoil
vs 3-Bar line tell; Yeezy minimalist-aesthetic tell). Yeezy is a NEW
brand_knowledge row (not in the 00389 alias seed). Every fact source_url +
confidence + verified. Bumps `EXPECTED_SCHEMA_VERSION` → **00392**. Self-records
'00392'.

**Risk: LOW — additive INSERTs only** (no DDL). Idempotent (brand_knowledge
`ON CONFLICT DO UPDATE`, children `DO NOTHING`).

**⚠️ CLIENT READ — none** (server-side extraction/baselines only).

**⚠️ Apply order:** after 00391 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then redeploy the edge (boot guard → 00392).

## ⏳ HELD: 00391_nike_jordan_brand_knowledge.sql (US-1719 Nike & Jordan, 2026-07-07)

**What:** DATA-ONLY seed of Nike + Jordan into the 00389 KB tables — 8 styles
(Tech Fleece vs Club Fleece fingerprints, Therma-FIT, Dri-FIT, Windrunner, ACG,
Jordan Jumpman), the Nike `style_number` decoder (6-char + "-" + 3-digit
colorway, `CW1234-001`) seeded as PURE DATA (regex + fieldMap, **no new
transform**) under both `nike` and `jordan`, and enriched `brand_knowledge`
(style-number tag era + line-vs-brand tells). Every fact source_url + confidence
+ verified=true. Bumps `EXPECTED_SCHEMA_VERSION` → **00391**. Self-records
'00391'.

**Risk: LOW — additive INSERTs only** (no DDL). Idempotent: brand_knowledge
`ON CONFLICT (brand_key) DO UPDATE`, children `DO NOTHING`.

**⚠️ CLIENT READ — none** (same as 00390 — server-side extraction/baselines
only).

**⚠️ Apply order:** after 00390 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then redeploy the edge so its boot guard
matches 00391. `NOTIFY pgrst` not required (rows only).

## ⏳ HELD: 00390_lululemon_brand_knowledge.sql (US-1718 Lululemon content, 2026-07-07)

**What:** DATA-ONLY seed of the 00389 KB tables with Lululemon content — 9
styles with disambiguating visual fingerprints (ABC 5-pocket+gusset vs Commission
chino, Align vs Wunder Train vs Fast & Free, etc.), 2 decoder specs
(`style_number` + `size_dot`; DB rows that override the in-code
DEFAULT_DECODER_SPECS), 5 representative colorways, and enriched
`brand_knowledge` (tag eras + authentication/size-dot tells). Every fact carries
source_url + confidence + verified=true. Bumps `EXPECTED_SCHEMA_VERSION` →
**00390**. Self-records '00390'.

**Risk: LOW — additive INSERTs only** (no DDL, no schema change). Idempotent:
brand_knowledge via `ON CONFLICT (brand_key) DO UPDATE`, children via
`ON CONFLICT … DO NOTHING` (re-running never clobbers an admin edit). Tables +
Lululemon size charts already exist from 00389.

**⚠️ CLIENT READ — none.** No SPA query reads these tables (the admin UI reads
via the service-role edge route). The KB only affects server-side extraction
(US-1713) + baseline generation (US-1717). No hard ordering hazard beyond the
edge boot guard expecting **00390**.

**⚠️ `NOTIFY pgrst, 'reload schema';`** — not strictly required (no schema-shape
change, rows only), but harmless; keep the runbook uniform.

**⚠️ Apply order:** after 00389 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then redeploy the edge so its boot guard
matches 00390.

## ⏳ HELD: 00389_brand_knowledge_base.sql (US-1710 Brand & Style KB, 2026-07-07)

**What:** creates FIVE global-reference operator tables — `brand_knowledge`,
`brand_styles`, `brand_style_codes`, `brand_colorways`, `brand_size_charts` — the
schema foundation for the DB-backed, retrievable garment brand/style/size
knowledge base (fixes brand/style ID failures, esp. Lululemon cut-tag recovery).
Seeds `brand_knowledge` from `brand-normalize.ts` BRAND_ALIASES (53 brands) and
`brand_size_charts` from `sizing-charts.ts` SIZING_CHARTS (15 charts) so the
future DB-first resolver (US-1711) has parity with today's in-code data. Deny-all
RLS (no `user_id`, no tenant data); registered in `rls-guard_test.ts`
`SERVICE_ROLE_ONLY`. Bumps `EXPECTED_SCHEMA_VERSION` → **00389**. Self-records
'00389'.

**Risk: LOW — five NEW additive tables + indexes + updated_at triggers + an
idempotent data seed** (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT
EXISTS`, `DROP TRIGGER IF EXISTS` before create; seed via `ON CONFLICT DO
NOTHING`). No changes to existing tables. Re-running the whole directory is a
no-op.

**⚠️ CLIENT READ — none.** Nothing reads these tables yet: this story is
schema-only. The resolver that reads them (US-1711) and the admin UI that writes
them (US-1715) are later stories. The only code shipping in this commit is the
migration, the `EXPECTED_SCHEMA_VERSION` bump, and the rls-guard registration —
so there is **no hard ordering hazard** beyond the edge boot guard expecting
**00389**. The SPA never queries them.

**⚠️ `NOTIFY pgrst, 'reload schema';` REQUIRED** (five new tables — PostgREST
must reload to expose them to the service-role client).

**⚠️ Apply order:** after 00388 (top of the held stack). Run
`scripts/apply-prod-migrations.sh` (idempotent tail), then
`NOTIFY pgrst, 'reload schema';`, then redeploy the edge so its boot guard
matches 00389.

## ⏳ HELD: 00388_content_safety_flagged_status.sql (advisory content-safety, 2026-07-07)

**What:** adds the value `'flagged'` to the `public.content_safety_status` enum
(`ADD VALUE IF NOT EXISTS`). The pre-publish content-safety review (US-486) is now
ADVISORY on the auto-publish path: AI blog/social posts publish immediately even
when the reviewer returns a non-pass verdict, tagged `safety_status='flagged'`
(reasons in `safety_notes`) instead of being held as a draft. Edge writes
`'flagged'` on the blog editor `/generate` path + the scheduler tick
(`runBlogTick`/`runSocialTick`). Bumps `EXPECTED_SCHEMA_VERSION` → **00388**.
Self-records '00388'.

**Risk: LOW — additive enum value, no data change.** Idempotent
(`ADD VALUE IF NOT EXISTS`), not wrapped in a transaction (a new enum value can't
be USED in the same tx; this migration never does). `'held'` is retained.

**⚠️ CLIENT READ — none.** No frontend query filters on `safety_status`, so a
frontend auto-deploy before the SQL applies is safe. The edge only WRITES
`'flagged'` from this build, which is boot-guarded on **00388**, so it can't run
before the value exists. Behavior change is otherwise pure product logic (publish
instead of hold).

**⚠️ Apply order:** after 00387 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';` (enum
changed), then redeploy the edge so its boot guard matches 00388.

## ⏳ HELD: 00387_ads_recommendation_decisions.sql (US-1702 review workflow, 2026-07-07)

**What:** adds `snooze_until timestamptz` + `dismiss_reason text` (+ an index) to
the existing `ads_recommendations` table for the approve/dismiss/snooze review
workflow. The decision itself is recorded as an `action='decision'` row in the
existing `ads_change_audit` (no new table). Bumps `EXPECTED_SCHEMA_VERSION` →
**00387**. Self-records '00387'.

**Risk: LOW — two additive nullable columns + one index on an existing operator
table, idempotent** (`ADD COLUMN IF NOT EXISTS`). No table creation.

**⚠️ CLIENT READ — the Command Center reads `snooze_until` / `dismiss_reason`
through the super-admin `/recommendations` route** (degrades: the columns are
nullable, so pre-migration reads just return null). No hard break.

**⚠️ `NOTIFY pgrst, 'reload schema';` REQUIRED** (new columns).

**⚠️ Apply order:** after 00386 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`, then
redeploy the edge so its boot guard matches 00387.

## ⏳ HELD: 00386_ads_search_terms.sql (US-1706 search-terms mining, 2026-07-07)

**What:** creates the operator table `ads_search_terms` (search_term,
matched_keyword, match_type, campaign/ad_group external ids, impressions/clicks/
cost/conversions, window) — the daily sync pulls the Google Ads search-terms
report here, and the analysis mines it for negative-keyword + new-keyword
recommendations. Deny-all RLS; registered in `rls-guard_test.ts`
`SERVICE_ROLE_ONLY`. Bumps `EXPECTED_SCHEMA_VERSION` → **00386**. Self-records
'00386'.

**Risk: LOW — one NEW additive table + indexes + updated_at trigger, idempotent.**
No changes to existing tables. Only the service-role sync writes it.

**⚠️ CLIENT READ — none.** Mining runs server-side; recommendations surface via
the existing super-admin route.

**⚠️ `NOTIFY pgrst, 'reload schema';` REQUIRED** (new table).

**⚠️ Apply order:** after 00385 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`, then
redeploy the edge so its boot guard matches 00386.

## ⏳ HELD: 00385_ad_click_attributions_upload.sql (US-1704 offline import, 2026-07-07)

**What:** adds `uploaded_at`, `upload_status`, `upload_error` columns (+ a partial
index) to the existing `ad_click_attributions` table so the offline-conversion
upload job is idempotent (uploads each converted row once) and records
success/skip/failure per row. Bumps `EXPECTED_SCHEMA_VERSION` → **00385**.
Self-records '00385'.

**Risk: LOW — three additive nullable columns + one partial index on an existing
operator table, fully idempotent** (`ADD COLUMN IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`). No table creation, no data change.

**⚠️ CLIENT READ — none.** Only the service-role upload job reads/writes these
columns. No frontend reads them.

**⚠️ `NOTIFY pgrst, 'reload schema';` REQUIRED** (new columns on a table the
service-role client selects).

**⚠️ Apply order:** after 00384 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`, then
redeploy the edge so its boot guard matches 00385.

## ⏳ HELD: 00384_ads_change_audit.sql (US-1703 guarded apply, 2026-07-07)

**What:** creates the operator table `ads_change_audit` (recommendation_id,
change_type, target_resource, before_value, after_value, dry_run, success,
action, result, owner_user_id) — every guarded apply/rollback of an approved
recommendation writes a row with the pre-mutate value for rollback. Deny-all
RLS; registered in `rls-guard_test.ts` `SERVICE_ROLE_ONLY`. Bumps
`EXPECTED_SCHEMA_VERSION` → **00384**. Self-records '00384'.

**Risk: LOW — one NEW additive table + indexes, idempotent.** No changes to
existing tables. Only the service-role apply flow writes it.

**⚠️ CLIENT READ — none directly** (Command Center reads via the super-admin edge
route). The apply/revert routes fail CLOSED when Google Ads is unconfigured.

**⚠️ `NOTIFY pgrst, 'reload schema';` REQUIRED** (new table).

**⚠️ Apply order:** after 00383 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`, then
redeploy the edge so its boot guard matches 00384.

## ⏳ HELD: 00383_ads_recommendations.sql (US-1701 Claude analysis, 2026-07-07)

**What:** creates the operator table `ads_recommendations` (target_type,
target_resource, change_type, rationale, confidence, projected_impact, payload,
severity, status='proposed') — the report-only output of the Claude ads-analysis
pass; the guarded apply (US-1703) later acts on the payload. Deny-all RLS;
registered in `rls-guard_test.ts` `SERVICE_ROLE_ONLY`. Bumps
`EXPECTED_SCHEMA_VERSION` → **00383**. Self-records '00383'.

**Risk: LOW — one NEW additive table + index + updated_at trigger, idempotent.**
No changes to existing tables. Only the service-role edge writes (the analysis
pass); the Command Center reads via /api/admin/ads/recommendations.

**⚠️ CLIENT READ — none directly.** The SPA reads recommendations only through the
super-admin edge route, which degrades to `[]` if the table is absent. The
"Analyze" button POSTs /api/admin/ads/analyze (report-only). No hard ordering
hazard beyond the edge boot guard expecting **00383**.

**⚠️ `NOTIFY pgrst, 'reload schema';` REQUIRED** (new table).

**⚠️ Apply order:** after 00382 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`, then
redeploy the edge so its boot guard matches 00383.

## ⏳ HELD: 00382_ad_click_attributions.sql (US-1700 conversion wiring, 2026-07-07)

**What:** creates the operator table `ad_click_attributions` (click_id,
click_id_type, platform, landing_at, owner_user_id nullable, converted_at,
conversion_type, value) — links captured Google click ids (gclid/gbraid/wbraid)
to the converting user + downstream conversion value, for the ads analysis
(US-1701) + offline import (US-1704). Deny-all RLS; registered in
`rls-guard_test.ts` `SERVICE_ROLE_ONLY`. Bumps `EXPECTED_SCHEMA_VERSION` →
**00382**. Self-records '00382'.

**Risk: LOW — one NEW additive table + indexes + updated_at trigger, fully
idempotent.** No changes to existing tables. Only the service-role edge writes
(the /api/ads/attribution route + the future offline import).

**⚠️ CLIENT READ — none.** The SPA never reads this table. The client only
CAPTURES click ids into first-party storage and POSTs them to
`/api/ads/attribution` (authed); that route no-ops safely if the table is absent
(the write just errors and returns 400 — no user-facing breakage). The
Command-Center/analysis reads are operator-only.

**⚠️ `NOTIFY pgrst, 'reload schema';` REQUIRED** (new table).

**⚠️ Apply order:** after 00381 (top of the held stack). Run
`scripts/apply-prod-migrations.sh`, then `NOTIFY pgrst, 'reload schema';`, then
redeploy the edge so its boot guard matches 00382.

## ⏳ HELD: 00381_ads_data_model.sql (US-1698 Ads Command Center, 2026-07-07)

**What:** creates SEVEN operator tables for the Ads Command Center —
`ads_accounts`, `ads_campaigns`, `ads_ad_groups`, `ads_ads`, `ads_keywords`,
`ads_metrics_daily`, `ads_sync_runs` — each with a `platform` column
('google_ads' | 'apple_search_ads') and deny-all RLS (service-role only). Local
snapshots of our OWN Google Ads account structure + daily metrics, synced by
`/api/jobs/ads-sync` (daily cron) and `/api/admin/ads/google/sync` (manual,
super-admin). Bumps `EXPECTED_SCHEMA_VERSION` → **00381**. Self-records '00381'.

**Risk: LOW — seven NEW additive tables + indexes + updated_at triggers, fully
idempotent** (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
`DROP TRIGGER IF EXISTS` before create). No changes to existing tables. Only the
service-role edge writes (bypasses RLS); registered in `rls-guard_test.ts`
`SERVICE_ROLE_ONLY`.

**⚠️ CLIENT READ — none.** No frontend reads these yet (the US-1699 dashboard is a
later story). The edge code that reads/writes them (`google-ads-sync*.ts`, the
admin route, the cron) NO-OPS entirely when the `GOOGLE_ADS_*` secrets are unset,
so there is **no hard ordering hazard** beyond the edge boot guard expecting
**00381** — the schema-version bump ships in this same commit.

**⚠️ `NOTIFY pgrst, 'reload schema';` REQUIRED** (seven new tables — PostgREST
must reload to expose them to the service-role client).

**⚠️ Apply order:** after 00380 (top of the held stack). Run
`scripts/apply-prod-migrations.sh` (idempotent tail), then
`NOTIFY pgrst, 'reload schema';`, then redeploy the edge so its boot guard
matches 00381.

## ⏳ HELD: 00380_cert_assets_bucket.sql (cert-image render fix, 2026-07-06)

**What:** creates the PUBLIC `cert-assets` storage bucket (+ a public-read
policy) that the new Deno-edge renderer writes the certificate images to (the
"slab" graded photo, OG card, badge). This moves image rendering off the
Free-plan Cloudflare Worker (which 503s with "error code: 1102" — CPU limit)
onto the edge, which renders once and stores here. Self-records '00380'.

**Risk: LOW — additive storage bucket + one public-READ policy, idempotent**
(`ON CONFLICT DO NOTHING` / `DROP POLICY IF EXISTS`). Only the service-role edge
writes (bypasses RLS). `NOTIFY pgrst, 'reload schema';` NOT required (no
table/column/RPC/enum shape change — storage.buckets is a data row).

**⚠️ CLIENT READ — none.** No frontend reads a new column. **Graceful
degradation if applied late:** the edge route uploads with `.catch()` and treats
a missing bucket as a cache-miss, so it re-renders every request (works, just
uncached) until the bucket exists. So there is no hard ordering hazard beyond the
edge boot guard expecting **00380**.

**⚠️ Apply order:** after 00379 (top of the held stack). Run
`scripts/apply-prod-migrations.sh` (idempotent tail). Redeploy the edge so its
boot guard matches 00380.

## ⏳ HELD: 00379_signup_source_survey.sql (US-1670 / SEO 2.0, 2026-07-06)

**What:** the last piece of the SEO/GEO measurement layer — a self-reported
"How did you hear about us?" signup survey with an **"AI assistant"** option.
Adds nullable `users.signup_source text` and `CREATE OR REPLACE`s
`handle_new_user()` to whitelist the value from `raw_user_meta_data` (exactly
like `use_case` in 00303). Self-reported AI discovery is the only reliable
ChatGPT/Claude/Perplexity attribution (referrers are stripped), complementing the
referrer-side `ai_referrer` PostHog property already shipped. Self-records '00379'.

**Risk: LOW — additive nullable column + CREATE OR REPLACE trigger (idempotent).**
No backfill (NULL = "not reported"). The whitelist rejects anything unknown to
NULL, so a malformed client value can never abort signup (the function also keeps
its resilient EXCEPTION handler). Edge boot guard now expects **00379**.

**⚠️ CLIENT READ — SAFE (backward-compatible):** the frontend signup form
(`src/pages/signup.tsx`) now passes an extra `signup_source` key in
`options.data` (raw_user_meta_data). The OLD trigger simply IGNORES that key, so
a frontend auto-deploy that lands BEFORE this migration applies degrades to
"source not recorded" — signup never breaks. Nothing client-side READS the column
(it's write-only attribution; admin analytics reads it server-side later). So
there is no hard ordering hazard beyond the edge boot guard.

**⚠️ Apply order:** after 00378 (i.e. last, on top of the whole held stack
00332–00378). `NOTIFY pgrst, 'reload schema';` IS needed (new column). Redeploy
the edge so its boot guard matches 00379. Constants↔trigger whitelist drift is
pinned by `src/lib/__tests__/signup-source.test.ts`.

## ⏳ HELD: 00378_seed_reseller_blog_and_topics.sql (blog seed, 2026-07-06)

**What:** pure DATA seed (no schema change). Inserts 4 fully-written **draft**
`blog_posts` (status='draft', generated_by='human') plus ~40 `content_topics`
(status='queued') derived from the July 2026 Reddit-research titles, re-angled to
GradeThread/FlipDesk. Self-records '00378'.

**Apply order: AFTER 00377.** This stacks on the still-held Vinted enum migration
— run `scripts/apply-prod-migrations.sh` (idempotent, applies the tail in NNNNN
order) so 00377 then 00378 land together.

**Risk: LOW — additive INSERTs only.** Idempotent: `blog_posts` via
`ON CONFLICT (slug) DO NOTHING`, `content_topics` via `WHERE NOT EXISTS` on the
`(surface, product_focus, lower(primary_keyword))` dedup key. Re-running is a
no-op. No new table/column/enum → **no `NOTIFY pgrst, 'reload schema'` needed**
(schema shape is unchanged; only rows added).

**⚠️ CLIENT READ:** the 4 posts are `status='draft'`, so the anon SSR (published-
only RLS) will NOT surface them until an admin publishes — the frontend
auto-deploy on push is safe. The only hard requirement is the edge boot guard:
apply the SQL (so `applied_migrations` reaches **00378**) BEFORE the next Coolify
edge redeploy, since `EXPECTED_SCHEMA_VERSION` is now `00378`.

**Review the drafts:** /admin/content/blog/editor — publish when ready. The rest
sit in the topic bank for the autonomous scheduler.

## ⏳ HELD: 00377_listing_platform_vinted.sql (US-1663, 2026-07-05)

**What:** adds the value `'vinted'` to the `public.listing_platform` enum. Vinted
is an EXTENSION-mechanism channel (no public API — listed via the GradeThread
Lister extension, like Poshmark/Mercari/Grailed), so there is NO edge connector;
the enum value just lets `listings.platform` carry 'vinted' and the Listing Kit /
cross-list surfaces map a Vinted sibling. Self-records '00377'.

**Risk: LOW — additive enum value, no data change.** Idempotent
(`ADD VALUE IF NOT EXISTS`), not wrapped in a transaction (can't use a new enum
value in the same tx; this migration never does).

**⚠️ CLIENT READ — safe:** the frontend now lists `vinted` in `LISTING_PLATFORMS`
/`MARKETPLACE_*` and renders it in the extension-channels section. Pure display,
no DB query for the enum value, so the frontend auto-deploy on push is safe even
before the SQL applies. No edge code filters `.eq("platform","vinted")` on a hot
path (extension channels have no server connector). Apply the SQL first anyway so
the edge boot guard (now **00377**) doesn't crash-loop.

**⚠️ Apply order:** after 00376. `NOTIFY pgrst, 'reload schema';` recommended
(enum changed). Redeploy the edge so its boot guard matches 00377.

## ⏳ HELD: 00376_listing_platform_etsy.sql (US-1659, 2026-07-05)

**What:** adds the value `'etsy'` to the `public.listing_platform` enum
(`ALTER TYPE ... ADD VALUE IF NOT EXISTS 'etsy'`). `listings.platform` and
`marketplace_connections.marketplace` are BOTH this enum, so the value must exist
before any Etsy connection row or sibling listing can be written. Ships alongside
the Etsy connection layer (`etsy-client.ts`/`etsy-api.ts`/adapter/route), all
gated behind `ETSY_ENABLED` (off until Etsy app approval). Self-records '00376'.

**Risk: LOW — additive enum value, no data change.** Idempotent
(`ADD VALUE IF NOT EXISTS`), so re-running the whole directory is a no-op once the
value exists. NOT wrapped in a transaction (an enum value added inside a
transaction can't be used in that same transaction; this migration never uses it).

**⚠️ CLIENT READ — safe, but note the enum caveat:** the frontend
(`src/lib/constants.ts`) now lists `etsy` in `LISTING_PLATFORMS`/`MARKETPLACE_*`
and the Marketplaces UI renders it in the "pending approval" tier. That is pure
client display and does NOT query the DB for the enum value, so the frontend
auto-deploy on push is safe even before the SQL applies. HOWEVER, per the enum
rule: no edge code filters `.eq("marketplace","etsy")` on a path that could run
before this migration applies except INSIDE the `ETSY_ENABLED` gate (off in prod
until approval) — so there is no window where edge code selects a not-yet-existing
enum value. Apply the SQL first regardless so the edge boot guard (now **00376**)
doesn't crash-loop.

**⚠️ Apply order:** after 00375. `NOTIFY pgrst, 'reload schema';` recommended
(enum changed). Redeploy the edge so its boot guard matches 00376.

## ⏳ HELD: 00375_affiliate_amounts_integer_cents.sql (US-1655, 2026-07-05)

**What:** converts `affiliate_commissions.amount` and `affiliate_payouts.amount`
from `numeric(10,2)` (USD dollars) to `integer` (cents), backfilling every
existing row by `round(amount * 100)`. `CHECK (amount >= 0)` and `DEFAULT 0`
carry over unchanged. The edge engine (`lib/affiliate-payout.ts`) now carries
integer cents end-to-end and drops the `*100` at the `stripe.transfers.create`
boundary (cents are the minor unit Stripe already expects). Self-records '00375'.

**Risk: MEDIUM — money-transforming column type change on existing rows.** The
transform runs `amount * 100` on live data, so it is guarded on
`data_type='numeric'`: once the column is already `integer` the `DO` block is a
no-op, making a re-run (apply-prod-migrations.sh re-runs the whole directory)
safe — it can NEVER double-multiply. Proven locally: verify:db green (fresh
from-zero apply reaches 00375) + a direct scratch-table proof
($5.00→500, $12.34→1234, $0.10→10, $599.99→59999, $0→0; a second run leaves them
unchanged). The affiliate engine ships `mode:'off'` by default, so in practice
these tables are empty in prod today — the backfill is a safety net, not a live
data move, but it is correct either way.

**⚠️ CLIENT READ — converted at the API boundary, NOT client-side:** the web
(`src/pages/referrals.tsx`) renders `payouts.balance.*`, `payouts.tax.*`, and
`payouts.payouts[].amount` as USD currency. The route `routes/affiliate.ts` now
converts cents→dollars at the JSON boundary (via `centsToDollars`), so the client
contract is UNCHANGED and no frontend edit is required. The finance-agent feed
(`lib/agent-tools.ts fetchRecentPayouts`) likewise converts affiliate cents→dollars
so its dollar math stays consistent with `consignor_payouts` (still numeric
dollars — NOT touched by this migration). **Because the contract is preserved,
the frontend auto-deploy on push is safe even before the SQL is applied** — but
apply the SQL first anyway so the edge boot guard (now **00375**) doesn't crash-loop.

**⚠️ Apply order:** after 00310 (the affiliate tables) and 00374. `NOTIFY pgrst,
'reload schema';` IS needed (column type changed). Redeploy the edge so its boot
guard matches 00375.

## ⏳ HELD: 00374_seed_user_lifecycle_agent.sql (US-1600 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the User Lifecycle agent (module U),
`status='paused'`, `autonomy='{}'` (L0), config = WEEKLY (Mon 05:00) / sonnet
model / read-only allowlist (get_user_lifecycle) / $2 cap. Cohort-level lifecycle
analyst: activation-stall diagnosis, churn narrative, winback sizing. Proposes
cohort-level moves only — enroll_cohort (wraps the existing drip enrollment for a
WHITELISTED cohort 'trial_expiring_7d' into campaign 'trial_conversion'; marketing
opt-outs excluded, already-enrolled deduped, hard-capped at 500) or a file_task
for a new drip variant. NEVER emails anyone (drip engine + frequency caps own
delivery). Prompt in the repo charter. `ON CONFLICT (key) DO NOTHING`. Self-records
'00374'.

**Risk: LOW — one paused seed row into the operator agents table (00357).** No
schema change beyond the seed. The read tool aggregates cohort COUNTS only
(funnel_metrics RPC, drip_enrollments, users trial-expiry HEAD counts) — no
per-user rows reach the model. enroll_cohort reuses the same idempotent upsert as
the trial-drip tick (UNIQUE user_id,campaign from 00274). No client read. Edge boot
guard now expects **00374**.

**⚠️ Apply order:** after 00357–00373. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00374.

## ⏳ HELD: 00373_seed_marketing_portfolio_agent.sql (US-1599 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the Marketing Portfolio agent (module M),
`status='paused'`, `autonomy='{}'` (L0), config = WEEKLY (Mon 06:00) / sonnet
model / read-only allowlist (get_marketing_portfolio) / $2 cap. One supervisor
over the three self-tuning marketing engines; its value is the cross-engine view
(audience fatigue, blog/newsletter cannibalization, same-day collisions). Proposes
engine-level levers only — add_marketing_topic (email_topic_bank 00290 /
content_topics 00041), adjust_frequency (marketing_frequency_cap_per_day setting),
or a file_task to pause a sequence. Prompt in the repo charter. `ON CONFLICT (key)
DO NOTHING`. Self-records '00373'.

**Risk: LOW — one paused seed row into the operator agents table (00357).** No
schema change beyond the seed; the tool reads/writes existing tables
(marketing_send_log, drip_enrollments, newsletter_issues, content_topics,
email_topic_bank) + the frequency setting. No client read. Edge boot guard now
expects **00373**.

**⚠️ Apply order:** after 00357–00372. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00373.

## ⏳ HELD: 00372_agent_handoffs.sql (US-1613 / AGENTIC-OS Phase 2, 2026-07-05)

**What:** creates `agent_handoffs` — the queue for agent-to-agent handoffs
(target_agent, origin_agent, origin_run_id, kind, payload, evidence, hop,
provenance jsonb, status queued|consumed, consumed_run_id/at). Deny-all RLS,
service-role only (mirrors agent_memory 00357); registered in rls-guard_test.ts
SERVICE_ROLE_ONLY. Partial index on (target_agent, created_at) WHERE
status='queued'. Also merges `accepts_handoffs_from` into two existing agent
configs — sentinel accepts ['support-triage'], integrations-watchdog accepts
['sentinel'] (jsonb ||, guarded by NOT (config ? 'accepts_handoffs_from') for
idempotency; a no-op if those rows aren't seeded yet).

**Risk: LOW.** New operator table (no tenant data — agent keys + run ids + the
emitting agent's finding payload) + two idempotent config merges. No client read.
The kernel reads/writes it entirely server-side. Edge boot guard now expects
**00372**.

**⚠️ Apply order:** after 00357–00371 (FKs to agent_runs from 00357; the config
merges target sentinel/integrations-watchdog rows seeded earlier). `NOTIFY pgrst,
'reload schema';` IS needed (new table). Redeploy the edge so its boot guard
matches 00372.

## ⏳ HELD: 00370–00371 Support Triage (US-1595 / AGENTIC-OS Phase 1, 2026-07-05)

**00370_support_ticket_triage_fields.sql — What:** adds four NULLable advisory
columns to `support_tickets` — `triage_category` (CHECK billing|grading|technical|
account|shipping|other), `triage_severity` (CHECK low|normal|high|urgent),
`triage_kb_slug` (text, references support_kb_articles.slug BY VALUE — no FK), and
`triaged_at timestamptz` — plus a partial index on (triage_severity,
last_message_at) for open/pending rows. Additive + idempotent. NO RLS change:
support_tickets already restricts SELECT to owner/admin and allows no client
writes (service-role only, 00223).

**00371_seed_support_triage_agent.sql — What:** seeds ONE `agents` row — the
Support Triage agent (module S), `status='paused'`, `autonomy='{}'` (L0), config =
every-2h / sonnet model / read-only allowlist (get_support_triage) / $3 cap.
Classifies + prioritizes new tickets, drafts approval-gated replies (draft_reply →
send_support_reply), persists classifications (triage_tickets → persist_ticket_
triage, onto the 00370 columns), and files cluster escalations for Sentinel
(file_task). NEVER sends a reply or changes a ticket itself. `ON CONFLICT (key) DO
NOTHING`. Self-records '00371'.

**Risk: LOW.** 00370 is additive columns on an existing table (no backfill, no
client read of the new columns yet — the admin support UI renders them once the
frontend adds them, but nothing breaks in the meantime). 00371 is one paused seed
row. Edge boot guard now expects **00371**.

**⚠️ Apply order:** 00370 THEN 00371 (the seed's comment references the columns),
after 00357–00369. `NOTIFY pgrst, 'reload schema';` IS needed (00370 adds
columns). Redeploy the edge so its boot guard matches 00371.

## ⏳ HELD: 00369_seed_experiments_governor_agent.sql (US-1609 / AGENTIC-OS Phase 2, 2026-07-05)

**What:** seeds ONE `agents` row — the Experiments Governor (module X),
`status='paused'`, `autonomy='{}'` (L0), config = twice-weekly (Mon/Thu 07:00) /
haiku model / read-only allowlist (get_experiments_registry) / $1 cap. Unifies
every LIVE A/B across three engines (newsletter subject tests, grading-prompt
canaries, drip variants) into one registry and flags portfolio issues:
interference (same audience + metric, overlapping windows), underpowered "wins",
and experiments past their decision date. Files an admin task (file_task) with a
concrete remedy; NEVER stops/extends/promotes an experiment itself. Prompt lives
in the repo charter. `ON CONFLICT (key) DO NOTHING` (idempotent). Self-records
'00369'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED. The get_experiments_registry tool reads existing columns
only — `newsletter_issues` A/B fields (00282), `ai_prompt_versions` canary fields
(00221), `drip_enrollments` (00253) — no new schema beyond this seed row. Edge
boot guard now expects **00369**.

**⚠️ Apply order:** apply after 00357–00368. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00369.

## ⏳ HELD: 00368_seed_release_agent.sql (US-1610 / AGENTIC-OS Phase 2, 2026-07-05)

**What:** seeds ONE `agents` row — the Release agent (module Q), `status='paused'`,
`autonomy='{}'` (L0), config = hourly / haiku model / read-only allowlist
(get_release_health) / $1 cap. Detects a RELEASE_SHA change, compares post-deploy
health to a pre-deploy baseline, files a regression admin task (file_task) or an
all-clear; may propose run_smoke. NEVER rolls back. Prompt lives in the repo
charter. `ON CONFLICT (key) DO NOTHING` (idempotent). Self-records '00368'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED. Edge boot guard now expects **00368**. NOTE: the
get_release_health tool lazily upserts a `release.verify_state` system_settings
row at runtime (SHA + baseline watermark) — no migration needed.

**⚠️ Apply order:** apply after 00357–00367. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00368.

## ⏳ HELD: 00367_seed_cron_governance_agent.sql (US-1611 / AGENTIC-OS Phase 2, 2026-07-05)

**What:** seeds ONE `agents` row — the Cron Governance agent (module J),
`status='paused'`, `autonomy='{}'` (L0), config = WEEKLY schedule / sonnet model /
read-only allowlist (get_cron_fleet_health + get_cron_health) / $1 cap. It diffs
CRON_REGISTRY vs cron_runs (missed ticks, maintenance-suppressed; duration creep)
and files schedule-adjustment admin tasks (file_task) once an operator grants L1;
it NEVER changes Coolify config. The prompt lives in the repo charter. `ON CONFLICT
(key) DO NOTHING` (idempotent). Self-records '00367'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED. Edge boot guard now expects **00367**.

**⚠️ Apply order:** apply after 00357–00366. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00367.

## ⏳ HELD: 00366_seed_growth_agent.sql (US-1602 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the Growth agent (module R), `status='paused'`,
`autonomy='{}'` (L0), config = WEEKLY schedule / sonnet model / read-only allowlist
(get_growth_health) / $2 cap. Narrates funnel anomalies + referral health and
files experiment briefs as admin tasks (file_task) once an operator grants L1; it
generates/ranks ideas but never starts experiments. The prompt lives in the repo
charter. `ON CONFLICT (key) DO NOTHING` (idempotent). Self-records '00366'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED. Edge boot guard now expects **00366**.

**⚠️ Apply order:** apply after 00357–00365. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00366.

## ⏳ HELD: 00365_seed_ceo_brief_agent.sql (US-1603 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the CEO Brief chief-analyst (module Y),
`status='paused'`, `autonomy='{}'` (L0), config = WEEKLY schedule / sonnet model /
read-only allowlist (get_ceo_brief) / $2 cap. Scheduled after the other weekly
agents so it can cite their runs. It narrates north-star metrics + the fleet's
latest run outcomes into a decision memo (honest attribution / graceful
degradation); it proposes nothing to execute. The prompt lives in the repo
charter. `ON CONFLICT (key) DO NOTHING` (idempotent). Self-records '00365'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED. Edge boot guard now expects **00365**.

**⚠️ Apply order:** apply after 00357–00364. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00365.

## ⏳ HELD: 00364_seed_trust_safety_agent.sql (US-1597 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the Trust & Safety agent (module T),
`status='paused'`, config = daily / sonnet / read-only allowlist
(get_trust_safety_health) / $2 daily cap. UNLIKE the other seeds, its `autonomy`
map is non-empty: it explicitly sets the account-action classes (suspend_account,
require_step_up, deny_claim) at **L1** to make the hard ceiling visible. The
policy engine (AUTONOMY_HARD_CAPS in agent-policy.ts) ALSO clamps them to L1
regardless of any later promotion — a permanent design decision. Approving one
files an admin task on the fraud console; it never suspends anyone directly. The
prompt lives in the repo charter. `ON CONFLICT (key) DO NOTHING` (idempotent).
Self-records '00364'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED. Edge boot guard now expects **00364**.

**⚠️ Apply order:** apply after 00357–00363. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00364.

## ⏳ HELD: 00363_seed_marketplace_ops_agent.sql (US-1598 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the Marketplace Ops agent (module L),
`status='paused'`, `autonomy='{}'` (L0), config = daily schedule / sonnet model /
read-only allowlist (get_marketplace_ops_health + get_marketplace_health) / $2
daily cap. The prompt lives in the repo charter
(`agents/charters/marketplace-ops-agent.ts`). It reads OPERATOR-SCOPE AGGREGATES
only and can propose reclaim-cron retry_jobs + file admin tasks once an operator
grants L1; it NEVER mutates tenant listings/inventory. `ON CONFLICT (key) DO
NOTHING` (idempotent). Self-records '00363'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED. Edge boot guard now expects **00363**. NOTE: the agent's
get_marketplace_ops_health tool also upserts a `marketplace_ops.backlog_snapshot`
system_settings row at RUNTIME (operator backlog watermark) — created lazily on
first run, no migration needed.

**⚠️ Apply order:** apply after 00357–00362. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00363.

## ⏳ HELD: 00362_seed_pricing_agent.sql (US-1601 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the Pricing agent (module P), `status='paused'`,
`autonomy='{}'` (L0), config = daily schedule / sonnet model / read-only allowlist
(get_pricing_health) / $2 daily cap. The prompt lives in the repo charter
(`agents/charters/pricing-agent.ts`). It audits cross-tenant aggregates and can
propose a curve-refresh retry_job + file admin tasks once an operator grants L1;
it NEVER edits a tenant's rules or prices. `ON CONFLICT (key) DO NOTHING`
(idempotent). Self-records '00362'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED, so it does nothing until an operator enables it. Edge boot
guard now expects **00362**.

**⚠️ Apply order:** apply after 00357–00361. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00362.

## ⏳ HELD: 00361_seed_finance_agent.sql (US-1596 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the Finance agent (module F), `status='paused'`,
`autonomy='{}'` (L0), config = daily schedule / sonnet model / read-only allowlist
(get_finance_health + get_revenue_window + get_ai_spend) / $2 daily cap. The prompt
lives in the repo charter (`agents/charters/finance-agent.ts`). It has NO write
tools of its own — it can only file admin tasks (file_task) once an operator grants
L1; it never moves money or credits. `ON CONFLICT (key) DO NOTHING` (idempotent).
Self-records '00361'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED, so it does nothing until an operator enables it. Edge boot
guard now expects **00361**.

**⚠️ Apply order:** apply after 00357–00360. Data-only (no `NOTIFY pgrst` needed).
Redeploy the edge so its boot guard matches 00361.

## ⏳ HELD: 00360_seed_integrations_watchdog_agent.sql (US-1604 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the Integrations Watchdog agent (module I),
`status='paused'`, `autonomy='{}'` (L0), config = daily schedule / haiku model /
read-only allowlist (get_integrations_health + get_marketplace_health) / $1 daily
cap. The prompt lives in the repo charter
(`agents/charters/integrations-watchdog.ts`). It has NO write tools of its own —
it can only file admin tasks (file_task) once an operator grants L1. `ON CONFLICT
(key) DO NOTHING` (idempotent). Self-records '00360'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED, so it does nothing until an operator enables it. Edge boot
guard now expects **00360**.

**⚠️ Apply order:** apply after 00357/00358/00359. Data-only (no `NOTIFY pgrst`
needed). Redeploy the edge so its boot guard matches 00360.

## ⏳ HELD: 00359_seed_grading_quality_agent.sql (US-1594 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the Grading Quality agent (module G),
`status='paused'`, `autonomy='{}'` (L0), config = weekly schedule / sonnet model
/ read-only allowlist (get_grading_quality + get_review_queue_stats) / $2 daily
cap. The prompt lives in the repo charter (`agents/charters/grading-quality.ts`).
It has NO grading write tools — it can never mutate grading config. `ON CONFLICT
(key) DO NOTHING` (idempotent). Self-records '00359'.

**Risk: LOW — one seed row into the operator agents table (00357).** No client
reads. Seeded PAUSED, so it does nothing until an operator enables it. Edge boot
guard now expects **00359**.

**⚠️ Apply order:** apply after 00357/00358. Data-only (no `NOTIFY pgrst`
needed). Redeploy the edge so its boot guard matches 00359.

## ⏳ HELD: 00358_seed_sentinel_agent.sql (US-1593 / AGENTIC-OS Phase 1, 2026-07-05)

**What:** seeds ONE `agents` row — the Sentinel health/incident agent (module H),
`status='paused'`, `autonomy='{}'` (L0), config = schedule 30m / haiku model /
read-tool allowlist (get_incidents + ops reads) / $1 daily cap / 8 max steps.
The prompt lives in the repo charter (`agents/charters/sentinel.ts`), not the
row. `ON CONFLICT (key) DO NOTHING` (idempotent; never disturbs later operator
edits). Self-records '00358'.

**Risk: LOW — one seed row into a brand-new operator table (00357).** No client
reads. The agent is seeded PAUSED, so it does nothing until an operator enables
it in Mission Control. Edge boot guard now expects **00358**.

**⚠️ Apply order:** apply after 00357 (the agents table must exist first). No
`NOTIFY pgrst` strictly needed (no schema surface change — data only), but
harmless. Redeploy the edge so its boot guard matches 00358.

## ⏳ HELD: 00357_agentic_os_kernel_schema.sql (US-1583 / AGENTIC-OS Phase 0, 2026-07-04)

**What:** creates the five foundational Agentic OS operator tables — `agents`
(registry: key/name/module_letter/status/autonomy jsonb/config jsonb),
`agent_runs` (run ledger: status/tokens/cost/outcome), `agent_run_steps`
(transcript: seq/step_type/input/output/duration), `agent_proposals` (approval
queue: action_class/payload/evidence/status/idempotency_key unique), and
`agent_memory` (agent_id/kind/key/content/weight). All uuid PKs, created_at/
updated_at + `set_updated_at` triggers, and indexes (runs by agent+started_at
desc, proposals by status, unique run_id+seq, unique agent_memory key).
Idempotent (`CREATE TABLE IF NOT EXISTS` / `CREATE … IF NOT EXISTS`);
self-records '00357'.

**Risk: LOW — five NEW empty deny-all tables; no client reads, no data change.**
All RLS-enabled with ZERO policies (service-role only, registered in
SERVICE_ROLE_ONLY in rls-guard_test.ts); none has a `user_id` column. Fixed-set
columns use text + CHECK (not Postgres ENUM) to stay cleanly idempotent. **No
routes or kernel code ship in this story** (US-1584 builds the run loop), so
nothing reads these at runtime yet — applying it is safe at any time. Edge boot
guard now expects **00357**.

**⚠️ Apply order:** apply after 00353→00356 (all held above). `NOTIFY pgrst,
'reload schema';` after applying (new tables PostgREST would otherwise not know
of — harmless here since the SPA never reads them, but keeps the runbook
uniform). Redeploy the edge so its boot guard matches 00357.

## ⏳ HELD: 00356_public_cert_moderation_withhold.sql (US-1654 / DB-P2, 2026-07-04)

**What:** `CREATE OR REPLACE VIEW public_grade_reports` reproducing every 00318
column verbatim, plus a LEFT JOIN to `submissions` and a WHERE predicate that
mirrors `isCertificateWithheld` (excludes `status='pending_review'`, and flagged
submissions unless `moderation_status='approved'`). Closes the bypass where a
finalized-then-flagged certificate stayed readable via PostgREST / the SPA
`/cert/:id` even though the edge endpoints 404 it. Self-records '00356'.

**Risk: LOW — output columns UNCHANGED (only the row set narrows); no client
projection change; no data change.** The view runs as its owner (bypasses the
underlying RLS exactly as the existing view already does for grade_reports), so
the submissions join needs no new grant. Edge boot guard now expects **00356**.

**⚠️ Apply order:** apply after 00353/00354/00355. `NOTIFY pgrst, 'reload
schema';` after applying (the view definition changed). Redeploy the edge so its
boot guard matches 00356. No client code depends on the change (it only stops
withheld rows appearing) — so applying it is safe at any time; do it before
merging so the SPA `/cert/:id` stops rendering withheld grades.

## ⏳ HELD: 00355_dispute_admin_alerted_at.sql (US-1652, 2026-07-04)

**What:** `ALTER TABLE disputes ADD COLUMN IF NOT EXISTS admin_alerted_at
timestamptz`. The dedup gate for the dispute-filed admin alert — the handler
claims it with a race-safe conditional UPDATE (`WHERE admin_alerted_at IS NULL`)
so the alert fires at most once per dispute. Self-records '00355'.

**Risk: LOW — additive nullable column; no client reads.** No backfill (NULL =
"never alerted", correct for existing open disputes). Edge boot guard now expects
**00355**.

**⚠️ Apply order:** apply after 00353/00354. The edge code reads/writes
`admin_alerted_at` at RUNTIME only when `/dispute-filed` is called — an update
targeting a missing column would 42703-fail that request, so apply 00355 before
this edge build deploys. `NOTIFY pgrst, 'reload schema';` after applying (a new
column PostgREST must expose). Redeploy the edge so its boot guard matches 00355.

## ⏳ HELD: 00354_dead_letter_googleplay_provider.sql (US-1650 / C6, 2026-07-04)

**What:** extends the `webhook_dead_letters.provider` CHECK allow-list to include
`'googleplay'` (was `stripe`/`ebay`/`appstore`/`content`), so the new Google Play
RTDN webhook (`routes/google-play-rtdn.ts`) can durably dead-letter a
non-transient failure like every other provider. `DROP CONSTRAINT IF EXISTS` +
re-`ADD` (mirrors 00206); self-records '00354'.

**Risk: LOW — no client-side reads; constraint-only.** No column/view/data
change. The edge boot guard now expects **00354**.

**⚠️ Apply order:** apply 00353 first (already held below), then 00354. After
applying, redeploy the edge so its boot guard matches 00354. No `NOTIFY pgrst`
needed. The RTDN webhook only reconciles at RUNTIME when Google delivers a
notification, so nothing breaks pre-apply — but its dead-letter path would fail
the CHECK until 00354 is applied, so apply it before enabling the Pub/Sub push.

Also set `GOOGLE_RTDN_WEBHOOK_SECRET` on the edge and configure the Pub/Sub push
endpoint as `…/api/webhooks/google-play?token=<that secret>`.

## ⏳ HELD: 00353_google_purchase_token_unique.sql (US-1614 / C1, 2026-07-04)

**What:** a partial unique index
`idx_users_google_purchase_token ON users(google_purchase_token) WHERE google_purchase_token IS NOT NULL`.
The DB backstop for binding a Google Play subscription purchaseToken to exactly
one account (the edge verify path now also requires a matching
`obfuscatedExternalAccountId` and refuses a token already claimed on another
user's row).

Idempotent (`CREATE UNIQUE INDEX IF NOT EXISTS`); self-records '00353'.

**Risk: LOW — no client-side reads of new schema.** Purely an index; no column
or view change. Edge boot guard expects 00353.

**⚠️ Apply caveat:** if prod already has duplicate `google_purchase_token`
values (the C1 exploit was used before this shipped), the index creation will
FAIL — that's the correct signal to investigate/de-dupe first. Google Play
billing is pre-launch, so no legitimate duplicates are expected. No
`NOTIFY pgrst` needed (no schema surface change), but redeploy the edge so its
boot guard matches 00353.

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
