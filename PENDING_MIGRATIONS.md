# PENDING MIGRATIONS — apply BEFORE pushing this branch to origin

> [!warning] 2026-07-31 — these three holds look STALE. Please confirm.
>
> All three migrations (00504, 00505, 00506) are present on `origin/main`:
>
> - `00504` — 53767fda `fix(db): make listings.is_active a lockstep mirror…`
> - `00505` — ed88c7d6 `feat(analytics): give the Grading-ROI tab period presets…`
> - `00506` — 7c745d01 `feat(flipdesk): make the Listing Quality Score a sortable column…`
>
> Under the standing held-migration rule a migration commit is not pushed until
> the operator has applied the SQL, so a migration ON origin/main means its hold
> was already released. `EXPECTED_SCHEMA_VERSION` on main is 00506 and the edge
> boot-guards on it, so a prod still at 00503 would be failing its readiness
> check rather than serving.
>
> NOT flipped to APPLIED here, because that would assert a prod fact this
> session cannot observe. Flagged instead, because a stale hold is not
> harmless: it tells every reader (and the session-start hook, which reads the
> ⏳ markers below) that the branch is frozen when it is not — which either
> invites a pointless prod session or holds back a push that was always safe.
> This is the second time this file has gone stale the same way; see the
> US-2017 note in prd.json for the first.
>
> **If prod is at 00506, mark the three entries APPLIED and delete this
> callout.** If it is genuinely still at 00503, the push that carried these
> commits bypassed the rule and prod needs them urgently.

**Three migrations held.** Schema on prod is at **00503** (applied 2026-07-29);
this branch bumps `EXPECTED_SCHEMA_VERSION` to **00506** and holds three
migrations below (apply **00504 → 00505 → 00506**, in order). All are **db-lane
verified** — `npm run verify:db` applied the whole tree from zero on 2026-07-30
(green). Apply to prod, then OK the push.

---

## ⏳ HELD: 00506_items_full_quality_score.sql (US-2170 sortable quality score, 2026-07-30)

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

## ⏳ HELD: 00505_grading_roi_period_filter.sql (US-2234 AC3 grading-ROI presets, 2026-07-30)

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
  tab errors. **Apply 00505 to prod BEFORE the push.**
- **If it stays unapplied.** The Grading-ROI tab breaks once the frontend deploys
  (see above). Until the frontend deploys, prod is unaffected.
- **`NOTIFY pgrst, 'reload schema';`** after applying (functions changed).

---

## ⏳ HELD: 00504_listings_is_active_lockstep.sql (US-2176 is_active lockstep, 2026-07-30)

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
