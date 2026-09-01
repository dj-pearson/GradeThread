# PENDING MIGRATIONS — applied to prod separately from the push

## ▶ OUTSTANDING RIGHT NOW: 00708_registered_number_lookups.sql (US-9036 — count the RN lookups we could not answer)

**Not yet applied.** Held per the standing rule: apply the SQL to prod, then OK
the push.

**Risk: low.** One NEW table, one NEW function, two new indexes and one trigger.
Nothing existing is altered, dropped or backfilled. `registered_number_sightings`
is deliberately untouched — see below for why this is a separate table rather
than a column on that one.

**⚠ Needs `NOTIFY pgrst, 'reload schema';`** — a new table and a new RPC, so
PostgREST will 404 on both until it is told.

**Apply order: after 00501 and 00502**, both long since applied. Order against
00700-00707 does not matter. It is the highest file, so
`scripts/apply-prod-migrations.sh` picks it up on its own.

**What it does.** Creates `public.registered_number_lookups`: one row per
RN/CA number that somebody looked up and we could not answer, with a count, a
`resolved` flag and first/last seen timestamps. Plus
`record_registered_number_lookup(text, text, text)`, an increment-or-insert RPC
in one statement so two concurrent lookups cannot lose a count. Deny-all RLS
with zero policies, matching `registered_number_sightings`; registered in
`SERVICE_ROLE_ONLY` in `rls-guard_test.ts`.

**No REVOKE, and NOT `SECURITY DEFINER` (US-2403).** 00501's RPC is both, and
copying that pair here would have been a database-restart bug: on this Postgres
image supautils decorates a permission-denied error with a GRANT hint, and
building it segfaults the backend on a FUNCTION denial, taking every other
session with it. `anon` is the key in the browser bundle. Authorization comes
from the table instead — the function is `SECURITY INVOKER`, service_role
bypasses the deny-all RLS and writes, anon hits an ordinary row-level refusal on
the INSERT. Caught by `us2403-function-revoke-gate.test.ts`, whose allowlist is
shrink-only and which this file is deliberately NOT added to.

**Why not a column on `registered_number_sightings`.** A sighting means our OCR
read the number off a real garment tag, and `/rn/:number` prints that count as
the one line a mirror site cannot print. A typed lookup is demand, not evidence,
and folding them together would inflate the number the page's credibility rests
on. `00501`'s own `CHECK (sighting_count > 0)` also makes a lookup-only row
impossible to represent there honestly.

**Does client code read it before the apply?** NO, and this is the part to be
sure of. Nothing in the SPA touches it. The only caller is the edge service, in
`GET /api/content/public/registered-numbers/:number`, and that call is
**fire-and-forget after the payload is built**: the RPC result is checked, a
failure is logged with `console.warn` and the reader still gets their answer. So
if the frontend auto-deploys before the SQL lands, the RN pages keep working and
the edge logs a warning per miss until the apply. The `EXPECTED_SCHEMA_VERSION`
bump to `00708` means the edge boot guard will refuse to start on an unapplied
database, which is the real ordering constraint: apply first, then redeploy the
edge.

**Verify after applying:**

```sql
select count(*) from public.registered_number_lookups;                 -- 0
select proname from pg_proc where proname = 'record_registered_number_lookup';
```
Then the edge boot log should print
`[schema-version] OK — DB at 00708 matches expected 00708`.

---

## ✅ Previously held

00706 and 00707 were held here while already applied to prod, so the gate
blocked every push for something that was done. Both are recorded below with the
reads that confirm them.

## ✅ APPLIED 2026-08-30: 00706_sale_pnl_view.sql (US-3018 — one per-sale profit row the team reports group by)

**Verified applied 2026-08-30.** Not applied by this change — found already on
prod when the held-migration gate blocked an unrelated push. Three independent
reads agree: `public.sale_pnl` exists in `pg_views`; the edge boot guard prints
`[schema-version] OK — DB at 00707 matches expected 00707`; and
`GET /rest/v1/sale_pnl` returns 200. The `NOTIFY pgrst, 'reload schema'` this
entry calls for had NOT been run, so PostgREST was still 404ing on the view; it
has been run now, which is what took that endpoint from 404 to 200.

**Note on `supabase_migrations.schema_migrations`: it is NOT the evidence here.**
That tracker reads 00589 as its highest version on this database, ~117 behind
the schema, which is the known Lovable-origin tracker lag. The objects and the
boot guard are what was checked. Do not read the tracker as "unapplied".

**Risk: low.** One NEW view. No table, column, function, policy or row is
touched, and nothing existing reads it yet.

**⚠ Needs `NOTIFY pgrst, 'reload schema';`** — the view is new, and PostgREST
will 404 on `/rest/v1/sale_pnl` until it is told.

**Apply order: any time after 00143 and 00008**, both of which are years old.
Order against 00700-00705 does not matter.

**What it does.** Creates `public.sale_pnl`: one row per completed sale
carrying the profit `finances_dashboard` already computes, plus the grouping
keys the FlipDesk team reports need (`sourcer_name`, `sourcer_key`,
`source_key`, `brand_key`, `category_key`). `security_invoker = on`, the same as
`items_full`, so RLS on `sales` and `inventory_items` decides visibility and no
new tenant logic is introduced.

**Does client code read it before the apply?** NO. This commit ships the view
and its invariant check only. The first reader is US-3019, which is not written
yet. A push before the apply therefore breaks nothing on the frontend — but the
edge boot guard still expects `00706`, so keep the normal order.

**Verified locally 2026-08-30** against `supabase_db_gradethread`:
`node scripts/check-sale-pnl-invariant.mjs` reports the view and
`finances_dashboard` agreeing at $164.84 with $0.00 variance. Both guards were
sabotage-tested: dropping the legacy-shipments term fails at $5.95, and removing
the case fold fails on `'Dan'`/`'dan'` not collapsing.

## ✅ APPLIED 2026-08-30: 00707_created_by_tracking.sql (US-3023 — who created an item or listing)

**Verified applied 2026-08-30.** Not applied by this change — same discovery as
00706 above. `created_by` exists on both `inventory_items` and `listings`, and
all four triggers this migration declares are present and enabled:
`set_inventory_items_created_by`, `guard_inventory_items_created_by`,
`set_listings_created_by`, `guard_listings_created_by`. The edge boot guard
independently reports the schema at 00707.

**Risk: low-to-medium.** Two NEW columns, two indexes, two functions and FOUR
triggers. No existing column, policy or row is changed, and nothing is
backfilled — but it does add triggers to `inventory_items` and `listings`, which
are the two hottest write paths in the product. If a trigger raised, every
insert on those tables would fail. Neither can raise: `set_created_by` does one
assignment, and `guard_created_by_immutable` pins a value and returns.

**⚠ Needs `NOTIFY pgrst, 'reload schema';`** — two new columns, and PostgREST
will not expose `created_by` until it is told.

**Apply order: after 00706.** No dependency between them; this is just the
number order.

**What it does.**
- `inventory_items.created_by` and `listings.created_by`, both
  `uuid REFERENCES public.users(id) ON DELETE SET NULL`, with a
  `(user_id, created_by)` index on each.
- A BEFORE INSERT trigger stamps `coalesce(NEW.created_by, auth.uid())`, so
  every client — web, iOS, Android, the extension — is captured with no app
  changes. Service-role and job inserts leave it NULL, which is correct.
- A BEFORE UPDATE trigger pins the value for authenticated sessions, silently.
  Service-role can still correct a row.

**Why the immutability trigger, when the story did not ask for one.** AC5 asked
whether the `00526` deny-by-default column allowlist covers this column. It does
not — that guard is on `public.users` alone, and `inventory_items` / `listings`
carry plain row-level UPDATE policies with no column list. So nothing stopped a
later UPDATE from rewriting the attribution. The realistic break is not a
malicious teammate: it is a client that reads a whole row, changes one field and
writes the object back, carrying an absent `created_by` with it.

**Does client code read it before the apply?** NO. `src/types/database.ts` now
declares the field, but no query selects it and no UI renders it. US-3024 is the
first reader and is not written yet. A push before the apply breaks nothing.

**⚠ THIS REPORTS FORWARD ONLY.** Existing rows are NOT backfilled and stay
NULL, because nothing has ever recorded which member performed an insert. Any
report on this column has to say so rather than showing an empty chart.

**Verified locally 2026-08-30** against `supabase_db_gradethread`:
`node scripts/check-created-by.mjs` passes all five cases, and the migration
re-applies cleanly (every statement reports `already exists, skipping`). Four
sabotages were run rather than assumed, each caught with exit 1:
dropping the INSERT trigger; stamping `NEW.user_id` (the tenant) instead of
`auth.uid()` (the actor), which the fixture catches only because it inserts as a
MEMBER of someone else's workspace; dropping the immutability guard; and a guard
that returns OLD and swallows the whole UPDATE rather than just the column.

Production reported `applied: 00705` with no missing versions
(`GET https://functions.gradethread.com/health/ready`, unauthenticated), and the
owner confirmed that apply on 2026-08-30.

`unexpected` currently lists 00700-00705. That is the DEPLOYED EDGE CONTAINER
reporting versions its own shipped manifest predates, not a problem with the
database, and it clears on the next Coolify deploy.

⚠ **FLIP EACH HEADING TO `## ✅ APPLIED <date>:` AS YOU GO.** The pre-push gate
blocks on the marker, not on the database, so a migration that is applied but
still marked HELD blocks *the next person* push rather than the author. That
happened three times on 2026-08-29 (00691, 00696, 00698) and cost a full push
cycle each time, and again on 2026-08-30 when five sat marked while applied.

## ✅ APPLIED 2026-08-30: 00705_quickbooks_sync_log.sql (US-2998 — the QuickBooks push, and running it twice safely)

**Risk: low.** Two NEW tables and two NEW functions. No existing table, column,
function, policy or row is touched.

**⚠ Needs `NOTIFY pgrst, 'reload schema';`** — two tables and two RPCs are new,
and PostgREST will 404 on all four until it is told.

**Apply order: AFTER 00704**, which created `qbo_connections`. Both new tables
have a foreign key to it, so 00705 on its own fails. Order against 00701, 00702
and 00703 does not matter.

**What it does.**
- `qbo_sync_log` — one row per pushed object, keyed
  `(user_id, object_kind, source_id)`. This is the idempotency memory: a re-run
  reads it before it writes, so a source with a recorded QuickBooks id is
  updated or skipped and only an unrecorded one is created.
- `qbo_sync_runs` — the resume bookmark for a bounded backfill.
- `qbo_pending_documents(uuid, date, date, date, int)` — groups ledger entries
  by SOURCE so a sale's revenue, shipping, fees, label and cost of goods are one
  document rather than five.
- `qbo_payout_sales(uuid, uuid)` — which sales a payout paid for, via
  `sales.payout_reference`.

**Both functions are SECURITY DEFINER and take a user id, with an in-body
guard.** They have to: the caller is the edge, which uses the service-role
client where `auth.uid()` is NULL, so a function keyed on `auth.uid()` alone
would return nothing there and read as "no sales to push" rather than as a bug.
A signed-in browser caller can only ever ask for themselves — naming anyone else
raises 42501. **No REVOKE** (US-2403): the refusal is raised in the body.

**Frontend dependency, and it is safe in both directions.** The sync card ships
in the same commit but renders nothing until there is a QuickBooks connection,
and every read goes through the edge rather than PostgREST. With the Intuit env
vars unset — which is today — the routes answer 503 and the card never appears.

**Verified on the local stack.** Applied twice, idempotent.
`node scripts/check-qbo-sync.mjs` passes 16 assertions against real rows: one
sale is one document carrying all six accounts, the facilitator tax is out of
the total (10952) and reported beside it (1487), the payout link resolves to the
right seller's sale, the cursor and the limit both bound the batch, and both
functions refuse another tenant with 42501. **The sabotage was run**: adding
`source_kind` to the GROUP BY turns three documents into six and the check fails
seven assertions.

The check is registered in `scripts/verify.mjs`,
`.github/workflows/db-migrations.yml` and `package.json` in the same commit.


## ✅ APPLIED 2026-08-30: 00704_quickbooks_connection.sql (US-2997 — the QuickBooks Online connection and its account mapping)

**Risk: low.** Three NEW tables and nothing else. No existing table, column,
function, policy or row is touched, so an unapplied state is invisible to every
current screen rather than broken.

**⚠ Needs `NOTIFY pgrst, 'reload schema';`** — three tables are new, and
PostgREST will 404 on all of them until it is told.

**Apply order: independent.** It shares no object with 00701, 00702 or 00703 and
can go before or after any of them.

**What it does.**
- `qbo_connections` — one row per connected QuickBooks company file. Holds the
  realm id, the environment, and the AES-GCM access and refresh tokens. Per-user
  RLS in the `(select auth.uid())` initplan form.
- `qbo_account_mappings` — one row per GradeThread account the seller has mapped
  to a QBO account. Absence means unmapped, which blocks that account's push and
  nothing else. Per-user RLS.
- `qbo_oauth_states` — the single-use OAuth CSRF token. RLS enabled with ZERO
  policies by design (service-role only), and registered in `SERVICE_ROLE_ONLY`
  in `rls-guard_test.ts` in the same commit.

**Why it is NOT on `marketplace_connections`.** That table's `marketplace`
column is the `listing_platform` enum, and QuickBooks is not a place you list a
garment. Adding a value to that enum would put "quickbooks" into every platform
dropdown, breakdown and count in the app, for a row that can never hold a
listing. The OAuth SHAPE is copied exactly; only the table is separate.

**Frontend dependency, and it is safe in both directions.** The QuickBooks card
ships in the same commit, but every read goes through the edge
(`/api/flipdesk/qbo/*`), not through PostgREST. If the frontend deploys before
this SQL is applied, `/status` returns `configured: false` (the env vars are
unset anyway) and the card says QuickBooks is not switched on. No screen 500s
and no query 404s in the browser.

**It is inert until the env vars are set.** `QBO_CLIENT_ID`,
`QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI` and `QBO_ENVIRONMENT` are all new and
all optional. With none of them set — which is today — every route refuses with
503 and nothing reaches Intuit. Applying this migration on its own changes
nothing a seller can see.

**Verified on the local stack.** Applied twice against the throwaway Postgres to
prove idempotency; the second run is clean. `migrations-lint` passes,
`rls-guard_test.ts` passes with the new registration, and the full edge suite is
9130 passed / 0 failed.


## ✅ APPLIED 2026-08-30: 00703_archived_needs_a_reason.sql (US-3007 — archived items with no reason reach the review queue)

**Risk: low.** Re-emits `public.books_review_queue(date, date)` with one extra
branch. No table, column, policy or row is touched, and nothing else changes.

**⚠ Needs `NOTIFY pgrst, 'reload schema';`** — a function body changes, so
PostgREST must be told or the queue keeps returning six kinds.

**Apply AFTER 00699**, which created the function. Order against 00701/00702
does not matter; they touch different objects.

**What it does.** Adds a seventh branch, `archived_no_reason`: an item whose
status is `archived` with no `removed_reason` recorded. It is the one status the
US-3007 removal trigger will not resolve, because lost, damaged, donated and
sold-off-platform are four answers with four different tax treatments.

**Why it matters.** Until answered, the item still counts as stock, so ending
inventory is too high and cost of goods sold too low. That direction OVERSTATES
the tax owed, which is why the trigger leaves it alone rather than guessing —
nobody under-reports while this sits unread.

**Frontend dependency, and it is one-way.** `src/lib/books-review.ts` ships the
new `IssueKind` and its copy in the same commit. If the frontend deploys before
this SQL is applied, nothing breaks — the kind simply never appears. The reverse
is also safe. There is no window where either half is wrong.

**Verified on the local stack**, on real rows rather than by inspection:
archived-with-no-reason fires with an exact 5500 impact; archived WITH a reason
does not; archived AFTER a completed sale does not; archived with no cost
recorded fires with a null impact rather than a guess. Dismissal round-trips
seven → six → seven. `scripts/check-books-review.mjs` covers all of it and runs
in the db lane.


## ✅ APPLIED: 00696_pricing_plans_shipping_labels.sql (US-3011 — turns the shippingLabels gate flag on for Pro and Business; applied 2026-08-29, confirmed by prod /health/ready reporting applied=00696)

**Risk: very low.** Two `UPDATE`s that merge one boolean key into
`public.pricing_plans.gate_flags`. No table, column, function, policy or piece of
seller data is touched, and both are guarded by `not (gate_flags ? 'shippingLabels')`
so an operator who has already set the key keeps their value and the file is safe
to re-run.

**No `NOTIFY pgrst` needed** — no table, column or RPC changes shape.

**What it does.**
`free`/`starter` get `shippingLabels: false`; `pro`/`business` get `true`.

**⚠ APPLY BEFORE THE PUSH, or the feature ships switched off for everyone.**
This is the one thing to get right here. `pricing_plans.gate_flags` is CANONICAL
once the row exists — `pricing-config.ts` `rowToConfig()` reads
`gateFlags[k] = flags[k] === true`, so a key absent from the row is a hard false
that outranks `FALLBACK_MATRIX`. Push the code without this SQL and a Pro seller
is told label buying is not part of their plan and pointed at the pricing page
they are already paying for. Nothing errors, nothing logs. That is precisely
what happened to `connectorAccess` (US-2687, fixed by 00625), and
`src/test/plan-gate-flags-seeded.test.ts` exists to stop it happening a third
time — it fails the build if a flag in `GATE_FLAG_KEYS` appears in no migration.

**The frontend reads it too.** `src/lib/constants.ts` carries the mirror
`FLIPDESK_PLANS[*].gateFlags.shippingLabels` and the Pro/Business feature bullet,
and Cloudflare Pages auto-deploys the frontend on push. The bullet says labels are
included; if the SQL has not run, the ship dialog will still say the plan does not
include them.

**Nothing is live yet either way.** Buying labels needs eBay's limited-release
`sell.logistics` scope, which this keyset does not hold (US-2380). Until that is
granted, `/capabilities` returns `feature_unavailable` for every seller on every
plan, deliberately ahead of the plan check — so this migration changes nothing a
seller can see until the eBay application lands.

**⚠ 00695_mileage_log.sql was written by a concurrent agent and is NOT mine.**
`EXPECTED_SCHEMA_VERSION` is 00696, which asserts 00695 applied too. Apply both,
in order, or the edge boot guard reports `behind`.


## ✅ APPLIED: 00694_drop_phantom_00689.sql (removes a stale applied_migrations row; applied 2026-08-29, confirmed by prod /health/ready no longer listing 00689 as unexpected)

**Risk: very low.** One `DELETE` of a single row from `public.applied_migrations`.
No table, column, function, policy or piece of seller data is touched.

**No `NOTIFY pgrst` needed** — nothing in the schema changes.

**What it does.** `DELETE FROM public.applied_migrations WHERE version = '00689';`

**Why.** Two agents claimed 00689 within minutes on 2026-08-29. The US-3007
write-offs migration was applied to prod while still carrying that name, so its
footer recorded `'00689'`; both files were then renamed away (00690 and 00691)
and the number ended up belonging to nobody. `/health/ready` reported
`unexpected: ["00689"]`.

**The schema was never wrong.** 00692 applied cleanly and references
`removed_on`/`removed_reason` fourteen times, so 00690's columns were already
there; re-running 00690 recorded its own version and `missing` went empty. Only
the discarded label survived.

**Precedent, not invention.** `schema-version.ts` records that 00638 removed the
00636/00637 rows for the same reason, "so the applied set matches the shipped set
exactly and the phantom list below does not have to grow" — and that list is
guarded by a test asserting it may only shrink. Listing 00689 instead would have
meant editing that test to permit growth.

**Nothing true is lost.** The row claimed version 00689 was applied; no such
migration exists in this repo and none ever will — the number is annotated in
`migrations-lint`'s `KNOWN_GAPS`. What actually ran is recorded under 00690.


## ✅ APPLIED: 00692_keeping_leaves_inventory.sql (US-3007 — the status a seller already sets is what records the write-off; owner-confirmed applied 2026-08-29)

**What it does.** A BEFORE INSERT/UPDATE trigger on `inventory_items` derives the
write-off from `item_status`, so a seller does not have to say it twice. Plus a
one-time backfill of items already sitting in `keeping`.

**⚠ Only `keeping` leaves inventory, and the obvious mapping is wrong twice.**
Owner's ruling 2026-08-29:

| status | inventory | why |
|---|---|---|
| `keeping` | leaves | taken for personal use, reduces Schedule C line 36 |
| `wearing` | STAYS | still stock — they are wearing it and will still sell it |
| `returned` | STAYS | a buyer sent it back, so it returns to stock |
| `archived` | STAYS | ambiguous, so the trigger will not guess |

**⚠ The backfill writes real rows.** Every item in `keeping` with no reason gets
`removed_on = updated_at::date` and `personal_use`. `updated_at` is when the row
last changed for ANY reason, not necessarily when the item was taken — the owner
chose it because nothing in the schema records the transition. Idempotent, and a
hand-set reason is never overwritten.

**Needs `NOTIFY pgrst, 'reload schema';`** — a new function, so the schema cache
must be told.

**Verified on the local stack.** Applied twice (idempotent, `UPDATE 0` /
`INSERT 0 0` on the rerun). `scripts/check-inventory-writeoffs.mjs` now asserts
all three statuses, that `keeping -> listed` puts the item back, and that a
hand-set `lost` survives a status change. SABOTAGE-CHECKED by widening the
trigger to include `wearing` — it went red naming the real risk ("wearing or
returned was removed from inventory - both must STAY") and green on restore.


## ✅ APPLIED 2026-08-30: 00702_period_close.sql (US-2995)

**Risk: MEDIUM, and the highest in this epic so far.** It installs BEFORE
triggers on four tables that the whole product writes to: `flipdesk_expenses`,
`mileage_trips`, `sales` and `inventory_items`. They are inert until a seller
closes a period -- `is_period_closed` returns false for everyone with no
`closed_periods` row -- but the trigger fires on every write regardless, so the
cost is one indexed lookup per row.

**What it does.** Creates `closed_periods`, `is_period_closed(uuid, date)`,
three trigger functions, `close_period(date, date, text)` and
`reopen_period(uuid, text)`.

**WHY TRIGGERS AND NOT RLS.** The edge service uses the service-role client,
which BYPASSES RLS. A policy-based lock would hold against the browser and let
every edge route, job and webhook straight through -- and those are exactly the
paths that rewrite history with nobody watching. **Every refusal in the check is
tested as `postgres`.**

**What is deliberately NOT locked**, because a lock that blocks ordinary work
gets switched off: shipping, tracking, delivery, status, titles, photos,
measurements, listings. A buyer can open a return in February on a December
sale, and refusing that write would break the marketplace sync rather than
protect the books. Only the columns that move a filed NUMBER are frozen.

**`close_period` and `reopen_period` are SECURITY DEFINER with in-body auth.**
The table has a SELECT policy only -- a close a user could hand-write is not a
close, and a DELETE would erase the audit trail AC4 exists for. **NO REVOKE
anywhere** (US-2403).

> **A design bug caught by running it.** Both functions were SECURITY INVOKER
> first, so the INSERT hit a table with no INSERT policy and closing could never
> have worked at all. The fixture failed on the first run with
> `new row violates row-level security policy`.

**Verified against real Postgres.** Applied twice (second run clean).
`npm run check:close` runs 17 assertions: six refusals as `postgres`, four
ordinary writes that must still succeed, the snapshot taken by the close, the
figures recorded, a blank reopen reason refused, and writes working again after
a reopen. Sabotage-verified by dropping the expense trigger, which reddens six.

**Apply order.** After 00701. No `NOTIFY` strictly needed for the triggers, but
send it anyway for the new table and two RPCs.

**Nothing is locked until a seller closes something.** Applying this changes no
existing behaviour.

## ✅ APPLIED 2026-08-30: 00701_bank_statement_import.sql (US-2994)

**Risk: low.** Two new tables, two new functions. Nothing existing is altered
and nothing runs until a seller uploads a CSV.

**What it does.** Creates `statement_sources` (one per bank or card, holding the
COLUMN MAP so it is chosen once and remembered) and `statement_rows` (a line
from the CSV, kept as its own record), plus `match_statement_row(uuid)` and
`statement_import_summary(uuid)`.

**The statement row NEVER mutates an expense.** `matched_expense_id` is a LINK,
recorded and reversible. An import that rewrites an amount a seller typed is how
a bookkeeping tool silently disagrees with the person using it, and the person
always loses because they do not know it happened.

**Idempotency keys off the ROW, not the import run.** The unique index on
`(user_id, source_id, row_fingerprint)` is the whole of AC3. Re-exporting an
overlapping date range is the NORMAL case -- sellers widen the range when they
think something is missing -- so keying off the run would duplicate every
overlapping row, and keying off a line number would break the moment the bank
reorders.

**A CHECK keeps `status` and `matched_expense_id` honest**: matched implies a
link and unmatched implies none. Without it the two drift and "matched" stops
meaning anything.

**Verified against real Postgres.** Applied twice (second run clean).
`npm run check:statements` runs 15 assertions.

> **Sabotage-verified on the assertion that matters.** Removing the
> already-matched exclusion from `match_statement_row` reddens three checks: an
> expense linked to one statement row gets offered to a second. Two lines for
> one expense IS the double payment a bank import exists to catch, so offering
> it would hide the thing the feature was built to find.

**Apply order.** After 00700. Then `NOTIFY pgrst, 'reload schema';` — two new
tables and two new RPCs.

## ✅ APPLIED: 00700_receipt_extraction.sql (US-2993, applied 2026-08-29 — owner-confirmed)

**What it does.** Adds four extraction-provenance columns to
`flipdesk_expenses` (`extracted_at`, `extraction_prompt_version`,
`extraction_confidence`, `extraction_proposed`) and
`find_duplicate_expenses(numeric, date, text)`. No existing column changes and
nothing is backfilled.

**The extracted values land in the ORDINARY columns.** A confirmed extraction IS
the expense; there is no second class of machine-entered row. What is stored
separately is provenance: which prompt produced it, how sure the model was per
field, and what it proposed before the seller touched it — which is the only way
to tell an accepted extraction from a corrected one, and therefore whether the
prompt is any good.

**AC6 is why the prompt version is on the row.** A bad prompt release has to be
traceable to the entries it made, and without it the only way to find them is to
guess at dates.

**Confidence is PER FIELD, not one number.** A receipt can have a crisp total
and an illegible date, and an aggregate would hide exactly the field worth
checking.

**Duplicate detection is a FUNCTION, not a unique constraint.** Two coffees from
the same shop on the same day for the same price is a real thing that happens,
and refusing it outright would be wrong. It matches on amount, a day either side
(a card statement and a receipt can disagree by one), and description — and the
screen asks rather than blocks.

**Apply order.** After 00699. Then `NOTIFY pgrst, 'reload schema';` — four new
columns and one new RPC.

## ✅ APPLIED: 00699_books_review_queue.sql (US-2992, applied 2026-08-29)

> **Confirmed by READING production.** `/rpc/books_review_queue`,
> `/rpc/books_review_count` and `/books_review_dismissals` are all present in
> the prod OpenAPI document. The owner separately ran the fixture and returned
> `count after undismiss: 6`, matching local exactly.

**What it does.** Creates `books_review_dismissals`, adds
`median_cost_ratio_bps()`, `books_review_queue()` and `books_review_count()`.
No existing table or function is altered and the ledger is untouched.

**Six checks, and three deliberate silences.** It flags sold items with no cost
basis, expenses that reach no Schedule C line, marketplace sales with zero fees,
payouts matching no sale, expenses over $75 with no receipt, and a year boundary
with no inventory snapshot. It stays QUIET on a local cash sale (Facebook and
OfferUp genuinely charge nothing on a pickup), on expenses under the $75
substantiation threshold, and on items that have a cost basis.

> **The negative assertions are the ones that matter.** Anyone can make a queue
> find problems. Sabotage-verified by removing both exemptions, which turns six
> issues into nine and reddens three checks. A queue that cries wolf gets
> ignored, and then the real issue in it goes unread too.

**Where the impact is honestly unknown, it says so.** A sold item with no cost
basis overstates profit by whatever it cost — which is precisely what nobody
recorded. Rather than inventing a figure, the row carries an estimate derived
from the seller's OWN median cost-to-price ratio, labelled as an estimate, and
null under five priced sales because a ratio from two items is a guess dressed
as a statistic. Exact and estimated totals are reported separately.

**Dismissals require a reason and have no UPDATE policy.** A dismissal without
one is indistinguishable from hiding the row, and editing a recorded reason
later turns the record into whatever the last edit said. Undismiss and dismiss
again.

**Apply order.** After 00698. Then `NOTIFY pgrst, 'reload schema';` — one new
table and three new RPCs.

## ✅ APPLIED: 00698_estimated_tax.sql (US-2991, applied 2026-08-29)

> **Confirmed by READING production.** `/tax_rate_years` and
> `/estimated_tax_payments` are both in the prod PostgREST OpenAPI document.

**Risk: low.** Two new tables, two new nullable columns on `tax_profiles`. No
existing table, function or policy is altered, and nothing runs on its own.

**What it does.** Creates `tax_rate_years` (seeded 2024, 2025 and a PROVISIONAL
2026) and `estimated_tax_payments`, and adds
`tax_profiles.income_tax_rate_bps` and `tax_profiles.last_year_total_tax_cents`.

> **⚠ TWO NEW COLUMNS ON `tax_profiles`.** Migration 00526 made
> `public.users` self-updates deny-by-default; `tax_profiles` is a different
> table with its own ordinary owner policies, so no allowlist restatement is
> needed. Flagged because the shape looks similar and the failure mode there is
> a SILENT no-op on save.

**No ledger change.** `rebuild_ledger_for_user()` is untouched — estimated tax
payments are PERSONAL, not a business expense, and a seller who deducted them
would understate their own profit and overstate the deduction. The payments
table is deliberately not wired into the ledger.

**What it computes, and what it refuses to.** Self-employment tax is mechanical
and is computed exactly: 15.3% on 92.35% of net profit, Social Security capped
at the wage base, Medicare uncapped, plus the 0.9% surcharge. **Income tax is
NOT computed from brackets.** It depends on the seller's whole return — a
spouse's wages, a W-2 job, other deductions, credits, state tax — none of which
this app sees. Shipping a bracket table would give a confident number built on
inputs we do not have, so the seller picks a rate and the screen names it as
their assumption.

**The safe harbour needs no projection at all** and is offered beside the
estimate: 100% of last year's tax, 110% above the AGI threshold, and no
underpayment penalty however the year turns out.

**The 2026 row is PROVISIONAL and UNDERSTATES.** The Social Security wage base
is carried forward from 2025 because the 2026 figure was not published when this
shipped, and it rises most years — so a high earner's Social Security portion
comes out low. **Update that row when the SSA announces it.**

**Verified.** Applied twice locally (second run clean); the three seeded years
read back with the right wage bases and the provisional flag. 30 vitest cases
cover the arithmetic, including the 92.35% factor, the wage-base cap, the 0.9%
surcharge threshold per filing status, and that the surcharge is NOT halved into
the deductible half (it has no employer match).

**Apply order.** After 00697. Then `NOTIFY pgrst, 'reload schema';` — two new
tables and two new columns.

**Client-side read risk: LOW.** The card is inside Money -> Tax and its queries
fail closed to a skeleton; the rest of the page is unaffected.

## ✅ APPLIED: 00697_home_office.sql (US-2990, applied 2026-08-29)

> **Confirmed by READING production.** `home_office_rates` reads back through
> the anon key as $5.00 a square foot, capped at 300 square feet, so a $1,500
> maximum. The owner separately ran the fixture and returned an overlap result
> matching local exactly: `overlaps: true`, $600 home office beside $400 rent.

**What it does.** Creates `home_office_rates` and `home_office_years`, adds
`home_office_deduction_cents()` and `home_office_overlap()`, and replaces
`rebuild_ledger_for_user()` so the deduction becomes a ledger entry dated at the
end of the tax year.

**THE CAP APPLIES TO THE FOOTAGE, THEN THE MONTHS ARE PRORATED.** 400 sq ft for
six months is 300 capped and then halved: **$750**. Prorating first and capping
after gives **$1,000**. Both look plausible on a screen and only one is right.
`npm run check:homeoffice` asserts it, and the sabotage swaps the order and
turns that check red.

**It is Schedule C LINE 30, which is not line 28.** The form keeps the home
office out of total expenses: 28 is expenses, 29 is profit before it, 30 is the
home office, 31 is what you are taxed on. **The P&L was folding it into line 28
until this story** — a seller transcribing that subtotal would have overstated
it by the whole deduction. `pnl-statement.ts` now gives it its own section and
shows lines 29 and 30 only when there is one.

**The double-count guard reports, it does not decide.** The simplified method
already covers rent and utilities for that space, so claiming it alongside rent
expensed separately deducts the same room twice — and neither figure looks wrong
alone. A genuinely separate storage unit is fine and the app cannot tell the
difference, so it puts both numbers side by side and says only the seller can.

**Actual expenses produce NO entry.** Form 8829 needs mortgage interest,
insurance, utilities and a basis calculation this app does not do. The card says
so rather than showing a figure that does not apply.

**Apply order.** After 00695. Then `NOTIFY pgrst, 'reload schema';` — two new
tables and two new RPCs.

## ✅ APPLIED: 00695_mileage_log.sql (US-2989, applied 2026-08-29)

> **Confirmed by READING production.** All seven `mileage_rates` rows are live
> and read back correctly through the anon key: 56.0c for 2021, **58.5c to 30
> June 2022 and 62.5c from 1 July** (the mid-year change, which is the whole
> reason the rate is a dated table rather than a constant), 65.5c, 67.0c, 70.0c,
> and a **PROVISIONAL** 70.0c for 2026.

**What it does.** Creates `mileage_rates`, `mileage_trips` and
`vehicle_use_years`; adds `mileage_rate_on(date)` and
`mileage_summary(from, to)`; and replaces `rebuild_ledger_for_user()` so trips
become ledger entries on the `vehicle_mileage` account.

**The rate is looked up by trip DATE, never snapshotted onto the trip.** A
corrected rate flows through instead of being frozen into rows nobody revisits,
and last year cannot silently reprice when a new rate lands.

**A trip with no rate for its date produces NO ENTRY.** A rate we do not have is
not a rate of zero, and `mileage_summary` reports the count so the screen can
say so rather than showing a silently smaller total.

**The 2026 rate is carried forward and flagged.** The IRS notice was not out
when this shipped. Carrying the last known rate and SAYING SO beats a silent
zero and a silent guess. **Update that row when the real rate is published.**

**The unit is TENTHS OF A CENT and the column name says so.** Most published
rates are not whole cents, so an integer `cents_per_mile` cannot hold them, and
585 in a column called cents means five dollars eighty-five a mile.

> **A one-cent bug found and fixed before shipping.** `mileage_summary` first
> rounded once on the total while the ledger rounds per trip. Two 10.4-mile
> trips at 58.5 cents are 608.4 cents each: 1216 per trip against 1217 rounded
> once. Reproduced on Postgres (15498 against 15499), then fixed by rounding per
> trip in both places. `npm run check:mileage` asserts they agree, and
> sabotage-verified by reverting the rounding, which reddens exactly that check.

**Apply order.** After 00691. Then `NOTIFY pgrst, 'reload schema';` — three new
tables and two new RPCs.

**Sellers need to press Rebuild** on the P&L before logged trips reach their
books; entries are written by the rebuild, not on save.

## ✅ APPLIED: 00693_form_1099k.sql (US-2988, applied 2026-08-29)

> **Confirmed by READING production, not by trust.** `/form_1099k` and
> `/rpc/form_1099k_bridge` are both present in the prod PostgREST OpenAPI
> document, fetched with the public anon key. PostgREST only exposes what exists
> in the schema cache, so their presence proves the SQL landed AND that
> `NOTIFY pgrst` ran.

**Risk: low.** One new table, two new functions. Nothing existing is altered and
nothing runs on its own — the bridge is a read, and the table is empty until a
seller types a form in.

**What it does.** Creates `public.form_1099k` (one form per platform per
calendar year), `form_1099k_bridge(platform, year)` and
`platforms_with_sales(year)`.

**Two correctness points worth reading before applying.**

1. **A 1099-K is ALWAYS a calendar year.** It has nothing to do with the
   seller's fiscal year. The function takes a YEAR and builds January-to-January
   bounds itself, so a seller on a July year start cannot accidentally compare a
   calendar-year form against fiscal-year totals and see a variance that is pure
   artefact.
2. **Computed gross must be identical on both US-2987 tax branches.** A 1099-K
   counts the buyer's payment, so it includes sales tax whether the marketplace
   collected it (excluded account) or the seller did (inside `sales_revenue`).
   The function adds the excluded account back in for exactly this reason.

> **Sabotage-verified, and the failure is the instructive part.** Removing the
> add-back turns 7 checks red and drops eBay's gross from $118.24 to $109.99
> while Shopify's stays at $118.24 — so the variance would have read $13.25,
> which is exactly the sales tax. That looks like a real finding and would send
> every marketplace seller hunting for sales that were never missing.

**The TIN column is `payer_tin_last4` and a CHECK enforces four digits.** A
payer's full TIN is a federal identifier this app has no use for, and a
free-text field is how one ends up in the database despite the column name.

**Verified against real Postgres.** Applied twice (second run clean), on a stack
already carrying 00690, 00691 and 00692. `npm run check:1099k` runs 19
assertions: both tax branches, the calendar-year boundary (a 2026-12-28 sale and
a 2027-01-03 sale land in different forms), a cancelled sale in neither the
gross nor the count, cross-platform isolation, and a $5.00 variance that fires.

**Apply order.** After 00691. Then `NOTIFY pgrst, 'reload schema';` — one new
table and two new RPCs.

**Client-side read risk: LOW.** The bridge is a card inside Money -> Tax.
Without the migration its queries fail and the card shows its loading state; the
tax-profile form above it is unaffected.

## ✅ APPLIED: 00691_facilitator_sales_tax.sql (US-2987, applied 2026-08-29)

> **Confirmed by READING production.** `/marketplace_facilitator_rules`,
> `/rpc/is_facilitator_collected` and `/rpc/sale_platform` are all present in
> the prod OpenAPI document, and the data reads back correctly: **12 rules, 10
> facilitators, `other` and `shopify` not**, and the `sales_tax_remitted`
> account present on Schedule C line 23. That is the seed, not just the table.
>
> **The gate caught this the right way round.** It reported 00691 as ALREADY ON
> origin/main while still marked HELD — the push happened before the heading was
> flipped. Nothing broke, because the SQL had in fact been applied first, but
> the ordering is the thing the rule protects and it was not followed here.

**Risk: MEDIUM, higher than the rest of this epic, and the reason is worth
reading.** It is the first migration here that CHANGES an existing derivation
rather than adding one. `rebuild_ledger_for_user()` is replaced, and after the
next rebuild a seller on a non-facilitator channel sees different GROSS RECEIPTS
than before. Net profit does not move on any branch.

**Numbered 00691, not 00689.** It was written as 00689 while 00690 was landing
in parallel, and 00690 reached origin/main first. A migration numbered BELOW an
already-pushed one is not untidy, it is invisible:
`apply-prod-migrations.sh` skips by MAXIMUM recorded version, so a hole below
the maximum is never applied — which is how `listings.draft_id` from 00134 sat
missing in production for months (US-2726). Renumbered before anything was
committed. 00690 replaces `take_inventory_snapshot()` and `cogs_worksheet()`;
this replaces `rebuild_ledger_for_user()`, so there was no overlap to rebase.

**What it does.** Creates `public.marketplace_facilitator_rules` (12 seeded
rules with effective dates), adds the `sales_tax_remitted` account to the chart,
adds `is_facilitator_collected(platform, date)` and `sale_platform(uuid)`, and
replaces `rebuild_ledger_for_user()` so the single unconditional tax entry
becomes two mutually exclusive branches.

**Why.** Since 00685 every sale's `tax` went to the excluded account
unconditionally. Right for eBay, Poshmark, Mercari and the rest. WRONG for a
seller running their own storefront with nexus: there the seller is the
retailer, the tax is part of gross receipts (line 1) and the remittance is a
deduction (line 23). Booking it as excluded understates income, which
understates tax — the direction that gets a seller in trouble rather than the
direction that costs them money.

**The unknown-platform fallback is SELLER-COLLECTED, on purpose.**
`sales.listing_id` is `ON DELETE SET NULL`, so a sale can outlive its listing.
Overstating income is a number the seller can dispute; understating it is one
the IRS disputes.

**NO REVOKE.** The `GRANT EXECUTE ... TO public` from 00686 is re-issued after
the `CREATE OR REPLACE`, and the in-body authorization check from US-3002 is
carried forward verbatim. Do not drop either: on this image a denied EXECUTE
restarts the database.

**Verified against real Postgres.** Applied twice (second run clean), on a local
stack that already had 00690. `npm run check:tax` runs 13 assertions on a
three-sale fixture — same price, same tax, different platform. All three
database checks (`check:ledger`, `check:cogs`, `check:tax`) pass against the
current schema.

> **Why this one needed a test rather than an eyeball.** NET PROFIT IS IDENTICAL
> on both branches — $67.00 for all three fixture sales — because facilitator
> tax is excluded outright and seller-collected tax is booked as income AND as
> an equal deduction. The bottom line cannot tell you the branch was chosen
> correctly. GROSS RECEIPTS can: $100.00 on eBay against $108.25 on Shopify.
> That is the figure a 1099-K is compared against. Sabotage-verified by flipping
> the fallback to facilitator, which turns 3 checks red while every net stays
> $67.00.

**One coarseness, recorded rather than hidden.** A single national
`2021-07-01` start date is coarser than the law, which arrived state by state
between 2018 and 2023. A 2019 sale in a state without a law yet would be
mis-booked. Fifty rows per platform would claim a precision `sales` cannot
support, since it carries no buyer state — so the `state` column exists, is
nullable, and is seeded empty.

**Apply order.** After 00690. Then `NOTIFY pgrst, 'reload schema';` — one new
table and two new RPCs.

**After applying, a rebuild is needed before anything changes.** Existing ledger
entries are not rewritten until `rebuild_my_ledger()` runs, which happens on the
P&L page's Rebuild button or the first books screen on an empty ledger.

## ✅ APPLIED: 00690_inventory_writeoffs.sql (owner-confirmed applied 2026-08-29) (US-3007 — an item that is lost, donated or kept never left inventory)

**Risk: low-to-moderate.** Two new nullable columns and two CHECK constraints on
`inventory_items`; two existing functions re-emitted. No data is rewritten and
no existing row is touched — every current row has `removed_on IS NULL`, which
is the "still held" case and is exactly today's behaviour.

**⚠ NEEDS `NOTIFY pgrst, 'reload schema';`** — two columns are added and two
function bodies change, so PostgREST must be told or the new fields are invisible
to the API and `cogs_worksheet` keeps returning the old JSON shape.

**What it does.** Adds `inventory_items.removed_on` (date) and `.removed_reason`
(text, CHECK: lost / damaged / donated / personal_use / returned_to_consignor).
`take_inventory_snapshot` gains ONE clause so an item that left before `as_of`
drops out of ending inventory. `cogs_worksheet` nets personal-use withdrawals off
Schedule C line 36 and reports `writeoffs_cents` plus
`variance_after_writeoffs_cents`.

**Why it matters.** A completed sale used to be the only exit from inventory, so
an item that was lost, donated or taken for personal use sat in ending inventory
for ever — overstating line 41, understating line 42 COGS, and overstating the
tax the seller owes. It is the rare bug that costs the user money in the
government's favour.

**Ordering.** Apply AFTER 00688 and alongside 00689 (it re-emits two functions 00688 created). No
frontend dependency: nothing in the client reads the new columns or the new JSON
keys yet, so there is no window where a deployed frontend breaks against the old
schema. The reverse is also true — applying it changes no behaviour a seller can
see until something writes `removed_on`, and nothing does yet.

**The US-3008 guard is carried forward BY HAND.** `take_inventory_snapshot` is
re-emitted whole (a plpgsql body cannot be patched), so its authorization check
had to be copied. `definer-user-id-guard_test.ts` scans migrations above 00640
for the shape that results if it is dropped, so this is checked rather than
trusted.

**Verified on the local stack, not by inspection.** Applied twice (idempotent),
then `scripts/check-inventory-writeoffs.mjs` seeded three items, wrote two off by
different routes, and asserted the figures: ending 1 item / 10000 cents,
line 36 net 20000 of 30000 gross, writeoffs 10000, residual 0. Sabotage-checked
by restoring 00688's predicate — three assertions went red naming the real defect
(all three items still in ending inventory), and green again on restore.


## ✅ APPLIED: 00688_inventory_snapshots.sql (US-2986 + US-3008, applied 2026-08-29 — owner-confirmed; /health/ready reports applied 00688. Carries the US-3008 body guard on take_inventory_snapshot, which was added before the file was applied anywhere.)

**Risk: low.** Two new tables, four new functions. No existing table, column,
policy or function is touched, and nothing runs until a seller presses "Value my
inventory" on the P&L page.

**What it does.** Creates `public.inventory_snapshots` and
`public.inventory_snapshot_items` (a point-in-time inventory valuation for
Schedule C Part III lines 35 and 41), plus
`take_inventory_snapshot(uuid, date, text, boolean)` SECURITY DEFINER,
`take_my_inventory_snapshot(date, text, boolean)` SECURITY INVOKER (the only one
`authenticated` may execute), `cogs_worksheet(date, date)` and
`items_missing_cost_basis(date, date)`.

**Why it could not wait.** `inventory_items.acquired_price` is editable, so the
moment a seller corrects last year's cost, last year's ending inventory silently
changes -- and last year's ending inventory is this year's beginning inventory.
The snapshot COPIES each cost rather than referencing it. This is the one gap in
the epic that gets harder to close the longer it is left.

**NO REVOKE ANYWHERE.** Authorization is in the function body raising 42501,
matching 00686. On this Postgres image a denied EXECUTE from `anon` or
`authenticated` restarts the database (US-2403).

**RLS.** SELECT and DELETE for the owner. Deliberately NO INSERT or UPDATE
policy on `inventory_snapshots`: a record a user can hand-write is not a record.
Snapshots are created only by the function, which counts the items itself.
DELETE is allowed because a seller who took one on the wrong date needs a way
out. All policies use the `(select auth.uid())` initplan form from the start,
which is what US-3005 had to retrofit onto the first three migrations.

**Verified against real Postgres, not asserted.** Applied twice (second run
clean). `npm run check:cogs` seeds a two-year fixture inside a rolling-back
transaction and asserts twelve things, including that 2025 reconciles at $0.00
and 2026 does NOT, at -$50.00. Sabotage-verified: removing the
`NOT EXISTS (... sales ...)` arm so sold items never leave inventory turns seven
checks red; restoring it returns them to green.

> **A finding worth carrying, measured rather than assumed.** A sold item with
> NO cost basis does **not** move the variance, because both routes to COGS read
> the same `acquired_price` column and a null cancels on both sides. The
> variance catches STRUCTURAL mismatches; the `items_without_cost` counts catch
> UNDERSTATED ones. A screen watching only the variance would call those books
> clean. Both signals are shown, as two different problems with two different
> fixes.

**Apply order.** After 00685 (it reads `ledger_entries` for the cross-check).
Then `NOTIFY pgrst, 'reload schema';` - two new tables and three new RPCs.

**Client-side read risk: LOW.** The COGS card is inside the P&L page. Without
the migration it fails its own query and renders nothing; the statement above it
is unaffected.

## ✅ APPLIED: 00687_ledger_rls_initplan.sql (US-3005, applied 2026-08-29)

> **Owner-confirmed, not read from the database.** The same distinction the
> 00682 entry draws, and it matters here more than usual: this migration changes
> only RLS policy predicates, which are not part of the PostgREST schema cache
> and are not visible in the OpenAPI document. There is no read that confirms it
> from outside the database. What is recorded is who said so and when.


**Risk if NOT applied: LOW but growing.** Thirteen RLS policies on tax_profiles,
tax_profile_changes, ledger_accounts and ledger_entries re-evaluate auth.uid()
per row instead of once per statement (US-1927 AC1). Invisible on a small table;
ledger_entries gets NINE rows per completed sale, so it gets worse every month a
seller uses the product.

**Risk of applying it: LOW.** DROP/CREATE POLICY only. No data, no schema, no
permission change - the predicates are identical apart from the initplan
wrapper, including the `user_id IS NULL` arm that makes the system chart of
accounts readable and the `source_kind = 'adjustment'` arm that stops a seller
writing a fake 'sale' row. Every DROP is IF EXISTS, so it is safe to run twice.

**Apply order:** independent. Any time, before or after 00686.

**Client-side read risk: NONE.**

**After applying:** no NOTIFY needed - policies are not part of the schema cache.

## ✅ APPLIED: 00686_ledger_rebuild_no_revoke.sql (US-3002, applied 2026-08-29)

> **Owner-confirmed, not read from the database.** The signature of
> `rebuild_ledger_for_user` is unchanged by this migration, so its presence in
> the production OpenAPI document proves nothing either way — a grant is not in
> the schema cache. And the only direct probe, calling the function as `anon`,
> IS the outage this migration exists to remove. So there is deliberately no
> verification here beyond the owner saying it was applied.
>
> **What this closes and what it does not.** It removes THIS instance: the
> `REVOKE` that 00685 left on a PostgREST-exposed function. It does nothing
> about the class — on this Postgres image, any denied `EXECUTE` from `anon` or
> `authenticated` still segfaults the backend and restarts the database, taking
> every other connected session with it. That is [US-2403](prd.json), and the
> host-level defusal (`supautils.hint_roles = ''` in
> `/etc/postgresql-custom/supautils.conf`, then restart Postgres) cannot be done
> from SQL and cannot be carried by any commit in this repo.


⚠ **APPLY THIS ONE FIRST. It removes a live crash vector, it does not add one.**

**Risk if NOT applied: HIGH.** 00685 is already applied and ends with
`REVOKE ALL ON FUNCTION public.rebuild_ledger_for_user(uuid) FROM public`. On
this Postgres image a DENIED function call from `anon` or `authenticated`
segfaults the backend and restarts the whole database (US-2403), and PostgREST
exposes the function at `/rpc/rebuild_ledger_for_user` — confirmed present in the
production OpenAPI document. `anon` is the key that ships in the browser bundle,
so today a database restart is one unauthenticated request away.

It also breaks the feature it was guarding: `rebuild_my_ledger()` is SECURITY
INVOKER, so it needs EXECUTE as the CALLING role. With execute revoked from
public, every authenticated seller pressing rebuild takes the denial path.

**Risk of applying it: LOW.** It restores the default EXECUTE (a grant, never a
denial) and moves the authorization into the function body, where it raises an
ordinary 42501. Tenant isolation is preserved and is now explicit: the service
role may rebuild anyone, a signed-in seller may rebuild only their own.

**Apply order:** any time, and sooner is better. It is independent of the rest of
the ledger epic and safe to apply before the code that ships with it.

**Client-side read risk: NONE.** No column or type changes; a function body and a
grant only.

**After applying:** `NOTIFY pgrst, 'reload schema';` — the signature is unchanged,
so this is belt-and-braces rather than required.

## ✅ APPLIED: 00685_ledger_entries.sql (US-2984, applied 2026-08-29 — owner-confirmed; ledger_entries present in prod PostgREST schema)

**Risk: low to apply, and it writes nothing on its own.** One new table, three
new functions. No existing table, column, policy or function is altered.
`rebuild_ledger_for_user()` only runs when something calls it, and nothing calls
it automatically -- the client calls `rebuild_my_ledger()` the first time a
books screen finds an empty ledger.

**What it does.** Creates `public.ledger_entries` (signed integer cents against
one account, with a natural key that makes re-derivation idempotent) plus
`rebuild_ledger_for_user(uuid)` SECURITY DEFINER, `rebuild_my_ledger()` SECURITY
INVOKER (the only one `authenticated` may execute, and it resolves the owner
from `auth.uid()`), and `ledger_reconciliation(timestamptz)`.

**RLS is deliberately narrow.** SELECT is the owner's own rows. INSERT, UPDATE
and DELETE are confined to `source_kind = 'adjustment'`. A seller who could
hand-author a `sale` entry could inflate the very number their 1099-K
reconciliation is meant to check.

**Verified against real Postgres, not asserted.** Applied to the local stack,
then a six-case fixture (`scripts/fixtures/ledger-invariant.sql`) seeded and
`ledger_reconciliation()` run as the real `authenticated` role:
**variance $0.00, agrees true**, 15 entries, ledger net $127.64 against
finances_dashboard net $127.64. Re-running the rebuild produced 15 entries
again, not 30.

> **Sabotage-verified, and the first attempt failed to fail.** Removing the
> double-count guard from the legacy-shipment join left the invariant GREEN,
> because no sale in the fixture had both a `shipping_cost` and a `shipments`
> row. Added that case; the same sabotage now moves the variance to -$9.85 and
> restoring the guard returns it to $0.00.

**Depends on 00684.** `rebuild_ledger_for_user()` looks accounts up by code and
raises rather than skipping if one is missing, so applying this without 00684
means every rebuild fails loudly. That is the intended failure.

**Apply order.** After 00683 and 00684. Then
`NOTIFY pgrst, 'reload schema';` - one new table and three new RPCs, and
PostgREST will 404 `rebuild_my_ledger` until it reloads.

## ✅ APPLIED: 00684_ledger_accounts.sql (US-2983, applied 2026-08-29 — owner-confirmed; ledger_accounts present in prod PostgREST schema)

**Risk: low.** One new table, one seeded chart of 31 system rows, one new
nullable column on `flipdesk_expenses`, one new IMMUTABLE function. No existing
column, policy, view or index is altered.

**What it does.** Creates `public.ledger_accounts` (the chart of accounts) and
seeds 31 system rows, each carrying the Schedule C part, line number and the
IRS's own wording for that line. Adds
`public.flipdesk_expenses.account_id uuid NULL` and
`public.default_account_for_category(expense_category) -> text`.

**Nothing is backfilled.** `account_id` stays NULL on every existing row and
that is the design: NULL means "use the default for this category", and setting
the column is how a seller OVERRIDES that default. An unset column and a column
set to the default mean different things.

**The seed is an UPSERT, so a wording fix ships as an ordinary migration.**
`ON CONFLICT (code) WHERE user_id IS NULL DO UPDATE` refreshes the labels and
never deletes, so a seller's own sub-accounts survive a re-seed.

**RLS, verified rather than asserted.** A system row is readable by everyone
and writable by nobody. Proven on the local stack inside a transaction as the
real `authenticated` role with a JWT claim set: 31 rows visible, 0 deletable,
0 updatable, a cross-tenant insert blocked, and an attempt to mint a new SYSTEM
row (user_id NULL) blocked. The first attempt at this test was INVALID -
`SET LOCAL ROLE` outside a transaction block is a no-op, so it ran as superuser
and deleted the chart. Re-seeded and redone inside `BEGIN`.

**What breaks if the frontend deploys first.** The expense form and list read
the chart from the bundled TypeScript mirror, not from the database, so the
Schedule C lines still render. The `account_id` column is not read by the
client yet. Low urgency, but apply it with 00683 anyway.

**Apply order.** After 00683. Then `NOTIFY pgrst, 'reload schema';` - one new
table and one new column.

## ✅ APPLIED: 00683_tax_profiles.sql (US-2982, applied 2026-08-29 — owner-confirmed; tax_profiles present in prod PostgREST schema)

**Risk: low.** Two brand-new tables, one new trigger function, no change to any
existing table, column, function, view or policy. Nothing reads either table
unless a seller opens Money -> Tax, and the frontend falls back to hard-coded
defaults when the row is absent.

**What it does.** Creates `public.tax_profiles` (one row per seller: entity
type, accounting method, fiscal year start month, filing state and status,
business start date, a `has_ein` boolean, and other household income in integer
cents) and `public.tax_profile_changes` (append-only history of the three fields
that are IRS elections rather than preferences). Both are RLS-scoped to the
owner. `tax_profile_changes` has a SELECT policy only, so the history is written
by the `record_tax_profile_change()` trigger and cannot be authored by a user.

**The EIN itself is deliberately NOT stored.** The column is a boolean. Nothing
in the app needs the number and holding it would make the row a breach target.

**Verified locally, not asserted.** Applied twice to
`supabase_db_gradethread` (second run clean, so it is idempotent), then four
behaviours proven with a `DO` block: fiscal month 13 rejected, a free-text
state rejected, a second profile for one user rejected, and the audit trigger
recording `accounting_method cash -> accrual` and
`fiscal_year_start_month 1 -> 7`. The test user was deleted afterwards.

**What breaks if the frontend deploys first.** The Tax tab under Money 404s at
the PostgREST layer and `fetchTaxProfile` throws, which the page surfaces as a
load error. `src/pages/finances.tsx` also queries `tax_profiles` now - its
`useQuery` failure is non-fatal there (it falls back to the January default via
`??`), but the query will retry once and log. **So apply this before the push.**

**Apply order.** Nothing before it. After applying:
`NOTIFY pgrst, 'reload schema';` - two new tables, so PostgREST will not serve
them until it reloads.

## ✅ APPLIED: 00682_auto_upright_setting.sql (US-2890)

> **Applied to prod. Confirmed by the owner on 2026-08-28** — not by reading the
> database. That distinction is the same one the 00677 entry makes below, and it
> matters for the same reason: this file is a hand-edited marker and has gone
> stale in both directions, so what is recorded is who said it and when.
>
> It reached origin/main BEFORE that confirmation, which is the wrong order and
> was not caught because `scripts/held-migration-gate.mjs` matched only the word
> **HELD** while this heading said **PENDING**. The gate now matches both, with
> three cases pinning it — including that the word in prose must not arm it,
> since this file's own header is "# PENDING MIGRATIONS".

**Risk: very low.** One INSERT of one row into `public.system_settings`, with
`on conflict (key) do nothing`. No table, column, function, view, policy or
index is touched. Re-running it is a no-op, verified locally.

**What it does.** Registers `measure.auto_upright_enabled` in the settings
registry (00207 + 00208), seeded **false**, category `flipdesk`, value_type
`bool`.

**Why it exists at all, given the code does not need it.** `getSetting()`
returns its fallback for an absent key and the fallback here is `false`, so the
feature is already off with or without this row. What the row buys is the
switch appearing in the admin settings editor, which is the difference between
a flag an operator can find and one they have to be told about.

**What breaks if the edge or the frontend deploys first.** Nothing. The feature
reads the key through `getSetting()` and an absent key is `false`, which is
also the seeded value — so the behaviour before and after applying this is
identical until a human turns it on. This is the rare migration whose apply
order genuinely does not matter.

**Watch the value_type.** `system_settings_value_type_check` allows exactly
`number | bool | string | json`. The first draft of this file said
`'boolean'` and was rejected at insert; that is caught here only because the
migration was applied to the local stack rather than reasoned about.

**Apply order.** Anywhere after 00681. Run `NOTIFY pgrst, 'reload schema';`
afterwards out of habit, though strictly nothing about the schema changed.

## ✅ APPLIED: 00678_listing_description_blocks.sql (US-2956)

> **Applied to prod. Confirmed by the owner on 2026-08-28** — not by reading the
> database. That distinction is the same one the 00677 entry makes below, and it
> matters for the same reason: this file is a hand-edited marker and has gone
> stale in both directions, so what is recorded is who said it and when.
>
> It reached origin/main BEFORE that confirmation, which is the wrong order and
> was not caught because `scripts/held-migration-gate.mjs` matched only the word
> **HELD** while this heading said **PENDING**. The gate now matches both, with
> three cases pinning it — including that the word in prose must not arm it,
> since this file's own header is "# PENDING MIGRATIONS".

**Risk: low.** One nullable column and one new table. Nothing existing is
altered, nothing is backfilled, no function or view is replaced.

**What it does.** Adds `listings.description_blocks jsonb` (nullable, no
default) and creates `public.listing_snippets` (id, user_id, name, body,
sort_order, timestamps) with one index, an `updated_at` trigger, RLS on, and
four own-row policies. It references `public.users` and nothing else.

**Why it exists.** The listing description is one opaque string, so a fact can
sit in the AI prose, the measurements block and the facts block at once, and
only the last two update. `description_blocks` becomes the ordered list the
description is rendered from; `listing_description` stays as the render output
because full-text search (00016), fuzzy search history (00248) and return
attribution (00655) all read that column.

**What breaks if the edge or the frontend deploys first.** Nothing, at this
commit. No code reads either object yet — the renderer is US-2957 and the
routes are US-2958. `description_blocks` being NULL is a designed state that
means "legacy string, parse on open", so even after the reading code ships, an
unapplied migration degrades to today's behaviour rather than an error.

**Apply order.** Anywhere after 00677. Run
`NOTIFY pgrst, 'reload schema';` afterwards — a new table and a new column both
need it, or PostgREST will 404 the settings page in US-2961.

## ✅ APPLIED: 00677_marketplace_promotions.sql (US-2949)

**Applied to prod. Confirmed by the owner on 2026-08-27 — NOT by reading the
database.** That distinction is the whole point of the 00674 entry further
down: a marker maintained by hand is not evidence, and this one has gone stale
in both directions before. There is no service-role credential on the dev box,
so the read could not be run here. Settle it in one command when you next have
the env:

```
deno run --allow-net --allow-env \
  services/edge-functions/scripts/check-prod-migration.ts 00676 00677
```

It is read-only, and it checks the self-record footer rather than the schema —
so a row means every statement in the file ran, not just the ones that created
a column PostgREST would show.

**What it does.** Creates `public.marketplace_promotions` — one row per
marketplace promotion (markdown sale, coupon, volume discount) plus the result
eBay reports for it. One index, an `updated_at` trigger, RLS on with a single
own-rows SELECT policy. New table only; nothing existing is altered. It
references `public.users` and nothing else.

**Why it exists.** Promotions were created through FlipDesk and never looked at
again: the card re-fetched them from eBay on every open, and nothing measured
whether a sale sold more. `reported_units` / `reported_revenue_cents` stay NULL
until a report exists, which is the normal state for a promotion that has not
run yet.

**What breaks if the edge deploys first.** Nothing user-visible, and nothing
silent. `loadPromotions` and `recordPromotions` each log a PostgREST error and
return empty/0. Concretely:

- "Did your sales sell more?" shows its empty state and the Refresh button
  reports 0 stored.
- The stack check still runs — it reads `listings`, which is unaffected — but
  finds no active markdown or coupon percentage, so it checks the auto-accept
  and shipping only. That UNDER-reports; it does not report a false breach.
- The hourly markdown rule finds no existing promotion by name and would create
  one per run. **That is the one real risk, and it is why this must be applied
  before a markdown_schedule rule is enabled** — no rule of that type can exist
  yet, since the trigger ships in this same commit.

**Apply order (done).** 00676 then 00677, then `NOTIFY pgrst, 'reload schema';`
for the two new tables. If "Did your sales sell more?" stays empty after the
edge redeploys and Refresh reports 0 stored, that reload is the first thing to
check.

## ✅ APPLIED: 00676_marketplace_offers.sql (US-2939)

**Applied to prod. Confirmed by the owner on 2026-08-27 — NOT by reading the
database.** That distinction is the whole point of the 00674 entry further
down: a marker maintained by hand is not evidence, and this one has gone stale
in both directions before. There is no service-role credential on the dev box,
so the read could not be run here. Settle it in one command when you next have
the env:

```
deno run --allow-net --allow-env \
  services/edge-functions/scripts/check-prod-migration.ts 00676 00677
```

It is read-only, and it checks the self-record footer rather than the schema —
so a row means every statement in the file ran, not just the ones that created
a column PostgREST would show.

**What it does.** Creates `public.marketplace_offers` — one row per marketplace
offer in either direction (`received` from a buyer, `counter_sent` by the
seller, `offer_sent` to interested buyers). Three partial indexes, an
`updated_at` trigger, RLS on with a single own-rows SELECT policy. New table
only; nothing existing is altered. It references `public.users`,
`public.inventory_items`, `public.listings` and
`public.flipdesk_automation_rules`, all of which exist.

**Why it exists.** Best offers were fetched live and never stored, so counter
history, buyer memory, the discount-conversion curve and the send-offer cooldown
were all impossible. `list_price_cents` is snapshotted with the offer so a later
reprice cannot rewrite what a past discount was worth.

**What breaks if the edge deploys first.** Nothing user-visible, and nothing
silent. Every writer logs a PostgREST error and returns 0 (`recordOffers`,
`recordOfferResponse`); every reader logs and returns an empty list
(`loadOffers`, `loadBuyerHistory`, `loadListPricesByItemId` reads `listings`,
which is unaffected). Concretely:

- The Offers page renders exactly as it did before, minus the new margin/buyer
  history lines — `buyerHistory` comes back null and the row omits it.
- "What your discounts convert at" shows its empty state.
- "Watchers worth an offer" shows every eligible item with no cooldown applied,
  because there is no send history to read.
- The offer-rule dry run reports 0 offers considered, and says so in words.

**Apply order (done).** 00675, then this. `NOTIFY pgrst, 'reload schema';` is
required for a new table — if the Offers page shows no buyer history and no
margin after the edge redeploys, that reload is the first thing to check.

## ✅ APPLIED: 00675_marketplace_post_sale_cases.sql (US-2927)

**Applied to prod. The user confirmed the apply on 2026-08-26 while the story
was being written.** Verify rather than trust this line: `deno run --allow-net
--allow-env --allow-read services/edge-functions/scripts/check-prod-migration.ts`
is a read and settles it in either direction.

**What it does.** Creates `public.marketplace_post_sale_cases` — one row per
post-sale case a marketplace opens against a seller (return, cancellation,
payment dispute, and the two US-2928/US-2929 will fill: inquiry and MBG case).
Three partial indexes, an `updated_at` trigger, RLS on with a single
own-rows SELECT policy. New table only; nothing existing is altered.

**Why it exists.** Every return, cancellation and dispute was a LIVE eBay fetch
on page load. So the page cost call quota each time it opened, nothing survived
eBay's retention window, and no deadline, history or analytic could exist
because there was nothing to read.

**What breaks if the edge deploys first.** Nothing user-visible.
`loadCachedSummaries` logs a PostgREST error and returns `{ items: [], fresh:
false }`, so the three list routes fall straight through to the live eBay call
they already made — the pre-US-2927 behaviour exactly. `recordPostSaleCases`
logs and returns 0. The frontend reads no new column.

## ✅ APPLIED: 00674_brand_size_charts_measurement_basis.sql (US-2917)

**Applied to prod. Confirmed 2026-08-26 by reading the database**, not by
reading this file. `public.applied_migrations` holds a row for `00674`, and
since the self-record footer is the LAST statement in the migration, that row
means the ADD COLUMN, the CHECK constraint and the comment all ran.

**This heading said HELD and BLOCKING for longer than it was true**, while the
commit was already on origin/main and prod already had the column. That is the
opposite of the failure `scripts/held-migration-gate.mjs` was built to catch,
and it is just as expensive: the gate blocked every push, the session-start
hook warned on every session, and two story notes told the next reader the
branch was frozen. A marker maintained by hand is not evidence about a
database. Check with `deno run --allow-net --allow-env --allow-read
services/edge-functions/scripts/check-prod-migration.ts` (read-only, needs
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`) before trusting a heading here
in either direction.

**What it does.** One `ADD COLUMN IF NOT EXISTS measurement_basis text NOT NULL
DEFAULT 'body'` on `public.brand_size_charts`, plus a guarded CHECK constraint
limiting it to `body` or `flat`, plus a column comment. No data change: every
row that exists today holds body measurements, which is what the default says.

**Why it exists.** The US-2916 size checker converts a chart's body
measurements into expected flat-lay ranges by adding garment ease and halving
the circumference. A brand that publishes garment-FLAT specs would get ease
added on top of ease, and every correctly sized item on that brand would be
flagged. The column lets that case be recorded honestly instead of worked
around by editing the numbers.

**What breaks if the edge deploys first.**
`services/edge-functions/src/lib/brand-knowledge.ts` now SELECTs `source_url,
verified, measurement_basis` from `brand_size_charts`. Against a database
without the column PostgREST returns an error for that one query, which the
resolver already catches — size charts silently fall back to the in-code seed
and every chart reads as tier `brand`/`generic` instead of `verified`. Degraded,
not broken, and it logs the existing `[BrandKnowledge] … IN-CODE fallback`
warning. Nothing 500s and no frontend page breaks.

**Frontend read of the new column: NONE.** The SPA never touches
`brand_size_charts` directly; it reads `GET /api/flipdesk/size-bands`, which
returns `measurementBasis` computed server-side and defaulting to `body`.

**Risk: LOW.** Idempotent, additive, no backfill, no lock beyond a brief
ACCESS EXCLUSIVE for the ADD COLUMN (the table has a few hundred rows).

**Apply order.** 00674 alone. Then `NOTIFY pgrst, 'reload schema';` — PostgREST
caches the column list, and without the reload the new SELECT keeps failing
against a database that already has the column.

---

## APPLIED: 00673 — take SECURITY DEFINER off ensure_sourcer (US-2886)

**Applied to prod by the owner on 2026-08-25**, after 00672 and before the push.

**The problem it fixes.** 00672 shipped `public.ensure_sourcer()` as SECURITY
DEFINER, copying the trigger functions next to it. On a Supabase stack a
callable SECURITY DEFINER function that says nothing about who may execute it
inherits DIRECT grants to `anon` and `authenticated` from Supabase's own
`ALTER DEFAULT PRIVILEGES` bootstrap — so any signed-in session could POST to
it and write a roster row into ANOTHER workspace, because the definer context
bypasses the RLS on `public.sourcers` that is the only thing scoping that
insert. `src/test/security-definer-grants.test.ts` (US-2282) caught it.

**What it does.** No DDL on tables. One `DROP FUNCTION IF EXISTS` plus a
`CREATE OR REPLACE` of the same body without the definer flag. The two triggers
from 00672 are untouched: a trigger function's EXECUTE is never consulted, and a
SECURITY INVOKER function called from inside a definer trigger still runs as the
definer, so the roster keeps filling itself.

**Why not just GRANT it to service_role.** That satisfies the guard and leaves
the hole. The default grants are direct, so only a REVOKE removes them, and a
REVOKE on a public function is the US-2403 segfault. Removing the flag is the
fix that actually closes it.

**Risk: LOW.** Idempotent. Dropping a function that PL/pgSQL triggers call by
name is safe — the name resolves at runtime, so there is no dependency error and
no window where the triggers break.

**Apply order.** After 00672. `EXPECTED_SCHEMA_VERSION` is bumped to `00673`.
No `NOTIFY pgrst` needed — a function's security flag changed, not a column.


## APPLIED: 00672 — sourcers roster (US-2886)

**Applied to prod by the owner on 2026-08-25**, before the push. The
`SELECT public.ensure_sourcer(...)` backfill returned 28 empty rows, which is
what a `void` function returning one row per account looks like — not an error.

**What it does.** New `public.sourcers` table (workspace roster of people who
source inventory), RLS mirroring `public.sources` (viewer+ read,
listing_manager+ write), two helper functions and two AFTER INSERT triggers so a
new account gets itself and a new workspace member gets added to the owner's
roster. Backfills every distinct `inventory_items.sourced_by` name first, then
links the user rows onto them.

**`inventory_items.sourced_by` is unchanged and still text.** The roster only
decides what the picker OFFERS. iOS, Android, the CSV importer and the Sheets
projection keep reading and writing the same name string.

**Risk: LOW.** Additive DDL, idempotent, no REVOKE. The triggers wrap their work
in `EXCEPTION WHEN OTHERS THEN NULL` so roster bookkeeping can never fail a
signup or an invite acceptance.

**`NOTIFY pgrst` not needed** — verified by reading the prod PostgREST OpenAPI
doc with the anon key on 2026-08-25: `/sourcers` is already an exposed path.

**Frontend dependency.** The web picker reads `sourcers` straight from the
browser, so the push had to come after this. It did.

## ✅ APPLIED: 00671 — unfreeze the eight columns 00668/00669 added (US-2852, US-2853)

**Applied to prod by the owner, confirmed 2026-08-25.** Taken on the owner's
word rather than measured: this migration only replaces a function BODY, so
there is no table or column to probe for, and `applied_migrations` answers
`42501 permission denied` to the anon key. The check that would settle it is
`src/test/users-self-update-allowlist.test.ts` against prod, or reading
`guard_users_protected_columns()` with the service role.

**The problem it fixes.** 00526 made `public.users` self-updates DENY-BY-DEFAULT:
an authenticated session may write only the columns the guard function
enumerates, and everything added since is refused. 00668's seven listing defaults
and 00669's `notification_quiet_hours` are settings-screen controls written
straight from the browser, and all eight were frozen the moment they were
created. Both new settings cards save cleanly in every test and raise on the
first real user. `src/test/users-self-update-allowlist.test.ts` is what caught
it — it reads the allowlist out of the migration rather than a copy.

**What it does.** No DDL. One `CREATE OR REPLACE` restating
`guard_users_protected_columns()` — 00567's body plus the eight new names and
nothing else. Removals stay removed: `business_phone` and `ship_from_address`
are still absent (edge-encrypted, service-role only).

**Risk: LOW, but the ORDER matters.** Idempotent by `CREATE OR REPLACE`.
Pushing before this is applied auto-deploys two settings cards whose Save button
raises. The value guards are CHECK constraints on the columns themselves
(00668/00669), so being on the allowlist buys the ability to set a legal value,
not an arbitrary one.

**Apply order.** After 00670. `EXPECTED_SCHEMA_VERSION` is bumped to `00671`.
No `NOTIFY pgrst` needed — a function body changed, not a column.

## ✅ APPLIED: 00670 — outgoing-email kill switches (US-2854)

**Applied to prod by the owner on 2026-08-24.**

**What it does.** One `system_settings` row, `email_categories_disabled`, seeded
as an empty json array. Read through `getSetting()`, so switching a category off
lands on the next send rather than the next deploy.

**Risk: LOW.** Seeds empty, so applying it changes nothing until somebody flips a
switch. `ON CONFLICT DO NOTHING`, so a re-run never clobbers a live list. No
REVOKE — `system_settings` is already RLS-enabled with no client policies from
00207, so it stays service-role only by inheritance.

**Enforcement is in code, not in the row.** Auth codes, receipts and
payment-failure emails are refused by `PROTECTED_CATEGORIES` in
`lib/email-kill-switch.ts`, both when the list is written and again when it is
read — a row edited by hand in this table still cannot suppress one.

**Client-side reads: NONE.** The admin page goes through
`/api/admin/settings/email-categories` (super_admin + MFA step-up).


## ✅ APPLIED: 00668 + 00669 — seller listing defaults and quiet hours (US-2852, US-2853)

**Applied to prod by the owner on 2026-08-24, before the push.**

**00668 — what it does.** Seven additive columns on `public.users`
(`default_listing_format`, `default_auction_duration`, `default_best_offer_enabled`,
`default_best_offer_on_auction`, `default_best_offer_accept_pct`,
`default_best_offer_decline_pct`, `default_listing_quantity`) plus four CHECK
constraints. They seed a NEW composer draft and never touch a saved listing.

**00669 — what it does.** One additive jsonb column `users.notification_quiet_hours`
plus one CHECK constraint. Mutes PUSH inside the stored window; the in-app row and
any email are unaffected.

**Risk: LOW.** Nothing is altered, dropped or revoked. Every new column is
nullable or `NOT NULL DEFAULT false`, so existing rows keep exactly their current
behaviour: no seller has a listing default, and no account has quiet hours.

**Client-side reads: YES, and that is the half a bare push would have broken.** The
frontend reads all eight columns directly through supabase-js
(`use-seller-listing-defaults.ts`, `quiet-hours-card.tsx`), so the SQL had to land
before Cloudflare Pages auto-deployed. It did.

**`NOTIFY pgrst, 'reload schema';` is required** — PostgREST caches the column list,
and a client SELECT naming a column it has not reloaded returns a 400, not a null.

`EXPECTED_SCHEMA_VERSION` is bumped to `00669` in the same commit.



## ✅ APPLIED: 00667 — the comp read queue, and the budget that switches it off (US-2845)

**Applied to prod by the owner, confirmed 2026-08-25.** Also taken on the
owner's word. The three tables it adds are deny-all operator tables, so they
are absent from the PostgREST OpenAPI doc whether or not they exist — a
MISSING path proves nothing here, only a PRESENT one would. The worker stays
inert either way: the `comp_read` feature flag ships disabled.

**What it does.** Three new operator tables (`comp_read_demand`,
`comp_read_batches`, `comp_read_jobs`), one SECURITY INVOKER function
(`comp_read_demand_touch`), one `feature_flags` row and one `ai_budgets` row.

**Risk: LOW, and the worker is INERT on arrival.** The `comp_read` feature flag
ships **disabled**, because the US-2842 calibration spike has not returned a GO.
The cron answers `{ok:true, skipped:true}` until somebody turns it on by hand.
Nothing existing is altered or dropped.

**The budget.** `comp_read` / `day` / **$5.00** / action `kill`, enabled. Action
`kill` flips the `comp_read` flag off, so the gate and the guardrail are the same
switch. $5 is deliberately small: the first real dollars-per-read number comes
from the spike, and a ceiling set before the cost is measured should be one you
would not mind hitting. Raise it in the admin AI budgets page once you have the
number.

**Apply order.** After 00666. Depends on `feature_flags` (00096), `ai_budgets`
(00219) and `applied_migrations`.

**Client-side reads: NONE.** No frontend code touches any of it.
`EXPECTED_SCHEMA_VERSION` is bumped to `00667` in the same commit.

**Proven by execution, not by reading the SQL.** Applied four times against a
throwaway Postgres 16, then:

- the flag lands `enabled = false`, and re-running does not re-enable it
- exactly ONE `comp_read` budget row exists after repeated runs
- a bogus `status` raises the CHECK on both the batch and the job table
- the atomic claim works: two racing `where status='pending'` updates report
  `UPDATE 1` then `UPDATE 0`
- `comp_read_demand_touch` increments (1 → 2 → 3 across three calls) and its
  `coalesce` keeps a brand an earlier call supplied when a later one passes null
- all three tables: RLS on, zero policies, `anon` has no select

**On the function's security mode, which changed during the work.** It was
written SECURITY DEFINER and `security-definer-grants.test.ts` caught that: a
DEFINER function with no grant is callable by anon and authenticated through
PostgREST with RLS bypassed, so anyone with the public key could have inflated a
cell's demand count and steered where the AI budget is spent. It is INVOKER now.
The obvious fix, a REVOKE from anon/authenticated, is the exact shape US-2403
parked 00527 for: on the Supabase image, denying a FUNCTION to a supautils hint
role segfaults the backend. INVOKER needs no revoke. Proven both ways on the
throwaway stack: `service_role` (with BYPASSRLS, as in real Supabase) calls it
and the count increments; `anon` gets a clean `permission denied for table`,
which is the TABLE denial path, not the crashing function one.

**After applying:** `NOTIFY pgrst, 'reload schema';` — new tables and a new
function.

**Also register two Coolify scheduled tasks** (see COOLIFY.md, regenerated):
`comp-read` at `25 * * * *` and `comp-read-reclaim` at `*/10 * * * *`. Register
them even though the worker is off: the reclaim job drains a queue a disabled
worker left behind, and a queue with no self-healing cron is the failure the
durable-jobs contract exists to prevent.


## ✅ APPLIED: 00666 — flipdesk_settings.sourcing_target_roi_pct (US-2851)

**Applied to prod, VERIFIED 2026-08-25.** The one of the three that could be
checked without credentials: `sourcing_target_roi_pct` is present on the
`flipdesk_settings` definition in the prod PostgREST OpenAPI doc, read with
the anon key.

**What it does.** Adds one nullable integer column to
`public.flipdesk_settings`, plus a CHECK bounding it to 0..1000. It is the
target return on cost a seller sources to, in whole percent, and it is what
sizes Scout's "don't pay more than" ceiling.

**Why a new column and not an existing setting.** There wasn't one. The
autolister's "floor at % margin" is typed fresh into a bulk action and never
stored; `automation_rules.margin_floor_pct` is a per-rule offer threshold, not a
sourcing goal. US-2851's AC asked for "the existing workspace setting" and no
such setting existed, so this creates it rather than inventing a multiplier.

**Risk: LOW.** Additive, nullable, no backfill. NULL means "use the product
default", which is `DECISION_MAYBE_ROI` in `lib/scout-decision.ts` (30%), the
same threshold that already decides whether Scout calls an item a maybe.
Defaulting in the column would have frozen today's number into every existing
row and split the two apart the first time one of them moved.

**Apply order.** After 00665. It depends on nothing but `flipdesk_settings`
(00134/00145) and `applied_migrations`.

**⚠ CLIENT-SIDE READ, so this one DOES break on a Pages deploy before the SQL.**
`src/components/flipdesk/sourcing-target-setting.tsx` selects and upserts
`sourcing_target_roi_pct` directly through the browser Supabase client under
RLS. Until the column exists and PostgREST has reloaded, that control errors
(the page still renders; the toast says the save failed). The edge side is
covered by the boot guard: `EXPECTED_SCHEMA_VERSION` is bumped to `00666` in the
same commit.

**Proven by execution, not by reading the SQL.** Applied twice in a row against
a throwaway Postgres 16 with a stand-in `flipdesk_settings`, then:

- an existing row keeps a NULL target and is untouched
- `30` and `0` both save; zero is a real, if aggressive, choice
- `-5` raises `flipdesk_settings_sourcing_roi_range` (a negative target is a
  ceiling ABOVE breakeven)
- `3000` raises the same constraint (a typo there would set a ceiling near zero
  and silently tell the seller every item is a skip)
- the column is `integer`, nullable, and `00666` is in `applied_migrations`

**After applying:** `NOTIFY pgrst, 'reload schema';` — a new column, and the
browser client reads it through PostgREST.


## ✅ APPLIED 2026-08-24: 00665 — condition_value_shadow_samples, the live-vs-measured record (US-2848)

**What it does.** Creates one new table,
`public.condition_value_shadow_samples`. One row every time `valueAtGrade`
produced both answers for a market cell: the live conditionId-filtered median
that shipped, the measured-curve median that did not, and the difference. Two
CHECK constraints, two indexes, RLS on with zero policies.

**Risk: LOW.** Additive only. Nothing existing is altered or dropped. The write
path is bounded by the thing it measures: nothing is written for a cell with no
`provenance = 'measured'` curve, and no cell has one until the US-2845 worker
fits one, so the table stays empty on day one.

**Apply order.** After 00664. It depends on nothing but `applied_migrations`.

**Client-side reads: NONE.** No frontend code touches this table. The only
reader is `GET /api/admin/condition-index/shadow-deltas`, which is behind the
admin gate on the edge, and the edge boot guard covers that side:
`EXPECTED_SCHEMA_VERSION` is bumped to `00665` in the same commit.

**Proven by execution, not by reading the SQL.** Applied twice in a row against
a throwaway Postgres 16 (the second run is all no-ops and NOTICEs), then:

- a `delta_cents` with only one side present raises
  `condition_value_shadow_samples_delta_needs_both`
- `grade = 0.5` raises `condition_value_shadow_samples_grade_range`
- a null grade inserts, which is required: `valueAtGrade` is called with a null
  grade on the ungraded paths
- `relrowsecurity` is true with 0 policies; `anon` and `authenticated` have no
  select privilege
- the self-record footer put `00665` in `applied_migrations`

**On the coalesce trap.** Neither CHECK can evaluate to NULL: both branches use
`is null` / `is not null`, which always return true or false. That is the 00663
lesson applied rather than restated, and the executions above are what confirm
it.

**After applying:** `NOTIFY pgrst, 'reload schema';` — a new table changed the
schema, and PostgREST will not see it otherwise.

**Applied on the founder's word 2026-08-24, not on a read of prod.**


## ✅ APPLIED 2026-08-24: 00664 — condition_price_curves says where its numbers came from (US-2847)

**What it does.** Adds four columns to `public.condition_price_curves`:
`provenance` (`seeded` default, or `measured`), `slope_cents_per_point`,
`fit_confidence` and `measured_at`. Plus two CHECK constraints and one index.

**Risk: LOW.** Additive. Every existing row keeps describing itself correctly
with no backfill, because the default is the thing they all already are.

**Proven on the local stack by execution, not by reading the SQL.** Applied
twice in a row cleanly (the second run is all no-ops and NOTICEs), and then:

- a `measured` row with no `slope_cents_per_point` raises
  `condition_price_curves_measured_has_fit`
- `provenance = 'bogus'` raises `condition_price_curves_provenance_chk`
- the seeded-write guard behaves: against a measured row the conditional update
  reports `UPDATE 0` and the curve is untouched; against a seeded row it reports
  `UPDATE 1` and refreshes

**Why the guard matters.** `condition-index-seedgen.ts` and `refreshIndexSeed`
both used a plain upsert on `item_key`. Once a cell is measured from real comp
reads, the next seedgen run would have silently replaced those points with
generated ones. Both now go through `persistSeededCurve`, which inserts if the
key is free and then updates only while the row is still seeded.

**After applying:** `NOTIFY pgrst, 'reload schema';` — new columns.


## ✅ APPLIED 2026-08-24: 00663 — comp_condition_reads, the comp condition sample store (US-2844)

> Marked applied on the founder's word, not on a read of prod. Everything below
> is the original pending entry, unchanged.

**What it does.** Creates one new table, `public.comp_condition_reads`. One row
per comp listing we read for condition, keyed by a SHA-256 hash of the
listing's sorted photo hashes so the same listing is never paid for twice. It
carries a cell key, a 1.0-10.0 score, a confidence, an image count, an asking
price, a stock-rejection flag and its reasons. It carries no seller, no listing
id, no URL, no title and no image bytes, by design and by test.

**Risk: LOW.** Additive only. One CREATE TABLE, two indexes, RLS enabled with
zero policies and a REVOKE from anon and authenticated, matching
`condition_price_curves` in 00098. Nothing existing is altered or dropped, and
nothing reads the table yet — the worker that writes it is US-2845 and is gated
on the US-2842 spike.

**Apply order.** After 00662. It depends on nothing but `applied_migrations`.

**Client-side reads: NONE.** No frontend code touches this table, so a
Cloudflare Pages deploy landing before the SQL is applied changes nothing a
user can see. The edge boot guard handles the edge side: `EXPECTED_SCHEMA_VERSION`
is bumped to `00663` in the same commit.

**After applying:** `NOTIFY pgrst, 'reload schema';` — a new table changed the
schema, and PostgREST will not see it otherwise.

**verify:db: RUN AND GREEN.** All 5 checks passed, including
`supabase db reset --no-seed`, which re-applies every migration from zero. Then
proven directly against the local Postgres rather than inferred from the lane:
the table has 11 columns, RLS is on with zero policies, `applied_migrations`
carries `00663` from the self-record footer, a duplicate `photo_set_hash`
insert is `INSERT 0 0` and leaves the first row untouched, and all three CHECK
constraints raise.

**One defect was found this way and fixed before the commit.** The
`rejected_has_reason` CHECK was written as `array_length(stock_reasons, 1) >= 1`
and was INERT: `array_length('{}', 1)` is NULL, not 0, and a CHECK evaluating to
NULL passes. A rejected read with no reason inserted cleanly. It now reads
`coalesce(array_length(stock_reasons, 1), 0) >= 1`, re-proven after a full reset.
00663 was amended in place because it had never been committed, pushed, or
applied to prod.


## ✅ APPLIED 2026-08-23: 00662 — flipdesk_price_gap takes p_user_id, so a job can ask on a seller's behalf (US-2828)

**CONFIRMED FROM PRODUCTION, not from the fact of the apply.** Two independent
read-only checks:

1. The live PostgREST OpenAPI document at `api.gradethread.com/rest/v1/` lists
   `/rpc/flipdesk_price_gap` with args `['p_period_start', 'p_user_id']` -
   **one** path, so the DROP took the old signature with it and there is no
   stale overload. PostgREST only advertises what its schema cache holds, so
   this also proves the `NOTIFY pgrst` landed.
2. `/health/ready` reports schema `{expected: 00661, applied: 00662,
   status: "ahead"}`. **Ahead is the correct state right now** and not a
   problem: the deployed edge still runs the build that expects 00661. The boot
   guard refuses only a database that is BEHIND. It reads `match` once the push
   redeploys the edge - which is the documented order, migration first.

**Risk: LOW, and the behaviour change is additive.** One function, rewritten
with one extra defaulted parameter. Every existing browser call is unchanged:
`flipdesk_price_gap(p_period_start)` still resolves, still reads the signed-in
seller, still returns the same figures.

**What it fixes.** The function scored the CALLER's items by reading
`auth.uid()` in three places. The edge holds the service-role client, where
`auth.uid()` is NULL, so calling it from a job returned an empty result for
every seller — silently, with a 200. That is what has blocked US-2828's weekly
digest and US-2829 AC2.

**The safety property, PROVEN BY EXECUTION on the local stack** (not reasoned
about — this is the migration US-2828's notes said must not ship on a parse-tree
assertion):

| caller | `p_user_id` | reads |
|---|---|---|
| service_role | B | **B's rows** — the point of the change |
| authenticated (A) | B | **A's rows** — cannot reach B |
| authenticated (B) | A | **B's own rows** — the argument is ignored, not refused |
| service_role | none | nothing — today's behaviour, unchanged |

The argument is ignored rather than rejected for a non-service_role caller, so
there is no error to probe and it cannot be used as an oracle either.

| Object | What | Risk |
|---|---|---|
| `public.flipdesk_price_gap(date)` | dropped | LOW — replaced in the same transaction |
| `public.flipdesk_price_gap(date, uuid)` | created | LOW — superset of the old signature |
| grants to `authenticated`, `service_role` | re-issued | **REQUIRED, see below** |

**⚠️ THE RE-ISSUED GRANTS ARE NOT BOILERPLATE.** Dropping a function destroys
its grants, and the fresh create hands `EXECUTE` back to PUBLIC by the CREATE
default and nothing else. Measured on the local stack:
`CREATE OR REPLACE` preserves a prior REVOKE; `DROP` + `CREATE` loses it. So
00652's two grants are restored explicitly. **No REVOKE anywhere in this file** —
a denied call from anon or authenticated segfaults this Postgres image
(US-2403); `gt_require_role` in the body is what replaces it, exactly as 00652
had it.

**Why the DROP is unavoidable.** Adding a defaulted parameter creates a SECOND
overload rather than replacing the first, and PostgREST would then find two
candidates for a one-argument call and fail it as ambiguous. The create still
says `OR REPLACE` so the file survives a second run (US-2837) — verified,
applied twice, exit 0 both times, exactly one signature left.

**Apply order:** anywhere after 00652. `NOTIFY pgrst, 'reload schema';`
afterwards — the signature changed, so PostgREST's cache must be told or the
browser's existing one-argument call will 404 against a stale entry.

**Nothing in the same commit reads it from the client.** The web caller in
`src/lib/price-gap.ts` passes only `p_period_start` and is untouched. The edge
caller that motivated this is NOT in this commit — it is the next step on
US-2828, and `src/test/edge-never-calls-caller-scoped-rpc.test.ts` now fails
the build if one is added to a function that has NOT had this treatment.


## ✅ APPLIED 2026-08-23: 00661 — drop inventory_distinct_brands and its index (US-2814)

**CONFIRMED, not assumed.** `/health/ready` reports schema
`{expected: 00661, applied: 00661, status: match}`, and `inventory_distinct_brands`
is GONE from prod's live PostgREST schema document - zero occurrences, where it
had 3 before. That second read is the conclusive one: PostgREST only advertises
what its schema cache holds, so the function is dropped AND the cache reloaded.

**Risk: LOW, and NOT applying it has an ongoing cost.** One function and one
index, both dead. `public.inventory_distinct_brands()` (00482) was written for
the Inventory brand dropdown; US-958 rewrote that page into a lazy view router
and the dropdown went with it. Nothing has called the function since - not a
client, not an edge route, not another SQL function - while
`idx_inventory_items_user_brand` has been maintained on **every** inventory_items
insert and every brand update to serve a DISTINCT scan nobody runs.

| Object | What | Risk |
|---|---|---|
| `public.inventory_distinct_brands()` | dropped | LOW - zero callers, verified |
| `idx_inventory_items_user_brand` | dropped | LOW - exists only for that function |

**DROP, not REVOKE, and the difference matters here.** A REVOKE on a function
`anon` or `authenticated` can still reach segfaults this Postgres (US-2403),
which is why no new migration in this repo revokes. Dropping removes the
function outright: a call would answer `42883 function does not exist`, an
ordinary error, and there is no caller to make one.

**No `NOTIFY pgrst` strictly needed** - nothing reads it - but send one anyway so
the schema cache stops advertising a function that is gone.

**Owner decided this on 2026-08-23**, choosing drop over keeping it unwired. The
reasoning survives if it is ever wanted back: 00482's header explains why
PostgREST cannot express DISTINCT, and US-2814's notes carry the rest, so
re-adding it is a small migration rather than a rediscovery.

**Nothing in the same commit reads it from the client.** Nothing read it before.


## ✅ APPLIED 2026-08-23: 00660 — ensure listings.draft_id has a durable record (US-2832)

**CONFIRMED.** Schema version reads 00661, which is past this one, and
`listings.draft_id` is still present in the live PostgREST schema - which is
exactly right, since this migration is a no-op wherever the column already
exists. Its whole deliverable is the `applied_migrations` row, and the boot
guard reporting `match` at 00661 with no `missing` key is that row being read.

**Risk: NONE on this production, and that is the point.** Production already has
`listings.draft_id` (repaired by hand 2026-08-20, re-confirmed 2026-08-23 by
reading the live PostgREST schema). Both statements are `IF NOT EXISTS` forms,
so applying this is a no-op against the data and the schema. The only thing it
changes is that `applied_migrations` gains a `00660` row.

| Object | What | Risk |
|---|---|---|
| `public.listings.draft_id` | re-assert the column from 00134 | NONE (already present) |
| `idx_listings_draft_id` | re-assert the partial index from 00134 | NONE (already present) |

**Why it exists.** 00134 is pre-footer-era, so the boot guard never checked it,
and production turned out to have its trigger and policies but not this column.
The missing half was pasted from this file, leaving the repair recorded nowhere
in the database. A restored backup, a staging stack or a new region would
silently lack the column again, and the only symptom is that every extension
cross-listing writeback fails with PGRST204.

**No `NOTIFY pgrst` needed on the current production**, because the column is
already in the schema cache. Send it anyway on any environment where this
migration actually adds the column.

**Nothing in the same commit reads anything new from the client.** The column
has been readable for days; this only records how it got there.

## ✅ APPLIED 2026-08-23: 00659 — seller digest ledger + opt-out (US-2828)

Owner applied it (with the rest of the outstanding set) on 2026-08-23, and it
was CONFIRMED here rather than taken on trust: prod's live PostgREST schema
document at api.gradethread.com/rest/v1/ names `seller_digest_log` and
`seller_digest_opt_out`. That is a read-only probe and it answers two questions
at once, because PostgREST only advertises what its schema cache holds, so the
`NOTIFY pgrst, 'reload schema'` below happened too.

The caveat below about never having been run against a Postgres is now moot for
this migration. It is left in place because the reason it existed is still true
of the dev box, and the next held migration inherits the same gap.

One table and one column, both additive. Nothing existing changes shape or
behaviour; no REVOKE anywhere (US-2403).

| Object | What | Risk |
|---|---|---|
| `public.seller_digest_log` | new table: one row per seller per weekly digest period | LOW |
| `public.users.seller_digest_opt_out` | new `boolean NOT NULL DEFAULT false` column | LOW |

**Apply, then `NOTIFY pgrst, 'reload schema';`** — the table and the column are
both reached by name through PostgREST, so without the reload a read of either
404s rather than answering.

**⚠ THIS ONE HAS NOT BEEN RUN AGAINST A POSTGRES, and that is unusual for this
file.** Docker Desktop's engine service (`com.docker.service`) is STOPPED on the
dev box, so `npm run verify:db` — the lane whose whole job is proving a migration
applies to a fresh schema — could not run. Starting it needs elevation the agent
does not have. What HAS been checked:

- `migrations-lint` passes (656 migrations, no gaps, no duplicate versions).
- `schema-version_test.ts` passes: `EXPECTED_SCHEMA_VERSION` is `00659`, bumped in
  the same commit, and the shipped manifest was regenerated.
- `rls-guard_test.ts` passes, and it CAUGHT A REAL DEFECT here: the policy was
  first written as bare `auth.uid() = user_id`, copied from 00412. US-1927
  requires `(select auth.uid())`, which the planner hoists into a single InitPlan
  instead of re-evaluating per candidate row. Fixed before commit.
- The self-record footer is present.

So the STRUCTURE is checked and the SQL has not been executed. Turn Docker on and
run `npm run verify:db` before applying, or accept that a syntax error would
surface at apply time — the statements are all `IF NOT EXISTS` / `DROP ... IF
EXISTS` forms, so a failed run is re-runnable rather than half-applied.

**Why the column is on `users` and not a preferences table.** AC6 requires the
opt-out to be honoured in the SAME query that selects recipients rather than
filtered afterwards, and the recipient scan already reads `users`. A join is one
more thing that can be forgotten in exactly the way AC6 is written to prevent.

**Nothing in the same commit reads either object from the client**, so a frontend
auto-deploy before this applies changes nothing. The job that will use them is
not built yet — only the pure composition (`seller-digest.ts`) and the anomaly
rule (`seller-anomaly.ts`) are, and neither touches the database.

## ✅ APPLIED 2026-08-23: 00655-00658 — seller analytics, wave 2 (US-2823..2827)

Four migrations, all **additive function definitions**. No table, column, index,
enum, policy or grant on any existing object is touched, so nothing that runs
today changes behaviour when these apply.

| File | Function | Security | Reads |
|---|---|---|---|
| 00655 | `flipdesk_return_attribution(date)` | INVOKER | own items, listings, sales, grade_reports, item_photos |
| 00656 | `flipdesk_source_yield(date)` | INVOKER | `items_full` |
| 00657 | `flipdesk_listing_quality_lift(date)` | INVOKER | own listings, listing_metrics, item_photos |
| 00658 | `measurement_drift(text, text)` | **DEFINER** | every seller's `inventory_items.measurements` |

**Apply in NNNNN order, then `NOTIFY pgrst, 'reload schema';`** — all four are
reached by name through PostgREST, so without the reload they 404 rather than
answering.

**Risk: LOW.** Every one is `create or replace function` on a NEW name; a
re-run replaces its own definition and nothing else. No REVOKE anywhere
(US-2403: a denied call segfaults this Postgres image).

**The one to read before applying is 00658.** It is the only SECURITY DEFINER
function in the set, because measurement drift has no meaning without other
sellers' rows. Its posture is the same as `condition_price_curve` (00651):
a `gt_require_role('measurement_drift','authenticated')` body guard, an
explicit GRANT to authenticated and service_role, and every cross-seller figure
behind the k-anonymity floor read from `system_settings.community_min_cohort_sellers`
and hard-clamped with `greatest(5, ...)`. The caller's own medians are returned
at any sample size, because those are their own data.

**Client-side read risk on push: NONE.** Cloudflare Pages auto-deploys the
frontend the moment this is pushed, and every one of the four surfaces reads its
RPC through a client wrapper that returns an EMPTY report on error and renders
nothing rather than an error state. If the frontend deploys before the SQL
applies, the four new panels are simply absent. They appear on the next load
after the RPCs exist. No blank page, no toast, no thrown error.

**One performance note, said plainly.** 00658 scans `inventory_items`
platform-wide and unnests each row's `measurements` jsonb. There is no index
that helps a jsonb unnest and adding one would not pay for itself at current
volume. It is a STABLE read behind an authenticated guard, called from two
surfaces at a 5-minute and a 30-minute staleTime. Revisit if the table grows an
order of magnitude.

**VERIFIED, not assumed.** Applied by the owner and measured against production
the same day:

- All four PRESENT in the live PostgREST OpenAPI document — **107 rpc paths**,
  up from 103. `measurement_drift` lists **both** `p_garment_category` and
  `p_size`, which proves the two-argument definition applied rather than
  leaving a one-argument overload behind.
- `measurement_drift` answers the anon key with **HTTP 401 / 42501**
  `measurement_drift: authenticated required`.
- The three SECURITY INVOKER functions answer anon with **HTTP 200 and an empty
  document**. Walked the whole JSON tree: every data array is empty and the only
  non-zero numbers are the sample floors the payload carries. No seller data
  reaches an unauthenticated caller.
- All four answered **HTTP 200 with real data** to a signed-in JWT.
  `flipdesk_return_attribution` reports 158 fulfilled / 3 returns / 1.9%, which
  is the **same 0.019** `seller_scorecard` computes by a different route.

**One thing this apply surfaced:** `flipdesk_listing_quality_lift` found that
`listing_metrics` has 7,352 rows since 12 July and **every value is zero**.
That is a real six-week production bug in the eBay traffic sync, filed as
US-2835. Nothing about these migrations caused it and nothing here needs to
change.

---


## ✅ APPLIED 2026-08-22: 00650_items_full_parcel_inputs.sql

US-2790. Applied by the owner and VERIFIED against the database rather than
against this file:

- `items_full` now reports **63 columns** in PostgREST's OpenAPI document for
  production, with `garment_category` and `material` both **PRESENT** alongside
  the pre-existing `category`, `quality_score` and `measurements`. Presence is
  conclusive, and the older columns still being there is the evidence that
  `create or replace` appended rather than replaced.
- `GET /health/ready` reports
  `{"expected":"00649","applied":"00650","status":"ahead","unexpected":["00650"]}`.
  `ahead` only says the RUNNING edge build predates the schema; this commit
  bumps `EXPECTED_SCHEMA_VERSION` and the next edge deploy resolves it.

**What it does:** `create or replace view public.items_full`, appending two new
LAST columns — `garment_category` and `material` — so the parcel estimator can
read them. Body otherwise verbatim from 00506.

**Risk: LOW, with one thing to know.** Additive and idempotent: all existing
columns keep their name, order and type, so dependents (the analytics RPCs that
select from `items_full`) are unaffected. No `DROP` — that would fail against
those dependents.

**Client-side read risk: NONE right now, and that is deliberate.**
`src/types/database.ts` is NOT updated in this commit. `ItemFullRow` is the
shape of this view fetched with `select("*")`, so declaring the fields before
the view returns them would give a type that is present at compile time and
undefined at runtime. The type change and the consumer land AFTER this is
applied.

**Apply order:** 00650 → `NOTIFY pgrst, 'reload schema';` (a view changed) →
redeploy the edge, whose boot guard now expects 00650 → then OK the push.

**Verify rather than trust this file:**
`curl -fsS https://functions.gradethread.com/health/ready | jq .schema`

## ✅ APPLIED 2026-08-22: 00649_sales_predicted_parcel.sql

US-2790. Applied by the owner and VERIFIED against the database rather than
against this file, which is the rule this file's own header states:

- `sales.predicted_parcel` is **PRESENT** in PostgREST's OpenAPI document for
  production (37 columns on `sales`, read with the public anon key). Presence
  is conclusive.
- `GET /health/ready` reports
  `{"expected":"00648","applied":"00649","status":"ahead","unexpected":["00649"]}`.
  `ahead` and the `unexpected` entry only say the RUNNING edge build predates
  the schema — this commit bumps `EXPECTED_SCHEMA_VERSION` to 00649, so the
  next edge deploy resolves both.

**What it does:** adds one nullable `jsonb` column, `sales.predicted_parcel`,
plus a partial index on its `tableVersion` key. Nothing else.

**Risk: LOW.** Additive, nullable, no default, no backfill, no data rewritten.
`add column if not exists` and `create index if not exists`, so re-running the
directory is safe. Every existing sale predates the estimator and correctly
gets NULL — inventing a prediction for a shipment that already happened would
poison the exact comparison the column exists to make.

**Client-side read risk: NONE.** No frontend or edge code reads
`predicted_parcel` yet. The writer is a later task. So the usual danger — the
frontend auto-deploying on push and immediately reading a column prod does not
have — does not apply here. `src/types/database.ts` is deliberately NOT
updated in this commit for the same reason.

**Apply order:** 00649 → `NOTIFY pgrst, 'reload schema';` (a column changed) →
redeploy the edge, whose boot guard now expects 00649 → then OK the push.

**Verify rather than trust this file:**
`curl -fsS https://functions.gradethread.com/health/ready | jq .schema`

> [!warning] HELD: none. 00646 and 00647 are both APPLIED and verified
> (2026-08-21),
> and the
> 00627 tail (US-2729) is fully resolved — both its functions are confirmed
> present, one of them against pg_proc directly. Everything through 00644 is
> applied.
> Everything through **00644** is applied. Verified by asking the database
> rather than this file: `GET /health/ready` reports
> `{"expected":"00642","applied":"00644","status":"ahead","unexpected":["00643","00644"]}`
> with no `missing` key. `ahead` and the `unexpected` pair only say the RUNNING
> edge build predates the schema, which the next edge deploy resolves.
>
> Superseded: everything through **00642** was applied, verified the same way
> at `{"expected":"00640","applied":"00642"}`.
>
> Superseded text follows, kept because this file's history is how a stale
> claim gets caught: everything through **00640** was applied. Verified by asking the database rather
> than this file: `GET /health/ready` reports
> `{"expected":"00639","applied":"00640","status":"ahead"}` with no `missing` key.
> `status:"ahead"` and `unexpected:["00640"]` only say the RUNNING edge build
> predates the schema, which the next edge deploy resolves; they are not a
> problem report.
>
> This file records INTENT; only the database records STATE. It has gone stale in
> both directions before — claiming HELD when prod had applied, and claiming
> applied when prod had not — and both times it was trusted and prod was not
> asked. One unauthenticated GET settles it.

## ✅ APPLIED 2026-08-22: 00648_lister_locales.sql (US-2777)

**APPLIED AND THE CACHE HAS RELOADED.** Both measured against production rather
than taken on trust, and the second is the half that usually gets assumed:

- `GET /health/ready` reports `expected 00647, applied 00648, ahead` with **no
  `missing` key**, so the applied set is complete. `ahead` only says the running
  edge build predates the schema, which the next edge deploy resolves.
- `lister_locales` appears in the `flipdesk_settings` definition of PostgREST's
  OpenAPI document (`GET /rest/v1/` with `Accept: application/openapi+json` and
  the public anon key), alongside `cross_post_channels` as a control. That
  document IS the schema cache, so the column being in it settles the column and
  the `NOTIFY pgrst, 'reload schema'` in one read. Presence is conclusive;
  absence would not have been.

Nothing further is required before this commit is pushed.

Original entry follows.


**Risk: LOW.** One nullable `jsonb` column added to `flipdesk_settings`. No
backfill, no default, no constraint, no function, no data rewritten. Every
existing row keeps a NULL, and NULL means "use the platform's default domain",
which is the behaviour every account has today.

**What it does.** `flipdesk_settings.lister_locales` holds a platform ->
locale-KEY map, e.g. `{"vinted": "vinted.fr"}`. Vinted runs 22 country
domains behind one app; until now nothing recorded which one a seller's account
lives on, so every cross-post opened the platform default and a seller outside
that market silently watched a form fill on the wrong country's site.

**The value is a KEY, never a URL.** The extension resolves it against its own
bundled domain map (US-1876), so a value that travels through the database and
three clients cannot steer a navigation.

**Client-side read risk: LOW, and here is the honest version of it.** The
frontend auto-deploys on push, and the new build DOES read this column from the
client: `src/hooks/use-lister-locales.ts` selects `lister_locales` from
`flipdesk_settings` through PostgREST, and the picker on the Marketplaces page
upserts it. Against a database without the column, PostgREST answers **42703**
and the picker renders an error toast — the Marketplaces page still loads and
nothing else on it breaks, because the query is scoped to that one component's
hook. So the failure is a visible broken widget, not an outage. **Apply the SQL
before the push anyway**, which is the standing rule and costs nothing here.

**`NOTIFY pgrst, 'reload schema';` is REQUIRED.** A column changed. Without it
PostgREST keeps a cache that has never heard of `lister_locales`, and both the
SPA read and the edge's enqueue lookup answer 42703 — the enqueue lookup
swallows its error by design (a queued cross-post must not fail because a
settings read did), so that half would fail SILENTLY and every queued job would
keep opening the default domain. That is the bug this migration exists to fix,
still happening, with the migration applied.

**Apply order:** 00648 -> `NOTIFY pgrst, 'reload schema';` -> edge redeploy
(`EXPECTED_SCHEMA_VERSION` is bumped to 00648 in the same commit) -> push.

**How to confirm it landed, read-only:** `GET /rest/v1/` with
`Accept: application/openapi+json` and the anon key — `lister_locales` should
appear in the `flipdesk_settings` definition's `properties`. Presence is
conclusive; absence is not (see the 00627 note further down).

## APPLIED 2026-08-21: 00647 — style_code_brand_candidates (US-2786)

**APPLIED, owner-confirmed and verified rather than taken on trust.**
`GET /health/ready` reports
`{"expected":"00646","applied":"00647","status":"ahead","unexpected":["00647"]}`
with no `missing` key, and the PostgREST OpenAPI read lists all four new
objects: `/style_code_brand_candidates`, `/style_code_prospect_state`,
`/rpc/record_style_code_brand_candidate` and `/rpc/record_style_code_prospect`.
Presence in that document is conclusive; absence would not have been (see the
00627 note further down).

`expected: 00646` only says the RUNNING edge build predates the schema, which the
next Coolify deploy resolves.

**Risk: LOW.** Two new tables with no foreign keys and two new functions. Nothing
existing is altered, dropped or backfilled.

### What it does

Adds `style_code_brand_candidates`: one row per brand NOT yet in
`brand_knowledge`, tallying how many of its eBay listings the survey looked at
and how many of those declared a style code in a structured field. The ratio is
the point — a brand with a million listings and nobody filling the Style Code box
is worth no crawl budget, and a small brand whose sellers all fill it is worth a
great deal.

Adds `style_code_prospect_state`: a single-row cursor for the unfiltered survey,
so it walks fresh inventory instead of re-reading eBay's first page nightly. Same
reasoning as 00646's per-brand cursor; one row rather than one per brand because
there is one unfiltered walk.

Plus `record_style_code_brand_candidate(...)` and `record_style_code_prospect(...)`,
both accumulating server-side so two overlapping passes cannot erase each other.

**Nothing here writes brand_knowledge.** A candidate is evidence for a human
decision; seeding a brand still goes through the US-1718 draft-verify-seed flow,
which rejects a fact with no `source_url`. That is why there is no `source_url`
column: a tally is a measurement, not a claim about a brand.

### The one thing that breaks if the order is wrong

The survey does not run until every curated brand has been crawled and gone flat,
which is roughly 19 nights away at the current budget, so the window here is wide.
If it did fire against a database without this migration, the candidate writes
would fail and the pass would log errors and record nothing. It is a CRON, so no
seller path is affected.

The admin "Brands worth curating next" card reads through an edge route, so the
frontend auto-deploy on push cannot get ahead of the schema.

### Apply

1. Run `supabase/migrations/00647_style_code_brand_candidates.sql`.
2. `NOTIFY pgrst, 'reload schema';` — two new tables and two new RPCs.
3. Redeploy the edge on Coolify (its boot guard now expects `00647`).
4. Then OK the push.

### Verify

```sql
select to_regclass('public.style_code_brand_candidates');   -- not null
select to_regclass('public.style_code_prospect_state');     -- not null
select proname from pg_proc
where proname in ('record_style_code_brand_candidate', 'record_style_code_prospect');
-- expect both rows; pg_proc is the question that has an answer, not the
-- PostgREST OpenAPI document (see the 00627 note below)
```

---

## APPLIED 2026-08-21: 00646 — style_code_discovery (US-2783)

**APPLIED, owner-confirmed and then verified against prod rather than taken on
trust.** `GET /health/ready` reports
`{"expected":"00644","applied":"00646","status":"ahead","unexpected":["00645","00646"]}`
with no `missing` key, and the PostgREST OpenAPI document (anon key, a pure
read) lists all three new objects: `/style_code_discovery_state`,
`/rpc/style_code_discovery_brands` and `/rpc/record_style_code_discovery`.

`expected: 00644` only says the RUNNING edge build predates the schema, which the
next Coolify deploy resolves. Still to do on the operator side: add the Coolify
scheduled task `10 3 * * *` against `/api/jobs/style-code-discovery`, or the
crawl never fires.

**Risk: LOW.** One new table with no foreign keys, two new functions, and one
CHECK constraint widened to admit an extra value. No backfill, no existing row
touched, nothing dropped that anything reads.

### What it does

Adds `style_code_discovery_state`: one row per brand holding where the nightly
brand-first style-code crawl (US-2784) stopped paging. Without it the crawl
re-reads eBay's first page every night, finds the same codes, and reports
success.

Adds two functions:

- `record_style_code_discovery(...)` — upserts a pass and accumulates the
  counters server-side, so two overlapping ticks cannot erase each other.
- `style_code_discovery_brands(p_limit)` — the brand rotation, `brand_knowledge`
  left-joined to the state table, least recently crawled first.

Widens `style_code_observations_source_check` to admit `'discovery'`. Existing
values (`market_verify`, `own_sale`, `admin`) all stay valid, so no row can fail
the new constraint.

### The one thing that breaks if the order is wrong

The edge writes observations with `source: 'discovery'` the moment the discovery
cron first fires. Against a database without this migration that write fails the
CHECK constraint. It is a CRON, not a user path, so nothing a seller does breaks,
but the job's first run would report zeros and log constraint errors.

Nothing in the SPA reads any of this before an edge deploy: the admin crawl
table goes through `/api/admin/brand-knowledge/style-codes/discovery`, an edge
route, so the frontend auto-deploy on push cannot get ahead of the schema.

### Apply

1. Run `supabase/migrations/00646_style_code_discovery.sql`.
2. `NOTIFY pgrst, 'reload schema';` — two new RPCs and a new table.
3. Redeploy the edge on Coolify (its boot guard now expects `00646`).
4. Add the Coolify scheduled task for the new cron: `10 3 * * *` against
   `/api/jobs/style-code-discovery`. See `services/edge-functions/CRON_SETUP.md`.
5. Then OK the push.

### Verify

```sql
select to_regclass('public.style_code_discovery_state');          -- not null
select proname from pg_proc
where proname in ('record_style_code_discovery', 'style_code_discovery_brands');
-- expect both rows

select pg_get_constraintdef(oid) from pg_constraint
where conname = 'style_code_observations_source_check';           -- must include 'discovery'

select count(*) from public.style_code_discovery_brands(10);      -- runs, returns brands
```

---

## RESOLVED 2026-08-21: the tail of 00627 — US-2729

**FULLY RESOLVED, 2026-08-21. Nothing to run.** Both objects 00627 creates are
present in production:

- `style_code_sweep_candidates` — the function whose absence broke every hourly
  sweep tick. Confirmed via the PostgREST OpenAPI read.
- `record_style_code_sweep` — confirmed directly against `pg_proc`, which is the
  only source that settles it.

> [!warning] A LESSON WORTH MORE THAN THE FIX
> `record_style_code_sweep` does **not** appear in the anon PostgREST OpenAPI
> document even though it exists in `pg_proc` and 00627 revokes nothing. Its
> sibling in the same file does appear. So **absence from that document proves
> nothing about whether a function exists** — it answers "did the schema cache
> reload" and "is this signature live", and only PRESENCE is conclusive.
> `select proname from pg_proc where proname = ...` is the question that has an
> answer. This nearly produced a second repair of something that was never
> broken.

Original write-up follows, kept because the reasoning is still the right
reasoning for the next half-applied migration.

The prod schema audit (2026-08-20) found `style_code_sweeps`, both its indexes
and `record_style_code_sweep` all present, and the LAST two objects the file
creates both missing. The file aborted partway.

**Run ONLY these two statements. Do NOT re-run the whole file.** Both are
idempotent on their own; re-running the whole file is how a partial apply gets
repeated rather than fixed.

1. The `CREATE OR REPLACE FUNCTION public.style_code_sweep_candidates` block
   from `supabase/migrations/00627_style_code_sweeps.sql`, plus its `GRANT`.
2. `CREATE INDEX IF NOT EXISTS inventory_items_style_code_idx ON
   public.inventory_items ((attributes->>'style_code')) WHERE
   attributes->>'style_code' IS NOT NULL;`

Then `NOTIFY pgrst, 'reload schema';`.

### Verify

```sql
select proname from pg_proc where proname = 'style_code_sweep_candidates';  -- one row
select indexname from pg_indexes where indexname = 'inventory_items_style_code_idx';
select count(*) from public.style_code_sweep_candidates(10);               -- runs
```

Then watch one hourly tick of `/api/jobs/style-code-sweep`: it should return
`{ok:true, considered, swept, ...}` with `considered` above zero instead of
logging "Could not find the function public.style_code_sweep_candidates".

---

## ✅ APPLIED 2026-08-22: 00645_provenance_decline_reason.sql (US-2779)

**APPLIED, and the HELD marker above it was stale.** Measured rather than
assumed: `GET https://functions.gradethread.com/health/ready` reports
`{"expected":"00647","applied":"00647","status":"match"}` with **no `missing`
key**, so the applied SET is complete through 00647 and 00645 is in it. The
apply script is `set -euo pipefail` with `ON_ERROR_STOP=1` per file and the
self-record footer is the last statement, so a recorded version proves the whole
file ran.

**HOW THIS WENT UNNOTICED, which is the part worth keeping.** `held-migration-gate.mjs`
keys on a heading of the exact shape `## HELD: NNNNN_name.sql`. This heading was
written as `## HELD: 00645 — why a visual run offered nothing` — a version number
with no filename — so the regex never matched it and the gate reported "no HELD
migrations listed — OK" while this file marked one held and origin/main already
carried it. That is the FOURTH time this control has been routed around, and the
first time by a heading rather than by `--no-verify`. Both headings in this file
are now in the parseable form, and the gate correctly reports 00645 as already on
origin.

Original entry follows.


**Risk: LOW.** One nullable column, one CHECK constraint, one partial index. No
backfill, no data rewritten, nothing dropped. The column defaults to NULL and
every existing row stays valid.

**What it does.** Adds `visual_declined` to `identification_provenance`.
`visual_candidates = '[]'` currently means both "the role gate refused to search
a ruler shot" and "eBay has nothing that looks like this garment". Those are
different findings with different fixes, and the operator report added in
US-2779 cannot separate them without this column.

**Apply order.** After 00644. Idempotent, so re-running the tail is safe.

```
psql -f supabase/migrations/00645_provenance_decline_reason.sql
NOTIFY pgrst, 'reload schema';
```

The `NOTIFY` matters here: a new column is invisible to PostgREST until the
schema cache reloads, and the write goes through PostgREST.

**Does the frontend read it before the edge deploys?** No. The new column is
read only by `/api/admin/identification-provenance`, an edge route, and the
admin page reaches it through the edge. Cloudflare Pages auto-deploying the
frontend on push cannot break anything here on its own.

**What happens if the push lands before the SQL.** Nothing user-visible, and
this is deliberate. `generateListing` skips the provenance write entirely when
the visual pass reports `disabled`, which is what it reports while
`SCOUT_EBAY_IMAGE_SEARCH_ENABLED` is unset — the flag's current state. So with
the flag off, no insert carrying the new column is ever attempted. The order
that matters is not push-vs-SQL, it is **SQL before the flag goes on**.

Turning the flag on before applying this would leave every provenance insert
failing on an unknown column. It is best-effort and would not break a
generation, but the whole US-2779 measurement would silently record nothing —
which is the failure mode the report exists to prevent.

## APPLIED 2026-08-21: 00644 — cross_post_channels (US-2721)

**APPLIED, owner-confirmed and then verified against `/health/ready`.**

> [!important] The edge still reports `expected: 00642`, so the running build
> predates this column. The SPA reads `cross_post_channels` DIRECTLY through
> RLS rather than through the edge, so the picker works as soon as PostgREST
> has reloaded its schema cache — it does not wait for an edge deploy. If the
> picker cannot save, `NOTIFY pgrst, 'reload schema';` is the thing to check.

**Risk: very low.** One nullable column on an existing per-user settings table.
No backfill, no default, no constraint. Every existing row keeps NULL.

### What it does

Adds `flipdesk_settings.cross_post_channels text[]`, the marketplaces a seller
cross-posts to. A seller on two channels was being offered six on every draft,
and the Listing Kit was generating AI fields for all six.

**NULL means ALL**, and that is the design rather than a convenience. Every
existing row has no value and every new seller starts with none, so the default
has to be "you keep what you have today". An empty array is treated the same
way by the app: unticking the last box is never how somebody says "stop
offering me marketplaces". The setting narrows; it cannot switch cross-posting
off.

Not an enum and not a foreign key — the platform vocabulary lives in
`src/lib/constants.ts` and moves when a channel ships, and a DB enum would make
that a migration every time.

### Apply

1. `supabase/migrations/00644_cross_post_channels.sql` — idempotent.
2. `NOTIFY pgrst, 'reload schema';` — a new column, so PostgREST must be told,
   and here it matters: **the SPA reads and writes this column directly**
   through RLS, the same path the `auto_end_cross_listings` toggle uses.
3. Redeploy the edge (boot guard now expects `00644`).

### Does the frontend read it?

**Yes — this one does.** Unlike 00641/00643, the column is read by
`useCrossPostChannels` and written by the picker on the Marketplaces settings
tab. So the ORDER matters more than usual: if Cloudflare deploys the frontend
before the SQL is applied, the read returns a PostgREST error for an unknown
column and the picker cannot save. Apply the SQL and reload the schema cache
first.

The read failure is not silent and not destructive — the query errors, the
picker shows nothing saved, and no channel is lost, because absent still means
all.

### Verified locally

Applied twice against the throwaway local stack: `ALTER TABLE` then
`NOTICE … already exists, skipping`. 17 web tests cover the empty-means-all
rule in both of its forms, the narrowing, the not-live channels, and that no
surface rendering existing listings filters them by the selection.

### Rollback

`ALTER TABLE public.flipdesk_settings DROP COLUMN IF EXISTS cross_post_channels;`
then `DELETE FROM public.applied_migrations WHERE version = '00644';`. Any
seller selection is lost and everyone returns to all channels, which is the
same state they are in today.

## APPLIED 2026-08-21: 00643 — listing_publications (US-2704)

**APPLIED, owner-confirmed and then verified against `/health/ready`.**

> [!note] Snapshots start from the first publish AFTER the edge redeploys,
> not from now. The table exists, but the funnel that writes it ships in the
> edge build, and the running one still reports `expected: 00642`. Coverage
> cannot be backfilled — a description that was never snapshotted is gone —
> so the redeploy is what starts the clock.

**Risk: low.** One new table, one index, no change to any existing table, no
backfill. Nothing reads it yet.

### What it does

Creates `public.listing_publications` — one row per publish and per revise,
holding the listing, the channel, the description, the aspect map, the price and
the timestamp. It is the evidence half of the grade-as-dispute-evidence epic
(US-2703): when a buyer claims a seller hid a flaw, the defence is the listing
text that was live, and nothing kept it. eBay's own `GetMyeBaySelling` does not
return descriptions.

**The claim is deliberately narrow.** This records what GradeThread PUBLISHED,
never what eBay DISPLAYED. A seller editing in Seller Hub changes eBay's copy
and not ours, and we usually cannot tell. Nothing built on this table may
upgrade the first claim into the second.

`last_confirmed_at` is the collapse column. The credentials-refresh cron
re-pushes unchanged text often, so an unchanged push extends the existing row's
window instead of writing a duplicate — which is also the stronger statement:
this exact text was live and confirmed from `published_at` through
`last_confirmed_at`.

Operator table: RLS on, zero policies, `REVOKE INSERT, UPDATE, DELETE FROM anon,
authenticated`. Registered in `SERVICE_ROLE_ONLY`.

### Apply

1. `supabase/migrations/00643_listing_publications.sql` — idempotent.
2. `NOTIFY pgrst, 'reload schema';` — a new table, so PostgREST must be told.
3. Redeploy the edge (boot guard now expects `00643`).
4. Then push.

### Does the frontend read it?

**No.** Nothing in `src/` touches the table. The only writer is the edge's
snapshot funnel, and every write there is best-effort by contract: a missing
table logs `[publication] …` and the publish it was recording still succeeds.
So a Cloudflare auto-deploy ahead of the SQL breaks nothing, and an edge deploy
ahead of it degrades to no snapshots rather than to failed publishes.

### Retroactivity

It covers listings published after it is applied and nothing before. A dispute
on an older item falls back to the grade-report-only argument. Coverage cannot
be backfilled — a description that was never snapshotted is gone — which is why
this ships first and alone.

### Verified locally

Applied twice against the throwaway local stack: clean, then
`NOTICE … already exists, skipping`. 19 new deno tests pass, and the coverage
guard was sabotage-checked 5 of 5.

### Rollback

`DROP TABLE IF EXISTS public.listing_publications;` then
`DELETE FROM public.applied_migrations WHERE version = '00643';`.

## APPLIED 2026-08-21: 00642 — the four agent columns match the repo again (US-2729)

**APPLIED, owner-confirmed and then verified against `/health/ready`.**

**Risk: low.** Four `DROP NOT NULL`s. No data moves, nothing is rewritten, and
dropping a constraint cannot invalidate a row that already satisfied it.

### What it does

The 2026-08-20 prod schema audit found four columns NOT NULL in production and
nullable in every migration: `agent_proposals.evidence`,
`agent_proposals.summary`, `agent_run_steps.name`, `agent_runs.trigger`. 00357
declares all four without the constraint and no later migration adds it, so
prod's copies of those tables did not come from the migration set.

This relaxes prod to match. The repo wins because the code writes NULL into
three of them deliberately — `dispatchWriteIntent` builds every proposal with
`summary: intent.summary ?? null` and `evidence: intent.evidence ?? null`, and
`AgentStep.name` is typed `string | null` — so the production constraint is a
23502 that can only ever fire in production, where CI cannot see it. Tightening
the repo instead would mean pinning those write paths non-null first, which is a
product question (what is a proposal with no summary?) rather than a schema
correction.

### Apply

1. `supabase/migrations/00642_agent_columns_match_the_repo.sql` — idempotent.
2. No `NOTIFY pgrst` needed: nullability is not part of the schema cache
   PostgREST keys on for routing. Harmless to send anyway, and it does refresh
   the OpenAPI `required` array that this was measured through.
3. Redeploy the edge (boot guard now expects `00642`).

### Does the frontend read it?

**No.** These are agent-runtime tables behind `/api/admin/agents/*`.

### Verified locally

Applied twice against the throwaway local stack: four `ALTER TABLE`s both times,
`INSERT 0 1` then `INSERT 0 0` on the footer. `information_schema.columns`
reports all four `is_nullable = YES`, and an `agent_runs` insert with an
explicit null trigger succeeds (rolled back).

`services/edge-functions/src/tests/agent-column-nullability_test.ts` holds the
decision: no migration may put the constraint back, and 00642 must actually
contain the four `DROP NOT NULL` statements rather than describe them.

### Rollback

Re-adding the constraint is what caused this, so there is no reason to roll it
back. If you must: `ALTER TABLE … ALTER COLUMN … SET NOT NULL` will now fail on
any row written since, which is the point.

## APPLIED 2026-08-21: 00641 — identification_provenance (US-2774)

**APPLIED, owner-confirmed and then verified against `/health/ready`.**

**Risk: low.** One new table, two indexes, no change to any existing table, no
backfill, no data movement. Nothing reads it yet.

### What it does

Creates `public.identification_provenance` — one row per AI identification run,
recording how the eBay category was chosen (`category_method` is one of `saved`,
`visual_consensus`, `keyword`, `none`, plus the support behind a winning vote and
the reason a losing one lost) and what the model ruled on each visual candidate.

The two jsonb columns are separate on purpose. `visual_candidates` is what was
put to the model; `visual_rulings` is what came back. A candidate that was never
offered, one that was offered and ignored, and one that was refused on evidence
are three different findings, and a table holding only the rulings would make
them look identical — which is the measurement the story exists for.

Operator table: RLS on, zero policies, `REVOKE INSERT, UPDATE, DELETE FROM anon,
authenticated`. Registered in `SERVICE_ROLE_ONLY` in `rls-guard_test.ts`.

### Apply

1. `supabase/migrations/00641_identification_provenance.sql` — idempotent, safe
   to re-run.
2. `NOTIFY pgrst, 'reload schema';` — a new table, so PostgREST must be told.
3. Redeploy the edge (its boot guard now expects `00641`).
4. Then push.

### Does the frontend read it?

**No.** Nothing in `src/` touches the table, so a Cloudflare Pages auto-deploy
ahead of the SQL breaks nothing. The only writers are the edge's extract and
eBay-prep phases, and both writes are best-effort: a missing table logs
`[provenance] … failed` and the extraction continues unaffected.

### Verified locally

Applied twice against the throwaway local stack (`supabase_db_gradethread`):
clean the first time, `NOTICE … already exists, skipping` the second. Both check
constraints reject a bad value; `anon` reads 0 rows while the service role reads
the row; `authenticated` insert is refused with `permission denied`.

### Rollback

`DROP TABLE IF EXISTS public.identification_provenance;` then
`DELETE FROM public.applied_migrations WHERE version = '00641';`. Nothing depends
on it.

## APPLIED 2026-08-21: 00640 — body guards for the 13 SECURITY DEFINER functions that had none (US-2282)

**APPLIED, verified 2026-08-21.** Owner applied it; the result was then measured
rather than assumed:

* `/health/ready` reports `applied: "00640"`.
* The three RPCs that were returning real data to the public anon key now answer
  **401 / 42501** — `channel_attribution` and `buyer_growth_metrics` with
  "service_role required", `community_benchmarks` with "authenticated required",
  which is the correct tier for each.
* `increment_grades_used` answers **PGRST202, function not found**. The drop
  landed.
* Edge `/health/ready` still reports `status: ready`, `database: ok`.

**One check is still open.** Nothing here exercised a guarded function through
the edge's own service-role client end to end — there is no public certificate in
the sitemap to drive `increment_certificate_view` with. Grade one item and list
one item when convenient; that covers `reserve_ai_action`, `increment_ai_actions`
and `get_or_create_source`. If the edge ever starts answering 42501, the rollback
below is immediate.

### What it does

Adds one authorization check to each function that lacked one. Measured against
prod 2026-08-21: 96 SECURITY DEFINER functions, 55 reachable by `anon`, 40
already guarded by 00514 and 00611–00617. These are the remaining 15, minus one
that is dropped and one that is deliberately public.

* **Ten get a `service_role` check** (the edge is their only caller):
  `claim_grade_lease`, `increment_ai_actions`, `reserve_ai_action`,
  `reserve_buyer_meter`, `record_style_code_submission`, `record_style_code_name`,
  `increment_certificate_view`, `channel_attribution`,
  `style_code_sweep_candidates`, `buyer_growth_metrics`.
* **Three get an `authenticated` check** (the browser genuinely calls these, so a
  service-role check would break the app): `get_or_create_source`,
  `merge_inventory_items`, `community_benchmarks`.
* **`increment_grades_used` is DROPPED.** It has no callers anywhere — not the
  edge, web, iOS, Android, extension or a script. Recreating it is one `CREATE`
  from 00004 if it is ever wanted.
* **`peek_workspace_invitation` is deliberately left open**, because
  accept-invite reads it before the invitee has signed in.

### Why a body check and never a REVOKE

A revoke makes the call permission-denied, and a denied call segfaults this
Postgres image and restarts the database (US-2403). **00527 stays `.BLOCKED`.**
This file contains no `REVOKE` and no new `GRANT` except on the helper.

### Verified before being held

Applied twice to the local stack (idempotent). Guard matrix, with the JWT claims
PostgREST actually sets:

| caller | service-role tier | authenticated tier |
|---|---|---|
| `service_role` | allowed | allowed |
| `authenticated` | refused 42501 | allowed |
| `anon` | refused 42501 | refused 42501 |

`src/test/security-definer-grants.test.ts` 5/5, sabotage-checked: removing a
guard call, and making the helper return true instead of raising, each fail it.

### Apply

```bash
psql "$PROD_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/00640_security_definer_body_guards.sql
```

Then **`NOTIFY pgrst, 'reload schema';`** — a function signature changed
(`increment_grades_used` is gone) and PostgREST caches those.

### Then check, in this order

1. `curl -fsS https://functions.gradethread.com/health/ready | jq .schema` → expect `applied: "00640"`.
2. Anon is refused. This is the point of the migration:
   `POST /rest/v1/rpc/channel_attribution` with the anon key should now answer
   **401 / 42501**, where before it returned real UTM data.
3. **The edge still works.** Grade one item and list one item — that exercises
   `reserve_ai_action`, `increment_ai_actions` and `get_or_create_source`. If the
   edge starts 42501-ing, `auth.role()` is not reaching the function and the
   rollback below is immediate.

### Rollback

Re-run the previous definition of any function from the migration named in the
comment above it; each one records where its body came from. The helper
`gt_require_role` can stay — nothing calls it once the bodies are reverted.

## ✅ APPLIED 2026-08-20: 00639 — remove the names derived from listing titles (US-2751)

**APPLIED, verified 2026-08-20.** `GET /health/ready` reports `applied: "00639"`.
The names produced from eBay listing TITLES are gone; the sweep now writes only
from listings that declare the style code in a structured item specific.

⚠ **The edge still has to redeploy.** Production is running a build that expects
00634, so until it rolls, the OLD title-consensus code is what the sweep cron
executes — and it can write fresh `consensus` rows into the table this migration
just cleaned. The delete is idempotent: re-run 00639 after the edge deploy and
the table is clean again. That is why this one's apply order was reversed in the
first place.

**Risk: LOW, and the risk of NOT applying it is higher.** One `DELETE` against
`style_code_names` rows whose source is `consensus`. No schema change.

**Why.** Those rows are the run of words that most eBay listing TITLES shared
for a code. A title is marketing text written by a seller who may have bought
the garment with no tag beyond a size dot, and our OWN sellers publish with
titles our AI wrote — so the method counted our guesses as independent
corroboration. The sweep now learns only from listings that DECLARE the style
code in a structured field and name a product in one.

The two generations are indistinguishable by source alone. Leaving them means a
reseller sees a name that might be either and nobody can tell which.

**Nothing is permanently lost.** The sweep re-derives a code once it is below
the confirmation floor, and 00627's cooldown lets a previously-resolved code be
re-asked. A name that does not come back is one no listing ever declared.

`seller`, `admin`, `official` and `public` rows are untouched — those came from
people, not from prose. The 00503 observation rows are kept too: a title is
still evidence, correctly labelled as weak, and an admin should be able to see
what the market called something even when that is not good enough to publish.

**Apply order**

1. Run `supabase/migrations/00639_clear_title_consensus_names.sql`.
2. Redeploy the edge (`EXPECTED_SCHEMA_VERSION` is now `00639`). Deploy the edge
   FIRST if you would rather not have a window where the old title-consensus
   code could write a new row: the delete is idempotent, so re-running it after
   the deploy is free.

**Confirm it landed**

```sql
select source, count(*) from public.style_code_names group by source;
```

`consensus` should be absent, or non-zero only from sweep ticks that ran after
the new edge build deployed.

## ✅ APPLIED 2026-08-20: 00635 — what the person holding the garment says it is (US-2749)

**APPLIED.** `/health/ready` reported `applied: "00638"` on 2026-08-20, which is
past this one, and `status:"ahead"` with no `missing` key means every version up
to it landed. This section previously said PENDING and was wrong — the file
records intent, only the database records state.


**Risk: LOW.** One new table, one `plpgsql` counter function, and one CHECK
constraint widened on `style_code_names`. No backfill, no existing data touched.
Deny-all RLS.

**What it is.** The reseller who looks up a style code we cannot name is holding
the tag — the best evidence in the world for that code — and today the lookup
tells them we do not know and the conversation ends. `style_code_submissions`
lets them answer.

**Why a table and not another `style_code_names` row.**
`record_style_code_name` upserts on `(brand, code, source)` and OVERWRITES the
name. That is right for a source with one opinion and wrong for anonymous
submissions, where the second person may DISAGREE with the first: through that
RPC, disagreement silently replaces agreement and resets the count. Submissions
are counted per `(code, name)` instead, so dissent stays visible, and a name is
promoted only once enough independent people said the same thing.

**The CHECK widening is the part to read twice.** It drops and re-adds
`style_code_names_source_check` to admit `'public'`. A drop-and-add is not
atomic with respect to a concurrent writer, but the only writers are the edge
service-role client and the 00629 trigger, and neither writes `'public'` until
the code that does is deployed. Applying this BEFORE the edge deploy is
therefore the safe order, which is the normal order anyway.

**Nothing identifying is stored.** No account, no session, no IP, no user agent.
Abuse is the existing `/api/content/public/*` rate limiter's job (60/min/IP,
fail-closed).

**Apply order**

1. Run `supabase/migrations/00635_style_code_submissions.sql`.
2. `NOTIFY pgrst, 'reload schema';` — REQUIRED. New table and new RPC.
3. Redeploy the edge (`EXPECTED_SCHEMA_VERSION` is now `00635`).

**Confirm it landed**

```sql
select proname from pg_proc where proname = 'record_style_code_submission';
select pg_get_constraintdef(oid) from pg_constraint
where conname = 'style_code_names_source_check';   -- must now include 'public'
```

## ✅ APPLIED 2026-08-20: 00634 — listings.listed_at becomes nullable (US-2727)

**APPLIED.** Below the 00639 the database reports as applied, and `/health/ready`
carries no `missing` key — which is the guard's way of saying there is no hole
under the maximum (US-2620 reports one as `incomplete`).

**Risk: LOW.** One `ALTER COLUMN ... DROP NOT NULL`. No table is created or
dropped, no data is written, no policy changes. Idempotent by nature: dropping
NOT NULL on an already-nullable column is a no-op, verified by applying the
file twice against the local stack.

**What it does.** `public.listings.listed_at` stops being `NOT NULL`. The
`DEFAULT now()` stays.

**Why.** US-1877 drew the line between PREFILLED and PUBLISHED: the extension
filling a marketplace form is not a live listing, so the row is a draft and
must not carry a `listed_at` — a date there is what made phantom rows look
like real, dateable cross-listings. The code has written `listed_at: null` for
a draft ever since. The column has been `NOT NULL DEFAULT now()` since 00002
and nothing ever changed it, so that INSERT has failed with 23502 on every
environment. Caught in production 2026-08-20 on a real Poshmark cross-post:
`[flipdesk.extension-writeback.insert] 23502 | null value in column
"listed_at" of relation "listings" violates not-null constraint`. The form was
filled, the seller had a listing in front of them, and FlipDesk recorded
nothing.

**Not a prod drift.** The local stack carrying all 633 migrations reports the
same `NOT NULL`. Every environment has this.

**Client-side read risk: LOW, and it was NOT zero — this line said "NONE" and
that was wrong.** The EDGE already treats the column as nullable
(`lib/api-listings.ts`, `lib/api-items.ts` type it `listed_at: string | null`,
`openapi-spec.ts` declares `nullable: true`) and the views that read it
(`items_full`, the finances dashboard) already guard with
`WHEN l.listed_at IS NOT NULL`. The FRONTEND did not: `src/types/database.ts`
typed the row as non-null `listed_at: string`, so it described a shape the
database can no longer guarantee, and two helpers parsed it unguarded
(`src/lib/price-suggestions.ts`, `src/components/analytics/listing-suggestions.tsx`).
Both are reached only behind an `is_active` filter and the writeback writes
`listed_at: null` together with `is_active: false`, so no NaN was actually
reaching a screen — but that is an argument from a caller, not from the type.
Fixed in the same commit: the row type is `string | null`, the Insert accepts
null, and both helpers return 0 for a draft. Correcting the type is what
surfaced the two call sites; nothing else in `src/` reads the column.

**Apply order.** 00634 after 00633. Then `NOTIFY pgrst, 'reload schema';` —
the column's nullability is part of what PostgREST caches. Then redeploy the
edge (its boot guard now expects 00634).

**⚠ Apply this one alongside the 00134 repair below**, or the writeback still
fails — they are two separate missing pieces of the same INSERT. Note the edge
change in the same commit makes that failure EARLIER and LOUDER rather than
merely continuing: `flipdesk-listings.ts` now returns a hard 500
(`WRITEBACK_GROUP_LOAD`) when the `draft_id` SELECT errors, instead of dropping
the error and limping on to the INSERT. So an edge deploy that lands before the
`draft_id` repair fails every writeback immediately. Correct order: 00634 SQL →
the 00134 `draft_id` repair → `NOTIFY pgrst, 'reload schema';` → edge redeploy →
push.

**✅ The 00134 repair now has a durable record: `00660`.** This paragraph used
to say the repair was SQL in a markdown file that `apply-prod-migrations.sh`
would never run, so no `applied_migrations` row would ever mark it done and a
future audit could not tell a repaired production from one that still has the
gap. US-2832 fixed that: `00660_ensure_listings_draft_id.sql` carries the two
statements and nothing else. See the HELD section at the top of this file.

## ⚠️ PROD REPAIR (not a new migration): listings.draft_id was missing (US-2726)

Found 2026-08-20. Production had no `listings.draft_id`, so every extension
cross-listing writeback failed with `PGRST204 | Could not find the 'draft_id'
column of 'listings' in the schema cache`. The column comes from **00134**,
which is pre-footer-era and therefore never checked by the boot guard —
`applied_migrations` only records 00254 and up.

**Do NOT re-run 00134.** It is not idempotent: its `CREATE TRIGGER` and three
`CREATE POLICY` statements have no guards, and re-running it fails with
`42710: trigger "set_flipdesk_settings_updated_at" ... already exists`. That
error also proves the REST of 00134 did apply — only the column was missing.

**The SQL that used to sit here is now `00660_ensure_listings_draft_id.sql`**
(US-2832). It carries exactly these two statements and nothing else, so run the
migration rather than pasting from this file. A paste leaves no
`applied_migrations` row, which is the whole problem this section documented
and then reproduced.

Production was repaired by hand on 2026-08-20 and still has the column -
confirmed 2026-08-23 by reading `listings.draft_id` out of the live PostgREST
schema document. So 00660 changes nothing there; the row it writes is the point.

**Open question worth answering before launch:** how a pre-00254 migration
came to be half-applied, and whether anything else below 00254 is missing.
`scripts/prod-schema-audit.sql` (generated from a local stack at 00633, and
self-tested against it at zero findings) reports every missing table, column,
index and function in one read-only pass.



## ✅ APPLIED (owner-confirmed 2026-08-20): 00633 — one review row per unmatched sale, not one per poll (US-2717)

**Risk: LOW.** One `DELETE` that removes duplicate rows from a table nothing has
written to yet, and one `CREATE UNIQUE INDEX IF NOT EXISTS`. No table is
altered, no column is dropped, no policy changes. Idempotent: the DELETE is a
no-op once there are no duplicates, and the index guard is `IF NOT EXISTS`.

**What it does.** Adds `marketplace_sync_reviews_unmatched_uniq`, a partial
unique index on `(user_id, platform, dedupe_key)` where the row is open, has no
`listing_id`, and carries a dedupe key.

**Why.** 00632's `marketplace_sync_reviews_open_uniq` is partial on
`listing_id IS NOT NULL`, and an UNMATCHED sale has no listing id -- so the one
branch guaranteed to repeat is the one branch that index does not cover. It
repeats by construction: the route builds its `seenKeys` set from
`marketplace_sync_observations`, and a row lands there only when a sale is
CONFIRMED, so an unmatched sold row is never suppressed and arrives again on
every poll with the same key. At the scheduled poll's 45-minute default that is
roughly 32 identical rows a day per unmatched sold row, and `GET /reviews`
returns only the newest 200, so the copies crowd out the real queue.

**The DELETE, specifically.** A unique index cannot be built over existing
duplicates. It keeps the OLDEST row of each group: that is the `created_at` the
seller would already have seen, and its id may be referenced by a claim they
have open.

**Client-side read risk: NONE.** No frontend code reads the index. The route
change in this commit writes with `onConflict: "user_id,platform,dedupe_key"`,
which REQUIRES this index -- so the SQL must be applied before the edge deploy,
which is the normal order anyway.

**Applied.** 00633 after 00632. The edge boot guard now expects 00633, which
matches EXPECTED_SCHEMA_VERSION in this commit, so the next Coolify deploy
starts clean.

## ✅ APPLIED (owner-confirmed 2026-08-20): 00632 — sold-sync storage for the no-API marketplaces (US-2697)

**Risk: LOW.** Three brand-new tables, four indexes, three RLS policies. No
existing table is altered, no column is dropped, no data is migrated, and
nothing already running reads any of it. Fully idempotent (`CREATE TABLE IF NOT
EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS` before each
`CREATE POLICY`). **No REVOKE** — see the standing rule; a denied `anon` call
segfaults this Postgres image.

**What it does.** Adds `marketplace_sync_observations` (the dedupe ledger that
makes re-reading the same Sold page a no-op rather than a second sale),
`marketplace_sync_reviews` (what the planner refused to act on alone) and
`marketplace_sync_state` (per-channel sync health, where `failing` means a
complete closet read returned nothing while listings are believed live).

**Why the tables have the columns they have.** A Poshmark order page carries the
buyer's name and shipping address. There is no jsonb payload column here and no
column that could hold either, and `sync-payload-guard_test.ts` pins the exact
column set so a later migration cannot quietly add one.

**Client-side read risk: NONE.** No frontend code in this commit reads these
tables. The web surfaces are US-2699 and are not built yet, so a Cloudflare
Pages auto-deploy on push cannot reach a table that is not there. The only new
reader is the edge route `POST /api/flipdesk/sync/observations`, which ships in
the same commit and goes out with the edge redeploy in step 2.

**Apply order**

1. Run `supabase/migrations/00632_marketplace_sync.sql`.
2. `NOTIFY pgrst, 'reload schema';` — three new tables, so PostgREST must be
   told or every call to the new route 404s at the schema cache.
3. Redeploy the edge (`EXPECTED_SCHEMA_VERSION` is now `00632`).

**Confirm it landed**

```sql
select table_name from information_schema.tables
where table_schema = 'public' and table_name like 'marketplace_sync%'
order by table_name;
-- expect: marketplace_sync_observations, marketplace_sync_reviews, marketplace_sync_state
```


## ✅ APPLIED (owner-confirmed 2026-08-20): 00631 — one spelling per Lululemon garment in the index (US-2714)

**Risk: LOW.** One `UPDATE` of three `brand_style_codes` rows, adding a
`canonicalFrom` key to their `extraction_rules`. No table, no column, no
function, no customer data. Guarded by `not (extraction_rules ? 'canonicalFrom')`
so a re-run touches nothing.

**What it does.** 00630 made all four spellings of a code decode. They still do
not share a KEY: the learned index files a code under whatever was transcribed,
so `W6AMYS`, `LW6AMYS`, `W6AMYSP60417` and `LW6AMYSP60417` are four rows in
`style_code_names`, `style_code_observations` and `style_code_sweeps`. A
consensus needs three agreeing titles per key, so splitting one garment four
ways can leave every fragment under the threshold and produce no name at all
from evidence that would have been enough.

`canonicalFrom` names the capture groups, in order, that concatenate to the one
spelling a code is filed under. The engine reads them from the RAW captures —
before the transforms turn `W` into `Women`, because a canonical code has to
stay a code — and uppercases the result.

⚠ **This migration is what makes the feature real.** `decodeTagCode` uses the
seeded specs INSTEAD of the in-code defaults once a brand has any; the in-code
copy is only the local fallback. `decoder-seed-parity_test.ts` fails if they
drift.

**Verified locally**: applied on top of a fresh 00630 stack, and all four
spellings now yield `canonicalCode = W6AMYS` through the DB-spec path.

**Not yet wired.** Nothing READS `canonicalCode` yet — the write and read sites
of the learned index still key on the transcription. That is the rest of
US-2714 and it changes no schema.

**Apply order**

1. Run `supabase/migrations/00631_lululemon_canonical_style_code.sql`.
2. Redeploy the edge (`EXPECTED_SCHEMA_VERSION` is now `00631`).

**Confirm it landed**

```sql
select decoder_kind, extraction_rules->>'canonicalFrom'
from public.brand_style_codes
where brand_key = 'lululemon' order by decoder_kind;
```

Expect `["gender", "style", "color"]` on the three `style_number*` rows and
nothing on `size_dot`.

## ✅ APPLIED (owner-confirmed 2026-08-20): 00630 — the whole size-dot string, not just the style number (US-2714)

**Risk: LOW.** Three `INSERT ... ON CONFLICT DO UPDATE` rows in
`brand_style_codes`. No table, no column, no function, no policy, no customer
data. Nothing client-side reads it.

**What it fixes.** The size dot carries more than the six-character style
number: `[L]` + the six characters beginning at the `W`/`M` + a colour letter +
a 5-6 digit manufacture date. `LW6AMYSP60417` = `L` + `W6AMYS` + `P` + `60417`.
Both seeded decoders anchored to the six characters alone, so the reading a
model actually produces — the extract prompt tells it to transcribe a style code
VERBATIM — matched nothing. The most complete transcription available was the
one that grounded no fields at all.

Three changes, all widening what is ACCEPTED, none changing what is DERIVED:
`style_number` and `style_number_2017` gain an optional leading `L`, and
`style_number_full` is new for the whole printed string.

**Verified locally**: applied to the local stack, and all four spellings of one
garment (`W6AMYS`, `LW6AMYS`, `W6AMYSP60417`, `LW6AMYSP60417`) now decode to the
same gender and the same style code, while `M7A83SX`, `M7A83S60417`,
`LLW6AMYS` and `buy my LW6AMYS now` still return nothing.

**Apply order**

1. Run `supabase/migrations/00630_lululemon_full_style_number.sql`.
2. `NOTIFY pgrst, 'reload schema';` — not strictly needed (no shape change).
3. Redeploy the edge (`EXPECTED_SCHEMA_VERSION` is now `00630`).

**Confirm it landed**

```sql
select decoder_kind, pattern from public.brand_style_codes
where brand_key = 'lululemon' order by decoder_kind;
```

Expect four rows, and the three `style_number*` patterns all starting `^L?`.

> [!note] Everything through 00629 is applied as of 2026-08-20.
> Every migration through **00629** is applied. Verified by asking the database
> rather than this file: `GET /health/ready` reports
> `{"expected":"00629","applied":"00629","status":"match"}`, which is the running
> edge reading `applied_migrations` through the service-role client.
>
> This file records INTENT; only the database records STATE. It has gone stale in
> both directions before — claiming HELD when prod had applied, and claiming
> applied when prod had not — and both times it was trusted and prod was not
> asked. One unauthenticated GET settles it.

## ✅ APPLIED 2026-08-20: 00629 — a seller's correction teaches the style-code index (US-2692)

**APPLIED, verified 2026-08-20.** `GET /health/ready` reports `{"expected":"00629","applied":"00629","status":"match"}` - the running edge reading `applied_migrations` through the service-role client, i.e. the database's own answer, not an inference from commit history. `status:"match"` with no `missing` key means every version up to and including this one landed (US-2620 reports a hole under the maximum as `incomplete`).

**Risk: LOW-MEDIUM, and the medium part is a trigger on `inventory_items`.** One
`plpgsql` function, one `AFTER UPDATE OF style` trigger, and one one-row `UPDATE`
of `brand_knowledge`. No new table, no backfill.

**Verified against a real schema, not reasoned about.** Applied to the local
stack at 00628 and exercised with five cases inside a transaction. Recorded:
a seller replacing a name WE proposed, and the same through an alias brand
spelling. Not recorded: a seller filling a style we never named, a one-word eBay
`Style` aspect ("Cargo"), and an item with no style code. The alias case failed
the first run and is what turned up the `brand_knowledge` bug below.

**Why a trigger.** The item editor writes `inventory_items` directly through the
supabase client under RLS (`src/pages/flipdesk/composer.tsx`), so a correction
never reaches the edge service and there is no handler to hook. The trigger
catches the web app, iOS and Android at once, and is tenant-safe by
construction: it only fires on a row the writer could already update.

⚠ **The trigger can never fail a seller's save.** Its body ends in
`EXCEPTION WHEN OTHERS THEN RAISE WARNING ... RETURN NEW`. A failure costs an
observation, not an edit. If you see `capture_style_code_name_correction failed`
in the Postgres log, that is the designed degradation, not an incident.

**It also repairs one `brand_knowledge` row, and that is not scope creep.**
00390 inserts lululemon with `aliases = ARRAY['lululemon','lulu']`, but its
`ON CONFLICT DO UPDATE` clause never updates `aliases` and 00389 had already
inserted the row — so prod has had `ARRAY['lululemon']` since the day 00390
applied. "Lulu" is what sellers type, and an unresolved alias gets its own brand
key, so a code learned from a "Lulu" item was never read back for a "Lululemon"
one. `brand-normalize.ts` gains the same alias in this commit so both sides
agree.

⚠ **The same UPDATE rewrites `tag_eras`, and it has to.** A later migration
added `CHECK (tag_eras_all_sourced(tag_eras))` as `NOT VALID`: existing rows are
grandfathered, but any row that is UPDATED gets re-checked. Lululemon's two eras
have a datable `years` and no per-era `source_url`/`confidence`, so the alias
repair alone fails with `brand_knowledge_tag_eras_sourced`. Same text, same
source the row already cites, now per-era.

**Apply order**

1. Run `supabase/migrations/00629_style_code_seller_corrections.sql`.
2. `NOTIFY pgrst, 'reload schema';`
3. Redeploy the edge (`EXPECTED_SCHEMA_VERSION` is now `00629`).
4. Then OK the push.

**Confirm it landed**

```sql
select array_to_string(aliases, ',') from public.brand_knowledge
where brand_key = 'lululemon';                    -- expect: lulu,lululemon
select tgname, tgenabled from pg_trigger
where tgname = 'capture_style_code_name_correction_trg';
```

## ✅ APPLIED 2026-08-20: 00628 — the resolved NAME for a style code, and where it came from (US-2691)

**APPLIED, verified 2026-08-20.** `GET /health/ready` reports `{"expected":"00629","applied":"00629","status":"match"}` - the running edge reading `applied_migrations` through the service-role client, i.e. the database's own answer, not an inference from commit history. `status:"match"` with no `missing` key means every version up to and including this one landed (US-2620 reports a hole under the maximum as `incomplete`).

**Risk: LOW.** One new table, one upsert function, no existing table touched,
nothing backfilled. Deny-all RLS, registered in `SERVICE_ROLE_ONLY`. No client
reads it; the extract path reaches it through the service-role client.

**What it is.** 00503 stores every listing title a code ever attracted, which is
evidence. `style_code_names` stores the ANSWER, one row per source, so the read
path does not recompute a consensus over a dozen titles on every extraction.

Four sources, arriving in four stories and disagreeing by design: `official`
(the brand's own name), `admin` (curated by hand), `seller` (a seller corrected
it on their own item), `consensus` (the run of words most listings share).
**Precedence lives in `lib/style-code-names.ts`, not in a rank column** — a
number in the table would be a second copy of the same rule, free to drift.

**No REVOKE on the function, on purpose.** Same US-2403 reason 00609 and 00627
carry: a denied call from `anon` or `authenticated` segfaults this Postgres
image and restarts the database.

**Apply order**

1. Run `supabase/migrations/00628_style_code_names.sql`.
2. `NOTIFY pgrst, 'reload schema';` — REQUIRED. New table and new RPC.
3. Redeploy the edge (`EXPECTED_SCHEMA_VERSION` is now `00628`).
4. Then OK the push.

**Confirm it landed**

```sql
select proname from pg_proc where proname = 'record_style_code_name';
select source, count(*) from public.style_code_names group by source;
```

Empty on a fresh apply. The `consensus` count is what the sweep fills; if it is
still zero a day after the sweep task is live, the sweep is finding titles but
never three that agree, and that is a finding about the codes, not a bug.

## ✅ APPLIED 2026-08-20: 00627 — sweep bookkeeping for the learned style-code index (US-2690)

**APPLIED, verified 2026-08-20.** `GET /health/ready` reports `{"expected":"00629","applied":"00629","status":"match"}` - the running edge reading `applied_migrations` through the service-role client, i.e. the database's own answer, not an inference from commit history. `status:"match"` with no `missing` key means every version up to and including this one landed (US-2620 reports a hole under the maximum as `incomplete`).

**Risk: LOW, with one thing to watch.** One new table, two `SECURITY DEFINER`
functions, and one index on an existing table. Nothing is altered or backfilled
and no client reads any of it — the sweep cron is the only reader and writer.
Deny-all RLS, registered in `SERVICE_ROLE_ONLY` in `rls-guard_test.ts`.

⚠ **The one thing to watch** is the index, because it is the only statement here
that touches a big existing table:

```sql
CREATE INDEX IF NOT EXISTS inventory_items_style_code_idx
  ON public.inventory_items ((attributes->>'style_code'))
  WHERE attributes->>'style_code' IS NOT NULL;
```

A plain `CREATE INDEX` takes a lock that blocks writes to `inventory_items` for
its duration. On a partial expression index over a table this size that is
seconds, not minutes, but if you would rather not block seller writes at all,
run that one statement separately as `CREATE INDEX CONCURRENTLY` (outside a
transaction, and it cannot be the form in the migration file — `CONCURRENTLY`
is not allowed inside one) and let the `IF NOT EXISTS` in the migration find it
already there.

**Why it exists.** 00503 records what the market CALLED a code. It cannot
record that a code was looked up and the market said nothing, because a zero-hit
sweep produces no title and therefore no row. Without that fact the new
background sweep re-queries its own dead ends forever, which is the whole eBay
budget spent on the codes least likely to resolve.

`style_code_sweeps` holds one row per (brand, code) attempted, whatever the
outcome: `sweep_count`, `titles_found` (of the most recent attempt),
`last_swept_at`, and `last_hit_at`, which only ever moves forward so a later
miss cannot erase the fact that a code once resolved.

**Apply order**

1. Run `supabase/migrations/00627_style_code_sweeps.sql`.
2. `NOTIFY pgrst, 'reload schema';` — REQUIRED here. A new table and a new RPC,
   so PostgREST will 404 `record_style_code_sweep` until it reloads.
3. Redeploy the edge on Coolify (`EXPECTED_SCHEMA_VERSION` is now `00627`).
4. Add the Coolify scheduled task — `style-code-sweep`, `35 * * * *`, POST
   `/api/jobs/style-code-sweep` with `X-Internal-Job-Secret`. Code without the
   scheduled task is a sweep that never runs. The row is in `CRON_SETUP.md`.
5. Then OK the push.

**Confirm it landed**

```sql
select count(*) from public.style_code_sweeps;                -- 0 on a fresh apply
select proname from pg_proc
where proname in ('record_style_code_sweep', 'style_code_sweep_candidates');
select count(*) from public.style_code_sweep_candidates(20000);  -- distinct codes we know
```

That last count is the backlog the sweep is working through, and it is the
number worth writing down before the first run so the second one can be
compared against it.

Then hit the endpoint once by hand; a first run on a cold table should report
`swept` greater than 0 and `skipped_cooldown` of 0.

## ✅ APPLIED 2026-08-20: 00626 — Lululemon style numbers from 2017-2019 decode to nothing (US-2689)

**APPLIED, verified 2026-08-20.** `GET /health/ready` reports `{"expected":"00629","applied":"00629","status":"match"}` - the running edge reading `applied_migrations` through the service-role client, i.e. the database's own answer, not an inference from commit history. `status:"match"` with no `missing` key means every version up to and including this one landed (US-2620 reports a hole under the maximum as `incomplete`).

**Risk: LOW.** One `INSERT ... ON CONFLICT DO UPDATE` of a single row into
`public.brand_style_codes`. No table, no column, no function, no policy, no
customer data. Nothing reads a new column, so the frontend auto-deploy on push
cannot break on it.

**What it fixes.** `brand_style_codes` carries one Lululemon `style_number`
decoder (seeded by 00390) and its pattern REQUIRES the `.SSYY` season/year
block:

```
^(?<gender>[WM])(?<style>[A-Z0-9]{3,5})(?<color>[A-Z])\.(?<season>0[1-4])(?<year>\d{2})$
```

Lululemon only started printing that block in 2019. Codes from Jan 2017 to Jan
2019 are the same `W|M` + code + colour-initial body with nothing after it
(`M7A83S`, `W6AVBS`), so every garment from those two years matched no decoder
at all: no brand confirmation, no gender, and no anchor for the learned style
index. 00626 adds a second row, `decoder_kind = 'style_number_2017'`, anchored
to exactly six characters at confidence 0.85 (lower than the 2019+ spec because
it grounds fewer fields — gender and the code, never season or year).

**Why a second row and not a looser pattern.** The two are anchored to
different lengths, so they can never compete, and a 2019+ code still decodes
against the more specific spec with its season and year intact.
`decodeTagCode` returns the first match and the `brand_style_codes` unique key
is `(brand_key, decoder_kind)`, so ordering is irrelevant either way.

**Note the code-side fallback also changed.** `DEFAULT_DECODER_SPECS` in
`services/edge-functions/src/lib/brand-decoders.ts` carries the same new spec.
`decodeTagCode` ignores the in-code defaults entirely when DB specs exist for a
brand, so both had to move or the fix would depend on which path ran.

**Apply order**

1. Run `supabase/migrations/00626_lululemon_2017_style_number_decoder.sql`.
2. `NOTIFY pgrst, 'reload schema';` — not strictly needed (no shape change),
   but harmless and keeps the habit.
3. Redeploy the edge on Coolify (`EXPECTED_SCHEMA_VERSION` is now `00626`).
4. Then OK the push.

**Confirm it landed**

```sql
select decoder_kind, pattern, confidence
from public.brand_style_codes
where brand_key = 'lululemon'
order by decoder_kind;
```

Expect three rows: `size_dot`, `style_number`, `style_number_2017`.

## ✅ APPLIED 2026-08-19: 00625 — the connector is denied on the plans that include it (US-2687)

**Applied to production by the owner on 2026-08-19 and verified in the same
sitting.** The confirmation query returned exactly the expected shape:

```
business | true
free     | false
pro      | true
starter  | false
```

So Pro and Business sellers can reach the connector for the first time since
US-9124 shipped the gate. Kept here rather than deleted because the next reader
of this file needs to know it LANDED, not just that it stopped being pending.

**Risk: LOW, and the do-nothing risk is higher.** Two `UPDATE`s against four
rows of `public.pricing_plans`. No table, no column, no function, no policy, no
backfill of customer data.

**What it fixes, measured rather than reasoned.** On the local stack today:

```
select key, gate_flags ? 'connectorAccess' from public.pricing_plans;
 business | f
 free     | f
 pro      | f
 starter  | f
```

`pricing_plans.gate_flags` is CANONICAL once the row exists — `pricing-config.ts`
`load()` overwrites the hardcoded `FALLBACK_MATRIX` with the DB row — and the read
is `gateFlags[k] = flags[k] === true`. So an absent key is a hard **false on every
tier**, including the two sold with the connector. A Business seller calling it is
told *"The GradeThread connector is not included in this plan … see pricing to
upgrade"*, which is an upgrade prompt shown to the customer already on the top tier.

`connectorAccess` was added to the code in US-9124 and the migration was never
written. Nothing errored, and no unit test went red, because every test that does
not use a database reads the fallback and sees the flag set.

**Apply order: any.** Nothing in this commit's code depends on the rows changing.
The code has been reading this key since US-9124; this migration is what makes the
answer correct.

**`NOTIFY pgrst, 'reload schema';` NOT required.** No table, column or RPC changed
— only row data. Running it anyway is harmless.

**Safe to re-run, and proven so.** A second pass reports `UPDATE 0 / UPDATE 0 /
INSERT 0`. Both statements carry `and not (gate_flags ? 'connectorAccess')`, so an
operator who has deliberately turned the flag OFF on a tier keeps their value —
tested by setting `pro` to false by hand and re-running, which left it false. That
is the same posture as 00166, 00607 and 00623's `ON CONFLICT DO NOTHING`.

**How to confirm afterwards:**

```sql
select key, gate_flags->>'connectorAccess' from public.pricing_plans order by key;
-- expect: business true, free false, pro true, starter false
```

**Also watch:** the `Tenant Isolation` GitHub workflow has failed on every commit
since 2026-08-19 12:47 on the case *"MCP: A's own key CAN read A's item"*. It reads
like an authorization failure and is this plan gate. It should go green once the
CI database is seeded from the migration directory.


## ✅ APPLIED 2026-08-20: 00624 — disputes INSERT must own the grade report (US-2670)

**APPLIED, verified 2026-08-20.** `GET /health/ready` reports `{"expected":"00629","applied":"00629","status":"match"}` - the running edge reading `applied_migrations` through the service-role client, i.e. the database's own answer, not an inference from commit history. `status:"match"` with no `missing` key means every version up to and including this one landed (US-2620 reports a hole under the maximum as `incomplete`).

**Risk: LOW.** Adds one SECURITY DEFINER helper (`grade_report_belongs_to`) and
re-creates the two `disputes` INSERT policies with an extra AND. No table, no
column, no data rewrite, no backfill. Both policies are dropped with `IF EXISTS`
first, so re-running the directory is safe.

**What it closes.** Both INSERT policies gated on the `user_id` column alone, so
an authenticated caller who set `user_id` to their OWN id could file a dispute
against ANY grade report id that exists, including another seller's.
`routes/grade.ts` has always loaded the submission scoped to the owner before
filing, so every client going through the route was already safe. This closes
the direct-PostgREST path, which is what iOS was using when it was found.

**No urgency in the apply order, and nothing breaks if it lands late.** No code
in this commit depends on the new function existing.

**`NOTIFY pgrst, 'reload schema';` not required.** The new function is only ever
called from inside the two RLS policies, which Postgres evaluates itself. Nothing
calls it as an RPC, so PostgREST's schema cache is not in the path. Running the
NOTIFY anyway is harmless.

**No REVOKE, deliberately.** The helper is an RLS predicate, so it runs as the
QUERYING role and must stay executable by `anon` and `authenticated`, exactly like
`is_workspace_member_with_role`. Revoking it would both break RLS and arm the
US-2403 segfault. The explicit GRANT states the `CREATE FUNCTION` default rather
than widening anything; it is there because the US-2282 AC4 guard requires every
SECURITY DEFINER function to name its callers.

**Workspace filing still works.** The check is on the ROW's `user_id`, not on
`auth.uid()`, so a member filing for the workspace owner passes as long as the
report belongs to that owner.

**After applying, run this read-only census (US-2670 AC4).** A non-zero count
means the hole was actually used and those disputes need looking at:

```sql
select d.id, d.user_id as filer, s.user_id as report_owner, d.created_at
from public.disputes d
join public.grade_reports gr on gr.id = d.grade_report_id
join public.submissions s on s.id = gr.submission_id
where s.user_id <> d.user_id;
```

**Rollback is clean.** Re-create the two policies without the
`grade_report_belongs_to(...)` conjunct; the helper can be left in place.

---

## ✅ APPLIED (owner-confirmed 2026-08-19): 00622 — ebay_search_terms (US-2683)

> **Applied by the operator on 2026-08-19**, together with 00621. Not measured
> from here: this session's network policy refuses `functions.gradethread.com`,
> so `/health/ready` could not be read. Owner-confirmed is the status, and it
> is the weaker of the two on purpose.
>
> **Two things the SQL does not do by itself.** `NOTIFY pgrst, 'reload schema';`
> is required — a new table PostgREST has not reloaded answers 404 on every
> read. And the daily `ebay-search-terms` Coolify task (06:25 UTC, POST to
> `/api/jobs/ebay-search-terms` with the job secret) has to be created; the
> block is in `services/edge-functions/CRON_SETUP.md`. Confirm both before
> treating the feed as live.

**Risk: low.** One new table, its unique key, one index, an updated_at trigger
and one RLS SELECT policy. Nothing existing is altered and nothing is dropped.
All `IF NOT EXISTS` / `DROP ... IF EXISTS` before `CREATE`, so re-running the
directory is safe.

**What it is for.** The queries buyers actually typed against a seller's items,
from eBay Promoted Listings reports. Every other demand signal FlipDesk has is
inferred from other sellers' listings; this is the only one that is not.

**Apply order:** after 00621. It does not depend on it, but applying in file
order keeps `applied_migrations` contiguous.

```sql
-- supabase/migrations/00622_ebay_search_terms.sql
NOTIFY pgrst, 'reload schema';
```

**The edge REQUIRES this before its next deploy.** `lib/ebay-ad-reports.ts`
reads and upserts `ebay_search_terms`, and the daily `ebay-search-terms` cron
calls it. Against a database without the table those calls fail — the cron
reports failures rather than the clean `no_campaign` it should. The boot guard
covers it (`EXPECTED_SCHEMA_VERSION` moves 00621 → 00622 in the same commit),
but apply the SQL first.

**Nothing in the frontend reads it directly**, so a Pages deploy ahead of the
SQL is harmless: the composer chips simply show mined terms, which is what they
showed before.

**One new Coolify task**: `ebay-search-terms`, daily at 06:25 UTC, POST to
`/api/jobs/ebay-search-terms` with the shared job secret. The regenerated block
is in `services/edge-functions/CRON_SETUP.md`.
## ✅ APPLIED (owner-confirmed 2026-08-19): 00621 — listings.demand_terms_detail (US-2675)

> **Applied by the operator on 2026-08-19**, together with 00622. Owner-confirmed
> rather than measured, for the reason under 00622.
>
> `NOTIFY pgrst, 'reload schema';` is required here too. This one is a COLUMN,
> and PostgREST rejects the whole listing insert with PGRST204 if its cache has
> not seen it — draft generation fails outright, not partially. If drafts start
> failing after this apply, the reload is the first thing to check, not the SQL.

**Risk: low to apply, but the edge REQUIRES it.** The SQL itself is one
nullable `jsonb` column on `public.listings` plus a column comment: no backfill,
no constraint, no index, nothing dropped, every existing row reads NULL.
`ADD COLUMN IF NOT EXISTS`, run twice against the local stack to prove it.

⚠️ **The hard dependency is the edge write, not the frontend read.**
`services/edge-functions/src/lib/ai-listing.ts` puts `demand_terms_detail` into
the listing insert payload unconditionally. Against a database without the
column PostgREST rejects the WHOLE write (PGRST204), so draft generation fails
outright rather than merely losing the provenance. The boot guard covers this in
practice (an edge image expecting 00621 refuses to start behind that version),
but apply the SQL before the edge deploys and do not treat the write as
optional.

**What it is for.** The demand-term miner now reads titles of items that SOLD,
not only active listings, and ranks by how much more common a term is among the
sold ones. `demand_terms` (text[], 00154) keeps only the words, so the new
column records `[{term,count,source,lift}]` alongside it. Both are written;
nothing reads only the new one.

**Apply order:** any time. It does not depend on another held migration.

```sql
-- supabase/migrations/00621_listing_demand_terms_detail.sql
NOTIFY pgrst, 'reload schema';
```

⚠️ **The frontend READS this column, so the push order matters.**
`src/pages/flipdesk/composer.tsx` reads `listing.demand_terms_detail` to mark a
keyword chip as sold-backed, and Cloudflare Pages auto-deploys on push. It is
written defensively (`?? listing?.demand_terms ?? []`), so a frontend that
deploys before the column exists degrades to unmarked chips rather than
breaking — but apply the SQL first anyway, so nobody has to rely on that.

**Edge:** `EXPECTED_SCHEMA_VERSION` moves 00620 → 00621 in the same commit, so
the edge boot guard will expect 00621 on its next Coolify deploy.


> [!important] 00610–00620 ARE APPLIED. Measured 2026-08-19, not assumed.
>
> `GET https://functions.gradethread.com/health/ready` reports
> `schema { expected: "00620", applied: "00620", status: "match" }`, and the
> deployed edge expects 00620 — so the migrations landed AND the edge that needs
> them is running. **Nothing is held.**
>
> The 2026-08-17 measurement below, which read 00617 on both sides, is kept
> because the anon-probe table under it is the evidence for 00610–00616 and is
> not re-derivable from a version number.
>
> **The guards were checked from OUTSIDE, which is the part that matters.** A
> recorded version proves a file ran, not that it worked — that is the whole
> 00611 lesson. So the public anon key (the one in the browser bundle) was used
> to POST each argument-less guarded function:
>
> | function | before | now |
> |---|---|---|
> | `ai_spend` | 200 + data | **401** |
> | `reconciliation_candidates` | 200 + **customer emails** | **401** |
> | `ai_profitability` | 200 + data | **401** |
> | `retention_cohorts` | 200 + data | **401** |
> | `ai_budget_status` | 200 + data | **401** |
> | `drip_analytics` | 200 + data | **401** |
> | `newsletter_analytics` | 200 + data | **401** |
> | `data_integrity_scan` | 200 + data | **401** |
>
> `admin_revoke_user_sessions` is present in the schema cache, so impersonation
> stop has a working mechanism in production.
>
> ⚠️ **The nine credit functions in 00615 are NOT verified this way, deliberately.**
> They all take arguments, so an argument-less POST answers 404 on signature
> alone and proves nothing. Verifying them from outside means making a
> WRITE-SHAPED call to production — and the entire premise is that they might
> not be guarded, so that call could mint credits. Their guards were proven on
> the local stack (anon refused 42501 on all nine, including a demonstrated
> `0 → 999` exploit); confirming prod needs a service-role session, not a probe.

---
## ✅ APPLIED (measured 2026-08-19): 00623 — seed the `claude_connector` kill-switch row (US-9127 AC7)

> Applied the same day it was written. `/health/ready` reports
> `expected: "00623", applied: "00623", status: "match"`, so the SQL landed and
> the edge that expects it is running. The flag row is in the same file as the
> self-record, so a recorded 00623 means the row exists.

**Risk: NONE that I can find.** One INSERT of one row into `public.feature_flags`,
`on conflict (key) do nothing`. No schema change, no existing row touched.

**Behaviour-neutral by construction.** The flag is read fail-open and a missing
row already resolves to enabled, so seeding `enabled = true` changes nothing at
runtime. What it changes is REACHABILITY: the admin console lists rows, and the
toggle endpoint answers 404 "Unknown feature flag" when there is none — so
without this row the connector's kill switch exists in the type system and
nowhere an operator can press it during an incident. That is exactly what 00607
was written to fix for four other flags.

**`NOTIFY pgrst, 'reload schema';` is NOT required.** No new table, no new
column, no new function signature. Nothing about what PostgREST exposes changes.

**The frontend deploy is harmless.** Nothing in `src/` reads this row.

**Apply order:** anywhere after 00622. It depends on nothing.

**Verified on the local stack, not assumed.** Applied twice (the second run
inserts 0 rows, so it is idempotent), then the switch was driven end to end:
authenticated `tools/list` returned **200**, the flag was set to false, and
within the 30-second cache TTL the same call returned **404**; setting it back
returned **200**. That is the rollback plan working, not described.

⚠ **Do not test it with an unauthenticated call.** Those return 401 whether the
connector is on or off, because the auth middleware runs before the gate. I made
that mistake first and briefly concluded the switch was broken.

**Rollback:** `delete from public.feature_flags where key = 'claude_connector';`
The flag then resolves to its fail-open default, which is where it was before.

---
During the pre-production sprint, migration commits go to `origin/main` AND get
an entry here; the operator applies the SQL to prod on its own schedule. A 🟠
entry is on origin and NOT yet in the production database.

**No held entries as of 2026-08-19.** 00621, 00622 and 00623 are all applied.
The first two are owner-confirmed rather than measured; see their entries.

**Keep this even when the count is zero.** The line that used to sit here said
"everything through 00623 is applied", which was true when written and became
false the moment two HELD entries were added above it. A status line dated at
the top of a file people trust is worth re-reading before every apply, because
`compareSchemaVersion` will not catch a stale one: it reads the HIGHEST applied
version, so an applied 00623 reports `status: "match"` while lower numbers are
missing. The check that sees a gap is `checkSchemaCompleteness`, published on
`/health/ready` as `schema.missing`, and it is advisory rather than fatal
(US-2009). Read that field, not the status.

## ✅ APPLIED (measured 2026-08-19): 00620 — OAuth authorization server storage (US-9122)

> **Applied by the operator on 2026-08-19**, together with 00618 and 00619, and
> the edge deployed alongside them. `/health/ready` reports
> `expected: "00620", applied: "00620", status: "match"`, so the SQL landed and
> the container that needs it is running.
>
> ⚠ **A matching version proves the FILES ran, not that they work** — that is the
> 00611 lesson and it applies here too. What is NOT probed from outside: the five
> tables are deny-all with no policies, so an anon read returning nothing is the
> same answer whether RLS is right or the table is empty, and it is empty. The
> guards were proven on the local stack instead (see below). The OAuth flow stays
> off behind `MCP_OAUTH_ENABLED`, so nothing reads or writes these tables in
> production yet — the first real exercise of them is US-9121/US-9123.

**Risk: LOW.** Five new tables, eight indexes, two CHECK constraints and one
operator function. Nothing existing is altered and no row is rewritten. All
five tables start empty and only the edge writes to them.

**`NOTIFY pgrst, 'reload schema';` IS required.** Five new tables and a new
function signature change what PostgREST exposes, and the edge reads and
writes these through it.

**The frontend deploy is harmless on its own.** Nothing in `src/` touches
these tables, and the OAuth flow itself is behind `MCP_OAUTH_ENABLED`, which
is off. Applying this migration does not turn anything on.

**Deny-all RLS on all five, deliberately.** No policies at all: readable,
they are a map of which sellers connected what and when; writable, a caller
could mint their own grant and skip the consent screen, which is the one
thing an authorization server must not allow. All five are registered in
`SERVICE_ROLE_ONLY` in `rls-guard_test.ts`, and the owner columns are named
`owner_user_id` per the rls-guard discovery convention.

**Every secret is stored hashed** — authorization codes and refresh tokens as
a hex SHA-256 (HMAC-with-pepper when `API_KEY_PEPPER` is set), the same way
`api_keys.key_hash` works. No code path needs the plaintext back.

**NO REVOKE in this file**, for the reason 00527 is permanently blocked
(US-2403). `sweep_oauth_expired()` guards in its body with an `auth.role()`
check raising 42501, as 00615, 00617 and 00619 do. Verified on the live local
stack: calling it as `anon` raises `sweep_oauth_expired: service role
required`.

**Verified locally, not assumed.** Applied twice (idempotent: the second run
inserts 0 rows). All four tables confirmed with `relrowsecurity = true` and
zero policies. The store's reads and writes were then exercised against these
tables for real — code redemption, refresh rotation, and reuse detection
revoking the grant with a reason — 4 passed / 0 failed.

**Rollback is clean:** drop the five tables (codes, refresh and access tokens cascade
from grants; grants and codes cascade from clients) and
`DROP FUNCTION public.sweep_oauth_expired();`. Nothing else references them,
and no seller has authorized anything yet because the flow is off.

---
## ✅ APPLIED (measured 2026-08-19): 00619 — MCP connector tool-call audit log (US-9113)

> **Applied by the operator on 2026-08-19.** `/health/ready` reads 00620 on both
> sides, which covers this file too.
>
> ⚠ **The one thing worth re-checking here is NOT re-checkable from outside, and
> it does not need to be.** The prod risk this migration carried was a denied
> call restarting the database (US-2403), and that risk came from a `REVOKE`
> which the shipped version does not contain — all three roles hold EXECUTE and
> the refusal happens in the body as a 42501. That is a property of the SQL text,
> already verified by reading it and by driving anon against it on the local
> stack, so a prod probe would add nothing and would mean POSTing to a function
> whose whole point is that it might not be guarded.
>
> **The retention sweep now HAS a caller** (2026-08-19): `handleDataRetentionCron`
> invokes `sweep_mcp_tool_calls` and `sweep_oauth_expired` nightly. The
> paragraph below saying nothing calls it on a schedule was true when written.

**Risk: LOW.** One new table, three indexes, one CHECK constraint and one
operator function. Nothing existing is altered, no row is rewritten, no
column is added to a table that already has data. The table starts empty and
only the edge writes to it.

**Apply order: after 00618, before the edge deploy.** The edge boot guard
expects 00619 once the new container ships, so the SQL must land first or the
container refuses to start (there is a ~40s grace window, US-778).

**`NOTIFY pgrst, 'reload schema';` IS required.** A new table and a new
function signature both change what PostgREST exposes, and the edge writes
audit rows through it. Without the reload the insert 404s on an unknown
relation — which is survivable, because the write is fire-and-forget and a
failure only costs the audit row, but it means the connector runs unaudited
until someone notices.

**The frontend deploy is harmless on its own.** Nothing in `src/` reads this
table. The seller-facing view of connector activity is US-9119 and does not
exist yet.

**Deny-all RLS, deliberately.** No policies at all: readable, the table is a
map of every seller's connector activity; writable, a caller could fabricate
the record that would exonerate them, which is the one thing an audit log
must not allow. Registered in `SERVICE_ROLE_ONLY` in `rls-guard_test.ts`. The
owner column is `owner_user_id` per the rls-guard discovery convention.

**Retention is 400 days**, enforced by `public.sweep_mcp_tool_calls(days)`.
It is `SECURITY DEFINER` and guarded IN THE BODY with an `auth.role()` check
that raises 42501 — deliberately **not** by a `REVOKE`. The first draft of
this migration used a revoke, which is the pattern 00527 is permanently
blocked for (US-2403): on this Postgres image a denied call from a role in
`supautils.hint_roles` segfaults the backend and restarts the database, and
this function is argument-defaulted and in `public`, so the anon key in the
browser bundle can reach it. 00615 and 00617 made the same call. Nothing
calls the sweep on a schedule yet — wire it into the maintenance cron when
the connector has real traffic; until then the table grows, which for an
empty table is not a problem.

**Verified on the local stack, not assumed.** Applied twice against
`supabase_db_gradethread` (idempotent: the second run inserts 0 rows), then
three real tool calls were driven through `/mcp` and the rows checked:

| tool | status | error_code | arguments_redacted |
|---|---|---|---|
| `gradethread_usage` | ok | | `{}` |
| `gradethread_nope` | refused | unknown_tool | `{}` |
| `gradethread_get_item` | refused | invalid_arguments | `{"item_id": 123}` |

**Rollback is clean:** `DROP TABLE public.mcp_tool_calls;` and
`DROP FUNCTION public.sweep_mcp_tool_calls(integer);`. Nothing references
either, so nothing else breaks. You lose the audit history, which is the
point of the table but not a dependency of anything.

---
## ✅ APPLIED (measured 2026-08-19): 00618 — allow `escalation_trigger = 'crisis'` (US-2667)

> **Applied by the operator on 2026-08-19.** `/health/ready` reads 00620 on both
> sides, which covers this file.

**Risk: LOW.** One CHECK constraint on `support_conversations` is dropped and
re-added one value wider (`'model','auto','user'` -> plus `'crisis'`). No column
is added, no row is rewritten, no index is touched. Every existing row already
satisfies the wider constraint, so the ADD cannot fail on legacy data.

**Apply BEFORE the edge deploy.** The crisis path writes
`escalation_trigger = 'crisis'`. Against the old constraint that INSERT/UPDATE
raises 23514 inside `performEscalation`, which runs after the user has already
been shown the crisis resources - so the person still gets the numbers, but the
handoff to a human silently fails. That is the one failure mode worth avoiding
here, and applying first avoids it entirely.

**`NOTIFY pgrst, 'reload schema';` NOT required.** No table, column or function
signature changed; PostgREST does not cache CHECK constraints.

**The constraint name is discovered, not assumed.** 00188 created it inline via
`ADD COLUMN ... CHECK (...)`, so Postgres named it. The migration drops every
check constraint on the table whose definition mentions `escalation_trigger`
rather than hard-coding `support_conversations_escalation_trigger_check` and
failing on a database where it landed as `..._check1`.

**Rollback is clean**, unlike an enum: drop the constraint and re-add it with
the three original values. Any `'crisis'` rows written in between would then
violate it, so narrow it only after checking
`select count(*) from support_conversations where escalation_trigger = 'crisis'`.

**The frontend deploy is harmless on its own.** `src/pages/admin/support.tsx`
widens a TypeScript union and renders a badge when it sees `'crisis'`; it never
writes the value and does not filter on it.

---

## ✅ APPLIED (measured 2026-08-17): 00616 — two SQL functions a plain guard could not reach (US-2282)

**Risk: LOW, and equivalence is measured rather than argued. Apply third of these three.**

`NOTIFY pgrst` **NOT required** — `CREATE OR REPLACE`, signatures unchanged.

`drip_analytics` and `newsletter_analytics` are `LANGUAGE sql`, so there is no
`BEGIN` block to insert a guard into and no `RAISE` available. Each is converted
to `plpgsql` with the **same query inside** — signature, volatility,
`SECURITY DEFINER` and `search_path` all carried through. Output hashed with
fixed arguments before and after: same digests.

⚠ **This file used to carry four more functions and no longer does.**
`data_integrity_scan`, `north_star_weekly_counts`, `north_star_lifetime_counts`
and `refund_snap` are converted by **00611** above, which landed on `main`
first. Two migrations `CREATE OR REPLACE`-ing one function is worse than an
error: whichever applies last silently wins, so the file you read is not
necessarily the body that runs. 00611 owns those four; this file owns two.

**The shortcut that was rejected:** leaving them as SQL and bolting the check on
as a predicate (`WHERE assert_service_role(...) AND …`) fails on evaluation
order — if the planner satisfies the other predicates first and the result is
empty, the assert never runs and an unauthorised caller gets a **silent empty
result** instead of an error. Worse than the leak.

---

## ✅ APPLIED (measured 2026-08-17): 00615 — nine credit functions had no authorization check at all (US-2282)

**Risk: LOW. Guard inserted after each function's own `BEGIN`; bodies untouched.**

`NOTIFY pgrst` **NOT required** — `CREATE OR REPLACE`, signatures unchanged.

`grant_grade_credits`, `debit_grade_credits`, `grant_api_credits`,
`debit_api_credits`, `grant_appstore_credits`, `grant_buyer_reward_credit`,
`issue_buyer_reward_credit`, `redeem_buyer_reward_credit` and
`refund_buyer_reward_credit` had **no guard of any kind** — not a weak one, none.

Verified against the local stack: anon refused 42501 on all nine, including a
demonstrated exploit moving a balance `0 → 999`; the service role still mints and
debits normally (balance 5, then 3 after a debit).

`refund_grade` calls `refund_buyer_reward_credit`, and that path was run rather
than reasoned about: the service role reached a 23503 FK error (so it passed the
guard) and anon got 42501 (so the wrapper is not a bypass).

---

## ✅ APPLIED (measured 2026-08-17): 00614 — six analytics functions answer an anonymous caller (US-2282)

**Risk: LOW. The guard line only; every body is the live definition.**

`NOTIFY pgrst` **NOT required** — `CREATE OR REPLACE`, signatures unchanged.

`ai_spend`, `ai_profitability`, `funnel_metrics`, `retention_cohorts`,
`ai_budget_status` and `reconciliation_candidates` shipped the guard shape that
reads as a check and is not one:

```sql
if auth.uid() is not null and not public.is_admin() then raise ... end if;
```

An anonymous caller has no `auth.uid()`, so the condition is false and the
document is returned. It only ever constrained users who were signed **in**.
`reconciliation_candidates` returns **customer email addresses**.

Replaced with the positive allowlist already proven on `admin_revenue_metrics`
and `revenue_dashboard`. See
[`vault/20-domain/security-definer-caller-allowlist.md`](vault/20-domain/security-definer-caller-allowlist.md).

### Apply order for these three

`00614`, then `00615`, then `00616`. All three assert their own effect before the
footer records the version, so a run that does not take hold cannot record itself
as applied — use `psql -v ON_ERROR_STOP=1`.

---
## ✅ APPLIED (measured 2026-08-17): 00613 — record the delivered pixel dimensions (US-2135 AC3)

**Risk: VERY LOW. Two nullable columns, no backfill, no constraint.**

`NOTIFY pgrst, 'reload schema';` **required** — it adds columns to a table the
API exposes, so PostgREST will not return `width`/`height` until the cache
reloads. Nothing breaks meanwhile; the columns simply do not appear.

### What it does

Adds `width int` and `height int` to `public.submission_images`, both nullable.

`validateImageUpload()` has always parsed width and height out of the
JPEG/PNG/WebP header — it needs them for the decompression-bomb ceiling and the
US-529 minimum-long-edge floor — and `grade.ts` was discarding them. This is the
column to keep them in. **Nothing new is measured.**

### Why it is server-observed, unlike the column beside it

`quality_score` is measured client-side on the compressed bytes and sent in the
form, so an older client or a canvas that cannot decode sends nothing. Width and
height are parsed from the bytes the server is about to store, so they need no
client cooperation to start working and cannot be overstated by one.

### NULL means unknown, and must never be read as 0

Two ways a row has no dimensions: it predates this migration, or its format's
header is one the parser does not read (it returns null rather than guessing).
`Number(null)` is `0` and finite, so a naive reader turns "unknown" into "worst
possible" — the same coercion trap that produced a fake `-9` factor delta in
US-2443.

### Apply order

1. After 00612. Idempotent (`ADD COLUMN IF NOT EXISTS`), safe to re-run.
2. `NOTIFY pgrst, 'reload schema';`
3. Redeploy the edge (boot guard now expects `00613`).

Old rows stay NULL on purpose. A backfill would have to re-download every stored
image to read its header, and the value of a historical dimension is low enough
that it is not worth the egress.

### Verify after applying

```sql
select count(*) filter (where width is not null) as measured,
       count(*)                                  as total
from public.submission_images;
-- measured climbs from 0 as new submissions land; total is unchanged.
```

### Verified locally

Applied to the local stack; both columns present and nullable. 5 new cases in
`src/tests/submission-image-dimensions_test.ts`, one of which parses a real 1x1
PNG through `validateImageUpload` rather than mocking it, so "the validator
returns dimensions" is asserted rather than assumed. Sabotage-verified by
dropping the video-frame loop's two lines, which reddened 2 cases naming that
loop; restored.

## ✅ APPLIED (measured 2026-08-17): 00612 — a revocation mechanism that exists (US-2662)

**Risk: LOW to apply. Apply AFTER 00611. Ships with edge code that CALLS it.**

`NOTIFY pgrst, 'reload schema';` **REQUIRED.** This adds a new RPC, and
PostgREST will answer 404 for `admin_revoke_user_sessions` until its schema
cache is reloaded.

### What it does

Adds `public.admin_revoke_user_sessions(p_user_id uuid) returns int` — deletes
the user's rows from `auth.refresh_tokens` and `auth.sessions`, returning the
session count. `SECURITY DEFINER`, service-role only, and the check is in the
BODY (no `REVOKE`: US-2666 and US-2403).

### Why it exists

Stopping impersonation called GoTrue's `POST /admin/users/{id}/logout`. That
route **does not exist** on GoTrue v2.195.0 — 404, with `GET /admin/users/{id}`
answering 200 as the control, so auth, routing and the id were all fine. Every
stop returned `sessions_revoked: false` and the admin's copy of the target's
refresh token stayed live for its full lifetime. US-2351 AC2 read as done and
was not true.

Deleting `auth.sessions` does revoke: refresh tokens hang off sessions, and a
refresh answered 200 before the delete and 400 `refresh_token_not_found` after.
It needs a function because PostgREST only exposes the schemas in its config
(`supabase/config.toml:5` lists `public` and `storage`), so a client call into
`auth` answers 406.

### ⚠ Order matters here, unlike 00610 and 00611

The edge in this commit calls the RPC as a fallback. If the frontend and edge
deploy before the SQL applies, a stop where GoTrue 404s will find no RPC either
and report `revoked: false` — which is exactly the current behaviour, so it
degrades to the status quo rather than breaking. But the fix is not live until
the migration is applied AND `NOTIFY pgrst` has run.

### Apply order

1. 00610, 00611, then 00612. All idempotent, safe to re-run.
2. `NOTIFY pgrst, 'reload schema';` — required for 00612.
3. Redeploy the edge (boot guard now expects `00612`).

### Verify after applying

```sql
-- service_role gets a count; anon and authenticated get 42501.
select public.admin_revoke_user_sessions('00000000-0000-0000-0000-000000000000'::uuid);
```

To confirm the `NOTIFY pgrst` actually landed — without calling a function that
deletes sessions — read PostgREST's own OpenAPI document. It reports the
signature **as the schema cache currently holds it**, so the RPC appearing there
IS the cache being current. Pure read; nothing is executed:

```bash
curl -fsS https://api.gradethread.com/ -H "apikey: $ANON_KEY"   | jq '.paths["/rpc/admin_revoke_user_sessions"] != null'
# expect true. false means the NOTIFY has not been seen yet.
```

Then read the GoTrue version, because it decides whether the fallback is doing
all the work or none of it:

```bash
curl -fsS https://api.gradethread.com/auth/v1/health   # unauthenticated
```

### Verified locally

Applied to the local stack and probed in rolled-back transactions: anon and
authenticated both get `42501 admin_revoke_user_sessions: service role
required`; service_role gets a count; a NULL id returns 0. End-to-end on real
rows — a user with 2 sessions and 1 refresh token went to 0 and 0, return value
2.

## ✅ APPLIED (measured 2026-08-17): 00611 — the six anon-callable functions get a guard in the body (US-2666)

**Risk: LOW to apply. Apply AFTER 00610.**

`NOTIFY pgrst, 'reload schema';` **NOT required.** Every signature is unchanged
(`CREATE OR REPLACE`, same arguments, same return types), so PostgREST's cache
stays valid. No table, column or new RPC.

### What it does

Six functions carry a `REVOKE ... FROM anon` that never denied anon: the
`CREATE FUNCTION` grant to PUBLIC survives it and every role belongs to PUBLIC.
They have been callable with the public anon key the whole time. This migration
adds an authorization check inside each function BODY, which is the remedy this
repo settled on (`admin_revenue_metrics`, 00514, is the model: anon-EXECUTABLE
and still safe).

| Function | Origin | Guard |
|---|---|---|
| `reserve_snap(uuid,int)` | 00099 | service_role |
| `refund_snap(uuid)` | 00099 | service_role |
| `data_integrity_scan()` | 00097 | service_role |
| `north_star_weekly_counts(timestamptz,timestamptz)` | 00170 | service_role |
| `north_star_lifetime_counts(uuid[])` | 00170 | service_role |
| `flipdesk_overview_metrics(...)` | 00594 | service_role or authenticated |

Every caller was traced first: five are edge-only through `supabaseAdmin`, and
the sixth is called from the browser by a signed-in seller
(`src/hooks/use-flipdesk-overview.ts:121`). No caller is anon, so denying anon
breaks nothing.

### ⚠ Why this is NOT a REVOKE

Two traps, both real:

1. A denied call from anon or authenticated segfaults Postgres on this image
   (US-2403), and 00527 is a standing DO NOT APPLY. A revoke would arm that
   crash on `flipdesk_overview_metrics`, which anyone can reach today.
2. On five of the six, `service_role` holds EXECUTE **only through the PUBLIC
   grant** — there is no explicit grant to it anywhere. `REVOKE ... FROM PUBLIC`
   would have stripped the edge's own access and taken out the paid Snap
   grading and refund paths.

A body check revokes nothing and raises an ordinary 42501, so it arms neither.

### Behaviour change to expect

Four functions change from `language sql` to `language plpgsql` because SQL
cannot raise. Same signatures, same results, same volatility markers. The
bodies are the originals with only the guard added.

`flipdesk_overview_metrics` stays SECURITY INVOKER, so RLS still scopes every
figure to the caller. An anon POST that used to return 200 with zeros now
returns 42501.

### Apply order

1. 00610 (US-2663), then 00611. Both are idempotent and safe to re-run.
2. No `NOTIFY pgrst` needed for either.
3. Redeploy the edge (boot guard now expects `00611`).

### Verify after applying

```sql
-- all six should now be plpgsql or carry the guard; spot-check one:
select prosecdef, prolang::regtype is not null
from pg_proc where proname = 'reserve_snap';
```

```bash
# anon must now be refused rather than answered
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://api.gradethread.com/rest/v1/rpc/flipdesk_overview_metrics \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
  -H 'Content-Type: application/json' -d '{}'
# expect 4xx (42501), not 200
```

**Not run against a database yet.** Docker was down on the dev box when this was
written, so `verify:db` did not run. The SQL is a mechanical edit of the four
originals plus a guard; it still needs one `supabase db reset` before it is
trusted.

## ✅ APPLIED (measured 2026-08-17): 00610 — revenue_dashboard has never worked, and the break was hiding a leak (US-2663)

**Risk: LOW to apply. Do NOT skip it and push, though — see the ordering note.**

`NOTIFY pgrst, 'reload schema';` **NOT required.** The signature is unchanged
(`CREATE OR REPLACE`, same three arguments), so PostgREST's cache stays valid.

### What it does

Two changes to `public.revenue_dashboard`, which must ship together. Everything
else in the file is the live 00608 definition carried through byte-for-byte —
the sandbox exclusion, the granularity handling and every other key are
untouched.

1. **The trial cohort keyed on a column that does not exist.** It selected
   `public.users.trial_started_at`, which has never existed on that table. So
   the function has raised `42703` on *every* call since 00215 shipped, with no
   parameter combination that avoids it. It now keys on `created_at`, filtered
   to users who were actually given a trial. The alternative — deriving a start
   from `trial_ends_at` — was rejected because that column MOVES after signup
   (the Stripe webhook and an admin route both write it), so extending someone's
   trial would silently relocate them into a different historical cohort.

2. **The authorization guard let anonymous callers through.** It read
   `if auth.uid() is not null and not public.is_admin()`, with a comment
   asserting "anon can't reach this — execute is not granted to it". Both halves
   are false together: anon *does* have EXECUTE (the `CREATE FUNCTION` grant to
   PUBLIC survives the `REVOKE … FROM anon` pattern — US-2666), and anon's
   `auth.uid()` *is* null, so the guard waved it straight through. Replaced with
   the allowlist form `admin_revenue_metrics` already uses.

### ⚠ Why the two halves cannot be separated

Fixing (1) alone converts a function that always errored into one that returns
MRR, ARR, ARPU, plan mix and churn **to anyone holding the public anon key**.
The `42703` was the only thing standing there. If you apply this migration
partially, apply neither half.

### Ordering

Apply the SQL, then OK the push. There is no code in the same commit that reads
anything new, so the frontend auto-deploy is not a factor — but the edge's boot
guard now expects `00610`, so a push without the apply would make the next edge
deploy refuse to start.

### Verified before it was written down

Applied to the local stack (609 migrations) and then **called over real
PostgREST**, which is the check the story asked for:

| Caller | Before | After |
|---|---|---|
| service role (the edge) | `42703 column "trial_started_at" does not exist` | HTTP 200, full document |
| anon (public key) | `42703` — errored, which is what hid the leak | **HTTP 401, `42501 admin role required`** |

The control is `admin_revenue_metrics`, which refuses the identical anon call
with the identical code.

### No REVOKE in this file, deliberately

Tightening the grant is the obvious-looking fix and is not available: a DENIED
call from anon or authenticated SEGFAULTS this Postgres image (US-2403), which
is why 00527 is a DO NOT APPLY. A body check raises an ordinary error instead,
so it arms nothing. This is US-2282's remedy applied to one function.

### Apply

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/00610_revenue_dashboard_trial_cohort.sql
```

Then confirm, read-only:

```sql
select public.revenue_dashboard(now() - interval '30 days', now(), 'day') is not null;
```

---

## ✅ WAS ALL CLEAR through 00609 (re-measured 2026-08-16) — superseded by 00610 above

```json
{"expected":"00608","applied":"00609","status":"ahead","unexpected":["00609"]}
```

No `missing` key, so the applied SET was read and it is complete — 00607, 00608
**and 00609** are all in `applied_migrations`. The `unexpected: ["00609"]` is the
running edge saying it is older than the database, which is the SAFE direction
and the one the runbook asks for.

**The COMMIT for 00609 is still held** — that is a separate thing from the SQL,
and the rule is about the push. Nothing is at risk while it waits.

### ✅ APPLIED (measured 2026-08-16): 00609 — stamp the store environment on each App Store credit grant (US-2286)

**Applied to prod ahead of its commit**, almost certainly by the same directory
run that applied 00607 and 00608 — `apply-prod-migrations.sh` applies every file
in the tree, and this one was sitting there uncommitted.

**That the recorded version proves the whole file ran** is worth spelling out,
because elsewhere in this file a recorded version has been over-read. The apply
script is `set -euo pipefail` and each file runs under `ON_ERROR_STOP=1`, so a
failure aborts before anything is recorded; and the self-record footer is the
LAST statement in the file. Either path means every statement before it
succeeded. This is not the "below the maximum, therefore applied" inference that
was wrong about 00594 — that one reasoned about a version nobody had recorded.

⚠ **`NOTIFY pgrst, 'reload schema';` — send it if you have not.** The function's
SIGNATURE changed, and PostgREST resolves an RPC through its cached schema. The
running edge calls with the five old argument names, which the new defaulted
signature accepts (proof 2 below), so purchases are not currently failing — but
send the reload before the next edge deploy, whose call names `p_environment`:

```sql
NOTIFY pgrst, 'reload schema';
```

Everything below is the record of what it does.

**Risk: LOW. Additive column, defaulted parameter, and the deploy order is safe
in the direction the standing rule already requires.**

`ADD COLUMN IF NOT EXISTS environment text` on
`public.appstore_processed_transactions`, a CHECK allowing NULL / `production` /
`sandbox`, a COMMENT, then a `DROP FUNCTION` + `CREATE FUNCTION` of
`public.grant_appstore_credits` with one new trailing parameter,
`p_environment text DEFAULT NULL`.

00559 stamped the USER and the Play purchase table and left this one alone,
because it is written ONLY through that SECURITY DEFINER function and stamping
it needs a signature change. The user column says what the account's LAST
purchase was; this table is the per-transaction record the AC5 audit reads.
Every row written before this lands is unattributable permanently — Apple's
receipt is not re-queryable from the database.

- **DROP then CREATE, not `CREATE OR REPLACE`.** Postgres identifies a function
  by its argument list, so replacing it with an extra parameter would leave BOTH
  versions and make the existing 5-argument call ambiguous. Both statements are
  in one migration, therefore one transaction, so there is no window where the
  function is missing.
- **The new parameter is DEFAULTED, which is what makes the gap safe.** Between
  applying this and redeploying the edge, the CURRENT edge calls with five named
  arguments and keeps resolving. Rows written in that window get NULL.
- **No REVOKE, deliberately.** This function has carried the default EXECUTE to
  PUBLIC since 00104. Tightening it looks obviously right and is currently
  unsafe — US-2403 found a denied call from anon/authenticated segfaults the
  backend on this Postgres image, which is why 00527 is parked as `.BLOCKED`.
  The permission question lands with US-2282/US-2403.
- **Nothing in the frontend reads the new column**, so a Cloudflare Pages
  auto-deploy ahead of the SQL changes nothing.

✅ **EXECUTED, unlike 00608.** Docker came up on the authoring host, so
`node scripts/verify.mjs --db` re-applied every migration from zero onto a
throwaway stack including this one, and four claims were then proven against
that real Postgres inside a rolled-back transaction:

1. a six-argument call stamps `environment = 'sandbox'` on the claim row;
2. a **five-argument** call — the current edge, after this migration and before
   its deploy — still resolves and leaves `environment` NULL;
3. the CHECK raises `check_violation` on `'staging'`;
4. a duplicate delivery still no-ops: the balance is unchanged and no second
   ledger row is written.

**Apply order was:** after 00608 (done).

**Verify:** buy a credit pack in sandbox, then

```sql
select transaction_id, credits_granted, environment
  from public.appstore_processed_transactions
 order by created_at desc limit 5;
```

The newest row should read `sandbox`. Older rows stay NULL and must not be read
as production.

---

## ✅ APPLIED (owner-confirmed 2026-08-16): 00607 and 00608

Both were applied by the owner during the 2026-08-16 outage recovery, and the
edge came back reporting
`{"expected":"00608","applied":"00608","status":"match"}` with no `missing` key.

> [!danger] **How these two came to be applied is worth more than the fact.**
> They were HELD, and they reached `origin/main` anyway — twice in one day,
> without the owner OKing a push. The edge redeployed from that commit with
> `EXPECTED_SCHEMA_VERSION=00608` against a database at 00606, the boot guard
> burned its 40s grace window and exited, Coolify restarted it, and the whole
> site answered 503 through Traefik ("no available server") until the SQL was
> applied. **The held-migration rule is not bureaucracy; this is the failure it
> prevents.** If a commit containing a migration appears on `origin/main`
> without an explicit OK, treat prod as at risk immediately.

### 00608 — exclude sandbox purchases from revenue reporting (US-2286)

**Risk: MEDIUM. This one changes numbers on the admin revenue surfaces.**

`CREATE OR REPLACE` on `public.revenue_dashboard` and
`public.admin_revenue_metrics`, adding one condition at six revenue sites:
`and billing_environment is distinct from 'sandbox'`.

00559 stamped `users.billing_environment` and nothing has read it since, so a
sandbox grant — an App Review tester on a free entitlement — has been counted as
a paying subscriber in MRR. After this, it is not.

- **MRR will drop by whatever sandbox has been inflating it.** That is the point.
  If the number moves and you were not expecting it, that movement is the bug
  being fixed, not a new one.
- **Pre-marker rows keep counting.** `is distinct from` is TRUE for NULL, and
  every row written before 00559 is NULL. A plain `<> 'sandbox'` would have
  zeroed historical MRR; there is a test refusing that spelling.
- **The bodies are otherwise byte-identical to what is running.** They were
  generated by reading 00215 and 00514 and inserting one line at each site, and
  a test undoes the six inserts and asserts the result matches those files
  exactly. Nothing was retyped.

~~⚠ **NOT EXECUTED ANYWHERE.**~~ **Corrected 2026-08-16: it has been.** That
warning was written while Docker was down on the authoring host. Docker came up
later the same day and `node scripts/verify.mjs --db` re-applied every migration
from zero onto a throwaway stack, this one included, so both view bodies are
known to parse and to create. What was still true when it was applied to prod:
nothing had compared the NUMBERS before and after.

**Apply order:** after 00607. Then:

```sql
NOTIFY pgrst, 'reload schema';
```

**Verify after applying:** open the admin revenue page. `activePaid` and the
plan mix should exclude any sandbox-granted account; §24 of
`scripts/prod-diagnostics.sql` gives the counts by `billing_source` ×
`billing_environment` to compare against.

### 00607 — seed four missing feature-flag rows (US-2653)

**`00607_seed_missing_feature_flags.sql`** — seeds four rows into
`public.feature_flags`: `forensic_grade`, `passport_forecast`,
`trial_conversion_drip`, `inventory_equity`.

**Risk: LOW, and deliberately behaviour-neutral.** All four are read fail-open
today — no call site passes `defaultEnabled:false`, and a missing row already
resolves to enabled — so seeding `enabled = true` changes nothing at runtime.
It only makes the switch exist somewhere an operator can reach it. `ON CONFLICT
(key) DO NOTHING`, so re-running keeps any override.

**Why it matters:** the admin console lists ROWS, and the toggle endpoint answers
404 "Unknown feature flag" when there is none. Three of these four promise
operator control in their own code comments and had none.

**No client-side read of anything new.** Nothing in this commit reads a new
column or enum, so a frontend auto-deploy ahead of the SQL is harmless — the
only consequence of applying it late is that the four switches stay unreachable,
which is today's status quo.

**Apply order:** after 00606, which is already applied. Then:

```sql
NOTIFY pgrst, 'reload schema';
```

(No table or column changed, so the reload is belt-and-braces rather than
required.)

**Verify after applying:** the four keys appear in
`GET /api/admin/feature-flags`, and `PUT` on any of them stops answering 404.

---

## ✅ Everything through 00609 is applied (see the measurement at the top of this file)

The reading immediately after the outage recovery was
`{"expected":"00608","applied":"00608","status":"match"}`. The previous measurement,
2026-08-15 at 23:30, was `{"expected":"00606","applied":"00606","status":"match"}`
— kept because the reasoning attached to it is the point.

No `missing` key and no `complete: false` — the applied SET was read and it is
complete. **00594 has been applied**, closing the gap this section spent the day
describing.

The measurement that makes that trustworthy is the *absence* of a key that was
present hours earlier on the same endpoint: at 01:22 it returned
`"missing":["00594"]`, and `missing` is omitted only when the set is complete.
A bare `"status":"match"` would not have been evidence of anything, for the
reason this file has warned about all along.

- **`unexpected: ["00479"]` is a KNOWN phantom** — never authored, which is why
  `00480+` were numbered around it (`scripts/prod-diagnostics.sql` §2,
  `scripts/migrations-lint.mjs` `KNOWN_GAPS`). No action. It has since stopped
  being reported, which is also fine: the phantom allowlist absorbs it.
- **US-2606 stays open on one thing that is not a migration**: the FlipDesk
  Overview page being confirmed to LOAD for a real signed-in seller. The RPC
  existing and the page working are different claims, and this file can only
  speak to the first.

> [!note] What changed in the endpoint since this was written
> US-2620: a hole under the maximum now reports `"status":"incomplete"` rather
> than `"match"`. The advice below — that a bare `match` proves nothing — was
> written when `status` could not see a gap. It still holds for any build older
> than that change, which is why it is kept rather than deleted.

Every section below that said HELD now says APPLIED.

**How to check this yourself rather than take the line above on trust:**

```bash
curl -fsS https://functions.gradethread.com/health/ready | jq .schema
```

US-2603 added `missing` to that block: the versions this build ships that the
database has never recorded. An empty or absent `missing` is the real all-clear.
A bare `"status":"match"` is NOT — `applied` is a maximum, and a maximum cannot
see a gap beneath it, which is exactly the state this file spent 2026-08-15
warning about. If `complete: false` comes back, the applied set could not be read;
that is "we do not know", not "clean".

**Everything below is history, kept on purpose.** 00594 was the last live item
and it is applied.
Each section records the risk, the apply order and the dependencies for a
migration. Read one when something misbehaves in a table it created. Do not read
this file as a queue.

**The check earns its keep, and this is the evidence.** Before the redeploy the
edge reported `expected 00603 / applied 00606` and nothing else; the very first
read from the new image named 00594. The gap had been sitting under a `match` for
a day, with a section of this file asserting the opposite.

## ✅ APPLIED (owner-confirmed 2026-08-15): 00606_help_analytics.sql (US-2592 — what people read, what they couldn't find)

**Risk: LOW.** One new `help_article_views` table (three-column primary key, one
index, RLS enabled, no policies), one `record_help_article_view` function and one
`help_zero_result_queries` function. Nothing existing is altered.

**Apply order:** after 00605. Depends on `help_articles` (00602) and
`help_search_misses` (00603).

**`NOTIFY pgrst, 'reload schema';` — yes.** A new table and two new RPCs. Both
functions are invisible to PostgREST until you send it, so the view counter
silently records nothing and the admin report 500s without it.

**⚠ NOT VERIFIED AGAINST A REAL POSTGRES**, same as the rest of the epic —
Docker was not running, so `verify:db` did not execute this SQL. The parts worth
running once by hand are the `insert ... select ... where exists ... on conflict`
in `record_help_article_view` (that combination is the least ordinary SQL in the
epic) and the `array_agg(... order by ...)` inside `help_zero_result_queries`.

**Deploy order is the usual one.** `EXPECTED_SCHEMA_VERSION` moves to `00606`,
so the boot guard refuses a 00605 database. Apply SQL → `NOTIFY pgrst` →
redeploy edge → push. The frontend is safe to deploy early: the report page
shows its error state and the in-app view counter fails silently by design.

**Privacy.** `help_article_views` holds NO identity of any kind — not a user id,
not a session, not an IP, not a referrer. Its grain is (article, surface, day).
That is what makes it writable from an anonymous public page with no consent
prompt, and it is why the counter is not simply PostHog. Deny-all RLS, classified
in `SERVICE_ROLE_ONLY`.

**One behaviour worth knowing before it surprises you.** The public view counter
is reachable anonymously (the Pages Function calls it on every article read), so
the RPC validates the slug shape AND requires the article to exist. A made-up
slug records nothing rather than creating a row. Crawlers are filtered by user
agent before the call is made at all, which means these numbers will read LOWER
than a raw server log and that is the intent.

## ✅ APPLIED (owner-confirmed 2026-08-15): 00605_help_feedback_and_freshness.sql (US-2591 — was it any good, is it still true?)

**Risk: LOW.** One `ADD COLUMN IF NOT EXISTS content_version integer NOT NULL
DEFAULT 1` on `help_articles`, one trigger function, one trigger, one new
`help_feedback` table with two indexes and RLS, and one view
`help_articles_stale`.

**The column does not rewrite the table.** Postgres 11+ stores a non-volatile
`DEFAULT` in the catalogue. Same shape as 00604, not 00603.

**Apply order:** after 00604. Depends on `help_articles` (00602) and
`auth.users`.

**`NOTIFY pgrst, 'reload schema';` — yes.** A new column, a new table and a new
VIEW. The view in particular is invisible to PostgREST until you send it, so the
admin freshness report 404s at the API layer without it.

**⚠ NOT VERIFIED AGAINST A REAL POSTGRES**, same as the rest of the epic —
Docker was not running, so `verify:db` did not execute this SQL. The trigger
function and the view expression are the parts worth running once before prod.

**Deploy order is the usual one.** `EXPECTED_SCHEMA_VERSION` moves to `00605`,
so the boot guard refuses a 00604 database. Apply SQL → `NOTIFY pgrst` →
redeploy edge → push. The frontend is safe to deploy early: the freshness panel
renders nothing when the endpoint fails.

**Privacy.** `help_feedback` stores the article, the content version, yes/no, an
optional comment and the viewer TIER. `owner_user_id` is **nullable on purpose**:
the articles are public, and requiring a signed-in reader would collect feedback
only from the minority who happened to be logged in and then present that as a
measurement. Deny-all RLS, classified in `SERVICE_ROLE_ONLY`.

**One behaviour worth knowing before it surprises you.** A stale article is
**flagged and nothing else**. It stays published and keeps its sitemap entry.
Anything that unpublished or de-sitemapped an unreviewed article would lose
rankings for a reason nobody decided on, and a test asserts the sitemap builder
never looks at `is_stale`.

## ✅ APPLIED: 00604_help_ticket_deflection.sql (US-2585 — did help prevent the ticket?, owner-confirmed 2026-08-14)

**Owner-reported, not measured from here.** Flipped on the user's word during the
US-2585 build; nothing in this session queried the database to confirm it.

**⚠ 00601, 00602 and 00603 are NOT confirmed applied.** They are still listed
as HELD below. That combination is unstable and needs checking before the edge
is redeployed:

- 00604 can apply on its own (it depends only on `support_tickets` and
  `auth.users`), so "604 is applied" does **not** imply 602 and 603 are.
- The edge boot guard expects `00604` and only compares the MAXIMUM recorded
  version, so a database missing 602 or 603 mid-sequence would still read as
  "match" and the edge would start against a schema with no `help_articles`
  table. That is precisely the gap the US-2009 guard exists for.

Run this before redeploying the edge, and flip the entries below to match:

```sql
select version from public.applied_migrations where version >= '00601' order by version;
```

**Still required regardless:** `NOTIFY pgrst, 'reload schema';` for the two new
`support_tickets` columns and the new table. Without it the ticket insert fails
on unknown columns, which breaks **opening a support ticket**, not just the
deflection metric.

<details>
<summary>What it did (kept for the record)</summary>

## ⏳ (was HELD) 00604_help_ticket_deflection.sql

**Risk: LOW.** Two `ADD COLUMN IF NOT EXISTS` on `support_tickets` (a `text[]`
with a `'{}'` default and a nullable `text`), plus one new table
`help_deflections` with two indexes and RLS enabled.

**Neither column rewrites the table.** Postgres 11+ stores a non-volatile
`DEFAULT` in the catalogue rather than backfilling every row, so both are
metadata-only regardless of how many tickets exist. This is not the same shape
as 00603's generated column, which does rewrite.

**Apply order:** after 00603. It depends on `support_tickets` (00223) and
`auth.users`, both long-standing.

**`NOTIFY pgrst, 'reload schema';` — yes.** Two new columns and a new table.
Until you send it, the ticket insert fails on the unknown columns, which means
**opening a support ticket breaks**, not just the deflection metric. That makes
this the one migration in the epic where skipping the NOTIFY is user-visible.

**⚠ NOT VERIFIED AGAINST A REAL POSTGRES**, same as 00602 and 00603 — Docker was
not running, so the `verify:db` lane did not execute this SQL.

**Deploy order, and it matters in the usual direction.** The edge INSERTS
`help_articles_shown` / `help_article_opened` on every ticket create. Against a
database without them the insert fails and the user cannot open a ticket. The
`EXPECTED_SCHEMA_VERSION` bump to `00604` is what prevents that: the boot guard
refuses to start against a 00603 database. Order: apply SQL → `NOTIFY pgrst` →
redeploy edge → push.

**The frontend is safe to auto-deploy ahead of the SQL.** It sends the two extra
fields, and the CURRENT edge ignores unknown body keys — so a frontend that
deploys early degrades to tickets without deflection data, not to broken
tickets. Do not reverse that reasoning: it is the EDGE that must wait.

**Privacy.** `help_deflections` records `owner_user_id`, the subject line typed
so far, and which article was read. Deny-all RLS, service-role only, and
classified in `SERVICE_ROLE_ONLY` in `rls-guard_test.ts` — readable it would
hand a customer an analytics feed of what other people were about to ask;
writable it would let anyone inflate the one number that says whether the help
centre is working.

</details>

## ✅ APPLIED (owner-confirmed 2026-08-15): 00603_help_center_search.sql (US-2577 — Help Center search)

**Risk: LOW, with one line that is not instant.** Adds a generated `search_tsv`
column to `help_articles`, a GIN index on it, a `help_search_misses` table with
two indexes, and the `help_search(text, text[], integer)` function.

**⚠ The `ADD COLUMN ... GENERATED ALWAYS AS ... STORED` rewrites the table.** On
a table with a handful of rows that is instant. If `help_articles` is already
large when you apply this, it takes an ACCESS EXCLUSIVE lock for the duration.
Apply it before the corpus is seeded (US-2586+) and it costs nothing.

**Apply order:** after 00602, which creates the table it alters.

**`NOTIFY pgrst, 'reload schema';` — yes.** A new column and a new RPC. The
`help_search` function is unreachable through PostgREST until you send it, so
search returns a 404 from the API layer rather than an empty result.

**⚠ NOT VERIFIED AGAINST A REAL POSTGRES**, same as 00602: Docker was not
running, so the `verify:db` lane did not execute this SQL. The generated-column
expression is the part most worth running once before it reaches prod, since a
non-IMMUTABLE function there is rejected at DDL time.

**The frontend is safe to auto-deploy ahead of the SQL.** The help search page
calls the edge, which cannot answer until the RPC exists; the page renders its
"search didn't answer" state rather than breaking.

**The EDGE is not.** `EXPECTED_SCHEMA_VERSION` moves to `00603` in this commit,
so the boot guard refuses a 00602 database. Order stays: apply SQL → `NOTIFY
pgrst` → redeploy edge → push.

**The security property to preserve.** `help_search`'s `p_visibilities`
argument has **no default**, on purpose. A default would make the safe call and
the unsafe call identical at the call site, and the unsafe one would be shorter
to type. Search is the most tempting way around a permission wall, because it
reads like a query against "the index" rather than against the articles. A
deno test asserts both the missing default and that the route hands it
`visibilitiesFor(viewer)`.

`help_search_misses` records **no identity of any kind** — not a caller id, not
an IP, not a session. Only the query text, the viewer tier and the hit count,
because a help query can carry anything a frustrated person types.

## ✅ APPLIED (owner-confirmed 2026-08-15): 00602_help_center_articles.sql (US-2572 — the Help Center store)

**Risk: LOW, but it is not a one-liner.** Three new enums
(`help_visibility`, `help_article_status`, `help_audience`), two new tables
(`help_categories`, `help_articles`), five indexes, two `updated_at` triggers,
six RLS policies, and a 14-row seed of the category shelf. **No existing table
is altered, no column is dropped, no data moves, no backfill runs.** Every
statement is `IF NOT EXISTS` / `DROP POLICY IF EXISTS` first / `ON CONFLICT DO
UPDATE`, so it is safe to run twice and safe to re-run the whole directory.

**Apply order:** after 00601. It depends only on `public.set_updated_at()`
(00001) and `public.is_admin()` (00003), both of which have existed for years.

**`NOTIFY pgrst, 'reload schema';` — yes, and it matters more than usual.** Two
brand-new tables that the Cloudflare Pages SSR worker will read with the ANON
key. Until PostgREST reloads, every read of them 404s at the API layer.

**⚠ NOT VERIFIED AGAINST A REAL POSTGRES.** Docker was not running on this box,
so the `verify:db` lane (which boots a throwaway stack purely to prove
migrations apply on a fresh schema) did not run. `deno test` covers the
migration triple and the RLS guard statically — both green — but nothing has
executed this SQL. **Start Docker and run `node scripts/verify.mjs db` before
applying it to prod**, or apply it inside a transaction you can roll back.

**The frontend is safe to auto-deploy ahead of the SQL.** Nothing in `src/`
reads these tables yet — the reader, the editor and the SSR Function are
US-2574/2575/2576 and have not shipped. This commit is the schema and the
version bump, nothing else.

**The EDGE is not safe to deploy ahead of the SQL**, which is the normal
direction. `EXPECTED_SCHEMA_VERSION` moves to `00602` in this same commit, so
the boot guard refuses to start against a 00601 database (with the ~40s grace
window from US-778). Order: apply SQL → `NOTIFY pgrst` → redeploy edge → push.

**The security property to preserve when you read this later.** `visibility`
has three values, not two, and the wall is the RLS policy rather than the edge
handler, because the SSR worker reads with the anon key:

- `public` → anon SELECT, indexable, sitemapped, quoted in `llms.txt`
- `members` → any authenticated user, never server-rendered publicly
- `internal` → `is_admin()` only: operator runbooks, abuse thresholds, unreleased

A handler bug cannot leak a `members` or `internal` row through the public
renderer, because the anon role never sees the row at all. If a future migration
loosens the `anon read published public help` policy, that guarantee is gone.

## ✅ APPLIED (owner-confirmed 2026-08-15): 00601_cancellation_requested_notification.sql (US-2560 — a buyer cancellation reaches no notification channel)

**Risk: LOW — the lowest kind there is.** One `ALTER TYPE notification_type ADD
VALUE IF NOT EXISTS 'cancellation_requested'`. No table is created, altered or
dropped, no data moves, no backfill runs, no index is built. It takes a
momentary lock on the type and returns. Safe to run twice.

**Apply order:** after 00600. It depends on nothing but the `notification_type`
enum, which has existed since 00007.

```sql
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'cancellation_requested';
```

**`NOTIFY pgrst, 'reload schema';` — yes.** An enum changed, so PostgREST's
cached schema is stale until you send it.

**The deploy order matters in ONE direction, and only one.** The edge INSERTS
this value (`notifyUser`, from `lib/marketplace-event-notify.ts`). On a database
that does not have it the insert fails with 22P02 and the notification is lost.
Nothing FILTERS on the value anywhere, so the reverse — a database that has it
while an older edge runs — is a plain no-op.

The `EXPECTED_SCHEMA_VERSION` bump to `00601` in the same commit is what enforces
that direction: the edge boot guard refuses to start against a database still on
00600. So the order is SQL first, then redeploy the edge, then push.

**The frontend is safe to auto-deploy ahead of the SQL**, unlike 00592. Nothing
in `src/` queries this value. `src/types/database.ts` gains it as a TypeScript
union member and `src/lib/notification-preferences.ts` gains a catalog row, both
of which are inert until a notification of that type exists to render.

**What breaks if you deploy the EDGE without applying it — and it is worse than
"nothing happens", so do not skip the order above.** Checked rather than assumed:
`deliver()` in `marketplace-event-notify.ts` wraps the in-app write in its own
try/catch and **logs without rethrowing**, so a failed insert never reaches the
poll's per-event catch. `notifyCancellation` resolves as a success, the claim
row stays, and the next poll reads it as already delivered. That cancellation is
then never notified again — permanently, not until the enum lands.

This is pre-existing behaviour shared by all five event types, not something this
story introduced, and the schema-version boot guard is what makes it
unreachable: an edge expecting 00601 will not start against a 00600 database.
It is written down here because "the migration is only an enum value" reads like
the safe kind of held migration, and the failure mode if the order is reversed is
silent and unrecoverable rather than loud.

## ✅ APPLIED: 00600_grade_report_revisions.sql (US-2569 — a regraded certificate is revised, not vanished, applied 2026-08-14 — owner-confirmed)

**Measured 2026-08-14T18:40Z, not inferred.**
`GET https://functions.gradethread.com/health/ready` returns
`"schema":{"expected":"00593","applied":"00600","status":"ahead"}`.

**⚠ THE EDGE HAS NOT BEEN REDEPLOYED.** That `expected: 00593` is the RUNNING
container, which predates every migration from 00594 on. Until it is redeployed
the revision writes in `lib/grading-pipeline.ts` are not live, so a regrade in
this window still retires a certificate with no record — the defect this story
fixes. Redeploy the edge before regrading anything.

**What `applied: 00600` does and does not prove.** It is the MAXIMUM recorded
version, so it confirms 00600 itself landed. It does not, on its own, prove
00594–00599 each landed — `applied_migrations` could in principle hold a
mid-sequence gap (the US-2009 guard exists for exactly that). The entries below
are left as HELD until that is checked; run
`select version from public.applied_migrations where version >= '00594' order by version;`
to confirm and flip them.

**Risk was: LOW.** One new deny-all table, five indexes, one trigger. Nothing
existing is altered, narrowed or dropped, and no backfill runs. Safe to run
twice.

**What it adds.** `public.grade_report_revisions` records each supersede: the
retired report's certificate id, number, score and tier, plus the replacement's
once it lands. A `BEFORE UPDATE OR DELETE` trigger freezes the superseded half
and permits the resolution to be set exactly once; DELETE is refused outright.

**⚠ THE EDGE MUST NOT DEPLOY AHEAD OF THIS ONE.** `lib/grading-pipeline.ts`
writes to the table on every regrade and updates it on every completed grade. On
a database without 00600 both fail with 42P01. Both are best-effort and logged,
so grading itself keeps working — but every certificate retired in that window
loses its revision record permanently and will 404 for good, which is the exact
defect this story exists to fix.

**Nothing in the frontend reads it directly.** The `/cert/:id` Pages Function
reads the `revised` flag from the edge response, so a Cloudflare Pages deploy
ahead of the SQL degrades to today's branded 404 rather than breaking.

**Backfill: none, and none is possible.** Certificates retired before this
migration had their `certificate_id` nulled with nothing recorded, so their
numbers are unrecoverable. Those URLs keep 404ing. Only regrades from here
forward resolve.

Apply order: AFTER 00599.

## ✅ APPLIED: 00599_moderation_certificate_reports.sql (US-2550 — a buyer can report a certificate, applied 2026-08-14)
**Measured 2026-08-14, not inferred.** `GET https://functions.gradethread.com/health/ready`
returns `"schema":{"expected":"00600","applied":"00600","status":"match"}` — the running
edge reading `applied_migrations` through the service-role client, i.e. the
database's own answer. This version is below that maximum and its file carries
the self-recording footer, so it is applied. Everything below is the record of
what it does.

**Risk: LOW, with one enum caveat.** One `ALTER TYPE … ADD VALUE IF NOT EXISTS`
and one `COMMENT`. No table, no column, no index, no policy, no backfill,
nothing dropped or narrowed. Safe to run twice and safe to re-run the whole
directory.

**What it adds.** `certificate` as a third value on
`public.moderation_content_type`, so a buyer report can be enqueued into the
EXISTING `content_moderation_flags` queue (US-889) alongside listings and
photos. The `content_id` for one of these is `grade_reports.certificate_id` —
the uuid the buyer is actually holding — so an operator can paste it into
/cert/:id and see exactly what was reported.

**⚠ THE FRONTEND IN THIS COMMIT WRITES IT.** The certificate page posts to the
new public `POST /api/content/public/certificates/:id/report`, and that route
inserts `content_type: 'certificate'`. Against a database without the value,
Postgres rejects the insert (22P02 invalid input value for enum) and every
buyer report fails — silently from the buyer's point of view, because the
enqueue helper swallows and logs. So the SQL goes FIRST, in the usual order:

1. Run the SQL.
2. No PostgREST reload needed for the enum itself — but run
   `NOTIFY pgrst, 'reload schema';` anyway if 00595-00598 are applied in the
   same pass, since those add tables and columns.
3. Deploy the edge (its boot guard now expects 00599).
4. THEN push.

**Enum caveat (US-1108).** A value added by `ALTER TYPE` cannot be USED in the
same transaction. Nothing in this migration uses it; the edge writes it on a
later connection, and the boot guard is what keeps an edge expecting 00599 from
running against a database that predates it.

**Nothing to roll back.** Removing an enum value is not supported in Postgres,
and would not help: the rollback for this one is a frontend revert.

Apply order: AFTER 00598.

## ✅ APPLIED (owner-confirmed 2026-08-15): 00595 – 00598 (the pre-launch money + evidence audit, US-2562..US-2567)

**Apply strictly in NNNNN order, after 00594.** `scripts/apply-prod-migrations.sh`
does that for you; all four are idempotent and safe to re-run.

**One hard dependency inside the set: 00597 REQUIRES 00595.** Until 00595 has
removed the cascading foreign key, account deletion still deletes ledger rows,
and 00597's DELETE-blocking trigger would abort every account deletion in the
product. Running the directory in order is safe. Running 00597 alone is not.

### 00595_ledger_survives_deletion.sql — **Risk: MEDIUM**

Drops three cascading foreign keys (`grade_credit_transactions.user_id`,
`grade_credit_transactions.submission_id`,
`flipdesk_subscription_events.user_id`), adds two indexes to replace the lookups
those constraints used to provide, adds three nullable columns to
`account_deletion_log`, and adds `redact_subscription_event_pii(uuid)`.

Medium rather than low because dropping a constraint is not additive: from this
point the database no longer enforces that a ledger row's `user_id` exists in
`public.users`. That is the intended behaviour — the ledger is a financial
record and must outlive the account — but it means any query that INNER JOINs
`grade_credit_transactions` to `users` will start silently dropping rows for
erased accounts. `routes/admin-billing.ts:447` reads the table without a join
and is unaffected; check any new report before assuming the same.

**No frontend in this commit reads the new columns**, so a push before the SQL
degrades nothing on Cloudflare Pages. The edge deletion path (US-2562) DOES call
`redact_subscription_event_pii`, so the edge must not deploy ahead of this SQL.

Rollback: re-adding the FKs is possible only after deleting the orphaned rows,
which is the data this migration exists to keep. Treat it as forward-only.

### 00596_api_idempotency_records.sql — **Risk: LOW**

One new deny-all table plus `prune_api_idempotency_records(interval)`. No
existing table, column, index or policy is touched. Nothing reads it until the
middleware ships (US-2563).

### 00597_ledger_append_only.sql — **Risk: MEDIUM**

Adds a `BEFORE UPDATE OR DELETE` trigger on `grade_credit_transactions` that
raises for every role, service_role included, plus
`ledger_append_only_enforced()` so the guard's state is readable.

Medium because it changes what the database will accept. Verified before
writing it: no migration and no edge module performs an UPDATE or a DELETE on
this table, so nothing in the product should notice. If something does, it
fails loudly with `restrict_violation` rather than corrupting quietly — which is
the trade being made.

Rollback if it does bite: `DROP TRIGGER grade_credit_transactions_append_only ON
public.grade_credit_transactions;` and nothing else is affected.

### 00598_item_photos_derivation_provenance.sql — **Risk: LOW schema, ORDERED deploy**

Six nullable columns and two partial indexes on `item_photos`. Nothing existing
is altered, narrowed or dropped, and no backfill runs. Derived rows written
before this migration keep their `disclosure_auto_` filenames and are pruned and
re-derived on the next annotation pass.

**⚠ THE EDGE MUST NOT DEPLOY AHEAD OF THIS ONE.** `lib/defect-annotations.ts`
(US-2566) now WRITES all six columns on every `item_photos` insert it makes. On
a database without 00598 that insert fails with 42703, and the annotation loop
swallows per-photo insert errors by design — so an opted-in item would quietly
ship with no disclosure imagery and nothing would look broken. Apply the SQL,
reload PostgREST, then deploy.

Nothing in the frontend reads the new columns, so a Cloudflare Pages deploy is
unaffected either way.

### Runbook for the set

1. Run the SQL in order (00595 → 00598).
2. `NOTIFY pgrst, 'reload schema';` — **required.** Three new RPCs and six new
   columns are invisible to PostgREST until its schema cache reloads.
3. Redeploy the edge (its boot guard now expects `00598`).
4. THEN push.


## ✅ RESOLVED 2026-08-16: 00594_flipdesk_overview_metrics.sql (US-2547 — the Overview stops reading the whole account) — US-2606

> [!note] **00594 IS APPLIED.** Confirmed 2026-08-16 by the measurement recorded
> near the top of this file: `/health/ready` stopped returning
> `"missing":["00594"]`, and `missing` is omitted only when the applied set is
> complete. The header on this section read `❌ NOT APPLIED` until 2026-08-17,
> which contradicted that newer section 500 lines above it — and a red header is
> what an operator scrolling for their next action stops at. **Everything below
> this line is history and is kept deliberately** (US-2606 AC4): the retraction
> and the reasoning it retracts are the lesson, and deleting them would leave the
> file looking like it had never been wrong.

> [!danger] **This section said APPLIED for a day and it was wrong.** Corrected
> 2026-08-15 by measurement. `GET /health/ready` now returns
> `{"expected":"00606","applied":"00606","status":"match","missing":["00594"]}`.
> The maximum matches AND 00594 is absent from `applied_migrations`, which is the
> hole a maximum cannot see. `public.flipdesk_overview_metrics` does not exist in
> production, and `src/hooks/use-flipdesk-overview.ts:120` throws on the error, so
> the FlipDesk Overview page is failing for every seller. Tracked as **US-2606**.
>
> **Read the retracted reasoning, because it is the lesson.** The 2026-08-14 note
> below argued: the recorded maximum was 00600, this version is *below* that
> maximum, and its file carries the self-recording footer, therefore it is
> applied. Every individual clause was true and the conclusion was false — the
> watermark only moves forward, so a file below it is never re-applied and never
> re-checked. This same file warned against exactly that inference 160 lines
> earlier, in the 00600 section, and the warning did not stop it being written
> here a few paragraphs later. **A version below the maximum is not evidence of
> anything. Read `schema.missing`.**

**RETRACTED 2026-08-14 note, kept verbatim:** "Measured 2026-08-14, not inferred.
`GET https://functions.gradethread.com/health/ready` returns
`"schema":{"expected":"00600","applied":"00600","status":"match"}` — the running
edge reading `applied_migrations` through the service-role client, i.e. the
database's own answer. This version is below that maximum and its file carries
the self-recording footer, so it is applied."

**The one hypothesis that has been ruled out.** The function is `language sql`,
whose body Postgres validates at CREATE time, so a drifted `public.items_full`
would make `CREATE FUNCTION` fail outright and would explain a single file being
skipped in an otherwise clean run. All 15 columns the body reads were probed
against prod through PostgREST on 2026-08-15 and every one resolves (a missing
column answers `42703` naming it — a distinguishable, completely safe read). So
apply it and expect success; if it errors anyway, the error is worth more than
the retry. Column *types* were not probed.

Everything below is the record of what it does.

**Risk: LOW.** One new `CREATE OR REPLACE FUNCTION`. No table, no column, no
index, no policy, no backfill; nothing existing is altered, narrowed or dropped.
Safe to run twice and safe to re-run the whole directory.

**What it adds.** `public.flipdesk_overview_metrics(p_from, p_to, p_tz,
p_aging_days, p_limit)` returns the FlipDesk Overview as one jsonb document:
per-status pipeline counts, the range-bound flow figures (listed / sold / gross /
net / top brands / recent sales), the state-of-now lists (inventory value, aging
items, stale listings) and the Monday-anchored week buckets the North Star streak
walks. It reads `items_full` and is SECURITY INVOKER, so RLS scopes every figure
to the caller exactly as the browser-side read did.

**⚠ THE FRONTEND IN THIS COMMIT CALLS IT.** `src/pages/flipdesk/overview.tsx` no
longer reads `items_full` at all — the old client-side loop is GONE, not
feature-flagged. Cloudflare Pages auto-deploys the frontend the moment this is
pushed, so between that deploy and the SQL, /dashboard/flipdesk answers PGRST202
("function does not exist") and the page renders its error state on every load.
The edge does not call this function, so the edge deploy is only about the boot
guard.

1. Run the SQL.
2. `NOTIFY pgrst, 'reload schema';` — **required**, not optional. A new RPC is
   invisible to PostgREST until its schema cache reloads, and the page calls it
   through PostgREST.
3. Deploy the edge (its boot guard now expects 00594).
4. THEN push.

**Nothing to roll back.** Dropping the function would leave the page broken, so
the rollback for this one is a frontend revert, not a DROP.

Apply order: AFTER 00593 (already applied).


## ✅ APPLIED: 00593_support_ticket_attachments.sql (US-2525 — images on a support ticket, applied 2026-08-14)

**Measured 2026-08-14, not inferred.** `GET https://functions.gradethread.com/health/ready`
returns `"schema":{"expected":"00593","applied":"00593","status":"match"}`, and
`origin/main` carries every commit through 4cf70df7 — so the SQL ran, the edge
that expects it is deployed, and the push it was gating has happened. Everything
below is kept as the record of what was applied.


**Risk: LOWEST of the two held here.** One additive `jsonb` column with a
default, on `support_ticket_messages`. No table, no index, no policy, no
backfill, nothing dropped or narrowed. The whole file is
`ADD COLUMN IF NOT EXISTS` plus a `COMMENT`, so it is safe to run twice and safe
to re-run the whole directory.

**What it adds.** `support_ticket_messages.attachments` — the image attachments
on one message, as `[{path, name, content_type, bytes}]`. The files themselves go
into the EXISTING private `submission-images` bucket under the uploader's own
folder (`{userId}/support/{ticketId}/…`), which already carries the US-276
per-user-folder RLS policy, so **no bucket and no storage policy is created**.
The column holds paths only; the edge hands out signed URLs with a 600s TTL and
never a public one.

**Order, and why it is gentler than 00592's.** The frontend in this commit sends
`attachments: []` on every ticket and reply. An edge that predates this column
would fail those inserts, so the SQL still goes first — but nothing 404s in the
gap, because the endpoints themselves are unchanged.

1. Run the SQL (00592 first, then this one).
2. `NOTIFY pgrst, 'reload schema';` — a COLUMN was added and the edge selects it
   by name through PostgREST.
3. Deploy the edge (its boot guard now expects 00593).
4. THEN push.

**iOS is NOT part of this.** `SupportTicketsView.swift` still sends text only,
which is safe in both directions: an old client omits the field and gets the
column default, and a message carrying attachments renders on iOS as its text.
Filed separately rather than shipped blind from a Windows checkout.

Apply order: AFTER 00592.


## ✅ APPLIED: 00592_flipdesk_import_runs.sql (US-2518 — the durable, reversible CSV import, applied 2026-08-14)

**Measured 2026-08-14** by the same `/health/ready` read as 00593 above: prod
reports applied 00593, which is after this one. Everything below is the record.


**Risk: LOW.** Two brand-new tables, two indexes, one trigger, two SELECT-only
RLS policies. Nothing existing is altered, narrowed or dropped, and no row is
backfilled or deleted. Every statement is `IF NOT EXISTS` or is preceded by a
`DROP … IF EXISTS`, so it is safe to run twice and safe to re-run the whole
directory.

**What it adds.** `flipdesk_import_runs` is one CSV inventory import: its
status, its progress counters, and the mapped rows themselves, so the worker no
longer needs the browser to stay open. `flipdesk_import_effects` is one row per
change the run made — created an item, or filled blank columns on an existing one
along with the values those columns held before. That second table is the entire
reason an import can now be undone.

**Order matters more than usual, and the frontend is the reason.** The page in
this commit stops importing in the browser and posts to
`POST /api/flipdesk/import/runs` instead. Cloudflare Pages auto-deploys the
frontend the moment this is pushed, so between that deploy and the edge deploy
the Import button would 404 — the old client-side loop is GONE, not
feature-flagged. Apply in this order and that gap never opens:

1. Run the SQL.
2. `NOTIFY pgrst, 'reload schema';` — two tables were created and the edge
   selects their columns by name through PostgREST.
3. Deploy the edge (its boot guard now expects 00592).
4. Register the new Coolify scheduled task,
   `*/5 * * * *` → `POST /api/jobs/flipdesk-import-reclaim` with the
   `X-Internal-Job-Secret` header. The regenerated table in
   `services/edge-functions/COOLIFY.md` has the exact command. Without this
   task, an import whose container dies is never resumed — which is the failure
   the whole story exists to remove.
5. THEN push.

**RLS is SELECT-only on purpose.** Sellers may read their own runs; every write
goes through the edge on the service-role client. A client that could insert an
effect row could undo an import it never ran, and undo deletes inventory.

Apply order: AFTER 00591.


## ✅ APPLIED: 00591_users_buyer_past_due_since.sql (US-2458 AC5 — the buyer dunning clock, applied 2026-08-14 — owner-confirmed)

**Risk: LOWEST of anything here.** One nullable `timestamptz` on `public.users`.
No backfill, no constraint, no index, nothing dropped or narrowed. The whole
file is `ADD COLUMN IF NOT EXISTS` plus a `COMMENT`, so it is safe to run twice
and safe to re-run the whole directory. Same shape as 00589 and as 00091, which
is its seller twin.

**What it adds.** `users.buyer_past_due_since` — when dunning began for the
BUYER subscription. `past_due_since` (00091) has anchored the seller equivalent
for months and the operator past-due panel sorts by it; the buyer product had
no equivalent, so a buyer whose card failed appeared in **no operator surface**
and support found out when the customer wrote in.

**It does NOT gate entitlement, deliberately.** The seller column additionally
drives `effectivePlanFor()` dropping paid caps after the grace window. This one
is operator visibility only — dropping a buyer's caps on a dunning clock is a
pricing decision that belongs with US-2458 AC4, and doing it silently inside a
column addition would be smuggling it in.

**Order is the usual one: SQL first, then the edge.** The webhook in this commit
writes the new column on every `customer.subscription.updated`, so an edge
deployed before the column exists would fail that write with 42703 — and that
handler owns buyer plan/status/period_end, so the whole buyer subscription state
would stop updating. **No PostgREST reload needed for reads to work, but do it
anyway** (`NOTIFY pgrst, 'reload schema';`): a COLUMN was added and the admin
panel selects it by name.

Apply order: AFTER 00590.

## ✅ APPLIED: 00590_extension_queue_drop_share_kind.sql (US-2497 — the queue stops accepting a share run, applied 2026-08-14 — owner-confirmed)

**Risk: LOW, with one deliberate DELETE.** No new object, no column, no index.
It narrows one CHECK constraint on `extension_work_queue.kind` from
`('list','delist','share')` to `('list','delist')`, and first deletes the rows
carrying the value being removed.

**What it changes, and why the DELETE is there.** `share` was a queue verb that
nothing could ever drain. The Poshmark engagement pass starts only against an
active tab already on the seller's own closet; the extension holds no Poshmark
handle by design and will not navigate to a URL that arrived in a message
(US-1876). A background drain has neither. The deciding argument is the fourth
statement of the engagement clickwrap — *"GradeThread will stop and hand the tab
back to me if Poshmark asks for a human check"* — which cannot be honoured with
nobody at the machine. The CHECK refuses the VALUE regardless of a row's status,
so existing `share` rows have to go before the constraint can be narrowed;
expiring them would not help. They are unrunnable instructions in a work queue,
not audit records, and the drain already completed the ones it saw with
`ok:false`.

**How many rows this touches in practice:** the feature shipped 2026-08-10 and no
client ever offered a share trigger, so this is expected to delete zero rows.
Check first if you want certainty:
`psql "$SUPABASE_DB_URL" -c "select status, count(*) from public.extension_work_queue where kind = 'share' group by 1;"`

**Order is the same as every other migration here: SQL first, then the edge.**
The boot guard is what settles it — an edge build expecting 00590 against a DB
still at 00589 reports `behind`, burns its grace window and exits, which is a
Coolify crash-loop and a 503 on every route. `COOLIFY.md` already makes
`apply-prod-migrations.sh` a pre-deployment command, so the normal path does this
by construction.

The window between the two is harmless in the other direction: the old edge build
still advertises `share` in its `kind must be one of:` message and would accept an
insert the database now refuses, turning a clean 400 into a 500. Nothing sends
one, so that is a footnote, not a reason to reorder.

**No PostgREST reload needed** — no table, column or RPC changed. A CHECK
constraint is invisible to PostgREST's schema cache.

Apply order: AFTER 00589.

## ✅ APPLIED: 00589_submission_image_role.sql (US-2471 — the photo role reaches the grader)

**Measured 2026-08-12, not inferred.** `GET https://functions.gradethread.com/health/ready`
returns `"schema":{"expected":"00589","applied":"00589","status":"match"}` — that
is the running edge reading `applied_migrations` through the service-role client,
i.e. the database's own answer. The column exists in prod and the edge build that
reads it is deployed. Everything below is kept as the record of what was applied;
the apply steps are done.

The measurement matters more than the correction. This file said HELD for a day
after the SQL had run, and the answer was one unauthenticated GET away the whole
time. Reasoning about prod schema state from commit history is what produced the
stale entry, and it is not the first time — check the endpoint before writing
"held" or "applied" here.


**Risk: LOW.** One nullable text column on `submission_images`. No enum change,
no backfill, no constraint, no index, nothing dropped or narrowed. The whole file
is `ADD COLUMN IF NOT EXISTS` plus a `COMMENT`, so it is safe to run twice and
safe to re-run the whole directory.

**What it adds.** `submission_images.image_role` — the open-text qualifier that
says WHAT a grading photo shows, mirroring `item_photos.photo_role` from 00587.
NULL means no qualifier, which is what every historical row keeps: this migration
deliberately does NOT rewrite `image_type` on existing rows, because those rows
are the evidence behind grades already issued and are served by the public API v1
contract.

**Why it exists, and the bug it closes.** 00587 rewrote `measurement_chest` into
(`measurement`, `chest`). A bare `measurement` is the MeasureCard calibration
frame, which is excluded from grading on purpose (00346). `mapPhotoTypeForGrading`
read the type alone, so from 00587 onward EVERY tape-measure photo resolved to
"not useful for grading" and silently stopped reaching the grader. The role is
the only thing that tells the two apart. That fix is in this commit and needs
this column.

**⚠ THE ONE THING TO WATCH — pre-apply, the new edge build breaks EVERY grading
path, not just FlipDesk.** Two separate reads of the column:

1. `grading-pipeline.ts` `processSubmission` SELECTs `image_role`, and that is
   the single entry point for every grade in the product: consumer
   (`routes/grade.ts`), the public API v1 (`routes/api-v1.ts`), Stripe-paid
   (`routes/webhooks.ts`), the stuck-submission retry sweep, and the batch
   worker. If the edge redeploys before the column exists, PostgREST returns
   42703 and every one of those fails — including submissions the customer has
   already paid for. Worse for diagnosis: the pipeline collapses that error into
   `No images found for submission …`, so the logs will name the wrong cause for
   the whole window.
2. `flipdesk-grading.ts` INSERTs `image_role` on every `submission_images` row.
   That path does compensate the charge (the idempotent `refund_grade` RPC in its
   catch); the consumer and webhook paths in (1) do not.

So: apply the SQL BEFORE the edge redeploys, without a gap. The frontend half is
harmless — no client reads this column (`grep -rn image_role src/` is empty), so
a Cloudflare Pages auto-deploy on push breaks no page.

**No grading behavior changes on apply.** The role-aware prompt text is behind
`GRADING_PHOTO_ROLES`, default off; with it unset the assembled prompt is
byte-identical (guarded by `photo-role-prompts_test.ts`). Turning it on is a
separate decision that goes through the eval gate and a canary slice, per the
`grading-engine` prompt lifecycle.

Apply order: AFTER 00588 (no dependency beyond sequence).

```bash
# 1. Apply. All migrations are idempotent; only 00589 does anything new.
SUPABASE_DB_URL="postgres://…@host:5432/postgres" ./scripts/apply-prod-migrations.sh

# 2. A COLUMN was added, so PostgREST must reload or the insert 404s on the
#    column even after the migration lands.
psql "$SUPABASE_DB_URL" -c "NOTIFY pgrst, 'reload schema';"

# 3. Redeploy the edge on Coolify (its boot guard now expects 00589).
# 4. THEN push.
```

## ✅ APPLIED: 00588_extension_work_queue.sql (US-2481 — queue extension work from mobile, drain it on the desktop, applied 2026-08-10 by Dj)

**Risk: LOW.** One new table, four RLS policies, two indexes, one `updated_at`
trigger. Nothing existing is touched — no column added to a live table, no
backfill, no enum change, nothing dropped or narrowed. The whole file is
idempotent (`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS` before each
`CREATE POLICY`, `DROP TRIGGER IF EXISTS` before the trigger).

**What it adds.** `public.extension_work_queue` — the server-side record of
extension work a seller queued from their phone, which the desktop Lister drains
the next time the browser opens. It stores WHAT to do (an item id, a platform, a
locale key) and never a marketplace credential. Plus one small IMMUTABLE helper,
`public.jsonb_has_credential_key(jsonb)`, which backs the
`extension_work_queue_no_credentials` CHECK: it walks the payload to any depth
and refuses a `password` / `cookie` / `session` / `token`-shaped key. That is the
bright line from
`vault/60-decisions/adr-no-server-side-marketplace-automation.md` written as SQL.

**⚠ THE ONE THING TO WATCH, and it is the ordinary new-table one.** The frontend
half deploys the moment this branch is pushed (Cloudflare Pages auto-deploy), and
the Marketplaces screen calls `GET /api/flipdesk/extension-queue` on load. That
route is NEW, so until the edge redeploys the old container 404s it regardless of
what the database says — the "Queued for your desktop" section renders empty, the
rest of the page is unaffected, and no data is at risk.

**It heals at step 3 (the Coolify redeploy), not at step 2.** The `NOTIFY` in
step 2 fixes PostgREST's view of the new table; it does not teach the running
edge build about a route it does not have. Do all three, in order, without a long
gap.

Apply order: AFTER 00586 (no dependency beyond sequence).

```bash
# 1. Apply. All migrations are idempotent; only 00586 and 00588 do anything new.
SUPABASE_DB_URL="postgres://…@host:5432/postgres" ./scripts/apply-prod-migrations.sh

# 2. A NEW TABLE was created, so PostgREST must reload or every queue read is a
#    404 "relation public.extension_work_queue does not exist".
psql "$SUPABASE_DB_URL" -c "NOTIFY pgrst, 'reload schema';"

# 3. Redeploy the edge on Coolify. Its boot guard now expects 00588.
#    expect: applied "00588" (status "ok" or "ahead")

# 4. THEN OK the push.
```


## ✅ APPLIED: 00587_item_photo_role_qualifier.sql (US-2462 — photo tags split into a type plus an open-text role, applied 2026-08-10 by Dj)

**Applied to prod before the push, per the standing held-migration rule. The
notes below are kept as the record of what was applied and what to watch.**

**Risk: MEDIUM-LOW for the schema, MEDIUM for the backfill.** The schema half is
additive and dull: two `ALTER TYPE … ADD VALUE IF NOT EXISTS`, one
`ADD COLUMN IF NOT EXISTS photo_role text` with no constraint and no default,
one `CREATE INDEX IF NOT EXISTS`. Nothing is dropped or narrowed and the whole
file is idempotent.

The backfill is the part to read twice. It **rewrites existing rows**:
`tag_2 → tag`, `detail_2/3/4 → detail`, and each `measurement_<key>` →
`(measurement, photo_role '<key>')`. `sort_order` is never touched, so no
gallery reorders and no eBay cover image moves. It is idempotent because after
the first pass no row matches a retired type. **It is not reversible by re-running
anything** — the old `detail_3` labelling is gone once applied, which is the
intent (that label never meant anything) but is worth knowing before you run it.

**⚠ THE ONE THING THAT COULD BITE, and it is already handled in code — verify
the deploy order anyway.** `measurement` is on `NON_LISTABLE_PHOTO_TYPES`
(the MeasureCard frame is a branded object and never publishes) whereas
`measurement_chest` was listable. So the backfill moves rows from a listable
type onto a non-listable one. The same commit makes that rule role-aware:
`measurement` + NULL role = card frame (not listable), `measurement` + a role =
tape photo (listable). **If the SQL is applied while the OLD edge build is still
running, every seller's tape-measure photos drop out of their listing photo
sets until the edge redeploys.** That is a temporary, self-healing state — no
data is lost and republishing restores them — but it is visible.

So for this one, apply in this order and do not leave a long gap:

```bash
# 1. Apply. All migrations are idempotent; only 00587 does anything new.
SUPABASE_DB_URL="postgres://…@host:5432/postgres" ./scripts/apply-prod-migrations.sh

# 2. A column was added, so PostgREST must reload or every photo_role read is a
#    400 "column item_photos.photo_role does not exist".
psql "$SUPABASE_DB_URL" -c "NOTIFY pgrst, 'reload schema';"

# 3. Redeploy the edge on Coolify RIGHT AWAY — this closes the listable-photo
#    window described above.

# 4. Confirm the database's own answer, not the repo's.
curl -s https://functions.gradethread.com/health/ready | jq .schema
#    expect: applied "00587" (status "ok" or "ahead")
```

**Apply order: AFTER 00586.** No dependency on it beyond sequence.

**Frontend timing.** The web client reads `photo_role` the moment Cloudflare
Pages auto-deploys on push. Step 2 must have happened first or the composer's
photo queries 400.

**Verified locally:** `deno check src/main.ts` clean, `deno test` on
`item-photo-storage_test.ts` + `schema-version_test.ts` green (34 passed),
`npx tsc -b` clean, manifest regenerated. **The SQL itself has NOT been run
against a Postgres on this machine** — check Docker and run
`node scripts/verify.mjs --db` if you want it proven on a fresh schema before
touching prod.

## ✅ APPLIED: 00586_handle_new_user_restore_legal_acceptance.sql (US-2017 — the signup clickwrap has not been recorded since 00303, applied 2026-08-10 by Dj)

**PUSH-BLOCKING. Apply this SQL before the branch is pushed.**

**Risk: MEDIUM — the highest of any migration in a while, and the reason is the
blast radius rather than the change.** It is a single `CREATE OR REPLACE
FUNCTION public.handle_new_user()`. Nothing is created, altered or dropped, and
it is idempotent. But that function runs on EVERY signup, and if its body fails
to parse, every new account lands without a profile row. The body's whole
contents are inside the existing `EXCEPTION WHEN OTHERS` guard, so a RUNTIME
failure only logs a warning and lets the auth signup through — but a PARSE
failure happens at apply time, and `CREATE OR REPLACE` either succeeds
completely or leaves the previous definition in place. So the failure mode at
apply is "the statement errors and 00401's version stays live", which is the
state we are in today. That is safe; it just means the fix did not land.

**⚠ NOT EXECUTED ANYWHERE. Docker was down on the authoring machine, so
`node scripts/verify.mjs --db` could not boot the throwaway stack and this SQL
has never been run against a Postgres.** Everything else was checked: the
inherited body was diffed line-by-line against 00401 to prove nothing carried
over was dropped, the column and value lists were counted, and every column
written exists in 00142's `legal_acceptances` / `users`. Run the `db` lane, or
watch this statement's output when applying, rather than assuming.

**Apply order: AFTER 00585.** No dependency on anything newer.

**The exact steps**, so this is a five-minute job and not a research task:

```bash
# 1. Apply. Runs every migration in NNNNN order; all are idempotent, so the
#    already-applied ones are no-ops and only 00586 does anything.
SUPABASE_DB_URL="postgres://…@host:5432/postgres" ./scripts/apply-prod-migrations.sh

# 2. A function changed, so PostgREST needs to reload.
psql "$SUPABASE_DB_URL" -c "NOTIFY pgrst, 'reload schema';"

# 3. Confirm the database's own answer, not the repo's.
curl -s https://functions.gradethread.com/health/ready | jq .schema
#    expect: applied "00586" (status "ok" or "ahead")
```

Then flip this heading to `## ✅ APPLIED:` with the date, and the push is
unblocked — `scripts/held-migration-gate.mjs` reads that heading and is what is
currently refusing the push.

**How to tell it worked, beyond the version number.** The next email signup
should write a `legal_acceptances` row with `method = 'signup_clickwrap'`, and
the `legal.signup_clickwrap_missing` metric should stop appearing. Both are the
symptom this migration exists to end, so either one is a real check rather than
a re-reading of the code.

**`NOTIFY pgrst, 'reload schema';` — YES.** A function was replaced.

**What it fixes.** 00142 taught the trigger to record an email signup's
clickwrap: `users.tos_accepted_version` / `privacy_accepted_version` plus an
append-only `legal_acceptances` row with `method = 'signup_clickwrap'`. 00303
replaced the function to add `use_case` and did not carry that block forward;
00379 and 00401 rebased on the truncated body. So since 00303, **no email
signup has recorded a clickwrap at all.** Two consequences:

1. The legal gate re-prompts the user on their first authenticated session
   (a NULL recorded version never meets the bar). Consent is still captured,
   just later and stamped with whatever is current then.
2. `POST /api/legal/confirm-signup` (the US-2116 strengthened-evidence path)
   **refuses every caller**, correctly, because there is no clickwrap row to
   corroborate. That entire path has recorded nothing, ever.

**It also changes where the version comes from (US-2017 AC1).** 00142 stamped
the browser's hardcoded `LEGAL_VERSIONS` constant. The new body uses the
metadata's PRESENCE as the "this was an email signup with a checkbox" signal but
reads the VALUE from `legal_documents`, ordered exactly the way
`deriveKind()` in `lib/legal-versions.ts` does. An OAuth signup still records
nothing, which the gate depends on.

**No backfill.** Accounts created between 00303 and this migration have no
clickwrap row and cannot get one — the acceptance they gave was never recorded,
and inventing a row now would be a fabricated consent record. They are covered
by whatever the legal gate captured on first sign-in.

**Rollback** is to re-apply `00401_buyer_account_roles.sql`, which contains the
previous definition verbatim.

---

## ✅ APPLIED: 00585_swim_brand_knowledge.sql (US-2220 — chlorine consumes the garment, invisibly, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT.** `GET https://functions.gradethread.com/health/ready` returned `schema: {expected: "00583", applied: "00585", status: "ahead"}` — the database's own answer. 00584 and 00585 were applied together, so that one reading covers both.

**Risk: LOW. Two `insert ... on conflict do nothing` statements into reference
tables.** Nothing is created, altered, dropped, read or backfilled. No decoders,
no size charts.

**Apply order: AFTER 00584.** 00584 and 00585 are independent and can go
together — they are the last two of the seven US-2220 packs.

**NOT push-blocking.** Speedo, TYR, Vilebrequin and Andie have always fallen
through the resolver.

**What it adds.** 4 brand rows, 4 style rows, 9 tells. This is the SEVENTH and
final category on US-2220 — applying it and 00584 closes the story.

**The point of the pack:** chlorine attacks elastane first, so a competition suit
loses recovery and goes translucent with no stain, tear or fade to grade. The
best predictor of remaining life is the FIBRE CONTENT on the care label, which
makes this the one category where the label beats the photographs.

**Verified from zero on a throwaway stack** (`node scripts/verify.mjs --db`),
applied and re-applied. `EXPECTED_SCHEMA_VERSION` bumped to `00585` in the same
commit with the manifest regenerated.

**No `NOTIFY pgrst` needed** — no table, column or RPC changed, only rows.

**Rollback** is `delete from public.brand_knowledge where updated_by =
'migration:00585';` and the same for `brand_styles`.

---


## ✅ APPLIED: 00584_snow_outerwear_brand_knowledge.sql (US-2220 — the spec is a new-garment claim, and what fails is invisible, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT.** `GET https://functions.gradethread.com/health/ready` returned `schema: {expected: "00583", applied: "00585", status: "ahead"}` — the database's own answer. 00584 and 00585 were applied together, so that one reading covers both.

**Risk: LOW. Two `insert ... on conflict do nothing` statements into reference
tables.** Nothing is created, altered, dropped, read or backfilled. No decoders,
no size charts.

**Apply order: AFTER 00583.** Independent of everything before it.

**NOT push-blocking.** Burton, Spyder, Volcom and Obermeyer have always fallen
through the resolver.

**What it adds.** 4 brand rows, 4 style rows, 11 tells.

**The point of the pack:** a snow jacket sells on two numbers (waterproofing in
mm, breathability in grams) that describe it WHEN NEW and cannot be observed on
a used garment. What actually fails splits in two — DWR wears off and is
re-treatable (a consumable), while seam tape delaminates and cannot be restored
(terminal). Same pair as golf's spikes and receptacles in 00583.

**Verified from zero on a throwaway stack** (`node scripts/verify.mjs --db`),
applied and re-applied. `EXPECTED_SCHEMA_VERSION` bumped to `00584` in the same
commit with the manifest regenerated.

**No `NOTIFY pgrst` needed** — no table, column or RPC changed, only rows.

**Rollback** is `delete from public.brand_knowledge where updated_by =
'migration:00584';` and the same for `brand_styles`.

---


## ✅ APPLIED: 00583_golf_brand_knowledge.sql (US-2220 — the logo is part of the item, and it is not the brand, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT.** `GET https://functions.gradethread.com/health/ready` returned `schema: {expected: "00582", applied: "00583", status: "ahead"}` — the database's own answer. The edge has also caught up to 00582 since the last batch, so the remaining gap is just this migration's own version bump.

**Risk: LOW. Three `insert ... on conflict do nothing` statements into reference
tables.** Nothing is created, altered, dropped, read or backfilled. No decoders.

**Apply order: AFTER 00582.** Independent of everything before it.

**NOT push-blocking.** FootJoy, Greyson, Callaway and Titleist have always
fallen through the resolver.

**What it adds.** 4 brand rows, 5 style rows, 1 width chart, 9 tells.

**⚠ One row is a CORRECTION to the story's premise.** US-2220 lists Titleist as
a golf apparel brand. It is an EQUIPMENT house — its own range is bags, headwear,
travel gear, accessories and gloves, with no polos — so a Titleist item reaching
a clothing grader is a cap or a glove. The row is deliberately thin and the
thinness is the finding.

**Verified from zero on a throwaway stack** (`node scripts/verify.mjs --db`),
applied and re-applied. `EXPECTED_SCHEMA_VERSION` bumped to `00583` in the same
commit with the manifest regenerated.

**No `NOTIFY pgrst` needed** — no table, column or RPC changed, only rows.

**Rollback** is `delete from public.brand_knowledge where updated_by =
'migration:00583';` and the same for `brand_styles` and `brand_size_charts`.

---


## ✅ APPLIED: 00582_western_brand_knowledge.sql (US-2220 — width is a size, and an exotic skin is a legal question, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT.** `GET https://functions.gradethread.com/health/ready` returned `schema: {expected: "00577", applied: "00582", status: "ahead"}` — the database's own answer. 00578 through 00582 were applied together, so that one reading covers all five. The "ahead" is the running edge image predating the version bumps; it resolves on the next edge deploy.

**Risk: LOW. Three `insert ... on conflict do nothing` statements into reference
tables.** Nothing is created, altered, dropped, read or backfilled. No decoders.

**Apply order: AFTER 00581.** 00578 through 00582 are all independent of each
other and can be applied in one sitting.

**NOT push-blocking.** Ariat, Justin and Lucchese have always fallen through the
resolver.

**What it adds.** 3 brand rows, 3 style rows, 1 width chart, 10 tells.

**⚠ Stetson is NOT re-seeded.** The story names it as a western brand, but it is
already a brand_knowledge row from 00574's headwear pack and its western hats are
covered there. A test asserts this migration does not create a second row — the
packs compose rather than overlap.

**Verified from zero on a throwaway stack** (`node scripts/verify.mjs --db`),
applied and re-applied. `EXPECTED_SCHEMA_VERSION` bumped to `00582` in the same
commit with the manifest regenerated.

**No `NOTIFY pgrst` needed** — no table, column or RPC changed, only rows.

**Rollback** is `delete from public.brand_knowledge where updated_by =
'migration:00582';` and the same for `brand_styles` and `brand_size_charts`.

---


## ✅ APPLIED: 00581_tailoring_formalwear_brand_knowledge.sql (US-2220 AC3 — a suit size is two garments and a subtraction, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT.** `GET https://functions.gradethread.com/health/ready` returned `schema: {expected: "00577", applied: "00582", status: "ahead"}` — the database's own answer. 00578 through 00582 were applied together, so that one reading covers all five. The "ahead" is the running edge image predating the version bumps; it resolves on the next edge deploy.

**Risk: LOW. Three `insert ... on conflict do nothing` statements into reference
tables.** Nothing is created, altered, dropped, read or backfilled. No decoders.

**Apply order: AFTER 00580.** 00578 through 00581 are all independent of each
other and can be applied in one sitting.

**NOT push-blocking.** Suitsupply, Hugo Boss, Canali and Jos. A. Bank have always
fallen through the resolver.

**What it adds.** 4 brand rows, 6 style rows, 11 tells, and — unlike the three
packs before it — THREE SIZE CHARTS, because tailoring has three sizing systems
at once and AC3 exists to stop them being flattened into an alpha size.

**⚠ The charts are seeded under a GENERIC key (`tailoringmenswear`) with no
brand_knowledge row.** That is deliberate and precedented: 00389 already does it
for `genericmensalpha` and friends. The chest run and the drop arithmetic are an
industry CONVENTION rather than a house's label, which is the opposite of the
headwear case where two makers print different inches for the same size.

**Verified from zero on a throwaway stack** (`node scripts/verify.mjs --db`),
applied and re-applied. `EXPECTED_SCHEMA_VERSION` bumped to `00581` in the same
commit with the manifest regenerated.

**No `NOTIFY pgrst` needed** — no table, column or RPC changed, only rows.

**Rollback** is `delete from public.brand_knowledge where updated_by =
'migration:00581';` and the same for `brand_styles` and `brand_size_charts`.

---


## ✅ APPLIED: 00580_scrubs_uniform_brand_knowledge.sql (US-2220 — uniform is a category, not more apparel, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT.** `GET https://functions.gradethread.com/health/ready` returned `schema: {expected: "00577", applied: "00582", status: "ahead"}` — the database's own answer. 00578 through 00582 were applied together, so that one reading covers all five. The "ahead" is the running edge image predating the version bumps; it resolves on the next edge deploy.

**Risk: LOW. Two `insert ... on conflict do nothing` statements into reference
tables.** Nothing is created, altered, dropped, read or backfilled. No decoders,
so nothing here can override an AI answer.

**Apply order: AFTER 00579.** 00578, 00579 and 00580 are independent of each
other and can all be applied in one sitting.

**NOT push-blocking.** FIGS, Cherokee and WonderWink have always fallen through
the resolver; the frontend reads none of it.

**What it adds.** 3 brand rows, 4 style rows, 9 tells.

**⚠ It also fixes a collision with a brand the KB already had.** Careismatic
publishes DICKIES MEDICAL — the Dickies name under licence on scrubs — while
`dickies` has pointed at the WORKWEAR house since 00389, whose pack and sizing
are about work pants. Dickies Medical is now its own canonical rather than a
fold, so a scrub top can never inherit the workwear chart. That change is in the
edge code shipping with this migration, not in the SQL, so it takes effect on
deploy regardless of when the rows land.

**Verified from zero on a throwaway stack** (`node scripts/verify.mjs --db`),
applied and re-applied. `EXPECTED_SCHEMA_VERSION` bumped to `00580` in the same
commit with the manifest regenerated.

**No `NOTIFY pgrst` needed** — no table, column or RPC changed, only rows.

**Rollback** is `delete from public.brand_knowledge where updated_by =
'migration:00580';` and the same for `brand_styles`.

---


## ✅ APPLIED: 00579_vintage_tee_blanks_brand_knowledge.sql (US-2220 AC4 — the first pack built on tag_eras, and the category that grades backwards, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT.** `GET https://functions.gradethread.com/health/ready` returned `schema: {expected: "00577", applied: "00582", status: "ahead"}` — the database's own answer. 00578 through 00582 were applied together, so that one reading covers all five. The "ahead" is the running edge image predating the version bumps; it resolves on the next edge deploy.

**Risk: LOW. Two `insert ... on conflict do nothing` statements into reference
tables.** No table, column, constraint, index, policy or function is created,
altered or dropped. Nothing existing is read, rewritten or backfilled. No
decoders, so nothing here can override an AI answer.

**Apply order: AFTER 00578.** 00578 and 00579 are independent and can be applied
in one sitting — but note 00578's constraints DO apply to 00579's rows, and every
one of them carries a source_url and a confidence, which the from-zero db lane
proves by applying both in order.

**NOT push-blocking.** Screen Stars, Brockum, Giant and Winterland have always
fallen through the resolver; the frontend reads none of it.

**What it adds.** 4 brand rows, 2 style rows, 6 tag_eras entries, 8 tells.

**Why it is unlike every pack before it.** The four "brands" are not the brand on
the shirt — a band tee's seller-facing brand is the BAND. These are the BLANK
MAKERS whose tag is sewn into the collar, so the rows exist to DATE a shirt and
never to price one.

**⚠ And the category grades backwards.** Screen Stars blanks are 50/50
cotton-poly: washing fades the cotton and spares the polyester, producing the
thin, translucent, feather-soft shirt the category is bought FOR. A vintage tee
graded on crispness reads a 9 as a 4. The tells say so and also name what IS a
defect here — holes, stains, an illegible print, a dead collar.

**Verified from zero on a throwaway stack** (`node scripts/verify.mjs --db`),
applied and re-applied. `EXPECTED_SCHEMA_VERSION` bumped to `00579` in the same
commit with the manifest regenerated.

**No `NOTIFY pgrst` needed** — no table, column or RPC changed, only rows.

**Rollback** is `delete from public.brand_knowledge where updated_by =
'migration:00579';` and the same for `brand_styles`.

---


## ✅ APPLIED: 00578_brand_kb_provenance_required.sql (US-1996 AC5 — a brand fact must carry its source, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT.** `GET https://functions.gradethread.com/health/ready` returned `schema: {expected: "00577", applied: "00582", status: "ahead"}` — the database's own answer. 00578 through 00582 were applied together, so that one reading covers all five. The "ahead" is the running edge image predating the version bumps; it resolves on the next edge deploy.

**Risk: LOW.** One IMMUTABLE function and five CHECK constraints added
`NOT VALID`. No table, column or index is created, altered or dropped, no row is
read, rewritten or deleted, and no backfill runs.

**Apply order: AFTER 00577.** Depends on nothing but the five brand-KB tables,
which have existed since 00389.

**NOT VALID IS THE DESIGN, and it is what makes this safe to apply blind.** A
plain CHECK would refuse to apply if ANY existing row lacks provenance — and 11
do, in `brand_size_charts`, seeded deliberately by 00498 (its own header says the
in-code chart seed carried no per-chart provenance to copy). More importantly,
prod also holds rows written by the admin curation surface, which permitted a
null confidence until the commit shipping this file. So a VALID constraint could
pass every local check and still fail against production. NOT VALID enforces on
every INSERT and UPDATE from now on and leaves existing rows alone.

**Measured on a from-zero throwaway stack** — this is the count US-1996 AC5 asked
for, taken against what the migrations actually seed:

| table | rows | missing provenance |
|---|---|---|
| brand_knowledge | 204 | 0 |
| brand_styles | 735 | 0 |
| brand_style_codes | 30 | 0 |
| brand_colorways | 159 | 0 |
| brand_size_charts | 316 | **11** |

**PROVEN AGAINST A RUNNING DATABASE, not inferred:** an unsourced INSERT into
`brand_knowledge` is refused by name, a sourced one succeeds, and the 11 legacy
rows still read.

**NOT push-blocking.** The edge code shipping alongside it refuses a null
confidence and a blank source_url in `buildPatch` before the DB ever sees them,
so an old database under new code is strictly safer, not broken.

**The residual operator action, and it is small:** count prod's own rows, then
`ALTER TABLE public.brand_knowledge VALIDATE CONSTRAINT brand_knowledge_sourced;`
(and the same per table) to enforce retroactively. That command is the definition
of done for the backfill and is deliberately NOT run here.

**No `NOTIFY pgrst` needed** — no table, column or RPC changed.

**Rollback** is `ALTER TABLE public.<t> DROP CONSTRAINT <t>_sourced;` for each of
the five, then `DROP FUNCTION public.brand_fact_is_sourced(text, numeric);`.

---

## ✅ APPLIED: 00577_small_leather_goods_brand_knowledge.sql (US-2221 — a wallet is not a bag, and half of them are not leather, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT.** `GET https://functions.gradethread.com/health/ready` returned `schema: {expected: "00575", applied: "00577", status: "ahead"}` — the database's own answer. 00576 and 00577 were applied together, so that one reading covers both. The "ahead" is the running edge image predating the version bump and resolves on the next edge deploy.

**Risk: LOW. Two `insert ... on conflict do nothing` statements into reference
tables.** No table, column, constraint, index, policy or function is created,
altered or dropped. Nothing existing is read, rewritten or backfilled. No
decoders, so nothing here can override an AI answer.

**Apply order: AFTER 00576.** No dependency, just NNNNN order. 00576 and 00577
are independent of each other and can be applied in one sitting.

**NOT push-blocking, and nothing waits on it.** Bellroy, The Ridge, Secrid and
Bosca have always fallen through the resolver; an old database under new code
behaves as it does today.

**What it adds.** 4 brand rows, 6 style rows, 10 authentication tells. It closes
US-2221 AC1 — the fourth and last accessory pack.

**Why it is a distinct class and not four more rows:** a wallet has no care
label, no hangtag and no creed patch, so its only mark is an emboss on the panel
the hand grips — meaning IDENTIFIABILITY DEGRADES WITH CONDITION, a coupling that
exists nowhere else in this KB. And the category's name lies: The Ridge is
aluminium/titanium/carbon fibre and Secrid's Cardprotector is anodised aluminium,
so a leather rubric invents defects that cannot exist and misses the ones that
can.

**Verified from zero on a throwaway stack** (`node scripts/verify.mjs --db`),
applied and re-applied. `EXPECTED_SCHEMA_VERSION` bumped to `00577` in the same
commit with the manifest regenerated.

**No `NOTIFY pgrst` needed** — no table, column or RPC changed, only rows.

**Rollback** is `delete from public.brand_knowledge where updated_by =
'migration:00577';` and the same for `brand_styles`.

---

## ✅ APPLIED: 00576_jewelry_brand_knowledge.sql (US-2221 — a mark that passes the bar and still is not a decoder, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT.** `GET https://functions.gradethread.com/health/ready` returned `schema: {expected: "00575", applied: "00577", status: "ahead"}` — the database's own answer. 00576 and 00577 were applied together, so that one reading covers both. The "ahead" is the running edge image predating the version bump and resolves on the next edge deploy.

**Risk: LOW. Two `insert ... on conflict do nothing` statements into reference
tables.** No table, column, constraint, index, policy or function is created,
altered or dropped. Nothing existing is read, rewritten or backfilled. The rows
land in `brand_knowledge` and `brand_styles`, global operator tables with RLS
enabled and zero policies.

**Apply order: AFTER 00575.** No dependency, just NNNNN order.

**NOT push-blocking, and nothing waits on it.** Pandora, Tiffany & Co., David
Yurman and James Avery have always fallen through the resolver, so an old
database under new code behaves as it does today. The frontend reads none of it.

**No decoders and no size charts, both deliberate.** Nothing here can override an
AI answer, which makes this the lowest-consequence of the three US-2221 packs —
the opposite of 00575, which seeded decoder authority.

**What it adds.** 4 brand rows, 5 style rows, 10 authentication tells, 2
deliberately low-confidence dating claims.

**⚠ The one thing to preserve if this is ever edited: NEVER AUTO-AUTHENTICATE.**
A hallmark is a few characters struck into soft metal and is the first thing a
counterfeiter copies. Every tell is phrased as necessary-and-not-sufficient, and
a test fails any tell that claims a verdict.

**Verified from zero on a throwaway stack** (`node scripts/verify.mjs --db`),
applied and re-applied. `EXPECTED_SCHEMA_VERSION` bumped to `00576` in the same
commit with the manifest regenerated.

**No `NOTIFY pgrst` needed** — no table, column or RPC changed, only rows.

**Rollback** is `delete from public.brand_knowledge where updated_by =
'migration:00576';` and the same for `brand_styles`.

---

## ✅ APPLIED: 00575_eyewear_brand_knowledge.sql (US-2221 AC3 — three decoders that pass the bar, and four that do not, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT.** `GET https://functions.gradethread.com/health/ready` returned `schema: {expected: "00574", applied: "00575", status: "ahead"}` — the database's own answer. The "ahead" is the running edge image predating the version bump and resolves on the next edge deploy.

**Risk: LOW. It is three `insert ... on conflict do nothing` statements into
reference tables.** No table, column, constraint, index, policy or function is
created, altered or dropped. Nothing existing is read, rewritten or backfilled.
The rows land in `brand_knowledge`, `brand_style_codes` and `brand_styles` —
global operator tables with RLS enabled and zero policies, so only the edge
service-role client sees them.

**Apply order: AFTER 00574.** No dependency, just NNNNN order.

**NOT push-blocking, and nothing waits on it.** Ray-Ban, Oakley, Persol and Warby
Parker have always fallen through the resolver, so an old database under new code
behaves as it does today: the in-code alias table shipping in the same commit
resolves the brand, and the DB rows add the decoders and styles on top. The
frontend reads none of it.

**⚠ THIS PACK SEEDS DECODERS, WHICH IS THE ONE THING IN A BRAND PACK THAT CAN
OVERRIDE A CORRECT ANSWER.** Decoder authority outranks the AI on conflict. Three
are added — `^RB\d{4}$`, `^OO\d{4}$`, `^PO\d{4}[A-Z]{0,2}$` — and every one is
PREFIX-ANCHORED on purpose. Ray-Ban, Oakley and Persol share one parent
(Luxottica) which also makes licensed frames for houses already canonical in this
KB, so a permissive two-letter pattern would decode a Prada or a Versace and spell
"Ray-Ban" over it. The anchors are asserted by RUNNING them against those sibling
codes in `eyewear-content_test.ts`, not by comment.

**What it adds.** 4 brand rows, 3 decoders, 9 style rows. No size charts,
deliberately: a frame's size is printed on the frame in millimetres, so there is
nothing to look up and a chart would be invented. A test asserts that absence so
it does not read as an omission.

**Verified from zero on a throwaway stack** (`node scripts/verify.mjs --db`),
applied and re-applied. `EXPECTED_SCHEMA_VERSION` bumped to `00575` in the same
commit with the manifest regenerated.

**No `NOTIFY pgrst` needed** — no table, column or RPC changed, only rows.

**Rollback** is `delete from public.brand_knowledge where updated_by =
'migration:00575';` and the same for `brand_style_codes` and `brand_styles`.
Every row carries that marker.

---

## ✅ APPLIED: 00574_headwear_brand_knowledge.sql (US-2221 — the KB learns to size a hat, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT, not by report.** `GET https://functions.gradethread.com/health/ready` returned `schema: {expected: "00573", applied: "00574", status: "ahead"}` — the database's own answer. The running edge image predates the 00574 version bump, which is why it reads "ahead"; that is the safe direction and it resolves on the next edge deploy.

**Risk: LOW. It is four `insert ... on conflict do nothing` statements into
reference tables.** No table, column, constraint, index, policy or function is
created, altered or dropped. Nothing existing is read, rewritten or backfilled.
The rows land in `brand_knowledge`, `brand_size_charts` and `brand_styles` —
global operator tables with RLS enabled and zero policies, so only the edge
service-role client sees them.

**Apply order: AFTER 00573.** No dependency, just NNNNN order.

**NOT push-blocking, and nothing waits on it.** Every one of these brands is a
brand the resolver has always fallen through on, so an old database under new
code behaves exactly as it does today: `canonicalizeBrand("New Era")` resolves
from the in-code alias table shipping in the same commit, and the DB rows only
add the charts and the era notes on top. The frontend reads none of it.

**What it adds.** New Era, Stetson, Kangol and Goorin Bros. were absent from the
KB entirely — no row, no alias, no chart — while `item_category` has carried
accessories since 00230 and `GARMENT_CATEGORIES` has listed `hat` all along.
Four brand rows, five size charts, nine style rows.

**The reason it is a category shift and not four more rows:** a hat is sized in
head circumference and labelled in eighths of an inch, which no chart in this KB
carried before. ⚠ And the brands DISAGREE — New Era publishes 22 3/4 in for a
printed 7 1/4 and Stetson publishes 23 in for the same label, because Stetson's
is a fit chart that rounds up. So a cross-brand hat-size conversion is lossy by
up to a quarter inch. Both numbers are seeded as published and a test pins the
disagreement so nobody reconciles them later.

**No decoder, deliberately.** New Era's `5950` names the silhouette, not the
item (and a bare four-digit run is the Chanel/Lee refusal), and the per-cap code
lives on a removable visor sticker — 00468's hangtag rule exactly. The refusal
is asserted in `headwear-content_test.ts`, not just commented.

**The `tag_eras` provenance constraint from 00572 enforced this on the way in.**
Every datable era entry carries `source_url` and a numeric `confidence`, or the
insert would have failed. That is the from-zero db lane doing the checking, not
a reviewer.

**Verified from zero on a throwaway stack** (`node scripts/verify.mjs --db`),
applied and re-applied. `EXPECTED_SCHEMA_VERSION` bumped to `00574` in the same
commit with the manifest regenerated.

**No `NOTIFY pgrst` needed** — no table, column or RPC changed, only rows.

**Rollback** is `delete from public.brand_knowledge where updated_by =
'migration:00574';` and the same for `brand_size_charts` and `brand_styles`.
Every row carries that marker for exactly this reason.

---

## ✅ APPLIED: 00573_legal_acceptances_signup_confirmed.sql (US-2116 AC4 — the consent record says which row is which, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT, not by report.** `GET https://functions.gradethread.com/health/ready` returned `schema: {applied: "00573"}` on 2026-08-09 14:27 UTC — the database's own answer, read through the service-role client. 00564 through 00573 were applied together, so that single reading covers all ten. Nothing below is outstanding; it is kept for the next reader.


**Risk: NONE. It is one `COMMENT ON COLUMN`.** No table, column, constraint,
index, policy or function is created, altered or dropped. Nothing is backfilled
and no row is read or written.

**Apply order: AFTER 00572.** No dependency, just NNNNN order.

**NOT push-blocking, and nothing waits on it.** `legal_acceptances.method` has
always been plain `text` with no CHECK, so the new `signup_clickwrap_confirmed`
value writes with or without this file. The edge code shipping alongside it does
not read the comment. An old database under new code behaves identically.

**What it fixes.** 00142:44 documents three method values and the code now
writes four. Applied migrations are immutable, so the only way to correct that
sentence is another migration. It matters because this column is the answer to
"what did this user agree to, and how do you know?" — and whoever asks that is
reading the table, in an incident or a data request, not reading TypeScript. A
comment listing three of four values tells them the fourth is unexpected data.

**The pair it documents.** An email signup now produces TWO rows.
`signup_clickwrap` comes from the `handle_new_user` trigger, which has no HTTP
request and therefore no IP or user-agent — guaranteed but weak. `signup_clickwrap_confirmed`
comes from `POST /api/legal/confirm-signup` on the first authenticated session,
with the IP and user-agent the edge observed itself and the versions copied off
the first row — best-effort but strong. Its `accepted_at` is when the SERVER
observed the session, not when consent was given; that is why they are two
method values and not one value with a null IP.

**Verified from zero on a throwaway stack** (`node scripts/verify.mjs --db`),
applied and re-applied. `EXPECTED_SCHEMA_VERSION` bumped to `00573` in the same
commit with the manifest regenerated.

**No `NOTIFY pgrst` needed** — PostgREST's schema cache does not carry column
comments, and no table, column or RPC changed.

**Rollback** is restoring the previous comment text. Nothing depends on it.

## ✅ APPLIED: 00572_tag_eras_provenance.sql (US-2212 AC5 — an era we cannot cite is invention, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT, not by report.** `GET https://functions.gradethread.com/health/ready` returned `schema: {applied: "00573"}` on 2026-08-09 14:27 UTC — the database's own answer, read through the service-role client. 00564 through 00573 were applied together, so that single reading covers all ten. Nothing below is outstanding; it is kept for the next reader.


**Risk: LOW.** One IMMUTABLE function, one CHECK constraint added `NOT VALID`,
two comments. No table rewritten, nothing backfilled, no existing row touched.

**Apply order: AFTER 00571.** No dependency, just NNNNN order.

**NOT push-blocking.** The constraint only bites on INSERT/UPDATE of
`brand_knowledge`, which no client writes — brand knowledge arrives through
migrations and the admin curation surface. The edge code that reads the new
per-entry provenance treats its absence as "uncited", which is what all ~220
existing entries are, so an old database under new code behaves correctly.

**`NOT VALID` IS THE DESIGN, NOT A SHORTCUT — do not "clean it up".** Every
seeded entry predates this and carries no provenance. A plain CHECK would refuse
to apply, so the only ways to ship it would be to fabricate sources (the thing
the rule exists to prevent) or delete curated knowledge that is still useful as
prompt reference. NOT VALID enforces on all new writes and leaves the legacy
rows readable. **The backfill is finished when this succeeds:**

```sql
ALTER TABLE public.brand_knowledge VALIDATE CONSTRAINT brand_knowledge_tag_eras_sourced;
```

Do NOT run that now — it will fail, and correctly.

**Why the predicate is in a function.** Postgres rejects a subquery in a CHECK
(`0A000`), and walking a jsonb array needs one. The first draft did it inline
and `node scripts/verify.mjs --db` caught it on a from-zero re-apply.

**Verified from zero on a throwaway stack**, not eyeballed.

**Run `NOTIFY pgrst, 'reload schema';`** after applying — a new function.

**Rollback** is dropping the constraint and the function. Nothing depends on
either; the edge code degrades to treating every era as uncited, which is the
state it is in today.

## ✅ APPLIED: 00571_grade_confidence_label_fn.sql (US-2303 AC2 — one home for the confidence buckets, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT, not by report.** `GET https://functions.gradethread.com/health/ready` returned `schema: {applied: "00573"}` on 2026-08-09 14:27 UTC — the database's own answer, read through the service-role client. 00564 through 00573 were applied together, so that single reading covers all ten. Nothing below is outstanding; it is kept for the next reader.


**Risk: LOW to apply, HIGH if the wrong revision had been edited — read the
second paragraph.** Adds an IMMUTABLE `public.grade_confidence_label(numeric)`
and re-issues `public.public_grade_reports` to call it instead of re-deriving
the four boundaries inline.

**⚠️ THE STORY POINTED AT THE WRONG VIEW REVISION.** US-2303's note named 00356
as the live one. Three revisions have landed since — 00530 (rubric factors),
00532 (video grading), 00534 (live capture). Replacing 00356's body would have
SILENTLY REMOVED `rubric_key`, `factor_scores`, `video_capture_verified` and
`video_live_capture_verified` from the public certificate. `CREATE OR REPLACE
VIEW` would not have complained: it refuses to DROP or reorder columns, and
those four are at the END, so dropping them is exactly the shape it permits.
This file is GENERATED from 00534's own text with one expression substituted, so
the column list cannot drift from what is deployed.

**Apply order: AFTER 00570.** No dependency, just NNNNN order.

**NOT push-blocking.** No client reads the function; the view's output shape is
unchanged, so an old frontend against the new view is byte-identical.

**ONE DELIBERATE BEHAVIOUR CHANGE, and it is a fix.** The function is `STRICT`,
so a NULL `confidence_score` now yields NULL. The old inline CASE returned
`'reviewed'` for it — `NULL >= 0.9` is NULL, so every branch failed and it fell
to `ELSE`. A grade with no confidence recorded is not the same as one that
scored badly, and claiming "reviewed" on a public certificate for a row we never
scored is a statement we cannot support. The client already treats a missing
label as no badge.

**Verified from zero on a throwaway stack**: `node scripts/verify.mjs --db`
re-applied every migration. `src/test/confidence-label-view-parity.test.ts`
fails the build if a seventeenth revision pastes the CASE back, and also asserts
the historical revisions were left alone — applied migrations are immutable and
rewriting them is the other way this could have gone wrong.

**Run `NOTIFY pgrst, 'reload schema';`** after applying — the view was replaced.

**Rollback** is re-running 00534, which restores the inline CASE. The function
can stay; nothing else calls it.

## ✅ APPLIED: 00570_headwear_neckwear_gloves_categories.sql (US-2223 + US-2224 — three taxonomy values, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT, not by report.** `GET https://functions.gradethread.com/health/ready` returned `schema: {applied: "00573"}` on 2026-08-09 14:27 UTC — the database's own answer, read through the service-role client. 00564 through 00573 were applied together, so that single reading covers all ten. Nothing below is outstanding; it is kept for the next reader.


**Risk: LOW.** Three `ALTER TYPE … ADD VALUE IF NOT EXISTS` and one type
comment. No table touched, no backfill, nothing rewritten. `item_category`
gains `headwear`; `garment_category` gains `neckwear` and `gloves`.

**Apply order: AFTER 00569.** No dependency, just NNNNN order.

**⚠️ PUSH-BLOCKING, and this is the classic case the held-migration rule exists
for.** The FRONTEND reads these enums directly: `GARMENT_CATEGORIES` and
`ITEM_CATEGORIES` in `src/lib/constants.ts` now list the new values, and both
drive pickers that write straight to the database under RLS. If Cloudflare
Pages deploys before the SQL applies, a seller who picks "Hats & caps" or
"Neckwear" gets `invalid input value for enum` and the save fails. Apply first,
then push.

**No transaction wrapper, deliberately, and do not add one.** Postgres refuses
to USE a new enum value in the same transaction that adds it. Nothing in this
file uses one — but wrapping it would make the file unsafe to extend, and the
next person appending an UPDATE would get an error that reads as a Postgres
quirk rather than as their own edit.

**Why headwear is its own item_category rather than living under
`accessories`.** `item_category` is the dimension that selects the grading
rubric, the photo profile AND the measurement template. A cap's condition lives
in the crown, the brim and the sweatband; an accessory's lives in its material,
its edges and its hardware. Filing headwear under accessories would have left
the headwear rubric permanently unreachable while looking correct — the same
class of silent deadness `rubric-parity_test.ts` was written to catch.

**`neckwear`, not `tie`.** One rubric grades a bow tie, an ascot and a cravat;
a value named for one of them invites a seller to pick "other" for the rest,
which routes them straight back into the clothing rubric this work exists to get
them out of.

**Verified on a throwaway stack**, not eyeballed: `node scripts/verify.mjs --db`
re-applied every migration from zero, so the SQL parses and the values land.

**Run `NOTIFY pgrst, 'reload schema';`** after applying — PostgREST caches enum
definitions and will reject the new values until it reloads.

**Rollback is NOT clean, and that is worth knowing before applying.** Postgres
cannot drop an enum value. Reverting means recreating the type without it, which
requires rewriting every column that uses it. In practice the rollback is to
leave the values in place (they are inert until something writes them) and roll
the frontend back.

## ✅ APPLIED: 00569_community_benchmarks_filters.sql (US-2235 — filters on Community Insights, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT, not by report.** `GET https://functions.gradethread.com/health/ready` returned `schema: {applied: "00573"}` on 2026-08-09 14:27 UTC — the database's own answer, read through the service-role client. 00564 through 00573 were applied together, so that single reading covers all ten. Nothing below is outstanding; it is kept for the next reader.


**Risk: MEDIUM, and it is the DROP that carries it.** No table changes at all.
It drops `community_benchmarks(date)` and recreates it with five extra filter
parameters, all defaulting to null.

**⚠️ PUSH-BLOCKING, and in the unusual direction: the SQL must go FIRST.** The
new frontend calls the RPC with six named parameters. Against the old
one-argument function that is a hard PostgREST error, so Community Insights
would be blank for every seller between the push and the apply. The reverse
(new function, old frontend) is completely fine — the extra params default to
null and return exactly today's unfiltered snapshot.

**Why it drops instead of overloading, since a DROP always reads alarming.**
`CREATE OR REPLACE` cannot add parameters; it would create a SECOND function at
a different arity. Both would then accept a single named `p_period_start` (the
new one via its defaults), and PostgREST resolves by NAME — so every existing
one-argument call would become ambiguous and fail at runtime, in production, on
a path no local test covers. One function is the only safe end state.

**There is a gap of milliseconds where the function does not exist** (between
the DROP and the CREATE, inside the same transaction — the file is wrapped in
`BEGIN;`/`COMMIT;`, so concurrent callers block rather than error). Apply it
during a quiet moment anyway.

**The privacy property, because this is the one to review.** Filtering is the
classic way to break a k-anonymity guarantee: narrow until one seller is left,
then read their numbers off the "aggregate". The filters apply to the BASE row
set, so all fifteen existing `sellers >= min_sellers` guards re-evaluate against
the filtered cohort and return nulls. The floor is unchanged — read from
`system_settings.community_min_cohort_sellers`, hard-clamped to at least 5 in
SQL. A guard test (`src/test/community-benchmarks-k-anonymity.test.ts`) fails
the build if a filter ever moves downstream of the base CTE.

**Verified on a throwaway stack**, not just eyeballed: `node scripts/verify.mjs
--db` re-applied every migration from zero, so the SQL parses and the function
creates.

**Run `NOTIFY pgrst, 'reload schema';`** after applying — PostgREST caches
function signatures, and it will keep rejecting the new parameters until it
reloads. **This one is not optional.**

**Rollback** is re-running 00241, which restores the one-argument function. The
old frontend works against it; the new one does not, so roll the frontend back
too.

## ✅ APPLIED: 00568_submission_image_quality_score.sql (US-2136 AC4 — keep the measured photo quality, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT, not by report.** `GET https://functions.gradethread.com/health/ready` returned `schema: {applied: "00573"}` on 2026-08-09 14:27 UTC — the database's own answer, read through the service-role client. 00564 through 00573 were applied together, so that single reading covers all ten. Nothing below is outstanding; it is kept for the next reader.


**Risk: LOW.** One nullable column on `submission_images` plus a range CHECK. No
backfill, no rewrite, no behaviour change until a client starts sending the
value.

**Apply order: AFTER 00567.** No dependency, just the NNNNN order.

**NOT push-blocking, but it IS write-blocking in one direction, so apply it
first anyway.** The frontend sends a new `quality_scores` FormData field and the
edge writes `quality_score` on every submission image. If the edge deploys
before the column exists, EVERY photo submission fails on the insert — the whole
grade, not just the metadata. Applying the SQL first makes that window
impossible. The reverse (column exists, old edge) is completely inert.

**NULL is a real value here, not a gap to backfill.** The score is measured in a
browser canvas that can legitimately fail, and older clients do not send one at
all. Every reader treats NULL as "not measured" and applies NO confidence cap.
Backfilling zeros would be actively wrong: zero means "we looked and it is
unreadable", which caps authenticity confidence on items nobody ever measured.

**What it turns on.** `applyVerdictCap` now slides the authenticity confidence
ceiling between `AUTHENTICITY_NO_MACRO_CONFIDENCE_CAP` (0.7) at quality 0 and no
cap at quality 0.5, using the best macro frame's measured sharpness. Before
this, a macro too soft to read a serial earned exactly the same confidence as a
crisp one. Pre-migration rows carry NULL and are unaffected.

**Run `NOTIFY pgrst, 'reload schema';`** after applying — a new column written
and selected by name through PostgREST.

**Rollback** is dropping the column. The only loss is the measurements
themselves, and every reader already handles their absence.

## ✅ APPLIED: 00567_users_shipping_pii_edge_only.sql (US-2417 — the seller's address stops being plaintext, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT, not by report.** `GET https://functions.gradethread.com/health/ready` returned `schema: {applied: "00573"}` on 2026-08-09 14:27 UTC — the database's own answer, read through the service-role client. 00564 through 00573 were applied together, so that single reading covers all ten. Nothing below is outstanding; it is kept for the next reader.


**Risk: MEDIUM, and the ORDER matters more than the SQL does.** There is no DDL
at all: one `CREATE OR REPLACE FUNCTION` narrowing the users self-update
allowlist, plus two column comments. `business_phone` is already text and
`ship_from_address` is already jsonb — a jsonb column holds a JSON *string*
scalar, so the AES-GCM envelope fits the existing column and no table is
rewritten under a lock.

**Apply order: AFTER 00566. THEN redeploy the edge. THEN push.** That order is
not the usual boilerplate here, it is load-bearing:

1. **Apply the SQL.** The moment it lands, a browser can no longer write those
   two columns. The CURRENTLY DEPLOYED frontend still tries, so a seller saving
   Business & shipping details in that window gets an error naming the column.
   The window is minutes and nothing is corrupted; it is the cost of closing the
   write path before the new frontend exists.
2. **`NOTIFY pgrst, 'reload schema';`** — the function changed, not a table, but
   the guard runs on every self-update and a stale plan is not worth the risk.
3. **Redeploy the edge**, which brings up `PUT/GET /api/account/shipping-profile`.
4. **Then push**, which auto-deploys the frontend onto that route.

Pushing FIRST would deploy a frontend calling a route that does not exist yet —
every Settings save 404s.

**Run the backfill after the edge is up**, not before — it needs the same
`EDGE_ENCRYPTION_KEY` the edge runs with:

```
deno run --allow-net --allow-env scripts/backfill-user-shipping-pii.ts          # dry run
deno run --allow-net --allow-env scripts/backfill-user-shipping-pii.ts --apply
```

It is DRY-RUN BY DEFAULT, refuses to start without the key, and is safe to
re-run: an already-encrypted value passes through rather than being double
wrapped, which would be unrecoverable. **The read path tolerates both formats
(AC4)**, so there is no deadline on running it — an un-backfilled row renders,
it just is not protected yet.

**Rollback** is restating the guard function with the two column names put back
(00550's body) and leaving the ciphertext alone. Do NOT try to decrypt back to
plaintext: the read path already tolerates a mixed table, so the only thing a
rollback needs to restore is the write permission.

## ✅ APPLIED: 00566_per_image_shadow.sql (US-2443 — per-image prompt changes get a live-traffic comparison, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT, not by report.** `GET https://functions.gradethread.com/health/ready` returned `schema: {applied: "00573"}` on 2026-08-09 14:27 UTC — the database's own answer, read through the service-role client. 00564 through 00573 were applied together, so that single reading covers all ten. Nothing below is outstanding; it is kept for the next reader.


**Risk: LOW, and it is INERT on arrival.** Six additive columns on
`grading_shadow_results` and three on `ai_prompt_block_versions`, one index, two
CHECK constraints. No backfill and no behaviour change: the new per-image shadow
path is OFF unless `PER_IMAGE_SHADOW_DAILY_VISION_CAP` is set to a positive
number, which it is not. Applying this migration alone changes nothing that runs.

**Apply order: AFTER 00564 and 00565.** No dependency between them, just the
NNNNN order the apply script uses.

**NOT push-blocking, and that is the difference from 00565.** Nothing in the
FRONTEND reads or writes any of these columns. The only readers are edge code
(`grading-shadow-per-image.ts`, and the admin `/shadow/comparison` +
`/shadow/results` endpoints, which now select `stage`, `tier_agreement`,
`per_factor_deltas`, `images_analyzed`, `vision_calls`). Those endpoints are
super-admin only, so the worst case if the edge deploys before the SQL applies
is an admin panel error on the Shadow tab, not a seller unable to work.

**`stage` defaults to `'composite'`, which is the correct backfill, not a
convenience.** Every row that exists today was written by the composite-only
path. A `NULL` default would have made "old row" and "unknown stage" the same
value.

**The cost columns are the point.** A composite shadow row is one cheap text
call, so nobody ever counted them. A per-image row is one paid VISION call per
photo plus one composite — six to eight for a normal submission. The daily
ceiling is enforced as a SUM over `vision_calls`, so the number has to be on
the row or the guardrail has nothing to read.

**`shadow_sample_rate` and `shadow_daily_cap` on `ai_prompt_block_versions`
default to 0 deliberately.** `ai_prompt_versions.shadow_daily_cap` defaults to
200; this one defaults to 0, because inheriting a sampling default is how a
vision bill arrives before anyone has read a comparison.

**Run `NOTIFY pgrst, 'reload schema';`** after applying — nine new columns
selected by name through PostgREST.

**To actually turn it on afterwards** (three switches, all off today): set
`PER_IMAGE_SHADOW_DAILY_VISION_CAP` on Coolify, then set a non-zero
`shadow_sample_rate` AND `shadow_daily_cap` on the candidate row, and mark it
`is_shadow = true` with `stage = 'per_image'`. Any one of those left at its
default means nothing is spent.

**Rollback** is dropping the nine columns. No data loss beyond shadow
comparison rows, which are advisory analytics and never reach a seller.

## ✅ APPLIED: 00565_expense_recurrence.sql (US-2228 AC3 — an expense that repeats monthly, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT, not by report.** `GET https://functions.gradethread.com/health/ready` returned `schema: {applied: "00573"}` on 2026-08-09 14:27 UTC — the database's own answer, read through the service-role client. 00564 through 00573 were applied together, so that single reading covers all ten. Nothing below is outstanding; it is kept for the next reader.


**Risk: LOW.** Two columns on `flipdesk_expenses` (one boolean with a `false`
default, one nullable uuid), two partial indexes, one CHECK constraint. No
backfill. Every existing row reads as "does not recur", which is what it was.

**Apply AFTER 00564 and BEFORE the push.** `src/pages/flipdesk/expenses.tsx`
writes `recurs_monthly` on every save — including the plain add-an-expense path
— so once Cloudflare Pages auto-deploys, an insert against a database without
the column fails with 42703 and the seller cannot log ANY expense. This one is
push-blocking in a way 00564 is not.

**The CHECK constraint is the runaway guard.** `NOT (recurs_monthly AND
recurrence_source_id IS NOT NULL)` — a generated copy may never itself become a
template. Without it, one bad write gives the next run a second series to
extend, then four, and the table grows on its own.

**The unique index is the idempotency guard**, and it is why the cron carries no
"next occurrence" bookkeeping column. One entry per template per month, enforced
by the database, so the job can re-run, catch up after an outage, or race a
second instance and still converge.

**`ON DELETE SET NULL`, not CASCADE, and this is the decision worth reading.**
Deleting the template means "stop repeating this", NOT "erase the months it
already covered". Those months were really paid. A cascade would silently
rewrite a year of books from one Delete click.

**A new cron ships with this: `expense-recurrence`, `20 5 * * *`,
`POST /api/jobs/expense-recurrence`.** Add the Coolify scheduled task after the
edge deploy — `CRON_SETUP.md` has the generated block. Until it is added the
feature is inert: sellers can tick the box, and nothing copies forward.

**Run `NOTIFY pgrst, 'reload schema';`** after applying — two new columns
selected and written by name through PostgREST.

**Rollback** is dropping the two columns (the indexes and constraint go with
them) and removing the Coolify task. Generated entries stay as ordinary
expenses, which is correct: they were real.

**Verified:** `EXPECTED_SCHEMA_VERSION` bumped to `00565` in the same commit,
manifest regenerated (310 footer-era migrations), self-record footer present,
cron-registry drift guard green with COOLIFY.md / CRON_SETUP.md /
launch-checklist.md / deploy.md all regenerated.

---

## ✅ APPLIED: 00564_expense_receipts.sql (US-2228 AC2 — the receipt behind the number, applied 2026-08-09 — MEASURED)

**Applied and confirmed by MEASUREMENT, not by report.** `GET https://functions.gradethread.com/health/ready` returned `schema: {applied: "00573"}` on 2026-08-09 14:27 UTC — the database's own answer, read through the service-role client. 00564 through 00573 were applied together, so that single reading covers all ten. Nothing below is outstanding; it is kept for the next reader.


**Risk: LOW.** Three nullable columns on `flipdesk_expenses` and one new PRIVATE
storage bucket. No backfill, no constraint, no index, no default. Nothing
existing is rewritten and no row changes. Old code that never mentions the
columns keeps working.

**Apply BEFORE the push, and the frontend is the reason.** `src/pages/flipdesk/
expenses.tsx` reads `e.receipt_path` off every row it lists, and Cloudflare
Pages auto-deploys on push. `select("*")` does not 42703 on a missing column —
it just returns rows without it — so the clip icon would silently never appear
and nobody would know why. The edge is the harder failure: `flipdesk-expenses.ts`
SELECTs `receipt_path, receipt_mime` by name, which PostgREST answers with 42703
until the columns exist.

**The bucket is the part that matters.** `expense-receipts` is created with
`public = false` and NO storage policies, i.e. deny-all to `anon` and
`authenticated`. Both directions go through the edge service-role client, which
does the ownership check itself. A receipt carries a card tail, a billing
address, sometimes a full name — this is deliberately not `item-photos`, the one
public bucket, whose contract is seller listing imagery only.

**If you apply the columns but not the bucket, uploads fail closed** with a
storage error and the row is left untouched (the route removes the orphan object
on a failed link and never writes a path it did not upload). Nothing corrupts;
the feature is simply unavailable.

**Run `NOTIFY pgrst, 'reload schema';`** after applying — three new columns
selected by name through PostgREST.

**Rollback** is `DROP COLUMN receipt_path, receipt_mime, receipt_uploaded_at`
plus `DELETE FROM storage.buckets WHERE id = 'expense-receipts'` (empty the
objects first). The screen degrades to what it was: an expense list with no
attachment.

**PDFs are stored byte-for-byte and are NOT metadata-stripped.** There is no PDF
parser in the edge, and `stripImageMetadata` only knows JPEG/PNG/WebP. That is
acceptable only because the bucket is private, signed-URL-only (TTL 900s), never
published, and never sent to a model — the same file the seller uploaded comes
back to the seller and to nobody else. Image receipts ARE stripped, on the normal
`validateImageUpload` → `stripImageMetadata` path.

**Apply order.** Last, after 00563. It depends on nothing but the
`flipdesk_expenses` table (00019) and `storage.buckets`.

**Verified:** `EXPECTED_SCHEMA_VERSION` bumped to `00564` in the same commit,
manifest regenerated, self-record footer present, full edge suite green.

---

## ✅ APPLIED: 00563_prompt_block_versions.sql (US-2438 — a versioned seam for the grading user message, applied 2026-08-08 — MEASURED)

**Applied and confirmed by measurement, not by report.** `GET https://functions.gradethread.com/health/ready` returns `schema: {expected: "00563", applied: "00563", status: "match"}` — the DB's own answer, read through the service-role client (US-1566), and the edge has already been redeployed on the matching build. Nothing below is outstanding; it is kept for the next reader.

**Risk: LOW.** One new table, ONE RLS policy, three indexes. Nothing existing is
altered, nothing is dropped, no row is rewritten, and no backfill runs. The table
ships EMPTY and stays empty until somebody inserts a row.

**Admins can SELECT; nobody can write except the service role.** An earlier draft
of this file said "four RLS policies" — that draft copied `ai_prompt_versions`'
original 00003 grants, including admin INSERT/UPDATE/DELETE, which migration
00510 had deliberately REVOKED (US-2348: those grants let the admin SPA write the
table directly and so reach around the scope guard, the MFA step-up, the audit
row and the eval gate). On a table holding live grading prompt text that would
have let an admin with a revoked scope move every grade the platform issues. The
file now creates the SELECT policy only, plus three `DROP POLICY IF EXISTS` lines
so re-running the directory converges on that posture even if an intermediate
draft was ever applied by hand.

**An empty table is the no-op state, and that is measured.** The edge reads
`ai_prompt_block_versions` once per grading stage — per-image and composite —
and zero live rows resolves every prompt block to the code constant it has always
used. `unversionedPromptSurfaceHash()` is `baf5d4cb` both before and after every
commit in this batch, so applying this migration cannot move a single grading
prompt.

**Apply order.** Last, after 00562. It depends on nothing but `is_admin()`,
which has existed since 00003.

**It is safe in BOTH orders, so it is not push-blocking on its own.** If the edge
deploys before the SQL runs, the table is missing, the query errors, and
`loadBlockRows` catches it and returns an empty set — i.e. exactly the code
defaults. That path is deliberate (it also covers a DB blip), so a grading call
against a missing table degrades to the prompt that shipped rather than failing.
The reverse order is the normal one and is fine.

**No frontend caller.** Nothing in `src/` reads the table, so a Cloudflare Pages
auto-deploy landing ahead of the SQL cannot 404 a page.

**Run `NOTIFY pgrst, 'reload schema';` after applying** — a new table means
PostgREST needs to see it, and until it does the edge takes the degraded path
above (correct, but it would look like overrides silently not working).

**Rollback** is `DROP TABLE public.ai_prompt_block_versions;`. Nothing else
references it and the edge falls back to code defaults the moment it is gone.

---

**NOTHING IS HELD.** 00564 through 00585 were applied to prod on 2026-08-09 and
measured as they went; every section in this file is now APPLIED. Below the line
is the older history:
00542 through 00563 went to prod on 2026-08-08 and were
confirmed by the owner, and the measurement agrees: `/health/ready` on
`functions.gradethread.com` reports `applied: 00563`. See the note under 00528
for how that is measured and why the measurement, not this file, is the
authority whenever the two disagree.

The running edge container lags the database again, and that is the expected
state right after an apply: as of 2026-08-09 14:27 UTC it reports
`expected: "00572"` against `applied: "00573"`, `status: "ahead"`. The image was
built before the 00573 version bump, so it catches up on the next edge deploy.
DB-ahead-of-code is the safe direction — the boot guard refuses the reverse — so
a lag here is never an incident, only a pending deploy.

## ✅ APPLIED: 00562_grade_prompt_surface_hash.sql (US-2432 — say which prompt surface graded a row, applied 2026-08-08 — owner-confirmed)

**Risk: LOW, and it is the safest shape in this file.** One nullable `text`
column added to `grade_reports`, plus a column comment. That is the whole
migration. No existing column changes type, no row is rewritten, no constraint is
added, and nothing is dropped. `ADD COLUMN` of a nullable column with no default
does not rewrite the table, so it takes a brief lock and returns.

**It builds no index, and that is the point.** The draft carried a partial btree
on the non-null rows. A non-`CONCURRENT` `CREATE INDEX` takes a `SHARE` lock and
scans the whole table — and a partial `WHERE` limits what gets STORED, not what
gets SCANNED — so it would block new grade inserts, meaning paid work, for the
length of a full scan of `grade_reports`. What that buys is a rarely-run operator
analysis query that already has a `created_at` filter to ride. Removed. If one of
those queries ever proves slow, add it `CONCURRENTLY`, outside a transaction.

**Apply order.** Last, after 00561. It depends on nothing but `grade_reports`.

**Rollback** is `DROP COLUMN prompt_surface_hash` (the index goes with it).
Nothing reads it yet outside the write itself.

**No frontend caller — this one is NOT push-order-sensitive.** Unlike 00560,
nothing in `src/` selects the column, so a push landing ahead of the SQL cannot
404 a page. Apply it whenever is convenient before the next edge deploy.

**The edge code is deliberately safe in BOTH orders.** `grading-pipeline.ts`
adds the value by conditional SPREAD, not as a plain key — a null-valued key
still NAMES the column in the PostgREST payload, which 42703s the whole insert
and takes a *paid grade* down with it on any environment where the SQL has not
landed. So the edge can deploy first without risk; it just records nothing until
the column exists. Pinned by a test in `unversioned-prompt-surface_test.ts`.

**`NOTIFY pgrst, 'reload schema';` IS required** — PostgREST caches the column
list, and the edge writes through PostgREST. Without the notify the insert keeps
42703-ing on the new column even after the SQL applies, which is the same
paid-grade failure the spread is there to avoid.

**What it does.** Stores an 8-hex digest of the assembled grading USER message on
every new grade. `prompt_version` names the composite system prompt and which
dynamic blocks were switched on; it says nothing about the CONTENT those blocks
held, so editing the text inside `FABRIC_CRITERIA` left before and after
reporting the same era. This column splits them.

**NULL on every historical row, and there is no backfill.** The surface those
grades ran under is not recoverable from the row, and stamping today's hash on
them would assert an era they never had. Absent means unknown.

## ✅ APPLIED: 00560_listing_performance_rpcs.sql (US-2233 — server-side KPIs + paged search, applied 2026-08-08 — owner-confirmed)

**APPLY BEFORE THE PUSH, and this is the strict direction.** The frontend
change in the same commit calls both functions through `supabase.rpc()`, and
Cloudflare Pages auto-deploys the frontend the moment the branch is pushed.
If the SQL is not in yet, Listing Performance calls an RPC PostgREST has not
published and gets a 404 that reads as a bug in the page.

(An earlier draft of this entry said DO NOT APPLY YET, on the grounds that the
caller did not exist. It does now — the page was wired in the same session.
Left visible rather than rewritten silently, because the two instructions are
opposites and a reader who saw the first one needs to know it changed.)

**Risk: LOW, and lower than most.** It adds two functions and touches no table,
no column, no index and no row. Both are `LANGUAGE sql STABLE` and, critically,
**SECURITY INVOKER** (the default) — they run as the CALLING role, so the
existing RLS on `listings` and `inventory_items` is what scopes them. There is
no tenant filter inside them to get wrong.

**Apply order.** Last, after 00559. No dependency on it beyond both being later
than the tables they read.

**Rollback** is `DROP FUNCTION` on both signatures. Nothing else changes.

**What it does.** `flipdesk_listing_performance_summary()` returns the four
header/KPI figures (count, total views, average CTR, stale count, last synced)
across every active eBay listing the caller can see.
`flipdesk_listing_performance_page(...)` returns ONE searched, sorted, paged
page, with `total_count` riding on each row so the caller gets the page and the
page count in a single round trip. Today the page loads every active listing
into the browser and does all three client-side.

**Why the seller-visible behaviour improves, not just the performance:** the
title fallback (blank `listing_title` → the inventory item's title) moves into
the query, so SEARCH now covers it. Client-side search matched `listing_title`
only, and silently missed every listing whose displayed title came from the
item. The `ILIKE` pattern is escaped, so searching for a title containing `%`
or `_` matches literally instead of wildcarding.

**Contains a `DROP FUNCTION IF EXISTS` on the summary, deliberately.**
`CREATE OR REPLACE` cannot change a function's return type, and this one gained
`last_synced_at` while it was being written. Dropping by full signature first is
what keeps the file re-runnable against a database holding either shape — which
is what rule 1 has to mean here. Verified by applying it twice in a row.

**`NOTIFY pgrst, 'reload schema';` is REQUIRED.** PostgREST will not expose a
new RPC until it reloads, and the frontend calls both through `supabase.rpc()`.
Without the notify the page gets a 404 from PostgREST that looks like a bug in
the page.

**Verified on a throwaway local stack**, not by reading: applied from a clean
state and then re-applied (idempotent); `prosecdef = false` on both; `anon` has
no EXECUTE and `authenticated`/`service_role` do; and behaviourally, with two
seeded sellers, seller A's results never included seller B's listing, the title
fallback resolved, a search for `50%` matched the literal percent sign,
the no-view window filtered, `total_count` was right under `limit 1 offset 1`,
an unknown sort key fell back instead of erroring, and a title sort ordered by
title rather than by views.

**00542–00557 used to be numbered 00539–00554.** The ADE hub loop ran against
the same backlog and landed its own 00539, 00540 and 00541, and those went to
prod first. An applied number is immutable, so the three the hub burned stayed
with the hub and the sixteen here moved up by three. Nothing in them changed
except the number — same SQL, same order, same risk.

## ✅ APPLIED: 00559_billing_environment_marker.sql (US-2286 — mark which store environment paid, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, after 00558. It depends on 00558 only in the loose sense
that both touch `public.users`; there is no ordering hazard between them.

**Risk: LOW.** Three nullable columns with no default and no backfill, two
CHECK constraints, two partial indexes on the sandbox side only. Nothing is
rewritten and no existing row changes. The columns are additive, so old edge
code that never mentions them keeps working unchanged.

**Apply BEFORE the edge deploy.** This is the strict direction. The new edge
writes `billing_environment` / `buyer_billing_environment` on every Apple and
Play entitlement grant, and `environment` on the Play consumable ledger. If the
edge deploys first, every in-app-purchase grant fails with PGRST204 ("column
does not exist") and paying customers get nothing. The frontend does not read
these columns, so a Cloudflare Pages auto-deploy is harmless on its own.

**What it does.** Apple's verifier falls back Production → Sandbox, and that
fallback is correct and stays: App Review always exercises IAP in the sandbox,
so refusing Sandbox JWS fails review. The defect was that the resulting grant
carried no marker — a sandbox-granted Business Yearly was byte-identical on the
users row to one somebody paid for, so it was indistinguishable in revenue
reporting, plan-distribution metrics, the expiry sweeps and any manual "why is
this account on Pro" check. Google has the same gap through licence-tester
purchases, whose signal both Play response parsers were dropping at parse time.

Nullable with three states on purpose: `production`, `sandbox`, and NULL
meaning "granted before the marker existed". `countsAsRevenue()` treats NULL as
revenue, because defaulting the past to sandbox would zero out historical MRR
the first time a revenue query used the column.

**Deliberately NOT included.** `appstore_processed_transactions` is written
only through the SECURITY DEFINER RPC `grant_appstore_credits`, so stamping it
needs a signature change and is its own migration. The revenue-query exclusion
(`revenue_dashboard`, `admin_revenue_metrics`) is also separate — you cannot
exclude what you have not marked, so the marker ships first.

**Operator follow-up (AC5, not shippable from here):** audit prod for existing
entitlements granted from a sandbox purchase. They are NULL after this
migration, so they need the store-side purchase history to identify.

**After applying:** `NOTIFY pgrst, 'reload schema';` — new columns, so
PostgREST must re-read or every write to them 404s at the schema cache.

## ✅ APPLIED: 00558_billing_source_googleplay.sql (US-2287 — Play subscriptions are being rejected, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, after 00557. It only touches a CHECK constraint on
`public.users` created by 00104, so it is independent of the rest of the held
tail and could be applied first if Play billing needs unblocking sooner.

**Risk: LOW, and it is a FIX FOR A LIVE OUTAGE rather than a new feature.** One
constraint dropped and re-added with a third allowed value. No column, no data,
no backfill. The re-add can only fail if a row already holds a value outside
the widened set, which is impossible — the old constraint is stricter.

**Apply BEFORE the edge deploy is not the urgent direction here — apply it as
soon as convenient.** The edge already writes `billing_source='googleplay'`
today and that write is *already failing* with 23514. Applying this makes the
existing code start working; it does not create a new dependency. There is no
window in which the old code breaks against the new schema.

**What it does.** 00104 created `users_billing_source_chk` allowing only
`('stripe','appstore')` and nothing ever widened it, while
`lib/google-play/products.ts` stamps `billing_source='googleplay'` on every
Play subscription grant. So every Play grant UPDATE was rejected: **the customer
is charged by Google and receives no entitlement**, and the Play expiry sweep
can never match a row because no row can hold the value it filters on. Three
sibling constraints WERE widened for Play (00354, 00414, 00486), which is why
grepping the corpus for `googleplay` looks reassuring.

The migration uses `DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT` rather
than 00104's `IF NOT EXISTS` probe on purpose — the probe is what let the stale
definition survive every subsequent apply.

**Operator follow-up (AC1/AC4, not shippable from here):** check prod for
customers who paid Google and were never entitled, and grant retroactively.
Play purchase tokens are recorded even though the users-row grant failed, so
the affected set is recoverable rather than lost.

**After applying:** `NOTIFY pgrst, 'reload schema';` — a constraint change, so
PostgREST should re-read.

## ✅ APPLIED: 00557_loyalty_tenure.sql (US-1914 — tenure tiers & anniversary grants, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, after 00556. It rewrites CHECK constraints owned by
00544 (`reward_milestones.trigger_type`) and 00549
(`reward_nudge_sends.nudge_type`), so both must already be applied — which
numeric order gives you, as long as the whole held tail goes in sequence.

**Risk: LOW.** Two new tables, one trigger function, two re-stated CHECKs that
only ADD an allowed value, and two seed rows behind `ON CONFLICT DO NOTHING`.
Nothing is dropped and nothing is backfilled — tenure derives from
`users.created_at`, which every row already has.

**Apply BEFORE the edge deploy.** `rewards-loyalty.ts` reads and writes
`user_loyalty_state` on the rewards read path, and the anniversary grant writes
`trigger_type = 'anniversary'` and the comeback nudge writes its new
`nudge_type`. Until this applies, those inserts are rejected by the old CHECKs
and the Rewards screen falls back to its error state.

**What it does.**
- `reward_tenure_tiers` — the operator-editable ladder, seeded. `rank` is stored
  rather than re-derived from `min_months`, so an operator editing a threshold
  cannot move anyone down.
- `user_loyalty_state` — one row per user: `member_since`, the `tier_rank_peak`
  high-water mark, and the anniversary bookkeeping. Read-own RLS, plus a
  `seed_user_loyalty_state()` trigger so the row exists before it is needed.
- Adds `'anniversary'` to `reward_milestones.trigger_type` and seeds the
  `anniversary_gift` milestone, so anniversary payouts ride the existing
  US-1853 grant rail (claim-before-pay, USD ceilings, velocity limit) instead of
  a second one.
- Adds the comeback nudge type to `reward_nudge_sends`.

There is deliberately no decay, lapse or reset column anywhere in the file —
that promise is kept in the schema or not at all.

**After applying:** `NOTIFY pgrst, 'reload schema';` — two new tables and two
changed constraints, so PostgREST has to re-read the schema.

## ✅ APPLIED: 00556_badge_click_variant.sql (US-1913 — plain vs status badge clicks, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00404, which creates `badge_click_events`. Long applied,
so in practice: anywhere in the held tail, and it is independent of 00555.

**Risk: LOW.** One additive text column with a default and a CHECK, on an
append-only analytics table. Nothing is dropped, modified or backfilled beyond
the column default.

**Apply BEFORE the edge deploy.** `recordBadgeClick` now writes
`badge_variant` on every insert. Until the column exists that insert fails, and
badge-click attribution stops recording entirely — silently, because the whole
path is best-effort and swallows its errors. The seller funnel would just go
flat.

**What it does.** Adds `badge_click_events.badge_variant` (NOT NULL DEFAULT
`'plain'`, CHECK over `plain | status`). Every existing row reads `plain`, which
is accurate: before US-1913 there was no other badge format.

## ✅ APPLIED: 00555_seller_integrity_tier.sql (US-1912 — seller Grade Integrity tier, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00443 (which owns the `reputation_events` event-type
allow-list this re-states) and after 00421 (which creates
`seller_grade_integrity`). Both are long applied, so in practice: anywhere in the
held tail.

**Risk: LOW.** Additive columns with defaults on a table that is small by
construction (one row per seller who has a buyer outcome), plus one enum value
and one re-stated CHECK constraint. Nothing is dropped or backfilled.

**Apply BEFORE the edge deploy AND before the frontend push.** Three reasons, and
the first is the one that bites:

- The recompute (`recomputeSellerGradeIntegrity`) now writes `tier`,
  `tier_displayable`, `avg_coverage_pct`, `graded_volume`, `tenure_days`. Until
  the columns exist that upsert fails, so a buyer confirming an arrival stops
  refreshing the seller's standing entirely.
- The edge writes `notification_type = 'integrity_tier_change'` on a demotion
  and `reputation_events.event_type = 'integrity_tier_up'` on a promotion. Both
  are rejected by the CHECK/enum until this applies.
- `GET /api/rewards/state`, the public seller profile and the public certificate
  all SELECT the new columns. They degrade to no badge rather than erroring, but
  the seller's own Rewards screen would show "building history" to everyone.

**What it does.**
- Adds `seller_grade_integrity.tier` (NOT NULL DEFAULT `'building'`, CHECK over
  the five tiers), `tier_displayable` (NOT NULL DEFAULT false),
  `avg_coverage_pct` (nullable, 0–100 CHECK), `graded_volume` (NOT NULL DEFAULT
  0), `tenure_days` (nullable), `previous_tier` (nullable, same CHECK) and
  `tier_changed_at`.
- Adds a partial index on the displayable rows (the only ones a public read
  wants).
- Re-states `reputation_events_event_type_check` in full, adding
  `'integrity_tier_up'`. There is deliberately no `'integrity_tier_down'`.
- `ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS
  'integrity_tier_change'`.

**Existing rows read as unranked, which is correct.** Every current
`seller_grade_integrity` row gets `tier='building'`, `tier_displayable=false`, so
nobody is granted a public rank by the migration itself. The first recompute
after a buyer outcome computes their real tier — and because `previous_tier`
starts effectively at `building`, crossing the floor registers as a promotion and
pays once.

## ✅ APPLIED: 00554_radar_activity_by_day.sql (US-1865 — Thrift Radar weekly activity pattern, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00552 — it adds a column to `radar_venue_aggregates`,
which that migration creates.

**Risk: LOW.** One additive column with a default and a cardinality CHECK on an
empty-in-prod table. Nothing is dropped, modified or backfilled.

**Apply BEFORE the edge deploy, not after.** The aggregation job's upsert now
includes `dow_counts` in its payload, so until the column exists every
`/api/jobs/radar-aggregate` run fails on the write and publishes no aggregates
at all — the map goes empty rather than degrading. The read path
(`GET /api/flipdesk/radar/venues*`) also selects the column, so it 500s the same
way. Both are Radar-only; nothing outside Radar touches this table.

**What it does.**
- Adds `radar_venue_aggregates.dow_counts integer[] NOT NULL DEFAULT
  ARRAY[0,0,0,0,0,0,0]` — scans per day of the week at the venue's approximate
  local day, array position 1 = Sunday.
- Adds `radar_venue_aggregates_dow_counts_len CHECK (cardinality(dow_counts) = 7)`.

**Why it rides the existing row.** The weekly pattern inherits the k-anonymity
floor, the hourly recompute and the sweep from the aggregate it is a column of.
A separate table would have meant a second copy of each guard, and a copied
privacy guard is one that goes stale on one side —
`vault/20-domain/thrift-radar.md` rule 6.

**No backfill, deliberately.** The job rewrites every servable row each run and
deletes what it did not rewrite, so the all-zero default is replaced within the
hour. A row still holding zeros renders as "no pattern yet" rather than as a
claim that the store is quiet every day.

## ✅ APPLIED: 00553_radar_personal_stores.sql (US-1864 — Thrift Radar personal store history, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00551 — both new objects reference `radar_venues`
(`sources.radar_venue_id` and `radar_personal_scans.venue_id` are foreign keys to
it), so applying this first fails on a missing relation.

**Risk: LOW.** One nullable column on an existing table, one new table, two
indexes, two RLS policies. Nothing existing is modified or dropped, no data is
backfilled, and the new table starts empty.

**⚠️ THE SPA READS THE NEW COLUMN — apply BEFORE the frontend deploy.** Unlike
00550–00552 this story is NOT server-only. `useSources()` selects `*` from
`sources`, so the column arrives for free once applied; but the new "My stores"
tab reads `sources.radar_venue_id` to decide which venues are still unlinked, and
`POST /api/flipdesk/radar/my-stores/link` writes it. Deploying the SPA first
leaves that tab erroring on every link attempt.

**What breaks if it stays unapplied.**
- `GET /api/flipdesk/radar/my-stores` returns 500 ("Failed to load your store
  history") on the `sources` read, because the selected column does not exist.
  The whole Sourcing → My stores tab shows its error card.
- `POST /api/flipdesk/radar/my-stores/link` returns 500 on the update.
- Every Prospect scan carrying a coordinate logs one warning
  (`radar.personal.insert`) and continues. The scan result itself is unaffected —
  the personal write is fire-and-forget (rule 8), like the contribution beside it.
- Radar contributions are otherwise unchanged: `radar_scan_events` still fills
  normally, so nothing already shipped regresses.

**What it does.**
- Adds `sources.radar_venue_id` (nullable, `REFERENCES radar_venues(id) ON DELETE
  SET NULL`) — the join that lets a named source's money meet a shared venue's
  visits. SET NULL rather than CASCADE on purpose: a merged-away venue must never
  take a reseller's own source row with it.
- Adds `radar_personal_scans` — the reseller's OWN visit log. It cannot be derived
  from `radar_scan_events`, which deliberately has no account column, so the
  personal layer needs its own store. Carries a plain `user_id`, a `venue_id`
  and/or a coarse `geohash`, the brand/category, grade band and verdict.
- **No coordinate column, and the same CHECKs as 00550** (`geohash` 4–7 chars of
  base32; at least one of venue/cell present). "Their own data" is the reason to
  be more careful, not less — these rows are not pseudonymised the way a
  contribution is, so a coordinate column here would be a movement trail of a
  named person.
- RLS: owner SELECT + owner DELETE (`(select auth.uid()) = user_id`), and NO
  insert/update policy — writes are service-role only.

**`NOTIFY pgrst, 'reload schema';`** — required. One new table AND a new column
on an existing table the SPA selects.

**Exercised** against a throwaway local stack via `npm run verify:db` (Docker),
not against prod.

## ✅ APPLIED: 00552_radar_aggregates.sql (US-1863 — Thrift Radar aggregates + retention archive, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00551 — `radar_venue_aggregates.venue_id` is a foreign key
to `radar_venues`, so applying this first fails on a missing relation.

**Risk: LOW.** Two new tables, one new config row. Nothing existing is modified
or dropped, and both new tables start empty.

**No client reads or writes anything new.** Both tables are service-role only
(deny-all RLS, `REVOKE ALL` from anon/authenticated) and are reached solely
through the new `/api/flipdesk/radar/*` endpoints. The web SPA and iOS are
untouched by this story, so pushing before the apply is safe from the
frontend's point of view.

**What breaks if it stays unapplied.**
- `/api/jobs/radar-aggregate` (new hourly cron) returns 500 on every run and
  records an error in `cron_runs`. Nothing else depends on it, and there is
  nothing to lose: the aggregates are recomputed from scratch on the first run
  after the apply. If the noise is unwanted, leave the Coolify scheduled task
  switched off until the SQL is applied.
- `GET /api/flipdesk/radar/venues*` returns 500 ("Failed to load Radar
  aggregates"). Nothing in the SPA calls it yet — the map surface is a later
  story — so no user-facing screen breaks.
- `radar_scan_events` simply keeps accumulating; retention pruning is what this
  migration enables, not something it interrupts.

**What it does.**
- Adds `radar_venue_aggregates` — venue × window (`7d`/`30d`/`90d`) × brand
  (`'*'` = the venue total). Scan count, DISTINCT contributor count, band-derived
  `avg_grade` plus the band mix, buy-verdict rate, `last_activity_at`, and a
  `computed_at` stamp the job sweeps stale rows by. Unique on
  `(venue_id, window_key, brand_key)`.
- **`contributor_count` carries a CHECK of `>= 2`** — the schema-level half of
  the k-anonymity floor. The table cannot hold a single-contributor aggregate.
  `radar_privacy.k_anonymity_floor` (default 3) may raise the effective floor
  above it, never below.
- Adds `radar_scan_history` — month-resolution archive of pruned scan events,
  keyed by a generated `place_key` (the venue id, or `cell:<geohash>` when the
  event never resolved to a venue) plus `month_start`. Deliberately has NO
  foreign key to `radar_venues`, so the archive outlives a venue row.
- Seeds `system_settings.radar_aggregation` (job tuning only — the floor and the
  retention window stay in `radar_privacy`, because lowering either is a policy
  change rather than tuning).

**`NOTIFY pgrst, 'reload schema';`** — required. Two new tables.

**Exercised** against a throwaway local stack via `npm run verify:db` (Docker),
not against prod.

## ✅ APPLIED: 00551_radar_venues.sql (US-1862 — Thrift Radar venue registry, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00550, which created `radar_scan_events` — this migration
adds the foreign key from that table's `venue_id` column to the new
`radar_venues`, so applying it first fails on a missing relation.

**Risk: LOW.** One new table, one new FK on a column that already exists and is
empty in prod, one config row. Nothing existing is modified or dropped.

**No client reads or writes anything new.** `radar_venues` is service-role only
(deny-all RLS, `REVOKE ALL` from anon/authenticated). The web SPA and iOS are
untouched by this story, so pushing before the apply is safe from the frontend's
point of view.

**What breaks if it stays unapplied.** Nothing user-facing. `resolveScanVenue`
selects from `radar_venues`, gets a PostgREST "relation does not exist" error,
logs it at warn and returns null — the contribution still lands with its geohash
cell, which is the state `radar_scan_events_located` was written to allow. That
is the pre-US-1862 behaviour, so the scan the user is waiting on is unaffected
(rule 8, fire-and-forget).

**What it does.**
- Adds `radar_venues` — display name, chain tag (goodwill / savers /
  salvation_army / value_village / other), centroid `lat`/`lng` plus a
  `centroid_source` saying whether that centroid came from a geohash cell centre
  (the only thing scan data may produce), a person, or a future Places
  enrichment. Status candidate / confirmed / merged, with `merged_into_id`
  naming the survivor so a merged id never dangles.
- Partial unique index on `(geohash, chain) WHERE status <> 'merged'` — this is
  what makes later scans converge onto one candidate instead of each minting
  their own, and what makes two concurrent scans safe.
- Adds the FK `radar_scan_events.venue_id → radar_venues(id) ON DELETE SET NULL`
  (guarded by a `pg_constraint` existence check, so re-running is safe).
- Adds the `radar_venues` config row (resolution kill-switch, match radius, merge
  radius, confirm threshold). Separate from `radar_privacy` on purpose: those are
  privacy parameters, these are tuning, and the k-anonymity floor must not sit in
  a row people feel free to edit.

**`NOTIFY pgrst, 'reload schema';`** — a new table and a new constraint.

**Rollback.** Safe to leave in place. Nothing reads the table except the edge's
resolver, which degrades to "unresolved" without it.

## ✅ APPLIED: 00550_radar_scan_events.sql (US-1861 — Thrift Radar consent + events, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It touches `public.users`,
`public.system_settings` and `public.applied_migrations` — all long applied — so
it has no dependency on 00530–00549 beyond the numeric sequence.

**Risk: LOW.** One new column with a `false` default, one new table, one config
row. Nothing existing is modified or dropped, and no behaviour changes on apply:
contribution is off for every user until they turn it on.

**⚠️ APPLY BEFORE PUSH — the frontend reads the new column from the client.**
The Settings → FlipDesk tab renders a "Contribute to Thrift Radar" card that
selects and updates `users.radar_contribute` through PostgREST. Cloudflare Pages
auto-deploys the frontend on push, so if the SQL has not been applied the card
errors on save for every user who touches it. Run the SQL, then
`NOTIFY pgrst, 'reload schema';` (a new column on `users` — PostgREST caches the
schema), then push.

**What it does.**
- Adds `users.radar_contribute boolean NOT NULL DEFAULT false` — the contribution
  consent. A NEW toggle on purpose: it is never folded into
  `share_sale_outcomes` or the analytics switch.
- Adds `radar_scan_events` — anonymized contributions. No coordinate column and
  no account column: a salted, weekly-rotating `contributor_key` plus a geohash
  cell capped at 7 characters by a CHECK. Deny-all RLS, service-role writes only;
  registered in both `SERVICE_ROLE_ONLY` and `SERVICE_ONLY_FORCED` in
  `rls-guard_test.ts` because a table with no owner column is never discovered.
- Adds the `radar_privacy` config row (kill-switch, cell precision, key rotation,
  k-anonymity floor, raw-event retention).

**Rollback.** Safe to leave in place; the edge only writes to the new table when
`radar_privacy.contribution_enabled` is true AND a user has opted in. To stop all
contribution without a deploy, set that key's `value` to
`{"contribution_enabled": false, ...}`.

## ✅ APPLIED: 00549_reward_nudges.sql (US-1859 — re-engagement nudges, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It references `public.users`,
`public.system_settings` and the `notification_type` enum (00007) — all long
applied — so it has no dependency on 00530–00548 beyond the numeric sequence.

**Risk: LOW.** One new table, one new enum VALUE, one config row, and a new
DEFAULT on an existing column. No existing column, row, view or policy is
modified or dropped, and no notification is sent on apply: the cron has to be
registered in Coolify separately.

**What it does.**
- Adds `reward_nudge_sends` — one row per nudge DECISION, including the
  deterministic holdout slice that is deliberately not sent. Service-role only,
  deny-all RLS. `UNIQUE (user_id, nudge_type, subject_key, period_key)` is both
  the idempotency guarantee and the per-subject frequency cap.
- Adds `'reward_nudge'` to `notification_type`. `ALTER TYPE ... ADD VALUE` is
  transactional in PG 12+ and the value is not USED in this migration, so it is
  safe either way. **The edge must not be rolled back past this migration while
  a `reward_nudge` notification row exists** — an older build's `NotificationType`
  union does not know the value, and the frontend catalog would render it as a
  bare slug.
- Moves `users.notification_preferences`'s DEFAULT onto the set that includes
  `reward_nudges`. EXISTING rows are untouched, which is correct: the engine
  reads the category with an opt-OUT default (absence ⇒ enabled), the same model
  every other category uses, so a pre-existing user needs no backfill.
- Seeds `system_settings.reward_nudges_config` (kill-switch, per-type switches,
  frequency cap, holdout share, attribution window).

**After applying,** register the `reward-nudges` cron in Coolify
(`0 15 * * *` → `POST /api/jobs/reward-nudges`) — see CRON_SETUP.md. Until it is
registered nothing sends, which is a safe state, not a broken one.

## ✅ APPLIED: 00548_reward_economics_guardrails.sql (US-1858 — reward budget guardrails, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It references `public.users`,
`public.system_settings` and the `abuse_signal_type` enum (00212) — all long
applied — so it has no dependency on 00530–00547 beyond the numeric sequence.

**Risk: LOW.** One new table, one new enum VALUE, one config row. No existing
column, row, view or policy is modified or dropped, and nothing is granted on
apply: the guardrails only narrow a budget that is already gated by the
`rewards_tangible` kill-switch, which stays off.

**What it does.**
- Adds `reward_budget_breaches` — one row per reward ceiling that refused a
  grant, suppressed while OPEN (two partial UNIQUE indexes: one platform-wide
  per scope, one per scope+account). Service-role only, deny-all RLS.
- Adds `'reward_farming'` to `abuse_signal_type`. `ALTER TYPE ... ADD VALUE` is
  transactional in PG 12+ and the value is not USED in this migration, so it is
  safe either way. **The edge must not be rolled back past this migration while
  a `reward_farming` row exists** — an older build's `SIGNAL_TYPES` set does not
  know the value and would filter those signals out of the safety console
  (silently; nothing errors).
- Seeds `system_settings.rewards_economics_guardrails` (margin floor, free-tier
  allowance, daily velocity limits, auto-pause and fraud-hold switches).

## ✅ APPLIED: 00547_reward_leaderboards.sql (US-1856 — public reward leaderboards, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It touches `users` and `referral_events`
(both long applied) and adds an index on `showcase_reactions`, which arrives in
**00546** — so 00546 MUST be applied first, or the second `CREATE INDEX` fails on
a missing table.

**Risk: LOW.** Two nullable-or-defaulted columns on `users` and three indexes. No
existing column, row, view, policy or enum is modified or dropped, and nothing
becomes public on apply (the opt-in defaults to false).

**What it does.**
- Adds `users.leaderboard_opt_in` (NOT NULL DEFAULT false) and
  `users.leaderboard_alias` — the opt-in and public alias for the reward
  leaderboards. A THIRD toggle beside the referral board's (00195) and the buyer
  board's (00423) on purpose: those boards' copy names a referral count and a
  confirmation count, and these publish XP, graded volume and reactions. The
  default is false, so nobody appears until they choose to.
- Adds `idx_users_leaderboard_opt_in` (partial, the small public cohort),
  `idx_showcase_reactions_report_user` (the finds board excludes a seller's
  reaction to their own find, so it reads reactions by report AND reactor) and
  `idx_referral_events_granted_at` (partial, the weekly share-driven-signups
  board filters on when a referral was granted).

**Deploy order.** Apply BEFORE the edge rolls (the normal order). The edge build
that ships with it serves `/api/content/public/leaderboards.json` and
`/api/rewards/leaderboard`, both of which read the new columns; against a DB
without this migration those routes 500 (and the leaderboards page renders
empty). Nothing EXISTING breaks either way — the columns are additive and no
current query reads them.

**Client-side reads?** No. The SPA reads the boards from the edge
(`/api/content/public/leaderboards.json`) and its own standing from
`/api/rewards/leaderboard`; it never queries `users.leaderboard_*` directly. The
new columns are added to the frontend `Database` type for completeness only.

## ✅ APPLIED: 00546_showcase_finds.sql (US-1855 — public Showcase / "Finds" feed, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It needs `submissions`, `grade_reports`
and `users` (all long applied), so it depends on none of the other held
migrations and could go first if 00530–00545 slip.

**Risk: LOW.** Three nullable-or-defaulted columns on `submissions`, one new
table, one new view, three indexes and one CHECK constraint. No existing column,
row, view or enum is modified or dropped.

**What it does.**
- Adds `submissions.showcase_opt_in` (NOT NULL DEFAULT false),
  `.showcase_opted_in_at` and `.showcase_value_cents` — the PER-ITEM consent that
  decides whether a graded find appears in the public feed. The default is false,
  so the backfill is implicit and NOTHING becomes public on apply.
- Adds `showcase_reactions` (one upvote per user per find) with owner-scoped RLS:
  a user reads, inserts and deletes only their own rows. Public counts are
  aggregated by the service-role edge, so no "anyone can read" policy exists —
  who reacted to what is not public, only how many did.
- Adds the `public_showcase_finds` VIEW, granted to `anon`. It re-states the
  `public_grade_reports` visibility predicate (certified, review-approved, not
  moderation-withheld) and ANDs consent on top, so a find can never be more
  visible than its own certificate.

**Deploy order.** Apply BEFORE the edge rolls (the normal order). The edge build
that ships with it serves `/api/content/public/finds.json` and `/api/showcase/*`,
both of which read the new view/table; against a DB without this migration those
routes 500. Nothing EXISTING breaks either way — the columns are additive and no
current query reads them.

**Client-side reads?** Yes, but only through the edge. The SPA reads the feed
from `/api/content/public/finds.json` and never queries `public_showcase_finds`
or `showcase_reactions` directly, so the RLS posture above is the whole story.

## ✅ APPLIED: 00545_share_to_earn.sql (US-1854 — share-to-earn loop, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It only needs `reputation_events`
(00417), `badge_click_events` (00404) and `users`, all long applied — so it does
not depend on any other held migration and could go first if 00530–00544 slip.

**Risk: LOW.** One new table, two new columns on `badge_click_events` (both
nullable-or-defaulted), three indexes, and one CHECK constraint widened by a
single value. No existing column, row or enum is modified or dropped.

**What it does.**
- Widens the `reputation_events` event_type CHECK by one value,
  `share_milestone`. Restated in full, so the whole allow-list is authoritative.
  Widening only — no existing event type is removed, so already-stored rows stay
  valid.
- Adds `share_events` — the TRACKED SHARE log (who shared which certificate,
  through which channel). **Deny-all RLS** plus an explicit REVOKE: it holds
  `sharer_hash`, which is the self-click defence, so a client that could write it
  could bank a fingerprint against someone else's find and have that seller's
  genuine clicks discarded.
- Adds `badge_click_events.visitor_hash` (nullable) and `.self_click` (NOT NULL
  DEFAULT false). `self_click` is defaulted, so the backfill is implicit and
  existing rows read as "not a self-click", which is the honest reading for
  clicks recorded before any fingerprint existed.

**Deploy order.** Apply BEFORE the edge rolls (the normal order). An edge build
running against a DB without this migration would fail the `share_milestone`
CHECK on every milestone grant and fail every `badge_click_events` insert on the
unknown `visitor_hash`/`self_click` columns — i.e. it would break the EXISTING
badge-click recording, not just the new feature. That is the one thing here worth
watching: this migration must land before the edge image that expects it.

**Client-side reads?** None. The SPA never queries `share_events` or the new
columns — both go through the edge (`/api/rewards/share`,
`/api/content/public/badge-click`). So a frontend auto-deploy ahead of the SQL is
harmless; the edge is the one that must not run ahead.

## ✅ APPLIED: 00544_reward_milestone_catalog.sql (US-1853 — milestone rewards, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It depends on `reward_tangible_grants`
(00538, also held), `users` and `set_updated_at()`, so it MUST go after 00538.

**Risk: LOW.** One new table, two new nullable columns on a table nothing has
written to in prod yet, two indexes, seven seeded catalog rows (five of which
restate the ladder already compiled into the edge). No existing column, enum or
row is modified.

**What it does.**
- Adds `reward_milestones` — the operator-editable tangible catalog: reward type,
  trigger (XP threshold | badge | season goal), value, marginal cost, and its own
  monthly + lifetime issue caps. **Deny-all RLS** (RLS on, zero policies) plus an
  explicit REVOKE: a client-writable reward catalog is a client-writable money
  faucet. Read through `/api/admin/rewards/milestones` and by the service-role
  engine only.
- Adds `reward_tangible_grants.expires_at` and `.consumed_at`. A per-grade
  discount is live until `expires_at` and then simply stops applying (no
  revocation job); a subscription coupon is redeemable once and the
  `customer.subscription.created` webhook stamps `consumed_at`.
- Seeds the five XP credit milestones US-1848 shipped in code, with the same
  keys/values/costs, so grants already in the ledger still map to a milestone.
- Seeds two DISABLED discount milestones (a badge-triggered subscription discount
  and a season-goal-triggered grading discount) so the shapes are visible in the
  admin screen. Turning one on is deliberate: both mint a real Stripe coupon, and
  the honest `cost_usd` of a discount depends on a plan mix this file can't see.

**Deploy order.** Apply BEFORE the edge rolls (the normal order). An edge build
that reads `reward_milestones` against a DB without it logs the failure and falls
back to the compiled ladder, so it degrades rather than breaking — but the
discount grants need `expires_at`/`consumed_at` to exist before they can be paid.
The `rewards_tangible` kill-switch (00538) is still seeded OFF, so nothing here
pays anybody until an operator turns it on.

**After applying:** `NOTIFY pgrst, 'reload schema';` — one new table and two new
columns need PostgREST to re-read the schema cache.

## ✅ APPLIED: 00543_reward_quests.sql (US-1852 — quests & challenges, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It depends on `reputation_events`
(00417/00443), `users`, `feature_flags` and `set_updated_at()` — all long
applied — and on nothing newer.

**Risk: LOW.** Two new tables, one widened CHECK constraint, one new
`feature_flags` row, four seeded quest rows. No existing table, column or row is
modified.

**What it does.**
- Widens `reputation_events_event_type_check` to admit `quest_completed`. The
  whole allow-list is re-stated (the 00443 precedent), so the statement is
  authoritative and re-runnable. Every existing type is unchanged.
- Adds `reward_quests` — the admin-authored definitions (criteria, window,
  reward) with a per-quest `enabled` kill-switch. **Deny-all RLS** (RLS on, zero
  policies): a client-writable quest definition would be a client-writable XP
  faucet. `xp_reward` is CHECKed at 0–200; the edge clamps it again.
- Adds `user_quest_progress` — the per-user snapshot and completion claim.
  `UNIQUE (user_id, quest_id, period_key)` is what makes a repeating quest pay
  once per window. RLS lets a user read their own rows; only the service role
  writes. Quest PROGRESS itself is still derived from `reputation_events` — this
  table can be dropped and rebuilt.
- Seeds `feature_flags.rewards_quests` = **true**, read fail-OPEN. Deliberately
  the opposite of `rewards_tangible`: quests pay XP, which is free status, so an
  outage that froze everyone's progress would do more damage than one that kept
  paying it. The money rail keeps its own fail-closed switch.
- Seeds four starter personal quests (three weekly, one monthly).

**Deploy order matters.** Apply BEFORE the edge rolls (the normal order): an edge
build that emits `quest_completed` against a DB with the old CHECK gets a 23514
on every quest completion. The frontend is safe either way — the quests panel
renders nothing when the read fails.

**After applying:** `NOTIFY pgrst, 'reload schema';` — two new tables need
PostgREST to re-read the schema cache.

## ✅ APPLIED: 00542_reward_levels_seasons.sql (US-1851 — levels & seasons, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It alters `user_reward_state` (added by
00443, long applied) and depends on nothing newer.

**Risk: LOW.** One new nullable-with-default column, one idempotent backfill of
that same column, one new table, one new `system_settings` row. No existing
column, enum or row is modified.

**What it does.**
- Adds `user_reward_state.xp_peak` (bigint, default 0) and backfills it to
  `GREATEST(xp_peak, xp_total)`. Reward LEVELS now derive from this high-water
  mark, so a level can never decrease — even if the underlying
  `reputation_events` log shrinks (erasure request, fraud reversal, cascade).
- Adds `user_season_recaps` — the frozen record of a completed quarterly season.
  `UNIQUE (user_id, season_key)` is the idempotency guarantee for the lazy
  rollover (the edge writes the row the next time the user opens their rewards
  screen; there is no quarterly cron). RLS lets a user read their own recaps;
  only the service role writes.
- Seeds `system_settings.rewards_season_timezone` = `America/Chicago`, the ONE
  shared zone the quarterly boundary is resolved in, so every seller's season is
  the same window.

**Deploy order matters here, mildly.** The edge writes `xp_peak` on every reward
grant, so applying this BEFORE the edge rolls (the normal order) is required —
an edge build that expects the column against a DB without it fails the upsert
and the reward state stops refreshing. The frontend is safe either way: the new
`/api/rewards/state` route degrades to level 0 / empty season on any read error.

**After applying:** `NOTIFY pgrst, 'reload schema';` — a new table and a new
column both need PostgREST to re-read the schema cache.

## ✅ APPLIED: 00541_listing_aspect_coverage.sql (US-2425 — draft coverage metric, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, after 00540. No dependency beyond `public.listings`
existing.

**Risk: LOW.** One nullable `jsonb` column on `listings` plus one partial index
on `updated_at` where the column is not null. No backfill, no constraint change,
no default — every existing row keeps `NULL` and reads as "not scored yet".

**Client-side read — this one matters for push order.** `src/types/database.ts`
declares `listings.aspect_coverage`, and the new admin page
`/admin/listing-coverage` reads it through the edge route
`/api/admin/listing-coverage`. Cloudflare Pages auto-deploys the frontend on
push, so if the SQL has not been applied the route's `select` fails and the page
shows its error card. Apply first.

**What it does.** Records how complete each generated draft's eBay item
specifics were at the moment AutoLister produced it. Required and recommended
tiers are stored separately on purpose — a required gap blocks the publish, a
recommended gap only costs search placement.

## ✅ APPLIED: 00540_listing_category_candidates.sql (US-2424 — category choice, applied 2026-08-08 — owner-confirmed)

**Apply order.** Before 00541, after 00539. No dependency beyond
`public.listings` existing.

**Risk: LOW.** One nullable `jsonb` column on `listings`. No backfill, no index,
no constraint change.

**Client-side read.** `src/types/database.ts` declares
`listings.category_candidates`. Nothing renders it yet, but the type is shipped,
so apply before the push for the same reason as 00541.

**What it does.** Stores the ranked eBay leaf candidates AutoLister weighed when
choosing a draft's category, with the required-aspect score behind each. Element
0 is the chosen leaf. Lets the composer offer a one-click switch to the runner-up
without a fresh AI run.

## ✅ APPLIED: 00539_quest_definitions.sql (US-1852 — quests & challenges, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It must go AFTER 00443 (which owns the
current `reputation_events` CHECK it rewrites) — long applied — and has no other
dependency.

**Risk: LOW, with one thing to read twice.** It creates one new table and
**re-writes the `reputation_events_event_type_check` constraint**: drop, then
re-add with the eleven existing values plus `quest_completed`. The re-added list
is a strict superset, so no existing row can violate it and no backfill runs.

`apply-prod-migrations.sh` runs each file with `-v ON_ERROR_STOP=1` and **no
`--single-transaction`**, so the two `ALTER`s autocommit separately and there is
a sub-second window where the column carries no CHECK. That window is safe here
(only the service role writes the table, and a superset re-add cannot fail on
existing data) — but if the `ADD` ever did fail, the script halts and the column
stays unconstrained until the file is re-run. Re-running is safe and idempotent.
00443 has exactly this shape; the same caveat applies to it.

**What it does.** Adds `quest_definitions` — the operator's list of which quests
and time-boxed challenges are running, how hard they are, when, and what they
pay. Deliberately NOT added: any per-user progress table. Progress is derived
from `reputation_events` over the quest's window, the same way season progress is
(US-1851), so there is one log and no rollover job.

**The safety rails:**
- `quest_definitions.enabled` defaults **false**, so a half-configured row cannot
  start paying.
- `feature_flags.rewards_quests` is read with `defaultEnabled: false` — the whole
  surface is off until an operator turns it on, and an outage suspends it rather
  than opening it. **No flag row is seeded**, so nothing needs to be un-set.
- The payout is clamped to 200 XP in code, both when written and every time it is
  re-scored — a row written past the ceiling still cannot pay past it.

**Nothing breaks if the frontend deploys first.** The only client surface is the
admin page at `/admin/growth/quests`, which reads the table through the edge
(`/api/admin/growth/quests`). Before the migration applies that call returns a
500 and the page shows its error state; no seller-facing route touches quests at
all. The edge boot guard will expect `00539`, so apply this before the next
Coolify deploy as usual.

**After applying:** `NOTIFY pgrst, 'reload schema';` — a new table AND a changed
constraint, so PostgREST needs to learn about both.

## ✅ APPLIED: 00538_reward_tangible_grants.sql (US-1848 — tangible reward rail, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It depends on nothing newer than
`users`, `feature_flags` and `system_settings`, all of which are long applied.

**Risk: LOW.** One new table, one new `feature_flags` row, one new
`system_settings` row. No existing table, column, enum or row is touched, and
nothing backfills.

**What it does.** Adds `reward_tangible_grants` — the ledger for the half of
GradeThread Rewards that moves real value (free grade credits today;
subscription and per-grade discounts once US-1853 registers their fulfillers).
`UNIQUE (user_id, milestone_key)` is the idempotency guarantee: the engine
claims a row before moving any value, so no retry or concurrent pass can pay a
milestone twice. RLS lets a user read their own grants; only the service role
writes.

**The two config rows are the safety rails:**
- `feature_flags.rewards_tangible` is seeded **`false`**, and the engine reads it
  with `defaultEnabled: false`. So payouts stay off until an operator turns them
  on, and an outage suspends them rather than opening them.
- `system_settings.rewards_tangible_budget` seeds the three USD ceilings
  (global monthly 500, per-user monthly 15, per-user lifetime 60).

**Nothing breaks if the frontend deploys first.** No client surface reads either
the table or the setting — the whole rail lives in the edge service, and with the
flag off it is inert. The edge boot guard will expect `00538`, so apply this
before the next Coolify deploy as usual.

**After applying:** `NOTIFY pgrst, 'reload schema';` — a new table means
PostgREST needs to learn about it.

## ✅ APPLIED: 00537_buyer_growth_metrics.sql (US-1845 — buyer analytics surface, applied 2026-08-08 — owner-confirmed)

**Apply order.** Last, in numeric order. It reads `submissions.buyer_video_grade`
and `ingested_listings`, so it needs 00535 and 00536 applied first — which the
numeric order already gives you.

**Risk: LOW.** One `CREATE OR REPLACE FUNCTION`. No table, no column, no enum, no
data touched. `buyer_growth_metrics(integer)` is SECURITY DEFINER, revoked from
public and granted to `service_role` only, and it returns counts — no user id, no
email, no UTM value tied to a person.

**What it does.** Aggregates the buyer funnel (accounts / activated / paying /
recently active), the plan × interval × status mix, per-feature adoption, a daily
buyer-demand vs seller-grading series, and a first-touch acquisition rollup, all
as one jsonb.

**⚠️ ONE ADMIN PAGE 404s UNTIL THIS APPLIES.** `/admin/growth/buyer` is the only
caller (via `GET /api/admin/growth/buyer`). If the frontend auto-deploys first,
that page shows its error card until the SQL lands. Nothing else reads the
function, no buyer- or seller-facing surface is affected, and no write path
depends on it — so this one is safe to apply after the push if it comes to that,
unlike 00536.

**After applying:** `NOTIFY pgrst, 'reload schema';` — PostgREST caches the RPC
list, so the endpoint 404s at the API layer until it reloads.

## ✅ APPLIED: 00536_buyer_video_grading.sql (US-1841 — buyer-funded walk-around grades, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00532 (it builds on the clip path) and last in numeric
order, like the rest.

**⚠️ THIS ONE IS NOT "LOW". Risk: MEDIUM**, for one specific reason: it adds an
enum value with `ALTER TYPE public.submission_payment_status ADD VALUE IF NOT
EXISTS 'buyer_credits'`. PG12+ permits that inside a transaction, but **the new
value cannot be USED in the same transaction that added it**. This file therefore
never writes or compares the literal against the enum — the `refund_grade`
comparison is deliberately `v_payment_status::text = 'buyer_credits'`. Do not
"tidy" that cast, and do not run any statement that inserts the new value in the
same session before the migration's transaction commits.

**What it does.**
- `submission_payment_status` gains `'buyer_credits'` — a grade paid with a buyer
  video-grade credit rather than the seller precedence.
- `submissions` gains `buyer_video_grade` (bool, default false),
  `buyer_credit_source` (`allowance` | `reward`, CHECKed, nullable) and
  `closet_item_id` (FK → `closet_items`, `ON DELETE SET NULL`), plus a partial
  index on the last one. Every existing row keeps its defaults; nothing is
  rewritten.
- `refund_grade()` is replaced with the 00093 body **plus** a `buyer_credits`
  branch that returns the unit to the pocket that paid
  (`refund_buyer_meter` / `refund_buyer_reward_credit`). Behaviour for
  `included` / `credits` / `paid_stripe` / `unpaid` is byte-identical.

**⚠️ THE EDGE NEEDS THIS BEFORE A BUYER CLIP GRADE CAN BE PAID FOR.**
`POST /api/grade/submit` writes `payment_status = 'buyer_credits'` and the three
new columns on the buyer path. If the edge rolls first, that write fails and the
grade is left reading `unpaid` after the credit was already spent. The frontend
does **not** read the new columns on any existing page — the new portfolio button
queries `submissions.closet_item_id`, which returns nothing until the column
exists (an empty result, not an error) — so a Cloudflare Pages auto-deploy on push
degrades quietly. Still: apply first.

**Apply, then `NOTIFY pgrst, 'reload schema';`, then redeploy the edge** (the
same commit bumps `EXPECTED_SCHEMA_VERSION` to `00536`, so the boot guard needs
the row recorded), then push.

## ✅ APPLIED: 00535_ingested_listings.sql (US-1808 — extension-fed marketplace listing ingestion, applied 2026-08-08 — owner-confirmed)

**Apply order.** Independent of 00530–00534; apply it last, in numeric order,
like the rest.

**Risk: LOW.** One new table with two indexes, a trigger and two RLS policies,
plus a CHECK swap on `watchlist_items.target_type`. No existing row is rewritten
and no existing column changes type.

**What it does.**
- `ingested_listings` — a marketplace listing the buyer was browsing, handed to
  GradeThread by the extension, graded, and matched against their saved
  searches. Owner READ + DELETE under RLS; **all writes are the edge's**
  (service role, scoped by `user_id`). Unique on `(user_id, listing_url)` so
  re-checking an item refreshes one row.
- `watchlist_items.target_type` gains `'ingested_listing'`. The constraint is
  dropped and re-added, so it is idempotent, but note it is a **drop + add, not
  a widening in place** — between the two statements the column is briefly
  unconstrained. That window is inside one migration and no writer runs in it.

**⚠️ THE EDGE NEEDS THIS BEFORE THE NEW ROUTE ANSWERS.**
`POST /api/grading/public/ingest-listing` writes `ingested_listings` on its
first call, so the edge must not roll before the SQL lands. The frontend does
**not** read the new table (the types are declared, nothing queries them yet), so
a Cloudflare Pages auto-deploy on push is harmless on its own.

**Apply, then `NOTIFY pgrst, 'reload schema';`, then redeploy the edge** (the
same commit bumps `EXPECTED_SCHEMA_VERSION` to `00535`, so the boot guard needs
the row recorded), then push.

## ✅ APPLIED: 00534_video_live_capture.sql (US-1766 — live-capture provenance for a clip, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00532 — it recreates the view 00532 last defined, so
applying it first would drop the `video_capture_verified` column 00532 adds.

**Risk: LOW.** One nullable `ADD COLUMN IF NOT EXISTS` on `submissions` and a
`CREATE OR REPLACE VIEW` that reproduces 00532's column list verbatim and
appends one boolean. No data is rewritten, no policy or index changes.

**What it does.**
- `submissions.video_capture_source` — how the walk-around clip entered the app
  (`in_app_recorder` / `library`), normalized server-side.
- `public_grade_reports.video_live_capture_verified` — the public boolean: the
  Video-Verified badge was earned AND the clip was recorded in the in-app
  recorder.

**⚠️ THE FRONTEND READS THE NEW VIEW COLUMN.** `certificate.tsx` fetches the
view with `.select("*")` and reads `video_live_capture_verified`. Cloudflare
Pages auto-deploys on push, so pushing before applying leaves the certificate
reading `undefined` — which renders the plain Video-Verified copy, i.e. it
degrades quietly rather than breaking. Still: apply first.

**Apply, then `NOTIFY pgrst, 'reload schema';`, then redeploy the edge** (the
same commit bumps `EXPECTED_SCHEMA_VERSION` to `00534`, so the boot guard needs
the row recorded), then push.

## ✅ APPLIED: 00533_video_grading_scenarios.sql (US-1765 — model video grading in the AI scenarios, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00532 — it patches a setting 00532 also patches, and its
guard assumes 00532 ran first.

**Risk: LOW.** Two `UPDATE`s against `system_settings` rows. No table, column,
view, index, policy or function is touched. Both are guarded so they are no-ops
on re-run, and both no-op entirely if the target row is missing or the wrong
jsonb shape. Nothing outside the two admin AI dashboards reads either row.

**What it does.**
- `ai_usage_scenarios`: gives every modeled scenario a `video_grading` volume of
  15% of its grading volume, **subtracted from** the grading volume rather than
  added on top. Same grade count, same modeled revenue, different cost mix.
- `ai_feature_economics`: ensures the `video_grading` entry exists. 00532 already
  adds it; this repeats the insert only when the key is absent, so a
  hand-edited row between the two migrations can't leave the scenarios pointing
  at a feature priced at zero.

**Why.** 00532 broke video_grading out in the OBSERVED per-feature table. The
projection half of the profitability report reads `ai_usage_scenarios` instead,
and video_grading was in none of them — so every modeled scenario projected
platform spend as if no seller ever graded from a clip.

**Apply order vs the push is not tight.** No frontend or edge code reads either
row directly; `ai_profitability()` reads them at query time, so applying late
just means the projection keeps ignoring video grading until it lands. The same
commit bumps `EXPECTED_SCHEMA_VERSION` to `00533`, so the edge still needs the
row recorded before it boots — apply the SQL, `NOTIFY pgrst, 'reload schema';`,
redeploy the edge, then push, exactly as for 00532.

## ✅ APPLIED: 00532_video_grading.sql (US-1762 — grade from a walk-around clip, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00531. Nothing else is queued behind it.

**Risk: MEDIUM — because of the VIEW, not the columns.** Four nullable/defaulted
columns on `submissions`, one nullable column on `grade_reports`, three seed rows
and one `system_settings` patch are all inert. The `CREATE OR REPLACE VIEW
public.public_grade_reports` is the part that can fail: a replace may only APPEND
trailing columns, so the 00530 column set is reproduced VERBATIM with
`video_capture_verified` added last. If prod's live view has drifted from 00530
this raises 42P16 and the whole migration rolls back — which is the safe
direction, but check that 00530 is applied FIRST.

**What it does.**
- `submissions`: `video_grading_opt_in` (bool, default false), `video_graded`
  (bool, default false), `video_slot_marks` (jsonb), `video_frames` (jsonb).
- `grade_reports`: `video_capture` (jsonb) — the server-side provenance result.
- `public_grade_reports`: appends `video_capture_verified` (the positive-only
  Video-Verified badge). Nothing else in the view changes.
- Seeds the `video_grading` feature flag (enabled), two `ai_budgets` rows
  (day $25 throttle / month $400 kill), and the `video_grading_max_frames` (6)
  and `video_grading_plans` settings. Patches `ai_feature_economics` so the admin
  AI-spend and profitability pages break the feature out on its own.

**Apply BEFORE the frontend deploys — this one genuinely matters.** Unlike 00531,
`src/` DOES read the new view column: `certificate.tsx` renders the
Video-Verified badge off `video_capture_verified`, and the SPA reads the view with
`.select("*")`. Cloudflare Pages deploys on push, so a frontend that ships first
just reads `undefined` and hides the badge — degraded, not broken. The edge is the
hard gate: the same commit bumps `EXPECTED_SCHEMA_VERSION` to `00532`, so apply
the SQL, `NOTIFY pgrst, 'reload schema';`, redeploy the edge, then push. Edge
first burns the ~40s grace window and then refuses to boot.

**The edge image changes too, and it is bigger.** The Dockerfile now installs
`ffmpeg` (the clip decoder) and the runtime gains `--allow-write=/tmp` +
`--allow-run=ffmpeg`. Verified locally: the image builds and the CI Trivy gate
(`--severity HIGH,CRITICAL --ignore-unfixed`) reports 0 vulnerabilities. If the
redeploy somehow lands without ffmpeg, video grading does NOT error — the
extractor probes once, reports unavailable, and every video submission falls back
to `needs_photos` uncharged.

## ✅ APPLIED: 00531_extension_usage_pings.sql (US-1757 AC2 — anonymous opt-in extension usage counters, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00530. Nothing else is queued behind it.

**Risk: LOW.** One new table. No existing table, column, view, index, policy or
function is touched, and there is no backfill and no row change anywhere else.
Nothing in the app reads it yet, so applying it late costs only lost counters,
never an error.

**What it does.** `CREATE TABLE IF NOT EXISTS public.extension_usage_pings`
(`event`, `surface`, `event_count`, `ext_version`, `created_at`), one index on
`(event, created_at DESC)`, RLS enabled with **no policies** (deny-all), and a
`REVOKE ALL … FROM anon, authenticated` in an exception-guarded `DO` block for
bare local stacks. Registered in `SERVICE_ROLE_ONLY` in `rls-guard_test.ts`.

**Why.** The extension funnel was measured only at its two ends — a store
dashboard reports installs, and US-1753's utm tags attribute the signup. Nothing
measured the middle, so "do installs convert to accounts" had no answer. This is
the tally the new opt-in popup toggle feeds.

**Deny-all is load-bearing in both directions.** An *anonymous, unauthenticated*
endpoint writes here (`POST /api/grading/public/usage`), so a readable table would
be a free public firehose; and there is no owner column to scope a read policy to
in the first place. Same posture as `selector_health_pings` (00475).

**No client-side read, so the frontend auto-deploy is safe.** Nothing in `src/`
queries this table — the SPA does not know it exists. The only writer is the edge
service. So the usual "the frontend deploys the moment you push" hazard does not
apply to this migration.

**Apply-order hazard is the ordinary one.** The same commit bumps
`EXPECTED_SCHEMA_VERSION` to `00531`, so the edge container boot-guards on it:
apply the SQL, `NOTIFY pgrst, 'reload schema';`, redeploy the edge, then push. If
the edge deploys first it burns the ~40s grace window and then refuses to boot.

**Verification after applying.**

```sql
select count(*) from public.extension_usage_pings;               -- 0, and no error
select relrowsecurity from pg_class where relname = 'extension_usage_pings';  -- t
select count(*) from pg_policies where tablename = 'extension_usage_pings';   -- 0
```

Then, with the extension's new "share anonymous usage counts" toggle ON, do a
condition read and click a link back to gradethread.com; a row appears after the
batch window closes (up to 6 hours, or immediately at 50 events).

## ✅ APPLIED: 00530_public_cert_rubric_factors.sql (US-1997 — public cert view exposes rubric_key + factor_scores, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00529. Nothing else is queued behind it.

**What it does.** One `CREATE OR REPLACE VIEW public.public_grade_reports`. It
reproduces 00356's SELECT list and WHERE clause verbatim and appends three output
columns: `rubric_key`, a sanitized `factor_scores`, and
`certified_content_updated_at`. No table, column, index, policy or function
changes. No backfill, no row changes, and the view's ROW SET is byte-identical —
only the projection widens.

**The third column is a US-2392 bug this migration's new guard caught.**
`certified_content_updated_at` shipped in 00522, is declared on
`PublicGradeReportRow`, and is read by `certificate.tsx:588`, which publishes it
as schema.org `dateModified`. The view never projected it, so the SPA
certificate's `dateModified` has always been null — while the SSR certificate
(`functions/cert/[id].ts`) prints the real value, because that path goes through
the edge endpoint's `CERT_REPORT_EXTRA_COLUMNS`, which US-2392 DID extend. Same
two-read-paths split as the rubric columns. Not a new disclosure: the edge has
served this value publicly since 00522. Applying this migration makes the SPA
certificate's structured data agree with the SSR one.

**Why.** Migration 00231 shipped `grade_reports.rubric_key` + `factor_scores` to
prod and deferred exposing them to "the activation phase". The owner settled
that on 2026-07-23: ACTIVATE. There are two public read paths for a certificate
and only the edge one (`content-public.ts` CERT_REPORT_COLUMNS) had been
extended. The SPA reads THIS VIEW — `certificate.tsx` and `embed-grade.tsx` both
`.select("*")` on it — and branches on `factor_scores && rubric_key` to render a
non-clothing factor breakdown. With the view not projecting either column that
branch was unreachable no matter what the pipeline wrote, so fixing the writer
alone would never have made it fire.

**Sanitization, deliberately in the view rather than trusted to the writer.**
`factor_scores` is free-form jsonb, so the view rebuilds it keeping only
NUMBER-valued entries, and collapses an empty result to NULL rather than `{}`.
The NULL matters: the client guard is `factor_scores && rubric_key` and `{}` is
truthy in JS, so an empty object would take the non-clothing branch and render a
breakdown in which every factor resolves to 0. NULL keeps the typed-column
fallback. The writer does not exist yet, which is exactly why the guard is on
the read side.

**Risk: LOW.** The two rubric columns are NULL on every row in prod today
(nothing writes them — that is Phase 2, gated on a non-clothing golden set), so
they come back NULL for every existing certificate and every current cert renders
from the five typed columns exactly as before. `certified_content_updated_at` is
already populated on adjusted reports and already public via the edge; surfacing
it here can only add a `dateModified` where the SPA previously emitted null.
`CREATE OR REPLACE VIEW` is safe to re-run.

**CLIENT reads.** The SPA already declares both fields on `PublicGradeReportRow`
and already handles their absence — that is the fallback path every certificate
takes today and will keep taking until Phase 2. So a frontend deploy AHEAD of
this SQL is safe: `select("*")` simply returns the old column set, both fields
come back `undefined`, and the guard falls through. There is no ordering hazard
in either direction.

**The edge does not read either column from this view** (it uses the base table
via CERT_REPORT_COLUMNS), so no edge behaviour depends on this migration beyond
the boot guard's version match.

**iOS / Android are unchanged and need no release.** Neither client reads the
public certificate view.

**Apply:** run the SQL, then `NOTIFY pgrst, 'reload schema';` — PostgREST caches
the view's column list, so without the reload `select("*")` keeps returning the
old projection. Then redeploy the edge (boot guard now expects `00530`), then
push.

## ✅ APPLIED: 00529_subscription_status_comp.sql (US-2398 AC4 admin comp grant, applied 2026-08-06 00:57 UTC — measured)

**Applied.** Confirmed 2026-08-05 by reading `public.applied_migrations`
directly on prod: `00529` recorded at `2026-08-06 00:57:56Z`. Prod
`/health/ready` reports `expected 00529 / applied 00529 / match`.

⚠️ `/health/ready` alone could NOT have established this. Its `applied` value is
`max(version)` (`compareSchemaVersion` in `lib/schema-version.ts`), so a
00529 present with 00528 missing would still read "match" — the same shape as
the 00479 phantom this repo already got caught by. Both rows were listed
explicitly before either heading was changed.

**Apply order (historical).** After 00528. The two were stacked and ran in
order: 00528 at `2026-08-05 13:01Z`, 00529 at `2026-08-06 00:57Z`.

**What it does.** One `ALTER TYPE public.subscription_status ADD VALUE IF NOT
EXISTS 'comp'` and one `COMMENT ON COLUMN`. No table, column, index, policy or
function changes. Nothing is backfilled and no existing row changes.

**Why.** `POST /api/admin/users/:id/plan` — the admin "Change Plan" control,
billing:write + MFA step-up + audit row — wrote the frozen `users.plan` column,
which nothing reads for entitlement. Every comp an operator issued reported
success and moved nothing. Rewiring it to `flipdesk_plan` alone would NOT have
fixed it: `effectivePlanFor()` demotes a paid plan to Free whenever
`subscription_status` is `none` or `canceled`, which is exactly what a cardless
account carries. `comp` is the status that entitles without inventing revenue —
MRR counts only `active` and `past_due`, so a comp grants caps and bills nobody.

**⚠️ THE EDGE WRITES THE NEW ENUM VALUE, so order matters more than usual.** A
new enum value cannot be USED in the same transaction that adds it, and an edge
container running ahead of this migration will fail the grant with a 22P02
(`invalid input value for enum subscription_status: "comp"`). The boot guard
already blocks that ordering; do not bypass it. Nothing else reads or writes
`comp`, so an unapplied database simply keeps the grant broken exactly as it is
today — the failure direction is safe.

**Risk: LOW.** An enum value nothing has yet written cannot affect an existing
row. `ADD VALUE IF NOT EXISTS` is safe to re-run.

**CLIENT reads/writes.** The SPA reads `subscription_status` and now renders
"Comped — granted, not billed" when it sees `comp`; it never writes the value
(only the edge route does). A frontend deploy ahead of the SQL is safe: no
account can be carrying `comp` yet, so the branch is unreachable. **The admin
user-detail page now sends `flipdesk_plan` tier names** (`pro`/`business`) to
that route instead of the legacy `professional`/`enterprise` — that half needs
the edge deploy, not this migration.

**iOS is unchanged and does not need a release.** `entitlingStatuses`
(`PlanStore`, `PaywallStore`) is used only to answer "who owns this
subscription" for the manage-billing routing — never to gate a feature — so a
comped account shows its granted tier from `flipdesk_plan` as usual.

**Apply:**

1. Run `supabase/migrations/00529_subscription_status_comp.sql`.
2. `NOTIFY pgrst, 'reload schema';` — the enum changed.
3. Redeploy the edge (boot guard expects 00529).
4. Then push.

**Verify after applying:** issue a comp from the admin user detail page, then
`select flipdesk_plan, subscription_status from users where id = '<id>';` —
expect the granted tier and `comp`. The user's caps should move immediately; MRR
should not.

**NOT exercised against a live database** (the `verify:db` lane needs Docker).

## ✅ APPLIED: 00528_best_offer_thresholds_manual_only.sql (US-2405 manual Best Offer thresholds, applied 2026-08-05 13:01 UTC — measured)

**Applied.** `public.applied_migrations` on prod records `00528` at
`2026-08-05 13:01:10Z`. The sequence around it is intact: 00524, 00525, 00526,
00528, 00529 — with 00527 correctly absent (see the apply-order note below).

**HOW THIS FILE WENT STALE, because it is the second time the same class of
mistake has cost a session here.** Both 00528 and 00529 were applied by the
owner and this file still said HELD, so the session-start hook announced "2
migrations HELD (not yet applied to prod)" and an agent planned around a frozen
branch that was not frozen. The previous instance of this ran the other way —
US-1897's notes claimed 00475/00476 were "genuinely pending" when prod had them.
Both times the file was trusted and prod was not asked.

The rule that falls out: **this file records intent; only the database records
state.** Before acting on a HELD heading, read `applied_migrations` — one query,
and it is the answer:

```sql
SELECT version, applied_at FROM public.applied_migrations
WHERE version >= '00520' ORDER BY version;
```

**Apply order (historical).** After 00526. **00527 does not exist as a `.sql` file** — it is
`00527_revoke_public_function_execute.sql.BLOCKED` (US-2403), invisible to the
`*.sql` glob, and its number stays reserved. `EXPECTED_SCHEMA_VERSION` therefore
jumps 00526 → 00528, the same deliberate skip already recorded for 00479.

**What it does.** One `UPDATE` over `public.listings` setting
`best_offer_auto_accept_cents` and `best_offer_auto_decline_cents` to NULL
wherever either is set, plus two `COMMENT ON COLUMN` statements. No table,
column, index, policy or function changes. Idempotent — the second run matches
zero rows.

**Why.** Blank Best Offer boxes used to fall back to the listing's comp band
(p75 → accept, p25 → decline), and the composer wrote that resolved default
into the columns on save. So sellers who never touched the fields still had
fixed numbers stored, and nothing refreshed them when the price moved. A shirt
repriced from $24 to $298 kept a $27.50 auto-accept and a $16 auto-decline: a
$28 offer on a ~$300 item would have auto-accepted. The code in this commit
removes the comp fallback on both sides (edge `best-offer.ts` and the web
mirror), so NULL now means "no threshold, the offer waits for you". This
backfill makes the stored data match that meaning.

**It clears hand-typed values too.** Nothing recorded which numbers were typed
and which were auto-filled, so they cannot be told apart. Re-entering a real one
is a single field; leaving an auto-filled one is a sale at the wrong price.

**Risk: LOW to apply, and the direction of failure is safe.** With the columns
NULL, no auto-accept or auto-decline is sent to eBay and every offer waits for
the seller. Nothing errors if it stays unapplied either: the new code simply
reads whatever is in the columns, so an unapplied database keeps honouring the
stale numbers — which is the bug, not a break.

**CLIENT reads/writes.** No NEW column is read or written. The SPA already reads
and writes both columns (composer, AutoLister bulk edit) and iOS reads them in
`ListingDraftService`. A frontend deploy ahead of the SQL is safe: the new
composer stops back-filling blanks immediately, so no fresh comp defaults are
created; the old stored values simply survive until this runs.

**⚠️ eBay still holds the old terms on LIVE listings.** This clears
GradeThread's copy only. A published listing keeps its old auto-accept on eBay
until FlipDesk revises it, and the revise sends the cleared (absent) terms. So
after applying: re-save / update any live Best Offer listing whose price has
changed. Verify with
`select count(*) from listings where best_offer_auto_accept_cents is not null or best_offer_auto_decline_cents is not null;`
— it should be 0 right after the apply.

**Apply:**

1. Run `supabase/migrations/00528_best_offer_thresholds_manual_only.sql`.
2. `NOTIFY pgrst, 'reload schema';` — column comments changed; harmless to run.
3. Redeploy the edge (boot guard expects 00528).
4. Then push.

**NOT exercised against a live database** (the `verify:db` lane needs Docker).
It is one guarded UPDATE and two comments, and the `raise notice` reports how
many rows it cleared.

---

**Previously:** 00524, 00525 and 00526 were applied to prod on
2026-08-04 (owner-confirmed, all three together). 00515 through 00523 were
applied on 2026-08-03.

After applying 00526, watch Sentry for one day for `users: column(s) … cannot
be modified` — that string means a client write path targets a column the new
deny-by-default guard refuses, and the fix is to move that write to the edge or
add the column to the allowlist in a follow-up migration. Nothing has been seen
as of the apply.

> [!warning] 00522 reached origin/main BEFORE it was applied — the second time
> A concurrent agent pushed the branch while 00522 was still marked held, the
> same ordering the hold rule exists to prevent and the same way it happened
> last time. It was safe again, for the same reason recorded below: the column
> sits in the EXTRA allowlist so an unapplied database degrades rather than
> breaks. Twice is a pattern, not a coincidence — the hold rule cannot be
> enforced by an agent that does not own the push.

`EXPECTED_SCHEMA_VERSION` is **00526**, matching the highest migration in the
tree. The edge needs a redeploy to pick that up: until it does, the database
is AHEAD of the running image, which the boot guard treats as a warning and
serves through. The reverse — an edge that expects a version the database does
not have — is the one that crash-loops.

> [!note] These went to origin ahead of being applied, and it worked out
> A concurrent agent pushed the branch while the migrations were still marked
> held. That is the ordering the hold rule exists to prevent, and the outcome was
> only safe because the frontend deploy did not race the SQL and the edge had not
> yet redeployed. It is recorded here rather than quietly fixed, because "it was
> fine last time" is how the rule gets dropped.

**All of them applied cleanly to a throwaway local stack on 2026-08-03**
(`supabase db reset` over the whole corpus on a fresh schema), so the ordering
and the SQL itself are verified rather than assumed.

> [!warning] 00517 went to prod ahead of 00515/00516, and it carried a bug
> The numbers are out of order in prod. That is harmless here — 00517 touches
> only two function bodies and depends on nothing 00515 or 00516 create — but it
> means `applied_migrations` has a gap, so do not read a missing 00515 as "not
> applied yet" without checking the others. What DOES matter is that 00517
> polluted its own results (see the 00518 entry below); until 00518 is applied,
> the audit-log list repeats a row on every page turn and its page count climbs
> as you browse.

00515 is **not** inert: the FlipDesk inventory table calls
`flipdesk_listing_page` on every render, so it must be applied before the
frontend deploys. (That sentence is about 00515 specifically — it predates the
later entries and used to read as if it described whichever migration was newest.)

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

## ✅ APPLIED: 00526_users_self_update_allowlist.sql (US-2283 [P0] self-update deny-by-default, applied 2026-08-04 — owner-confirmed)

**Risk: MEDIUM — the only one of the three that could break a client.** One
`CREATE OR REPLACE FUNCTION` plus a re-created trigger. No table, column or data
change. Safe to re-run.

**What it closes, demonstrated rather than argued.** `guard_users_protected_columns`
froze a HAND-LISTED set of columns on `public.users`. The table has ~100 and six
were missed. On a throwaway stack, as `role=authenticated` with a JWT matching the
row, the OLD function ACCEPTED
`update({ included_grades_this_period: 100000, ai_actions_used_this_month: 0 })`
and the row kept both values — unlimited Claude Vision grading billed to us. With
00526 the same statement raises, naming the column.

The guard now enumerates the 21 columns a user MAY change and refuses everything
else, so a column added next month is closed the day it is added.

**WATCH FOR ONE DAY:** `users: column(s) … cannot be modified` in Sentry. That
string means a client write path targets a column the new guard refuses. The fix
is to move that write to the edge (service-role) or add the column to the
allowlist in a follow-up migration — not to widen the guard blindly.
`src/test/users-self-update-allowlist.test.ts` fails the build if any `src/` or
`ios/` write path targets a refused column, so a regression should be caught in
CI rather than by a user.

**Still open on the same attack path:** US-2282 — SECURITY DEFINER functions that
PUBLIC can still EXECUTE. Either one alone gives free credits.

## ✅ APPLIED: 00525_admin_metrics_flipdesk_plan.sql (US-2398 admin metrics read flipdesk_plan, applied 2026-08-04 — owner-confirmed)

**Risk: LOW. Read-path only, and it CORRECTS numbers rather than changing
behaviour.** Two `CREATE OR REPLACE FUNCTION` statements (`admin_system_metrics`,
`admin_platform_analytics`) and nothing else. Safe to re-run.

**What it fixes.** `users.plan` has not been written since the 00039 backfill. It
is `NOT NULL DEFAULT 'free'`, so every account created since carries the default.
SIX metrics read it, two of which an operator acts on — the paid-user count and
the churn numerator. Both errors run the same direction, so the dashboard has
been telling a consistent story about a business doing worse than it is. MRR was
never affected; it already priced off `flipdesk_plan`, which is why nobody noticed.

**Expect the numbers to have MOVED on apply.** Paid users up, churn down, and the
plan mix relabelled: `professional`/`enterprise` disappear because those were the
frozen vocabulary — the live tiers are `pro`/`business`. Nothing was recalculated
retroactively; the dashboard simply started reading the column the rest of the
system uses.

## ✅ APPLIED: 00524_marketplace_sync_quarantine.sql (US-2324 AC3 sync quarantine, applied 2026-08-04 — owner-confirmed)

**Risk: VERY LOW.** One NEW table, nothing existing is touched. Both connectors
that use it are behind env kill-switches defaulting to FALSE, so on prod today
the table is created and never written.

**What it closes.** The Etsy and Depop syncs keep no cursor: each run re-reads
the provider window from the start. A permanently-bad record was therefore
re-attempted on every run forever, and its failure was one more line in a log
that becomes unreadable when something new breaks. After three failures a record
is set aside, with its attempt count and last error kept as the evidence.

**Deny-all by design:** RLS on, ZERO policies, grant revoked from anon and
authenticated. Readable, it would show a seller raw provider error text for their
own orders; writable, they could clear their own quarantine.

**Owner column is `owner_user_id`, not `user_id`** — rls-guard discovers TENANT
tables by that literal string in the CREATE TABLE block, and this is an operator
table. Registered in SERVICE_ROLE_ONLY in the same commit; the guard failed
first and passed after, which is how I know the registration is real.

**Verified on a throwaway stack:** full corpus applies on a fresh schema, all
nine columns present, RLS on with 0 policies, self-record row lands.

**Apply:**

1. Run `supabase/migrations/00524_marketplace_sync_quarantine.sql`.
2. `NOTIFY pgrst, 'reload schema';` — new table.
3. Redeploy the edge (boot guard expects 00524).

**Verify:** `select count(*) from marketplace_sync_failures;` returns 0, and stays
0 until an Etsy or Depop sync actually fails on a record.

## ✅ APPLIED: 00523_users_trial_notice_sent_at.sql (US-2319 trial-notice idempotency, applied 2026-08-03 — owner-confirmed)

**Risk: LOW.** One nullable column on `users`, plus a CREATE OR REPLACE of
`guard_users_protected_columns` that only ADDS the new column to its denylist.
No data is rewritten and no existing column changes meaning.

**What it closes.** The trial-ending notice had no marker: the exact-day window
(`daysLeft === 3`) was the only dedupe, so a missed cron day meant the customer
was NEVER warned — silently, because a notice nobody received leaves no trace —
and a same-day re-run double-sent. With the marker the window widens to
due-or-overdue and still sends exactly once.

**Why the guard changes too.** `guard_users_protected_columns` is a DENYLIST: a
new column is writable by the account owner unless it is named. A trialist
setting this themselves would suppress their own warning.

**Verified on a throwaway stack:** full corpus applies on a fresh schema, the
column is `timestamptz` and nullable, the replaced guard function names it, and
the self-record row lands.

**Ships with edge code that READS the column** (`jobs-trial-expiry.ts` selects
`trial_notice_sent_at`). On a database without it PostgREST answers 42703 and the
notice scan throws — the job catches and logs, so the downgrade half still runs,
but no notices go out until this is applied. Apply BEFORE the edge redeploys.

**Apply:**

1. Run `supabase/migrations/00523_users_trial_notice_sent_at.sql`.
2. `NOTIFY pgrst, 'reload schema';` — new column.
3. Redeploy the edge (boot guard expects 00523).

**Verify:** `select count(*) from users where trial_notice_sent_at is not null;`
returns 0 immediately after applying, and becomes non-zero the first time the
trial-expiry cron sends a notice.

## ✅ APPLIED: 00522_grade_report_certified_content_updated_at.sql (US-2392 certificate revision date, applied 2026-08-03 — owner-confirmed)

**Risk: LOW.** One nullable column and one partial index on `grade_reports`. No
data is rewritten — the backfill is "leave everything NULL", which is the
truthful state for a certificate that has never been revised.

**What it closes.** `grade_reports` had no `updated_at` at all. A human-review
adjustment rewrites the scores, the tier and the integrity hash on a LIVE,
publicly-served row and recorded no timestamp on it. The integrity hash is what
makes that sharper than missing metadata: the hash exists so a buyer can verify
the certificate was not tampered with, and a legitimate adjustment RECOMPUTES it
— so the certificate verified clean both before and after a score change, with
nothing marking that one happened.

**Verified on a throwaway stack:** the corpus applies on a fresh schema, the
column is `timestamptz` and nullable, every row reads NULL, and the index is
genuinely partial (`WHERE certified_content_updated_at IS NOT NULL`).

**Ships with edge + web:** the adjustment path stamps it (inside the certificate
branch only), the public certificate allowlist exposes it in the EXTRA set so the
42703 genesis fallback still serves certificates if this is unapplied, and both
the SPA and the cert SSR emit schema.org `dateModified` only when it is set.

**Safe to deploy ahead of the SQL, unusually.** The column sits in the EXTRA
allowlist, so on a database without it PostgREST answers 42703 and the existing
US-1945 fallback serves the genesis columns — certificates render, and
`dateModified` is simply absent. Apply it anyway; that is a degradation path, not
a plan.

**Apply:**

1. Run `supabase/migrations/00522_grade_report_certified_content_updated_at.sql`.
2. `NOTIFY pgrst, 'reload schema';` — new column.
3. Redeploy the edge (boot guard expects 00522).

**Verify:** `select count(*) from grade_reports where
certified_content_updated_at is not null;` returns 0 immediately after applying,
and becomes non-zero the first time a human-review adjustment resaves a
certificate.

---

## ✅ APPLIED: 00521_impersonation_sessions.sql (US-2351 [P0] impersonation bounds, applied 2026-08-03)

**Risk: LOW. One new table, nothing existing is touched.** But the EDGE change
that ships with it is behavioural, so migration and deploy have to travel
together: after this, starting an impersonation REQUIRES writing a row here. If
the table is missing, `/start` returns 500 and refuses — deliberately, because a
session with no record is exactly the unbounded one this removes.

**What was wrong.** The entry to impersonation was always well guarded —
super_admin, `users:role`, a fresh step-up, privileged targets refused, start
audited. Everything after the token was minted was open: no time limit, no
revocation on stop, no server-visible marker, and a stop audit row whose
`target_id` came straight from the request body. A super_admin could impersonate
a disputing customer, cancel their subscription and delete their account, and
every downstream record — Stripe, the deletion log, the marketplace disconnect —
would show the CUSTOMER doing it.

**What the table is.** The marker, the clock and the revocation handle in one.
Server-side rather than a token claim on purpose: a claim is equally invisible to
any route that does not parse it, and cannot be revoked once minted.

**Column naming, for the next person.** `actor_id` / `target_id`, NOT
`actor_user_id` / `target_user_id`. rls-guard discovers tenant tables by the
literal string `user_id`, and this is an operator table that must have no policy
at all. Registered in `SERVICE_ROLE_ONLY`.

**PROVEN ON A REAL DATABASE** — corpus applied to a throwaway stack, then: the
target cannot SELECT the row, cannot UPDATE it to end their own impersonation
record, and the row survives deleting BOTH parties with the emails intact.

**Ships with (edge + web):** a 30-minute hard cap enforced on read; `/stop` now
revokes the target's sessions through GoTrue's admin logout with `scope: global`
and reports whether it landed; the stop record comes from the START row rather
than the request body; account delete, subscription cancel, billing portal and
all five marketplace disconnects refuse while an impersonation is live;
`reviewer` joins the non-impersonable roles; and the account-delete password
re-authentication moves from the browser into the edge.

**Apply:**

1. Run `supabase/migrations/00521_impersonation_sessions.sql`.
2. `NOTIFY pgrst, 'reload schema';` — new table.
3. Redeploy the edge (boot guard expects 00521).

**Verify:** start an impersonation and check
`select expires_at from admin_impersonation_sessions order by started_at desc
limit 1;` is ~30 minutes out. Exit, and check `ended_at` and
`end_reason = 'stopped'` are set. While impersonating, the account-delete
endpoint should return 403 `impersonation_blocked`.

**Still open (AC7):** confirm the GoTrue OTP TTL in prod. It sets the real
lifetime of the minted impersonation and resume tokens — a second clock alongside
the 30-minute cap.

---

## ✅ APPLIED: 00520_audit_log_not_forgeable.sql (US-2349 [P0] audit integrity, applied 2026-08-03)

**Risk: LOW to apply, and it is the last of the three audit-log fixes.** No
destructive statement — two policies are dropped and a browser grant is revoked.

**Two holes, one migration.**

1. **Forgery.** 00003 defined the INSERT policy as `WITH CHECK (is_admin())`
   with nothing tying `admin_user_id` to `auth.uid()`. Any admin could write
   rows naming a *different* admin: grant yourself credits, then stamp a dozen
   `admin.change_role` rows with the super_admin's id. Non-repudiation gone for
   the whole table, and the 00227 anomaly detectors firing on the forged actor.
2. **The read, which 00517 did NOT close.** 00517 put the search RPC behind
   super_admin and gave it a self-audit. The table's own SELECT policy was still
   `is_admin()`, so `.from("admin_audit_log").select()` in the browser returned
   everything, to any admin, unrecorded. Hardening the front door while the wall
   stays open is worse than leaving both — it reads as fixed.

**The table ends with ZERO policies, by design.** Not a narrower INSERT policy:
`WITH CHECK (admin_user_id = auth.uid())` stops an admin framing someone else
and stops nothing else — they could still write any action and any details under
their own name, so the log would record fictions that are merely correctly
attributed. An audit log its own subjects can append to is not evidence.

**Nothing legitimate loses access,** and this was verified rather than reasoned:
`lib/audit-log.ts` writes as service_role; the 00065 dispute trigger, the 00518
self-audit and the 00519 stamping trigger are all SECURITY DEFINER; reads go
through `admin_audit_log_search`, also SECURITY DEFINER. `service_role` is
deliberately NOT revoked.

**PROVEN ON A REAL DATABASE, both directions** —
`scripts/verify-audit-log-not-forgeable.sql` against the full corpus on a
throwaway stack: forgery refused with 42501, a direct read returns 0 while the
row demonstrably exists, and both the service-role write and the RPC read still
work. Restoring the old policies made the same forgery succeed.

> [!note] The trap that would have produced a confident false pass
> A local `supabase db reset` grants `authenticated` no SELECT/INSERT on ANY
> public table — `human_reviews`, untouched by this work, is in the same state.
> So a run without an explicit grant "blocks" the forgery for a reason unrelated
> to the fix. The script grants first, reproducing prod, so the policy is the
> only thing under test.

**Ships with a web change.** `ai-models.tsx` no longer writes audit rows from the
browser. That call logged an admin having VIEWED a weekly accuracy summary, with
numbers the browser itself computed — a self-report of a read, unverifiable by
construction, consumed by nothing. It also passed `target_id: "weekly"` into a
`uuid` column, so it had been failing on every call; the error was discarded
until US-2357 made that write report itself. Deleted rather than relocated: an
endpoint whose only job is "write me an audit row" reintroduces this forgery.

**Apply:**

1. Run `supabase/migrations/00520_audit_log_not_forgeable.sql`.
2. `NOTIFY pgrst, 'reload schema';`
3. Redeploy the edge (boot guard expects 00520).

**Verify:** `select count(*) from pg_policies where tablename =
'admin_audit_log';` returns 0, and `select relrowsecurity from pg_class where oid
= 'public.admin_audit_log'::regclass;` returns `t`. Then open /admin/audit-log as
a super_admin — the list still loads, because it reads through the RPC.

---

## ✅ APPLIED: 00519_audit_log_survives_actor_deletion.sql (US-2350 [P0] audit trail, applied 2026-08-03)

**Risk: LOW to apply, HIGH to keep postponing.** No destructive statement; one
FK is replaced, one column is added, one trigger is created. The backfill is a
single UPDATE over `admin_audit_log` — check its row count first if that table
is large on your instance.

**The defect it closes.** `admin_audit_log.admin_user_id` was ON DELETE CASCADE
(00003). The append-only guarantee is a pair of RLS policies allowing SELECT and
INSERT and nothing else — and a cascade is not a policy-checked DELETE, it is
referential action, so it goes straight through. `POST /api/account/delete` is
self-serve, so an admin could issue refunds and role changes for a week, delete
their own account, and take every row they had ever authored with them. The
forensic export then returned nothing about any of it.

**What it does.**

1. The FK becomes ON DELETE SET NULL. `admin_user_id` was already nullable
   (00065), so nothing else had to change.
2. New `actor_email`, captured at write time and backfilled where the actor
   still exists. SET NULL alone would leave a row that survives but names
   nobody, which is not much better than no row.
3. A BEFORE INSERT trigger fills `actor_email` / `actor_role` from `users`. In
   the database rather than the edge writer because rows arrive from at least
   three places — `lib/audit-log.ts`, the 00065 dispute trigger and the 00518
   audit-search self-audit — and a rule in one writer is not followed by the
   others.

**PROVEN AGAINST A REAL DATABASE, both directions.** The whole corpus was applied
to a throwaway local stack and `scripts/verify-audit-survives-actor-deletion.sql`
run inside a transaction: two audit rows written, the acting admin deleted
through `auth.users` (the exact path account/delete takes), and both rows
survived with their email and role intact. Then the CASCADE was restored and the
same script showed the rows vanish — so the proof measures what it claims to.
The script is committed; you can re-run it anywhere.

**The privacy question, stated rather than skipped.** This deliberately retains
an email address after a user asks to be deleted. It applies ONLY to rows where
that person acted as an ADMIN, on other people's accounts. An audit trail a
subject can erase by leaving is not an audit trail. Ordinary users author no
`admin_audit_log` rows and are untouched.

**Ships with a behaviour change in the edge (AC3).** An admin or super_admin can
no longer self-serve delete: the endpoint returns 403 `admin_self_delete_blocked`
and tells them to have another admin remove the role first. The step-up it
replaces proved the person at the keyboard was the account holder, which was
never the question.

**Apply:**

1. Run `supabase/migrations/00519_audit_log_survives_actor_deletion.sql`.
2. `NOTIFY pgrst, 'reload schema';` — a column was added.
3. Redeploy the edge (boot guard expects 00519).

**Verify:** `select confdeltype from pg_constraint where conname =
'admin_audit_log_admin_user_id_fkey';` returns `n` (SET NULL). `c` would mean the
CASCADE is still there.

---

## ✅ APPLIED: 00518_audit_search_self_audit_ordering.sql (corrects 00517, applied 2026-08-03)

**Risk: LOW. This is a bug fix for a migration that is already in prod, and the
bug is live right now.**

**What went wrong in 00517 (my mistake).** It wrote the `audit_log.search` row
BEFORE running the search, in the same function and so the same statement. Under
READ COMMITTED the SELECT sees that row:

- `total_count` is a window `count(*) over ()`, so it grows by one on EVERY call
  and the console's page count climbs as you browse;
- the new row sorts first under `created_at desc`, so it displaces everything by
  one. Page 0 returns it plus originals 1-24; turning to page 1 inserts another
  row and `offset 25` then returns originals 24-48 — **one duplicated row per
  page turn**, and one skipped for each earlier insert.

**Nothing is lost or mis-recorded.** The audit rows themselves are correct and
the log is intact. What is wrong is the READING of it, which on a forensic
surface is its own kind of bad: a list that quietly repeats and skips rows is
worse than one that is obviously broken.

**The fix** moves the insert after the `RETURN QUERY`. `RETURN QUERY` executes
its query immediately and appends the rows, then execution continues — so the
search sees the state the caller asked about and the audit row still lands. It
also fills `actor_role`, which 00517 left NULL; every other writer sets it, so a
filter on `actor_role` silently skipped these rows and the CSV export showed a
blank column.

**Known limitation, now written down rather than over-claimed.** A REFUSED call
records nothing. The guard raises, the exception aborts the statement, and any
row written before it rolls back — reordering does not help and an autonomous
transaction is not available in a `SECURITY DEFINER` function. So the devtools
attack is blocked, but blocked SILENTLY. 00517's header claims the RPC path "is
no longer the quiet one" without that caveat, and an applied migration cannot be
corrected — which is why the full story now lives in
`vault/20-domain/audit-log-access-control.md`.

**Apply:**

1. Run `supabase/migrations/00518_audit_search_self_audit_ordering.sql`.
2. `NOTIFY pgrst, 'reload schema';` — the function body changed.
3. Redeploy the edge (boot guard expects 00518).

**Verify:** as a super_admin, open /admin/audit-log and turn to page 2. No row
should appear on both pages, and the total should not increase as you page.

**Cleanup worth doing once:** the `audit_log.search` rows written between 00517
applying and 00518 applying are real records of real reads — keep them. They are
just missing `actor_role`.

---

## ✅ APPLIED: 00517_audit_log_search_super_admin.sql (US-2352 audit-log exfiltration, applied 2026-08-03)

> [!important] Applied ahead of 00515/00516, and PARTLY SUPERSEDED by 00518.
> The gate it introduced is live and correct. Its self-audit ordering was wrong
> and 00518 above fixes it — apply that one promptly. The marker here is ✅ and
> not ⏳ on purpose: the session-start hook reads ⏳ as "the branch is frozen on
> this", and a stale hold marker has already misled two sessions.

**Risk: MEDIUM, and the risk is a LOCKOUT, not a break.** Now that it HAS applied,
`admin_audit_log_search` and `admin_audit_log_filter_options` refuse any caller
who is not `super_admin` or the service-role edge client. A plain admin opening
/admin/audit-log will see the page's own "super admin only" panel (shipped in
US-2357, same branch) rather than an error — but if you have an admin who is
*meant* to read the audit log and is not a super_admin, decide that BEFORE
applying, because the answer is a role grant, not a code change.

**What it does.**

1. The search RPC now requires `super_admin`. It was guarded by `is_admin()`
   only, granted to `authenticated`, and the console calls it from the BROWSER —
   so any plain admin could call it from devtools with `p_limit 50000` and take
   the whole forensic log (every other admin's IPs, user agents and `details`),
   leaving no export row behind. The edge route's super_admin gate and its
   self-audit were both skippable by not using the route.
2. Two ceilings instead of one. 50,000 stays for the service-role export path;
   a browser caller is capped at 500. The console pages at 25.
3. The RPC writes its own `audit_log.search` row for non-service-role callers,
   so the way around the gate is no longer also the way around the record.
   Service-role calls are left alone — the edge route already writes
   `audit_log.export` and recording both would double-count every export.
4. `admin_audit_log_filter_options` gets the same gate (it exposes the admin
   roster and the action vocabulary of the same log).

**Why the grant was not narrowed instead.** Revoking `authenticated` would break
the console's own paginated list, forcing that read through the edge in the same
change — a much bigger diff for the same security outcome.

**The function becomes VOLATILE.** It was STABLE, and Postgres refuses a write
inside a STABLE function, so the self-audit row forces the change. It is called
once per request on a low-QPS admin surface; nothing depended on the old
volatility.

**NOT verified against a live database** — unlike 00516, this was not applied to
a local stack. It is `CREATE OR REPLACE` on two existing functions with no schema
change, and the guard test pins the properties, but the first real execution will
be on prod. If you want a dry run, apply it to a scratch database and call the
RPC as a plain admin (expect `42501`) and as a super_admin (expect rows).

**Apply:**

1. Run `supabase/migrations/00517_audit_log_search_super_admin.sql`.
2. `NOTIFY pgrst, 'reload schema';` — two function bodies changed.
3. Redeploy the edge (boot guard expects 00517).

**Verify:** as a super_admin, open /admin/audit-log — the list loads, and a new
`audit_log.search` row appears in it naming your own user. As a plain admin, the
page shows the super-admin-only panel and a devtools call to
`admin_audit_log_search` returns `42501`.

---

## ✅ APPLIED: 00516_debit_grade_credits_idempotency.sql (US-2289 AC2 double-charge defence, applied 2026-08-03)

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

## ✅ APPLIED: 00515_flipdesk_listing_page.sql (US-2168 AC3 server-side row selection, applied 2026-08-03)

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

## ✅ APPLIED: 00561_measure_card_tracking.sql (US-2231 — tracking on a mailed MeasureCard, applied 2026-08-08 — owner-confirmed)

**Apply order.** After 00560. No dependency between them; both only need to be
in before the code that reads them.

**Risk: LOW.** Two nullable `text` columns on `measure_card_requests`, no
default, no backfill, no constraint, no index. Nothing is rewritten and no
existing row changes. Old edge code that never mentions them keeps working.

**Apply BEFORE the edge deploy.** The new edge SELECTs `tracking_number` and
`tracking_carrier` on both the operator queue and the seller's own
`/card-request` read. If the edge goes first, PostgREST answers 42703 and the
MeasureCard status panel breaks for every seller — not just those with tracking.
The frontend does not read these columns directly, so a Cloudflare Pages deploy
is harmless on its own.

**`NOTIFY pgrst, 'reload schema';`** after applying — the columns are selected
by name through PostgREST.

**What it does, and what it deliberately does NOT.** US-2231 AC3 asks for an ETA
*and* a tracking number. Only tracking is here. Quoting "ships in 3–5 days" on a
page a paying seller reads is a promise the fulfilment process does not make, and
a date we cannot honour is worse than no date. The ETA needs a real SLA first.

**Both columns are NULLABLE on purpose.** Cards are mailed by hand and many go
out as untracked letters. NOT NULL would either stop the operator marking those
shipped or push them to type a placeholder — and a placeholder tracking number is
worse than an empty one, because the seller clicks it.

**Plaintext, unlike the street address on the same table.** US-2417 encrypts
ship_name/address_line1/address_line2/city/postal_code because they say where a
person lives. A tracking number is a carrier's identifier for a parcel, the
operator has to search and paste it, and it is the one field on the row the
SELLER is meant to read back — the same reasoning that keeps state and country
readable there.

**The refusal worth knowing about.** The bulk transition takes up to 500 ids and
tracking is per-parcel, so sending a number with a batch is REFUSED (400) rather
than applied. Stamping one carrier reference onto 200 sellers would give each of
them a link that tracks somebody else's parcel, which is worse than no tracking
because it looks authoritative.

**Verified on a throwaway local stack:** applied from clean and re-applied
(idempotent); the US-1108 self-record footer present; schema-version guard green
at 00561 with the manifest regenerated in the same pass.
