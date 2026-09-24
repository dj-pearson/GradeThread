# PENDING MIGRATIONS — applied to prod separately from the push

## THE HOLD RULE, IN ONE PLACE (US-3421 AC3, settled by the owner 2026-09-19)

**It protects `origin/main`, and only `origin/main`.** Cloudflare Pages builds
main; the next Coolify edge deploy boot-guards the schema version. So a
migration must not reach **main** until the owner has applied the SQL.

**Pushing a held migration to a side branch — `claude/*`, `held-*` — is
allowed and preferred.** A branch that is not main deploys nothing, so the
push costs nothing the rule is defending and buys durability, review, and the
ability for any clone to land the migration after the apply.

This was ambiguous for months and the ambiguity cost real work: five finished
migrations existed on one machine only, and 00797 had to be rewritten from its
description in this file because its branch existed nowhere else. The entries
below are the specification whenever that happens again.

**Still forbidden:** merging or pushing a held migration to `main` before the
apply.

`scripts/held-migration-gate.mjs` blocks the push either way, because it keys
on `supabase/held-migrations.json` rather than on the target branch. On a side branch
`--no-verify` is the intended bypass and the only one; say so when you use it.
`scripts/check-held-branches.mjs` is the other half — it asks the REMOTE
whether a branch this file names actually exists, which cross-checking the
registries cannot answer.

## EIGHT HEADINGS WERE STALE, AND THAT IS WHY MAIN CI WAS RED, 2026-09-13

00786, 00787, 00788, 00789, 00790, 00791, 00792 and 00796 were still headed
HELD while prod already had all eight. The held-migration gate blocks on any
HELD heading whose file is on the pushed commit, so the `build` job in `CI` had
been failing on those eight for a normal-state reason that had stopped being
true — which is US-3308's whole subject: a lane red for a non-defect carries no
information, and a real failure underneath it is invisible.

This file had already noticed part of it and left the rest. The 00796 note below
says in as many words that it is applied. The paragraph about 00793-00795 says a
parallel session shipped 00790 and 00791 and prod applied those. Neither flipped
a heading, so the gate kept blocking on entries the file itself contradicted.

**The evidence, read credential-free on 2026-09-13 and repeatable by anyone:**

```bash
curl -s https://functions.gradethread.com/health/ready   # schema + release
curl -s https://functions.gradethread.com/health         # release SHA
```

`schema` answered `{"expected":"00800","applied":"00800","status":"match"}` with
**no `complete` key and no `missing` key**. Both absences are load-bearing and
neither is the same as a blank answer. `summarizeSchema` (routes/health.ts:156)
emits `complete:false` whenever the completeness read did not happen or threw,
and emits `missing` whenever the set comparison found a gap; `/health/ready`
always passes a completeness object when `database` is `ok`, and it was. So the
shape observed means the SET was compared over the whole generated manifest and
came back empty — not merely that the watermark is 00800.

And the manifest it compared against is the current one: `/health` reports
release `4e884a242a8b9ecf6557e7a41eda046a9fdda882`, which was the tip of
`origin/main` at the time, i.e. the deployed build's manifest already lists
00786 through 00800. A stale container would have made `missing: []` vacuous,
which is the one way this reasoning could have been wrong.

**What the headings now claim, exactly.** They say prod HAS these migrations,
confirmed from prod's own schema record. They do NOT say anyone in a session
watched them apply, which is why each is dated and marked "not watched" rather
than being folded in with the owner-applied entries above. If you need the
stronger claim for one of them, `check-prod-migration.ts` is the tool.

Nothing below 00786 was touched, and the six genuinely-held branches in the next
section are unchanged and still waiting.

## HELD: 00834_overview_metrics_owner_scope.sql (INV-D1 - FlipDesk Overview on /dashboard mixed two workspaces)

**What it does.** Replaces `flipdesk_overview_metrics` (5 args, 00594 body as
guarded by 00611) with a version that takes one more argument,
`p_owner_id uuid default null`, the workspace on screen. The one scan every
figure reads from is filtered to `user_id = p_owner_id`, so pipeline counts,
inventory value, listed/sold/gross/net in range, aging, stale, top brands,
recent sales and the North Star weeks all come from one workspace. The old
signature is DROPPED first so PostgREST never sees two overloads. It stays
SECURITY INVOKER and `language plpgsql stable`, with `search_path = public`,
and 00611's anon refusal is kept word for word and runs first. Grants are
replayed as they were: `authenticated` and `service_role` (PUBLIC comes back
with CREATE). `proacl` read before and after on the local cluster:
`{=X/postgres,postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}`
both times. No revokes (US-2403).

**The guard.** The same as 00833: a non-NULL `p_owner_id` must be the caller,
a workspace the caller is a member of (`public.is_workspace_member`), or the
caller must be the service role. Anyone else gets **42501**. **NULL means
`auth.uid()`**, the caller's own rows, which is what a client built before this
migration sends.

**Also fixed, same function.** `recentSales` listed every sale in the window,
refunded and cancelled included, beside a Sold tile that counts completed sales
only. It now reads the same `in_sold_window` predicate as `soldInRange`, so the
list and the count agree (00111: metrics exclude anything but `completed`).
`soldInRange` itself is unchanged; see the commit for why it was not moved to
the Inventory Sold tab's rule.

**Why.** The function relied on RLS over `items_full`, and that policy admits
own rows OR any workspace the caller is a member of. A seller who owned items
and also belonged to another workspace saw both tenants' numbers added
together on /dashboard.

**⚠ THE BROWSER SENDS THE NEW ARGUMENT, in the same commit.**
`src/hooks/use-flipdesk-overview.ts` sends `p_owner_id`. If Pages deploys
before this is applied, PostgREST finds no function with that parameter and
**every FlipDesk widget on /dashboard fails to load** (PGRST202). The other way
round is safe: the new function answers an old client's call (the argument
defaults), and the old client then sees the caller's own numbers only.
**Apply BEFORE the push to main.**

**Proved on a local Postgres 16** (migrations through 00833 already applied):
applied twice, second run clean with only the "does not exist, skipping"
notice from the drop. `node scripts/check-overview-owner-scope.mjs --dsn ...`
passes 12/12: A (also a member of B) reading A gets
`total:3,sold:1,gross:40,recent:1`; A with NULL the same; A in B and M in B get
B's `total:1,sold:1,gross:50,recent:1`; M in A gets A's; M, S and the service
role with NULL get zeros; S naming A, anon naming A and anon with NULL get
42501; the service role naming A gets A's. Sabotage 1 (owner filter replaced
with `true`): 8 of 12 red, A reading A got `total:4,sold:2,gross:90,recent:2`,
which is the shipped bug. Sabotage 2 (owner guard removed): the stranger case
goes red (an empty dashboard instead of 42501). Sabotage 3 (recentSales back to
any sale in the window): 4 red, `recent:2` with the refunded sale listed.
Restored: 12/12, and `check-inventory-owner-scope.mjs` still 13/13.

**Risk: LOW-MEDIUM.** Read-only function, no table change. The risk is the
deploy order above.

**Order.** 1) `npm run migrate:prod -- --apply --yes` (applies 00834 after
00823-00833, then `NOTIFY pgrst, 'reload schema';`). 2) Redeploy the edge (boot
guard expects 00834; the edge does not call this function). 3) THEN push to
main so Pages builds the client that sends `p_owner_id`.

## HELD: 00833_inventory_table_owner_scope.sql (INV-D1 - Inventory table and tab counts mixed two workspaces)

**What it does.** Replaces `flipdesk_listing_page` (12 args, 00771) and
`inventory_status_counts()` (00144) with versions that take one more argument,
`p_owner_id uuid default null`, the workspace on screen. Every read is filtered
to `user_id = p_owner_id`: the page rows, `total`, `soldAgg`, `buyerCounts`
(which read `items_full` directly and needed its own predicate), and the
per-status counts. The old signatures are DROPPED first so PostgREST never
sees two overloads. Both stay SECURITY INVOKER, so RLS still applies on top.
Grants are replayed exactly as they were: `flipdesk_listing_page` to
`authenticated`; `inventory_status_counts` to `authenticated` and
`service_role`. No revokes existed and none are added (US-2403).

**The guard.** A non-NULL `p_owner_id` is checked, not trusted: the caller
must be that owner or a member of that owner's workspace
(`public.is_workspace_member`, any role, the same bar as the viewer SELECT
policy), or the service role. Anyone else gets **42501**.
**NULL means `auth.uid()`**, the caller's own rows only, never "everything RLS
admits". That is what a client built before this migration sends, so an old
tab can never mix tenants; a workspace member on an old tab sees their own
(possibly empty) inventory until they reload.

**Why.** Both functions relied on RLS over `items_full` / `inventory_items`,
and that policy admits own rows OR any workspace the caller is a member of. A
seller who owned items and also belonged to another workspace saw both mixed
in the Inventory table, its tab badges, the repeat-buyer star, "Select all
matching" and the CSV export. Grid, Kanban and Prep were fixed client-side
(INV-1); the table filters inside these functions, so it needed this.

**⚠ THE BROWSER CALLS BOTH, AND SENDS THE NEW ARGUMENT, in the same commit.**
`src/pages/flipdesk/listings-page-queries.ts` (`listingPageArgs`, used by the
page query, select-all and the CSV export) sends `p_owner_id`, and
`src/hooks/use-inventory-status-counts.ts` sends it to `inventory_status_counts`.
If Pages deploys before this is applied, PostgREST finds no function with a
`p_owner_id` parameter and **the Inventory table fails to load for every
seller** (PGRST202), and the tab badges go blank. The other way round is safe:
the new functions answer an old client's call (the new argument defaults).
**Apply BEFORE the push to main.**

**Proved on a local Postgres 16** (all 825 migrations from zero, 0 failures):
applied twice, second run clean with only "does not exist, skipping" notices
from the drops. `node scripts/check-inventory-owner-scope.mjs --dsn ...` passes
13/13: A (who also belongs to B's workspace) reading A sees only A's 2 rows and
buyerCounts 1; A with NULL gets the same; A switched into B sees only B's row;
M (member of both) sees only B's row for B and only A's rows for A; M with
NULL gets M's own (zero); a stranger and anon naming A get 42501; the service
role naming A gets A's rows; counts match per workspace and the stranger gets
42501. Sabotage 1 (owner predicate replaced with `true` in both functions): 10
of 13 red, e.g. A reading A got `total:3,foreign:1,buyer:2`, which is the
shipped bug. Sabotage 2 (guard removed, buyerCounts predicate removed): the
stranger and anon cases go red (they get an empty table instead of 42501) and
every buyerCounts reads 2. Restored: 13/13.

**Risk: LOW-MEDIUM.** Read-only functions, no table change. The risk is the
deploy order above, and that a member on a stale tab briefly sees their own
inventory instead of the workspace's.

**Order.** 1) `npm run migrate:prod -- --apply --yes` (applies 00833 after
00823-00832, then `NOTIFY pgrst, 'reload schema';`). 2) Redeploy the edge
(boot guard expects 00833; the edge does not call either function). 3) THEN
push to main so Pages builds the client that sends `p_owner_id`.

## HELD: 00832_one_ebay_draft_per_item.sql (marketplaces plan action 3 - one AutoLister eBay draft per item)

**What it does.** Demotes duplicate eBay drafts, then adds
`uq_listings_one_ebay_draft_per_item`, a partial unique index on
`listings(inventory_item_id) WHERE platform = 'ebay' AND listing_status = 'draft'`.
Both run in ONE transaction that first takes `LOCK TABLE public.listings IN
SHARE ROW EXCLUSIVE MODE` (with `SET LOCAL lock_timeout = '15s'`), so no draft
can be inserted between the demote and the index build. Reads carry on; writes
to `listings` wait a few seconds for the commit.

**Why.** `generateListing` wrote the draft as select-then-insert with nothing
behind it, so a generation that outlived its batch timeout and the retry of
the same job could both insert. The edge half (same commit) aborts the
generation on timeout, re-checks the job is still `running` on its attempt
before writing, and turns a 23505 from this index into an update of the
surviving draft.

**Duplicates are DEMOTED, not deleted.** Per item the keeper is the draft with
an eBay listing id, else an offer id, else a publish schedule, else the most
recently updated. Every other eBay draft for that item becomes `ended`
(`is_active` follows via trigger), loses `scheduled_publish_at`, and gets
`platform_fields.dedupe_00832 = {kept_listing_id, demoted_at}`. Before
applying, the owner can count what will move:

```sql
select count(*) - count(distinct inventory_item_id) as rows_to_demote
from public.listings where platform = 'ebay' and listing_status = 'draft';
```

After, `select id from public.listings where platform_fields ? 'dedupe_00832'`
finds exactly the demoted rows (to delete, or to restore by hand).

**Proved on a local Postgres 16 clone at 00830:** seeded three items (three
eBay drafts, one with a schedule; one lone draft; two drafts where the older
holds an offer id) plus a Poshmark draft pair and an active eBay row. First
apply: `UPDATE 3`, the scheduled draft and the offer-holding draft kept, the
Poshmark pair and the active row untouched. Second apply: `UPDATE 0`, index
skipped with a NOTICE. A third eBay draft insert then fails with 23505; an
`ended` one inserts fine.

**Re-proved with the transaction on a clone at 00831 (round-3 review):** same
seed plus a fourth item with one draft, and a `pg_sleep(4)` spliced in before
the index build. A second eBay draft for that item inserted from another
session one second in: against the OLD two-statement file it went in at once
and the migration died with `could not create unique index` (no index, no
00832 row, two drafts). Against this file the insert waited 3s, then failed
with 23505 on the new index, and the migration committed (`UPDATE 3`, index
built, 00832 recorded). Keepers as before: the scheduled draft, the
offer-holding draft; Poshmark pair and active row untouched. Applied twice:
`UPDATE 0`, index skipped with a NOTICE, `INSERT 0 0`. Applied to the clone
left broken by the old file, it demoted the racing duplicate (`UPDATE 1`) and
built the index. With another session holding an uncommitted UPDATE on
`listings`, it gave up after 15s with `canceling statement due to lock
timeout` and rolled back whole; re-run it when that transaction is gone.

**Risk: LOW-MEDIUM.** Writes existing rows (the demotion). Any path that
inserts a SECOND eBay draft for an item now gets 23505 instead: the web
"create drafts" bulk action (`src/pages/flipdesk/listings-actions.ts`) skips
drafted items, and an item whose row still read undrafted (AutoLister wrote its
draft) is reported by name as "already had an eBay draft, so no second one was
made" and moved to drafted, not counted as a failure. Relist, cross-push
and extension writeback create drafts only for extension channels, so the
eBay-only predicate leaves them alone.

**Order.** Apply before the edge redeploy (boot guard expects 00832). The edge
code works without the index (it just loses the race protection), so a
deploy that lands first does not break. Then `NOTIFY pgrst, 'reload schema';`
(migrate:prod sends it). Apply 00831 first; the two are independent, but
the boot guard reads the highest version.

## HELD: 00831_source_item_counts.sql (flipdesk-inventory plan action 7 - Sources page counts items in SQL)

**What it does.** Adds one function, `public.source_item_counts(p_user_id uuid)`,
returning `(source_id, item_count)` for one workspace. SECURITY INVOKER, so
inventory_items RLS decides what is counted; `p_user_id` narrows to one
workspace and is not the tenant boundary. EXECUTE granted to `authenticated`
and `service_role`; deliberately NO revoke from `anon` (US-2403: a denied call
segfaults this image), and an anon call returns no rows because anon matches no
inventory_items SELECT policy. No table, index or policy change.

**Why.** The Sources page selected `source_id` for every inventory row the
caller could see, with no paging, and counted in the browser. That pulls one
row per item to print a number, and under a row cap the delete dialog would
under-report how many items get unlinked.

**⚠ THE BROWSER CALLS IT.** `src/pages/flipdesk/sources.tsx` calls
`supabase.rpc("source_item_counts")` in the same commit. If Pages deploys
before this is applied, the Items column shows 0 for every source and the
delete dialog names no linked items (the page itself still loads). Apply
first.

**Proved on a local Postgres 16** (clone of the test database, 00828-00831
applied): applies twice with no error, and
`node scripts/check-source-item-counts.mjs --dsn ...` passes: the owner and a
viewer member get the real count, a stranger naming the owner's workspace gets
no rows, anon gets no rows, the function is not a definer. Re-marking it
SECURITY DEFINER turns the stranger and anon cases red.

**Risk: LOW.** New read-only function.

**Order.** Apply any time, BEFORE the edge redeploy (the boot guard expects
00831) and before the frontend deploy. Then `NOTIFY pgrst, 'reload schema';`
(migrate:prod sends it).

## HELD: 00830_account_webhooks.sql (extensions-api plan actions 2+3 - customer webhook secret, one delivery per account, durable retries)

**What it does.** Creates three deny-all tables (RLS on, no policies, revoked
from anon/authenticated): `api_webhook_endpoints` (one row per account: url +
AES-GCM-encrypted `whsec_` signing secret), `webhook_deliveries` (the outbox,
UNIQUE on `(user_id, event_type, subject_id)` so a grade is one event), and
`webhook_delivery_attempts` (one row per HTTP attempt). Then copies each
account's most recent `api_keys.webhook_url` into `api_webhook_endpoints` with
NO secret, so existing customers keep receiving events.

**Proved locally** on a clone of the 00827 test database: applies twice with no
error; the backfill picks the newest key's URL and skips keys with none; the
unique index turns a second insert for the same grade into `INSERT 0 0`; the
status CHECK rejects an unknown status.

**Idempotent.** IF NOT EXISTS on every create, constraint and triggers dropped
before re-adding, backfill is ON CONFLICT DO NOTHING. **Risk: LOW.** New tables
only; `api_keys` is read, never changed.

**Order.** Apply BEFORE the edge redeploy: the new edge writes and reads these
tables on every finalized grade and on PATCH /api/v1/webhook, and its boot
guard expects 00830. Then `NOTIFY pgrst, 'reload schema';` (migrate:prod sends
it). No client-side (browser) code reads the new tables.

**Also needed on the host:** a Coolify scheduled task `webhook-retry`,
`*/5 * * * *`, `POST /api/jobs/webhook-retry` with `$FLIPDESK_INTERNAL_JOB_SECRET`
(it is in the generated COOLIFY.md table). Without it, the first attempt still
happens but no retry ever does. Uses the existing `EDGE_ENCRYPTION_KEY`.

## HELD: 00829_close_period_figures_caller_only.sql (security - closing figures covered every seller)

**What it does.** `CREATE OR REPLACE` of `close_period`, same signature. The
`closing_figures` ledger and COGS blocks are computed inline with
`user_id = v_uid` on every read instead of calling `ledger_reconciliation()`
and `cogs_worksheet()`. Same JSON keys. The dashboard net comes from
`sale_pnl` filtered to the seller. Carries 00826's
`PERFORM rebuild_ledger_for_user(v_uid)` forward, so **00826 must be applied
first** (it is below this number, so membership ordering does that).

**Why.** `close_period` is SECURITY DEFINER; the two functions it called are
SECURITY INVOKER and rely on RLS, which a definer bypasses. Locally, seller
A's close recorded ledger net 45700 cents, 2 sold items and $220 purchases
where A's own books were 5700, 1 and $50: seller B's sale and stock were in
A's filed record, which A can read.

**Proof.** `node scripts/check-period-close.mjs --dsn ...` seeds a second
seller. Before 00829: `got 45700,45700,2,22000, expected 5700,5700,1,5000`.
After: green, and the recorded COGS block equals `cogs_worksheet()` run as the
seller. Sabotage (drop the `sale_pnl` and `inventory_items` user filters): 3
checks red. Applied twice in a row with no error.

**Existing rows.** Periods already closed on prod keep their leaked
figures; this file does not rewrite them. Owner decision: reopen and re-close
each, or leave them (nothing computes from `closing_figures` today, it is a
record the seller reads). A read to count them:
`select count(*) from closed_periods;`

**Risk: LOW.** One function replaced in place. **Order.** After 00826 and
00828, before the edge redeploy (boot guard expects 00829). Then
`NOTIFY pgrst, 'reload schema';` (migrate:prod sends it).

## HELD: 00828_ledger_rebuild_skips_closed_periods.sql (money plan action 3 - a rebuild must not move a closed period)

**What it does.** `CREATE OR REPLACE` of `rebuild_ledger_for_user`, same
signature. The DELETE keeps ledger rows dated inside a closed period
(`closed_periods` row with `reopened_at IS NULL`, via `is_period_closed`), and
every INSERT skips those dates and is `ON CONFLICT DO NOTHING`. Everything
else is 00777 byte for byte, including the safeupdate TRUNCATE fix. Grants
re-issued, no REVOKE.

**Why.** The lock triggers cover expenses, mileage, sales and sold-item cost.
The rebuild also reads home_office_years, shipments, ebay_payouts and
mileage_rates, none locked, so the next rebuild silently moved a closed year
away from its `closing_figures`.

**Proof.** `node scripts/check-period-close.mjs --dsn ...`: without 00828 the
two new checks go red (home office -50000 instead of -100000, ledger no longer
equals `closing_figures`); with it, all green, and a rebuild after reopening
picks up the change. Applied twice in a row with no error.

**Risk: LOW.** One function replaced in place. A seller with no closed period
sees no change. **Order.** Apply before the edge redeploy (boot guard expects
00828). Then `NOTIFY pgrst, 'reload schema';` (migrate:prod sends it).

## HELD: 00827_listings_publish_attempts.sql (marketplaces - cap scheduled-publish retries)

**What it does.** `ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS
publish_attempts integer NOT NULL DEFAULT 0`, plus a column comment. Column
only; metadata-only on Postgres 11+, so no table rewrite.

**Why.** The eBay publish-due tick reclaims a failed scheduled draft every 10
minutes forever (about 144 tries a day on a permanent blocker). The edge change
that increments and caps this counter ships separately and reads exactly this
column name.

**Proved on a local Postgres 16 with all migrations applied:** inside a
rolled-back transaction, an existing listing reads 0 after the apply, a new
row defaults to 0, an increment works, NULL is refused, and applying the file
twice in a row succeeds (the second run skips with a NOTICE).

**Risk: LOW.** Additive. `src/types/database.ts` ListingRow carries the field
so `listing-row-schema-parity.test.ts` stays green; no client code reads it.

**Order.** Apply BEFORE any edge deploy whose publish-due code filters on
`publish_attempts` (that code 42703s without it) and before the edge redeploy
(the boot guard expects 00827). Then `NOTIFY pgrst, 'reload schema';`
(migrate:prod sends it).

## HELD: 00826_close_period_rebuilds_ledger.sql (money - closing a period froze stale ledger figures)

**What it does.** `CREATE OR REPLACE` of `public.close_period`, same signature,
same body as 00702 plus one line: `PERFORM public.rebuild_ledger_for_user(v_uid)`
before the inventory snapshot and the closing figures. The 00702 grants are
restated unchanged. No REVOKE (US-3002 / US-2403 pattern).

**Why.** `closing_figures` comes from `ledger_reconciliation()`, which reads
`ledger_entries`, and those rows only change when something calls
`rebuild_ledger_for_user`. Nothing on the close path did, so a seller could
freeze a year missing every sale since the ledger was last built.

**Proved on a local Postgres 16 with all migrations applied:**
`node scripts/check-period-close.mjs --dsn ...` now adds a sale after the first
build. Before 00826 both new checks are red (the sale has no ledger entries
and the frozen figure did not move); after, all 19 checks pass. Applied twice
with no error.

**Risk: LOW.** A close now does one rebuild of the seller's own ledger, the
same call the Money pages already make. Known and NOT changed here: a rebuild
rewrites entries dated inside an earlier closed period too (money plan,
action 3).

**Order.** Apply any time, BEFORE the edge redeploy (the boot guard expects
00826). Then `NOTIFY pgrst, 'reload schema';` (migrate:prod sends it).

## HELD: 00825_api_keys_no_client_writes.sql (security - a key owner could raise their own API tier and clear their quota)

**What it does.** Drops three RLS policies on `public.api_keys`: "Users can
update own API keys" (00005/00322), "Users can create API keys" (00001) and
"Workspace admins can create api keys" (00042). SELECT and DELETE policies stay.
No table change, no grant change.

**Why.** `api-key-auth.ts` trusts `rate_tier` ('enterprise' is the top
per-minute tier) and reads a NULL `monthly_quota` as unlimited. The UPDATE
policy had no column limit, so any key owner could PATCH both through
PostgREST. The INSERT policies let a client write both on a new row. Every
write to `api_keys` in the code goes through the edge's service-role client
(`routes/api-keys.ts`, `api-v1.ts` webhook, `admin-compliance.ts`); `src/`,
`ios/` and `android/` never write the table.

**Proved on a local Postgres 16 with all migrations applied:**
`node scripts/check-api-key-self-upgrade.mjs --dsn ...` goes red before 00825
(owner UPDATE changes 1 row, owner and admin INSERT allowed, key ends
`enterprise/null`) and green after (0 rows, both inserts REFUSED_42501, key
stays `null/100`; owner still reads and deletes, service role still inserts).
Applied twice with no error.

**Risk: LOW.** Nothing in the client writes the table. Not covered here:
POST /api/keys still mints keys with no quota, so deleting a capped key and
minting a new one escapes the cap (extensions-api plan, account-level quota).

**After applying, confirm on prod** that the three policies are gone
(`select polname from pg_policy where polrelid = 'public.api_keys'::regclass`).
A local cluster cannot answer that.

**Order.** Apply any time, BEFORE the edge redeploy (the boot guard expects
00825). Then `NOTIFY pgrst, 'reload schema';` (migrate:prod sends it).

## HELD: 00824_get_or_create_source_tenant_scope.sql (security - a signed-in user could write another seller's sources)

**What it does.** `CREATE OR REPLACE` of `public.get_or_create_source`, same
signature, same body as 00640, plus one check after the role guard: the caller
must be the service role, the account owner (`p_user_id = auth.uid()`), or a
`listing_manager`-or-higher member of that workspace. Anyone else gets 42501.
No table change, no grant change, no REVOKE.

**Why.** The function is SECURITY DEFINER and the browser passes `p_user_id`
itself (intake, bulk intake). Before this, any signed-in account could insert a
source into another seller's account, or look up one of their source names and
get the row id back. Live on prod for every signed-in account.

**Proved on a local Postgres 16 with all migrations applied:**
`node scripts/check-source-tenant-scope.mjs --dsn ...` goes red before 00824
(stranger ALLOWED, 1 planted row) and green after (stranger and viewer
REFUSED_42501; owner, listing_manager and service role ALLOWED). Applied twice
in a row with no error.

**Risk: LOW.** Same signature, so existing grants stand. The only callers are
the web intake pages, which pass the seller's own id or the workspace owner's
id for a member; a viewer-role member calling it was already refused by the
sources INSERT policy on the direct path.

**Order.** Apply any time, BEFORE the edge redeploy (the boot guard expects
00824). Then `NOTIFY pgrst, 'reload schema';` (migrate:prod sends it).

## HELD: 00823_imported_sales_shipped.sql (US-3465 - old imported sales out of the Ship queue)

**What it does.** One UPDATE on `public.sales`: sets `shipped_at` to the sale
date for rows that are `completed`, have no `shipped_at`, have no
`platform_order_id`, and sold more than 30 days ago. No schema change.

**Why.** The Ship tab is "completed and not shipped". Spreadsheet-imported
sales carry no marketplace order id, so no sync can ever mark them shipped, and
the owner confirms they all shipped. Sale date rather than a guessed later date,
because nothing computes ship speed from `shipped_at` (grepped 2026-09-22).

**Dry run on prod, 2026-09-22, inside BEGIN ... ROLLBACK:** `UPDATE 51`. After
it, 161 completed sales still waiting: 160 are eBay orders the full history
sync will mark (US-3209 path), 1 is a no-order sale from 2026-09-11, inside the
30 days.

**Idempotent.** Only `shipped_at IS NULL` rows match, so a re-run updates 0.
**Risk: LOW.** Touches only rows with no ship date; never moves an existing one.

**Order.** Apply any time. No code reads anything new; the edge boot guard
expects 00823 once this commit is deployed, so apply BEFORE the edge redeploy.
Then `NOTIFY pgrst, 'reload schema';` (migrate:prod sends it).

## ✅ APPLIED 2026-09-22 (owner, reported applied in session): 00822_closet_import_vinted_origin.sql (US-3460 - Vinted closet import)

**What it does.** Drops and re-adds `flipdesk_import_runs_origin_check` with
`'vinted'` added to the seven permitted values. Nothing else. No table, no
column, no backfill.

**Why it is first and not last.** The closet-import route writes
`origin: platform` into `flipdesk_import_runs`. Grailed shipped the other way
round: US-3155 added it to the platform list, the CHECK still listed five
values, and every Grailed import failed at the INSERT with 23514 while the
seller read "Could not start the import." That ran for months (US-3261). The
rule out of it, written into `vault/30-platform/import-sources.md`, is widen
the CHECK FIRST on any new import origin.

**Idempotent.** The constraint is named, so `DROP CONSTRAINT IF EXISTS` then
`ADD CONSTRAINT`. Re-running it rewrites the same definition.

**Risk: LOW.** The constraint only widens. Every value it permitted before it
still permits, which `closet-import-origin_test.ts` asserts for
`csv`/`sheet`/`paste` specifically. The re-add revalidates existing rows, and
they all hold one of the old six values.

**Apply BEFORE the edge deploy that carries this commit.** The edge in the
same commit adds `vinted` to `CLOSET_IMPORT_PLATFORMS`, so with the code
deployed and the constraint unwidened, a Vinted import starts and dies at the
insert. With the constraint widened and the code not yet deployed, nothing
happens at all, which is the safe direction.

## ✅ APPLIED 2026-09-22 (owner, reported applied in session): 00821_one_open_grade_per_item.sql (US-3214 - double-click grading)

**EXECUTED 2026-09-21 against a local Postgres 16** carrying all 813
migrations from zero, with `ON_ERROR_STOP=1`. Applied twice; the second run
logged `relation "uq_grading_submission_one_open_per_item" already exists,
skipping` and changed nothing.

**What it does.** One partial unique index on
`flipdesk_grading_submissions (inventory_item_id)` where the status is
`pending`, `processing` or `pending_review`, plus a backfill that closes any
duplicates already in the table.

**What it fixes, and it is money.** `submitItemsForGrading` checked nothing: a
second click on Submit inserted a second submission, ran Claude a second time
and charged a second time. US-2564's batch key already made the CREDIT debit
idempotent; `claimIncluded()` in `grade-billing.ts` is a compare-and-swap
increment with no key at all, so the monthly included bundle really did burn
twice. Checked rather than assumed, and
`src/tests/one-open-grade_test.ts` asserts that claim is still keyless so the
note cannot quietly stop being true.

**⚠ DEPLOY ORDER MATTERS MORE THAN USUAL HERE.** The edge in the same commit
MOVES the `flipdesk_grading_submissions` insert from step 4 (after the charge
and the photo copy) to step 1b (immediately after the submissions row, before
`runPaymentPrecedence`). That reorder is what lets the index refuse the loser
of a race while the money is still untouched. Apply this migration BEFORE
deploying that edge; with the edge deployed and the index missing, the second
press still charges, exactly as it does today.

**Risk: LOW on a clean table, MEDIUM where sellers have double-clicked.**
The rows the defect produced are exactly the rows the index refuses, so a bare
`CREATE UNIQUE INDEX` would fail on any database where it happened. The `DO`
block closes the duplicates first, keeping the OLDEST per item (the one the
pipeline actually ran) and marking the rest `failed` with a reason. Nothing is
deleted, so the record that they existed and were charged survives for the
void-and-refund action US-3214 adds to the admin queue.

**Read the count first if you want to know what it will touch:**

```sql
-- how many open grading submissions the backfill would close, and on how many
-- garments
select count(*) - count(distinct inventory_item_id) as would_close,
       count(distinct inventory_item_id) as items
  from public.flipdesk_grading_submissions
 where status in ('pending', 'processing', 'pending_review');
```

**Apply order:** after 00820. Then `NOTIFY pgrst, 'reload schema';` is NOT
required (no new relation or column), but it is harmless.

**Readback after applying:**

```sql
-- the index exists, is unique, and covers exactly the three non-terminal states
select indisunique, pg_get_expr(indpred, indrelid) as predicate
  from pg_index
 where indexrelid = 'public.uq_grading_submission_one_open_per_item'::regclass;
-- expect indisunique = t and a predicate naming pending, processing,
-- pending_review and nothing else

-- and nothing is left doubled up
select inventory_item_id, count(*)
  from public.flipdesk_grading_submissions
 where status in ('pending', 'processing', 'pending_review')
 group by 1 having count(*) > 1;
-- expect zero rows
```

## ✅ APPLIED 2026-09-22 (owner, reported applied in session): 00820_work_overrides.sql (US-3182 - Worth My Time R2 05/06)

**EXECUTED 2026-09-21 against a local Postgres 16** carrying all 812
migrations from zero, with `ON_ERROR_STOP=1`. Applied twice; the second run
logged `already exists, skipping` and changed nothing.

**What it does.** Two new tables, `flipdesk_work_overrides` and
`flipdesk_work_suppressions`, holding what a seller corrects about the
planner's estimates and what they set aside. Deny-all RLS on both, owner
column `owner_user_id`, FK to `inventory_items` with `ON DELETE CASCADE`, and
a CHECK per table fixing the shape each `kind` may take.

**Risk: LOW.** Nothing existing is read, written, dropped or altered. The only
reference to an existing table is the FK, which adds nothing to that table's
own deletes beyond removing rows in the new ones.

**⚠ IT NEEDS POSTGRES 15 OR NEWER, and that is the one thing to check before
applying.** Both unique indexes are declared `NULLS NOT DISTINCT`:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_overrides_scope
  ON public.flipdesk_work_overrides
    (owner_user_id, inventory_item_id, action_key, kind)
  NULLS NOT DISTINCT;
```

`action_key` is NULL for an item-wide correction, and on Postgres 14 or below
every NULL is distinct, so the index would not collide and a seller could
accumulate a new row on every save. Prod is Postgres 17, so this applies; the
version is named here because the failure is silent rather than loud.

**The first draft used an expression index and had to be rewritten.** It
spelled the same rule as `coalesce(action_key, '')`, which works as a
constraint and cannot be named by PostgREST's `on_conflict`, so every upsert
answered `42P10 there is no unique or exclusion constraint matching the ON
CONFLICT specification`. Found by running the routes against a real stack, not
by any test.

**Code in the same commit READS these tables from the edge**
(`/api/flipdesk/planner/overrides` and `/planner/suppressions`, five routes).
The frontend calls them from the Worth My Time screen. Until this applies,
those routes answer a 500 and the correction panel shows its error state; the
plan itself still builds, because a failed read leaves an empty book rather
than blocking.

**Apply order:** after 00819. Then `NOTIFY pgrst, 'reload schema';` - the new
tables are unreachable through PostgREST until it reloads.

**Readback after applying:**

```sql
-- both tables exist, deny-all, with the two NULLS NOT DISTINCT indexes
select relname, relrowsecurity
  from pg_class
 where relname in ('flipdesk_work_overrides', 'flipdesk_work_suppressions');
-- expect two rows, relrowsecurity = t for both

select indexrelid::regclass as index, indnullsnotdistinct
  from pg_index
 where indexrelid::regclass::text in
       ('uq_work_overrides_scope', 'uq_work_suppressions_scope');
-- expect two rows, indnullsnotdistinct = t for both

select count(*) from pg_policies
 where tablename in ('flipdesk_work_overrides', 'flipdesk_work_suppressions');
-- expect 0: deny-all means no policy at all, and the edge reaches them
-- service-role through owner-verified routes
```

## ✅ APPLIED 2026-09-22 (owner, reported applied in session): 00819_one_open_work_session.sql (US-3177 - Worth My Time R1 12/12)

**Fixes a defect in 00818, which is also still held — so the two land
together and 00819 goes second.**

**What it does.** 00818 created `uq_work_sessions_one_active_per_user` with
the predicate `state = 'active'`. A work session is CREATED in state
`planned` and only becomes `active` when its first task starts, so the rule
did not bind at the moment it was needed. `paused` was uncovered for the same
reason. This drops that index and creates
`uq_work_sessions_one_open_per_user` over `state IN ('planned','active',
'paused')`.

**Why it matters, measured rather than reasoned about.** A seller could pause
a session, build a second plan, and have the first drop off the screen while
staying open in the database: `GET /sessions/current` reads the newest of the
three open states and returns one row, so the paused evening became
unreachable through the UI with no error anywhere. Found by the end-to-end
run in `scripts/check-planner-e2e.mjs`, not by any unit test.

**It carries a BACKFILL and that is the risky half.** The rows the bug
produces are exactly the rows the new index refuses, so a bare
`CREATE UNIQUE INDEX` fails on any database where a seller made two plans —
it failed on the first machine it was tried on. The `DO` block closes the
duplicates first, keeping the session with the most COMPLETED tasks and only
then the newest, and sets the rest to `abandoned`. Nothing is deleted:
`abandoned` is terminal, the tasks and timing events stay, and what changes
is only which session `current` can reach.

**Risk: LOW on a fresh table, MEDIUM if sellers have already used the
planner.** Read the count first if you want to know what it will touch:

```sql
-- how many sessions the backfill would close, and for how many sellers
select count(*) - count(distinct user_id) as would_close,
       count(distinct user_id) as sellers
  from public.flipdesk_work_sessions
 where state in ('planned', 'active', 'paused');
```

Expect `0` on a prod that has never run the planner, which is the case today
(00818 is itself still held, so the table does not exist yet). If 00816-00818
are applied in the same sitting, this is a no-op by construction.

**Readback after applying:**

```sql
-- exactly one uq_ index, over the three open states
select indexname, indexdef
  from pg_indexes
 where tablename = 'flipdesk_work_sessions' and indexname like 'uq_%';
-- expect: uq_work_sessions_one_open_per_user ... WHERE state = ANY (...)
-- and NO uq_work_sessions_one_active_per_user

-- no seller left with two open sessions
select user_id, count(*)
  from public.flipdesk_work_sessions
 where state in ('planned', 'active', 'paused')
 group by user_id having count(*) > 1;
-- expect: 0 rows
```

**Apply order:** after 00818. Then `NOTIFY pgrst, 'reload schema';`.

**Client-side read in the same commit?** No. The route change that travels
with it (`flipdesk-planner.ts` reading `OPEN_SESSION_STATES`) queries only
columns 00818 already creates, so the edge is correct either side of this
index. The index is the concurrency backstop, not the mechanism.

**EXECUTED 2026-09-21 against a local Postgres 16** carrying all 811
migrations from zero, with `ON_ERROR_STOP=1`. Applied twice: the second run
logged `relation "uq_work_sessions_one_open_per_user" already exists,
skipping` and changed nothing. The backfill was exercised for real — the
database had three duplicate open sessions from the end-to-end run at the
time, and it closed two of them. The edge then booted against it and its
schema guard reported `DB at 00819 matches expected 00819`.

## ✅ APPLIED 2026-09-22 (owner, reported applied in session): 00818_work_sessions.sql (US-3167 - Worth My Time R1 02/12)

**EXECUTED 2026-09-21 against a local Postgres 16** carrying all 810
migrations from zero. Applied twice; the second run logged nine
`already exists, skipping` notices and changed nothing.

**Risk: LOW.** Three new tables, seven CHECKs, two partial unique indexes,
four supporting indexes, three triggers, three SELECT policies, three REVOKEs.
Nothing existing is read, written, dropped or altered. The only reference to an
existing table is an FK to `inventory_items` declared `ON DELETE SET NULL`,
which adds no behaviour to that table's own deletes beyond nulling a column in
the new one.

**Why it exists.** It holds a seller's work session, its tasks, and the timing
events recording when each one ran, so an interruption does not erase their
work. The planner that fills these is R1 06/12 onward.

**Two indexes are the point, and they are not optimizations.**
`uq_work_sessions_one_active_per_user` and `uq_work_session_tasks_one_active`
are partial unique indexes enforcing "one active session per seller" and "one
active task per session" under CONCURRENCY. A SELECT-then-INSERT in the route
passes twice when two tabs press Start together; an index does not. Dropping
either was sabotage-tested and reddens the check script by name.

**Client-side read risk: NONE.** Nothing in `src/` reads these tables as of
this commit - the screen is R1 10/12 and there are no routes yet. A frontend
that auto-deploys before this applies loses nothing.

**Apply order:** after 00817. Then `NOTIFY pgrst, 'reload schema';`.

**Readback after applying:**

```sql
-- 1. The three tables, RLS on, one SELECT policy each, no write policies.
select tablename, count(*) as policies, string_agg(cmd, ',') as cmds
from pg_policies where schemaname = 'public'
  and tablename like 'flipdesk_work_%'
group by tablename order by tablename;
-- expect three rows, each policies=1 and cmds=SELECT

-- 2. The two concurrency indexes exist and are PARTIAL. A non-partial one
--    would refuse a seller's SECOND session outright, which is wrong.
select indexname, indexdef from pg_indexes
where schemaname = 'public'
  and indexname in ('uq_work_sessions_one_active_per_user',
                    'uq_work_session_tasks_one_active');
-- expect two rows, each indexdef ending in WHERE (state = 'active'::text)

-- 3. The item FK is SET NULL, not CASCADE. CASCADE would erase a seller's
--    record of the hour they spent whenever the garment is deleted.
select confdeltype from pg_constraint
where conname = 'flipdesk_work_session_tasks_inventory_item_id_fkey';
-- expect n   (n = SET NULL; c would be CASCADE and is the bug)
```

**Proved locally rather than asserted:** `node scripts/check-work-session-storage.mjs --dsn "postgresql://..."` runs seventeen rules inside one rolled-back transaction - isolation, repeated retry keys, invalid states, two competing sessions, two competing tasks, a stale revision, an item tombstone and a full account erasure that leaves the other seller alone. It is wired into `npm run verify` and into `.github/workflows/db-migrations.yml`.

**Not applied yet, so the story stays open on its operator step.**

## ✅ APPLIED 2026-09-22 (owner, reported applied in session): 00817_work_preferences.sql (US-3166 - Worth My Time R1 01/12)

**EXECUTED 2026-09-21 against a local Postgres 16** carrying all 809
migrations from zero, 0 failures. Applied twice more; both runs changed
nothing and only logged `relation already exists, skipping`.

**Risk: LOW.** One new table, six CHECK constraints, one trigger, one SELECT
policy, one REVOKE. Nothing existing is read, written, dropped or altered.

**Why it exists.** It stores where a seller works, what tools they have and
what their time is worth, so the planner in R1 06/12 can fit a plan to their
situation. One row per seller, created lazily; an absent row is every default,
which is why every column is NOT NULL with one.

**Client-side read risk: NONE.** Nothing in `src/` reads this table as of this
commit - the screen is R1 10/12. The edge routes fall back to defaults when
the read errors, so a frontend that auto-deploys before this applies loses
nothing: `GET /api/flipdesk/work-preferences` answers with defaults and a
PATCH fails with a 500 the seller can retry after the apply.

**Apply order:** after 00816. Then `NOTIFY pgrst, 'reload schema';` - the
table is exposed through PostgREST for the owner's own SELECT and is invisible
to the API without the reload.

**Readback after applying:**

```sql
-- 1. The table, RLS, and exactly one policy (SELECT, owner-scoped).
select relrowsecurity from pg_class where relname = 'flipdesk_work_preferences';
-- expect t

select cmd, qual from pg_policies
where schemaname = 'public' and tablename = 'flipdesk_work_preferences';
-- expect ONE row: SELECT, qual mentioning (select auth.uid()) = user_id.
-- Writes are service-role only on purpose -- a direct write would bypass the
-- validation the route performs.

-- 2. All six CHECKs are there and named.
select conname from pg_constraint
where conrelid = 'public.flipdesk_work_preferences'::regclass and contype = 'c'
order by conname;
-- expect: context, currency, minutes, target, tools

-- 3. Nothing was created with rows.
select count(*) from public.flipdesk_work_preferences;
-- expect 0
```

**Proved locally rather than asserted:** every CHECK refuses its bad value (4
and 241 minutes, `sourcing_trip`, an unknown tool, `EUR`, a negative target); a
target of exactly `0` is ACCEPTED, because a seller may deliberately say their
time is free; and clearing one back to NULL works, which is what an explicit
null in the PATCH body does.

**Not applied yet, so the story stays open on its operator step.**

## ✅ APPLIED 2026-09-22 (owner, reported applied in session): 00816_easypost_label_provider.sql (US-3015 - EasyPost as the second label provider)

**Risk: LOW-MEDIUM.** One new deny-all table, two nullable columns on `sales`,
one CHECK constraint, one backfill UPDATE, two indexes, one trigger. Nothing
existing is dropped or rewritten. The one line that touches data is scoped to
rows that already have an eBay label and no provider recorded, so it can only
fill a hole it created.

**Why it exists.** The eBay label path can only price postage for an eBay order
on a connection holding the limited-release `sell.logistics` grant. Every other
sale - Shopify, extension-listed Poshmark, anything on a deployment eBay never
granted the scope to - had no way to buy a label in FlipDesk at all.
`easypost_accounts` maps a seller to their EasyPost REFERRAL CUSTOMER, so the
seller's own card is charged by EasyPost and GradeThread holds no postage float
and carries no reweigh liability. The row holds a pointer and an encrypted API
key; there is no balance column and there should never be one.

**Client-side read risk: NONE.** Nothing in `src/` reads `sales.label_provider`,
`sales.easypost_shipment_id` or `easypost_accounts` as of this commit; the whole
EasyPost path is edge-side and gated on `EASYPOST_API_KEY`, which is unset. A
frontend that auto-deploys before this applies loses nothing, because there is
nothing to lose yet.

**Write risk before the apply: NONE, for the same reason.** With the env var
unset the EasyPost routes report `feature_unavailable` and never reach a column
that does not exist. **Do not set `EASYPOST_API_KEY` on Coolify until this
migration is applied** - that is the one ordering that matters here.

**Apply order:** after 00815. Then `NOTIFY pgrst, 'reload schema';` - PostgREST
caches the column list, so without the reload the two new `sales` columns are
invisible to the API even after the ALTER succeeds.

**Readback after applying:**

```sql
-- 1. The table exists, RLS is on, and no policy grants a way in.
select relrowsecurity from pg_class where relname = 'easypost_accounts';
-- expect one row, t

select count(*) from pg_policies
where schemaname = 'public' and tablename = 'easypost_accounts';
-- expect 0 -- deny-all is the absence of a policy plus the REVOKE

-- 2. The two sales columns and the constraint.
select column_name from information_schema.columns
where table_name = 'sales'
  and column_name in ('label_provider', 'easypost_shipment_id')
order by column_name;
-- expect two rows

-- 3. The backfill named every pre-existing eBay label and nothing else.
select label_provider, count(*) from public.sales
where ebay_shipment_id is not null group by 1;
-- expect a single row: ebay | <however many labels were bought>
```

**Not applied yet, so the story stays open on its operator criterion.**

## ✅ APPLIED 2026-09-20 (owner, confirmed applied and merged): 00815_acquired_date_timezone.sql (US-3314 - record the zone that named an acquisition day)

**EXECUTED 2026-09-20 against the local cluster** carrying all 815 migrations.
One `add column if not exists` plus a `comment on column`. Applied twice; the
second run changed nothing.

**Risk: LOW.** One nullable text column on `inventory_items` and a comment. No
data is read, written or moved, no index, no policy, no constraint.

**Why it exists.** Until US-3310, both iOS writers named `acquired_date` in UTC
from a moment carrying the seller's local wall-clock time, so rows written when
the device's day and the UTC day disagreed are off by one. The stored value
carries no zone, so a blanket correction would corrupt every row that was
already right. The owner's decision on 2026-09-20 was to correct FORWARD: leave
the old rows, record the zone from here on, and say plainly which rows are
trustworthy. `acquired_date_tz` NULL means unrecorded - every earlier row, and
every CSV import, since an import carries the file's day rather than a device's.

**Client-side read risk: NONE, and one write risk worth naming.** Nothing reads
the column yet. The four web writers and the iOS canvas WRITE it in the same
commit, so if the frontend auto-deploys before this is applied, every insert
carrying an acquisition date fails with `column "acquired_date_tz" does not
exist` - PostgREST rejects the whole row rather than ignoring the field. **This
one is genuinely apply-before-push.**

**Apply order:** after 00814. No `NOTIFY pgrst, 'reload schema'` is optional
here: PostgREST caches the column list, so **send the reload** or the new column
is invisible to the API even after the ALTER succeeds.

**Readback after applying:**

```sql
select column_name, is_nullable
from information_schema.columns
where table_name = 'inventory_items' and column_name = 'acquired_date_tz';
-- expect one row, YES
```

## ✅ APPLIED 2026-09-20 (owner, reported applied in session): 00814_chart_category_match_precision.sql (US-3443 - the words a chart's own word list was missing)

**EXECUTED 2026-09-20 against the local cluster** carrying all 814 migrations.
87 UPDATEs, each appending only the tokens the row does not already carry.
Applied twice; the second run reported the same 87 rows covered and changed
nothing. The audit reads the table's fall-through count from 273 down to 162.

**Risk: LOW.** No DDL. It appends to one `text[]` column on 87 of 437 rows and
overwrites nothing: each statement computes `ARRAY[...] except category_match`,
so a word a later migration added by hand survives.

**What it fixes.** `narrowChartsByCategory` keeps the charts whose
`category_match` the asked-for category contains, and falls back to the family
when none matches. 254 of the resolver's brand-and-category asks fell through
that step, and 113 did so only because a chart's word list was short: a brand's
generic "Tops" chart that never says "blouse" matches nothing, so a blouse goes
through the fallback instead of straight to the right chart.

**What it deliberately leaves.** The other 141 asks are refused: a jeans chart
may not claim "skirt", a leggings chart may not claim "jeans", and a men's
chart may not claim either. That asserts a product the brand does not publish,
which is US-3405's reason for not doing this pass by rule, and it still holds.

**One target row of 88 is absent on purpose.** `brand_size_charts_sourced` is a
NOT VALID check demanding a `source_url` and a `confidence`, so the nine
unsourced rows grandfathered by 00578 are readable but not writable. Exactly one
target is among them - `express / Women / Tops & outerwear (US numeric 00-18 /
alpha)`, which would have gained "hoodie". The seed carries the word, so it
lands the day that row gets a source. Inventing one to get past the check is the
provenance defect the check exists to prevent.

**Client-side read risk: NONE.** `category_match` is read only by the edge
service when it assembles the grading prompt. Nothing in `src/` selects the
column, so the Cloudflare auto-deploy on push cannot reach it.

**Apply order:** after 00813. No `NOTIFY pgrst, 'reload schema'` needed - no
DDL, so PostgREST's schema cache is unaffected.

**Readback after applying:**

```sql
select count(*) from public.brand_size_charts
where brand_key = 'aloyoga' and department = 'Women' and 'blouse' = any(category_match);
-- expect 1
```

The migration checks itself: it raises rather than returns if any of the 87
target rows is missing from the database, or if any of them does not carry every
word it adds. 87 silent no-op UPDATEs read exactly like a clean apply, which is
the failure this guard exists for.

## ✅ APPLIED 2026-09-20 (owner, reported applied in session): 00813_chart_brand_key_accent_duplicates.sql (US-3443 - four size charts stored twice, and grading reads the unsourced copy)

**EXECUTED 2026-09-20 against the local cluster** carrying all 813 migrations.
Before: 441 chart rows, four of them duplicated. After: 437, with the four
surviving rows carrying the `source_url` and `confidence 0.55` that had been
sitting on the copies grading could not reach. Applied twice; the second run
moved 0 and deleted 0. `node scripts/check-chart-brand-keys.mjs --dsn ...` goes
from two findings to a tick.

**Risk: LOW.** Blast radius four UPDATEs and four DELETEs, all four deletes on
rows no lookup can reach. No DDL.

**What was wrong.** `brandKey` is
`raw.toLowerCase().replace(/[^a-z0-9]/g, "")`, which DROPS an accented letter
rather than transliterating it, so the German-spelled outdoor brand keys as
`khl` and the Swedish one as `fjllrven`. 00472 wrote four chart rows by hand
under the transliterated spellings; 00498's generator wrote the same four
charts from the seed under the dropped ones. The eight rows are identical in
`rows`, `category_match`, `brand_match`, `note` and `measurement_basis`, and
differ only in that **00472's carry the source_url and 00472's are the
unreachable ones**. So the grading prompt has been served the unsourced
approximation while the sourced chart sat beside it.

**It reports what it did.** A `RAISE NOTICE` carries both counts, and a second
DO block raises an exception if any row outside the three named convention keys
still carries a key the resolver cannot compute.

**Client-side read risk: NONE.** Nothing in `src/` reads `brand_size_charts`;
both readers are edge-side and both key on `brand_key`.

**Ordering: apply after 00812.** It touches only `brand_size_charts`, which has
existed since 00389, so the number is the only dependency.

**`NOTIFY pgrst, 'reload schema';` is NOT needed** - no table, column or RPC
signature changed.

**EXPECTED_SCHEMA_VERSION is 00813 in the same commit**, and the manifest was
regenerated.

**After applying, confirm it in one read:**

```sql
select brand_key, department, source_url
  from public.brand_size_charts
 where brand_key in ('khl', 'kuhl', 'fjllrven', 'fjallraven')
 order by brand_key;
-- expect FOUR rows, keys khl and fjllrven only, every source_url non-null.
-- Any kuhl or fjallraven row means the delete matched nothing.
```

## US-3355: the grant retrofit, in three batches (00810, 00811, 00812)

The three headings below are one piece of work and share this section. They are
written as three separate `HELD:` entries on purpose: every parser in this repo
that reads these headings -- `scripts/held-migration-gate.mjs`,
`scripts/operator-worklist.mjs` and their tests -- keys on
`HELD: NNNNN_name.sql`, and a heading naming three versions at once was read by
only one of them. That was the seventh way this control has been routed around
and the first one written by an agent. The gate now reads every version on a
heading; the convention stays one heading per file.

**EXECUTED 2026-09-20 against the local cluster** carrying all 812 migrations.
Applying all three took `anon` from SELECT on **318 of 362** public tables to
**224**, and `authenticated` from **320 to 226** -- exactly 94 each, no more and
no fewer. Re-applied; the counts did not move. Each file ends with a readback
that raises an exception if any of its own tables still grants SELECT, and that
readback was proved to fire: re-granting one table and deleting its statement
gave `ERROR: [00810] 1 of 12 tables still grant SELECT to anon or
authenticated`.

**Risk: LOW, and the batching is the risk control.** Apply in order, riskiest
first, and stop after any batch. Nothing depends on a later one.

| File | Tables | What they hold |
|---|---|---|
| `00810` | 12 | credential and session material in flight, plus the connector's OAuth authorization server |
| `00811` | 25 | identity, money and legal records about named people; one seller's operational data readable by another |
| `00812` | 57 | the admin surface and permission model, the agent kernel, paid acquisition, the brand KB and reference data, grading internals, reward economics, and the six that revoked only their writes |

**What the hole is, precisely.** NO ROW IS READABLE TODAY: RLS is on with zero
policies on all 94, so an anon SELECT returns 200 and an empty array. What is
exposed is the SCHEMA -- prod's PostgREST OpenAPI document, fetched with the
anon key that ships in the browser bundle, advertises 87 of them and publishes
941 of their column names. And one `CREATE POLICY` is the entire distance from
there to world-readable.

**The second layer is measured, both ways**, on the local cluster inside a
transaction that rolled back: with the revoke applied, a wide-open
`create policy ... for select to anon using (true)` on `oauth_clients` still
answers `permission denied for table oauth_clients`; with the grant put back,
the same policy returns the seeded row.

**Behavioural no-op.** 4,042 files were scanned for `.from("<table>")` and
`rest/v1/<table>` and not one of the 94 is read through a client path. Verified
after applying: `submissions`, `inventory_items`, `listings`, `grade_reports`,
`sales` and `item_photos` keep their grants, and `service_role` keeps SELECT and
INSERT on `oauth_clients`.

**Client-side read risk: NONE**, and this one really is none -- the tables are
operator-only by registration, and the edge connects as `service_role`, which
these files never name.

⚠ **Apply off-peak.** REVOKE takes a brief ACCESS EXCLUSIVE lock per table for
the catalog update. Instant on an idle table, but it queues behind a
long-running query.

**`NOTIFY pgrst, 'reload schema';` IS needed here**, unlike the other held
entries: PostgREST caches the schema and its OpenAPI document is built from what
the connecting role can see.

**EXPECTED_SCHEMA_VERSION is 00812 in the same commit**, and the manifest was
regenerated.

**After applying, confirm it credential-free in one request** rather than
trusting the apply -- this is the rare case where the verification needs no
database access at all:

```bash
curl -s https://api.gradethread.com/rest/v1/ \
  -H "apikey: $VITE_SUPABASE_ANON_KEY" \
  -H "Accept: application/openapi+json" | python3 -c \
  "import json,sys; print(len(json.load(sys.stdin)['paths']), 'paths')"
```

449 paths before. Expect about **356** after all three, and about 437 after
`00810` alone. A count that has not moved means the revoke applied but PostgREST
is still serving its cached schema, so send the NOTIFY.

The full reasoning, the eleven-group classification and the per-table names are
in `vault/20-domain/service-role-tables.md`, which owns this contract.

## ✅ APPLIED 2026-09-20 (owner, reported applied in session): 00812_revoke_operator_grants_c_platform.sql (US-3355 - batch C, 57 platform, reference and economics tables)

Apply LAST of the three. See the shared section above for the measurement, the
risk and the readback.

## ✅ APPLIED 2026-09-20 (owner, reported applied in session): 00811_revoke_operator_grants_b_people.sql (US-3355 - batch B, 25 tables of records about named people and cross-seller data)

Apply SECOND. See the shared section above.

## ✅ APPLIED 2026-09-20 (owner, reported applied in session): 00810_revoke_operator_grants_a_credentials.sql (US-3355 - batch A, 12 credential and OAuth-server tables)

Apply FIRST, and it is the batch to apply if you only apply one: these hold
PKCE verifiers, live tokens and the connector's authorization-server rows.
See the shared section above.

## ✅ APPLIED 2026-09-20 (owner, reported applied in session): 00809_size_class_curve_and_big.sql (US-3406 — two size charts that never got their class recorded)

**EXECUTED 2026-09-20 against the local cluster** carrying all 809 migrations
from zero. Before: both rows `size_class` NULL. After: `tommyhilfiger` Women
"Curve, tops & bottoms (body inches)" = `plus`, `brooksbrothers` Men "Bottoms,
big (body inches)" = `big_and_tall`. Applied three times; the second and third
updated nothing. Class counts moved exactly `plus` 6→7, `big_and_tall` 2→3,
NULL 262→260, and no other row changed.

**Risk: LOW.** Two UPDATEs, blast radius two rows, both pinned by the table's
full unique key `(brand_key, department, garment)`, with
`size_class is distinct from '<value>'` so a re-run writes nothing. No DDL, no
drop, no type change.

⚠ **The one statement that can abort** is either UPDATE, because
`brand_size_charts` carries a NOT VALID check `brand_size_charts_sourced` that
does not validate the existing table but DOES fire on a row you update. Both
target rows were given a `source_url` and confidence 0.85 by 00781, which is
applied, so it passes — but a hand re-run on this table aborted on an unsourced
row on 2026-09-09 (00499's header records it), so check those two columns in the
readback below rather than assuming.

⚠ **A zero-row match would be silent**, and 00782 and 00793 have retired and
renamed rows in this table before. The file `RAISE NOTICE`s both row counts:
0 and 0 on a re-run is correct, 0 and 0 on a FIRST run means the garment strings
have moved and nothing was repaired.

**Why it exists.** `size_class` is derived from the chart's garment scope by
`detectSizeClass`, and 00499's generator emits a row only when a size SYSTEM is
readable OR the class is non-standard. These two derived "standard", so the
generator emitted nothing for them at all and the column stayed NULL in
production. `CLASS_PATTERNS` is widened in the same commit to read "curve" as
plus and a bare "big" as big_and_tall, and **00499 is regenerated** to match
because `sizing-chart-parity_test.ts` asserts the committed file equals what the
generator produces. 00499 is already applied and both appliers compute pending
by MEMBERSHIP, so the regenerated file never re-runs against prod — this file is
what moves the live rows.

**Client-side read risk: LOW, and "none" would have been wrong.** Nothing in
`src/` queries the COLUMN, but `src/components/flipdesk/size-guide-panel.tsx:69`
renders `chart.sizeClass` when it is not "standard" — the field the edge returns
from `/api/flipdesk/size-bands`. So the frontend does show this value, and what
the migration changes is that two charts start carrying a label where they
showed none. That is the correct label appearing, not a broken one, and it needs
no deploy ordering: the frontend already handles any string there.

The other consumers are edge-side: `flipdesk-size-bands.ts` (the tier) and, new
in this commit, the chart ranking in `brand-knowledge.ts`.

**Ordering: apply after 00808**, which is the next number down. No dependency on
00805-00808 beyond the number: this touches only `brand_size_charts`, which has
existed since 00389.

**`NOTIFY pgrst, 'reload schema';` is NOT needed** — no table, column or RPC
signature changed. Harmless if sent.

**EXPECTED_SCHEMA_VERSION is 00809 in the same commit**, and the manifest was
regenerated (`node scripts/gen-migration-manifest.mjs`).

**After applying, confirm it in one read** rather than trusting the apply:

```sql
select brand_key, garment, size_class, source_url is not null as sourced, confidence
  from public.brand_size_charts
 where (brand_key = 'tommyhilfiger' and garment like 'Curve%')
    or (brand_key = 'brooksbrothers' and garment = 'Bottoms, big (body inches)');
-- expect two rows: plus and big_and_tall, both sourced = true.
-- Fewer than two rows means the garment strings moved and the UPDATE matched
-- nothing, which the RAISE NOTICE during the apply will also have said.
```

**Until it is applied, the ranking half still works and the data half does
not.** With the column NULL the demotion falls back to `detectSizeClass`, which
now reads "Curve" — so Tommy Hilfiger is already correct from the code. Brooks
Brothers likewise. What the migration buys is that the stored value stops
disagreeing with the derivation, which is what `size-class-reaches-the-caller_test.ts`
exists to keep true.

## ✅ APPLIED 2026-09-20 (owner, reported applied in session): 00808_cross_channel_link_reviews.sql (US-3197 — the cross-channel matches a human has to decide)

**EXECUTED 2026-09-20.** `public.flipdesk_cross_channel_link_reviews` exists with `relrowsecurity = true` and **zero policies**, which is the deny-all posture, and `anon` and `authenticated` hold no grant on it. Both indexes (`uq_cross_channel_link_reviews_pair`, `idx_cross_channel_link_reviews_open`) and both CHECK constraints are present.

⚠ **The table is `flipdesk_cross_channel_link_reviews`, not `cross_channel_link_reviews`.** A readback querying the shorter name answers NULL and reads exactly like a migration that recorded itself after failing, which is a real failure mode in this repo (00611, 2026-08-17). It cost a round here; it is written down so it does not cost the next one.

**Risk: LOW.** One new table, no data touched.

> [!note] AMENDED 2026-09-19, AFTER ITS FIRST COMMIT AND BEFORE ANY APPLY.
> `applied_writes jsonb` was added. If you have already applied 00808, apply
> it again — the file is idempotent and the second run adds only that column.
> The reason for the change: the undo belongs on the ROW, not on the run.
> `flipdesk_import_effects` reverses a whole import, and a seller who confirms
> twenty joins and regrets one wants that one back.

The edge now reads this table (`lib/cross-channel-link-service.ts`), so apply
it **before** the next edge deploy.

**What it is for.** Universal Import joins a Poshmark listing and an eBay
listing of ONE physical garment onto one item. The decision layers
(`cross-channel-link.ts`, `cross-channel-link-plan.ts`) deliberately refuse
more than they accept, and what they refuse has to go somewhere a person can
answer it. **Nothing merges without a confirmation** — a row here is a
question, not a pending action, and no job drains this table.

**Why a table rather than recomputing the list.** The queue is a screen a
seller works through over days, and the decision depends on rows that change
under them. Recomputing would reshuffle it, resurrect pairs they already
split, and lose the reasons they were shown when they decided. A resolved row
is also the only record that a human said NO; without it the next import
proposes the same merge forever.

- Deny-all RLS, **zero policies**, registered in `SERVICE_ROLE_ONLY` in
  `rls-guard_test.ts`, and it carries its own
  `REVOKE ALL ... FROM anon, authenticated` per US-3355.
- The unique index is on the **order-independent** pair
  (`least`/`greatest`), so the same pair asked the other way round collides
  instead of creating a second question. That is what makes a re-import
  idempotent at the review layer, the way `(platform, platform_listing_id)`
  already is at the import layer.
- CHECKs on `status` and on the two listings being distinct.

**Measured on a local Postgres 16 carrying all 800 migrations**, not reviewed:
applied from clean and re-applied three times with no change; the
order-independent unique index rejects the reversed pair; both CHECKs reject
their bad row; RLS is on with 0 policies; and after a simulated platform
`GRANT ALL`, the REVOKE takes `anon`/`authenticated` from **14 grants to 0**
while `service_role` keeps its 7.

```sql
-- after applying
NOTIFY pgrst, 'reload schema';
```

**No ordering hazard**: no code reads the table yet. Apply after 00807.

**EXPECTED_SCHEMA_VERSION is 00808 in the same commit**, and the manifest was
regenerated.

## ✅ APPLIED 2026-09-20 (owner, reported applied in session): 00807_scope_storage_public_read_policies.sql (US-3403 — stop a stranger enumerating the five public buckets)

**EXECUTED 2026-09-20.** Read back off `pg_policy` rather than off the file, which is what US-3403 AC asks for. All five public-read policies on `storage.objects` are scoped: avatars and item-photos to the owner folder, cert-assets, content-images and content-videos to `is_admin()`. The item-photos policy carries the uuid-shape regex BEFORE the `::uuid` cast, which is the part that matters -- the cast RAISES on a non-uuid folder name and in a SELECT policy that fails the whole list.

**Risk: LOW, and lower than it reads.** It narrows five `FOR SELECT` policies
on `storage.objects` and touches no data. **It cannot take a public image
dark**: storage-api serves `GET /object/public/<bucket>/<path>` on a SUPERUSER
connection after checking `buckets.public`, so that route consults no policy
at all. Read `vault/10-ops/storage-anon-enumeration.md` before applying.

**What it fixes.** All five were `USING (bucket_id = '<name>')` with no `TO`
clause, and a policy with no `TO` applies to every role including `anon`.
Measured against prod on 2026-09-11 with the anon key that ships in the
deployed frontend bundle: 7,057 objects listed in `item-photos` (3.5 GB), 124
in `content-images`, 44 in `cert-assets`.

| Bucket | Narrowed to |
|---|---|
| `item-photos` | the owner folder, or a workspace member of that owner |
| `avatars` | the owner folder |
| `cert-assets` | `public.is_admin()` |
| `content-images` | `public.is_admin()` |
| `content-videos` | `public.is_admin()` |

**It does NOT assume held 00794 has run.** `DROP POLICY IF EXISTS` then
`CREATE` for all five, correct whether or not 00794 ever lands. A file that
only narrowed the four smaller buckets would have tidied two EMPTY ones while
leaving the 3.5 GB one open to anon.

**Nothing in the app loses a capability**, checked rather than assumed. The
only `.list()` in the tree is `account-storage-purge.ts` on the service-role
client, which bypasses RLS; every client-side `createSignedUrl` targets
`submission-images`. `src/test/storage-public-read-scope.test.ts` pins both
and fails if a browser caller appears.

**Measured on Postgres 16 carrying all 799 migrations**, RLS on, one
transaction per role with `set local role` and `request.jwt.claims` — which is
what `POST /object/list` does. `anon` saw all 8 seeded objects before and
**0** after; a signed-up stranger dropped from 8 to 2, both in their own
folders; an admin sees only the three published-content objects. Re-applied
three times with no change.

**READ THE RESULT BACK OFF `pg_policies`, never off this file:**

```sql
-- Anything here applies to anon. FIVE rows are expected, not zero: they are
-- all submission-images and all gated on auth.uid(), so anon matches nothing.
select policyname, cmd, roles
from pg_policies
where schemaname = 'storage' and roles::text like '%public%';

-- And the five that changed should now be {authenticated} with a real USING.
select policyname, roles, qual
from pg_policies
where schemaname = 'storage' and policyname like '%public read';
```

```sql
-- after applying
NOTIFY pgrst, 'reload schema';
```

**No ordering hazard**: no code reads a new column and no route changes. Apply
after 00806, which is the next number down.

**EXPECTED_SCHEMA_VERSION is 00807 in the same commit**, and the manifest was
regenerated.

## ✅ APPLIED 2026-09-20 (owner, reported applied in session): 00806_repair_whole_dollar_listing_prices.sql (US-3318 — Poshmark and Vinted rows priced in cents)

**EXECUTED 2026-09-20, AND THIS IS THE ONE HELD FILE THAT REWRITES SELLER DATA.** `node scripts/check-whole-dollar-price-repair.mjs --dsn "postgresql://..."` seeds the six worked examples from this file's own header plus three rows that must not move, applies the real migration, and rolls back. All nine land where the header says: 32.49 to 32.00, 32.50 to 33.00, 31.50 to 32.00 with its `price_override` stepped alongside, 0.40 and 0.01 to the 1.00 floor, 25.00 untouched, and eBay, Depop and a zero price untouched. `listing_price` and `platform_fields` agree on every row, and another key in the channel blob survives the merge. **Idempotency measured rather than argued: the same file twice in one transaction reports 4 rows then 0.**

**Risk: MEDIUM. This one rewrites seller money.** It is the only entry here
that UPDATEs existing rows rather than adding structure, so read the count
before and after rather than trusting the run.

**Run the diagnostic FIRST.** It is a read, it writes nothing, and it prints
the per-platform counts the story asks for, including how many rows sit below
the marketplace floor rather than merely carrying cents:

```
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
  node scripts/diagnose-whole-dollar-price-drift.mjs
```

**What it repairs.** Poshmark and Vinted price in WHOLE DOLLARS. Until US-2736
and US-2739, every non-eBay channel was priced from the shared eBay number
with no rounding, so a sibling row recorded 32.49 for a listing the
marketplace can only hold at 32, and a 40-cent item was recorded at 0.40
against a floor of 1.00. Those two stories fixed what the extension TYPES and
what a new push RECORDS; neither repairs a row already written, and the row is
what profit, payout reconciliation and the revise price all read.

- `listings.listing_price` and `listings.platform_fields[platform].price` (and
  `price_override` where one exists) move TOGETHER, in one statement set. A row
  whose two copies disagree is worse than one that is merely wrong.
- Rounded to NEAREST, never below one step. This is `stepPriceCents` from
  `src/lib/marketplace-price.ts` expressed in SQL, and
  `src/test/whole-dollar-price-repair.test.ts` pins the two together.
- ONLY poshmark and vinted, the two platforms declaring `priceStep` in
  `src/lib/marketplace-specs.ts`. The same test fails if that set changes and
  this migration does not.
- A price of zero or below is left alone: that is "no price set", not a
  rounding error.

**It reports what it did.** `RAISE NOTICE '[00806] whole-dollar repair: N
listing_price row(s), N platform_fields row(s)'`. Read that line and put it on
the story; a silent success and a no-op look identical in a psql transcript,
and not knowing the count is why this story exists.

**Idempotent, measured rather than asserted:** applied to a local Postgres 16
carrying all 798 migrations, against a fixture holding every shape the story
names. First run reported 4 and 4; the second and third reported 0 and 0.

**No ordering hazard.** It changes no schema and no code reads a new column,
so it can be applied before or after the edge deploy. It should still go after
00805, which is the next number down.

```sql
-- after applying
NOTIFY pgrst, 'reload schema';
```

**EXPECTED_SCHEMA_VERSION is 00806 in the same commit**, and the manifest was
regenerated.

## ✅ APPLIED 2026-09-20 (owner, reported applied in session): 00805_phone_capture_groups.sql (US-3185 — several items on one capture code)

**EXECUTED 2026-09-20 against a local Postgres carrying all 808 migrations from zero.** `group_index` exists on BOTH `phone_capture_sessions` and `phone_capture_photos`, the `target_kind` CHECK reads `ANY (ARRAY['item','batch','staging'])`, and `idx_phone_capture_photos_session_group` is present. Nothing here was read off the file.

**Risk: LOW.** Two `ADD COLUMN ... IF NOT EXISTS` with a `DEFAULT 0` on two
tables that are minutes old at any moment (a capture session lives fifteen
minutes and nothing reads a finished one), one widened CHECK, one new index.
No data is rewritten and no existing row changes meaning: every row already in
those tables was written by a one-item code, and 0 is the index a one-item code
would have stamped.

**What it does.**

- `phone_capture_sessions.group_index` — the item the phone is shooting now.
  Moved only by `POST /api/flipdesk/capture/s/:token/next-item`.
- `phone_capture_photos.group_index` — the item a shot was taken on, copied
  from the session at insert. The phone never sends an index, so there is
  nothing for a tampered page to scatter.
- `phone_capture_sessions_target_kind_check` widens to accept `staging`.
  AutoLister photo intake has no `listing_generation_batches` row to bind to —
  that row is created when generation STARTS, which is after the photos exist
  and have been grouped into items — so a capture started from the intake page
  binds to the seller's own AutoLister session id.
- `idx_phone_capture_photos_session_group` — the desktop reads a session's
  photos in item order, then in shooting order inside an item.

**APPLY ORDER: SQL FIRST, then the edge, then the frontend.** The edge selects
`group_index` in `SESSION_COLUMNS` and inserts it on every capture photo, so an
edge deploy that lands before this SQL answers PostgREST 42703 on the whole
query and every phone upload fails. The frontend reads the new fields off the
edge's responses and degrades to "one item" without them, so it is the safe
one to be early.

```sql
-- after applying
NOTIFY pgrst, 'reload schema';
```

**Idempotent, and it has to be:** both `ADD COLUMN`s are `IF NOT EXISTS`, the
CHECK is dropped before it is recreated (an existing CHECK cannot be widened in
place), and the index is `IF NOT EXISTS`. Running it twice changes nothing.

**EXPECTED_SCHEMA_VERSION is 00805 in the same commit**, and the manifest was
regenerated (`node scripts/gen-migration-manifest.mjs`).

## ✅ APPLIED 2026-09-15 (owner, confirmed from prod): 00804 - preview, seed and save for SKU numbering (US-3416)

**Confirmed, credential-free:** `curl -s https://functions.gradethread.com/health/ready`
answered `{"expected":"00801","applied":"00804","status":"ahead","unexpected":["00802","00803","00804"]}`.
`applied` is the DB's own watermark. `ahead` and the `unexpected` list are the
deployed edge build still expecting 00801 while the DB has moved to 00804; that
is warn-only in `schema-version.ts` and clears on the next edge deploy.

**The ordering note below is therefore satisfied:** the SQL is in place ahead of
the frontend that calls it, so US-3417 can push without answering 404s.

**What it does.** Adds six functions and no tables: `flipdesk_sku_may_read`,
`flipdesk_sku_may_write`, `flipdesk_sku_validate`, `flipdesk_sku_preview`,
`flipdesk_sku_seed` and `flipdesk_sku_save`. They are the settings screen's only
way to touch `flipdesk_sku_sequences`, which 00802 deliberately gave a SELECT
policy and no write policy at all.

**Risk: low.** Every object is new, `CREATE OR REPLACE`, and nothing calls any
of them yet. `flipdesk_sku_save` is the sole writer; `preview` and `seed` are
`STABLE` and write nothing. The seed reads `inventory_items` and returns a
number -- **it never renumbers an existing row**, which is the property the
whole feature rests on.

**Apply order.** After 00803.

**The one ordering direction that matters.** The settings screen in US-3417
calls all three RPCs and Cloudflare Pages auto-deploys the moment the frontend
is pushed. Push that before this SQL applies and the screen answers PostgREST
404s on every call. Nothing else breaks and no data is at risk, but it is
visible: **apply this before pushing US-3417.** Nothing in the repo calls them
today, so applying it early is free.

**After applying:** `NOTIFY pgrst, 'reload schema';` -- PostgREST caches its
function list and will not expose a new RPC until it reloads. `npm run
migrate:prod` sends this for you.

**Verified locally on 2026-09-15** against the full migration schema, fourteen
cases in `scripts/fixtures/sku-rpcs.sql` including a 1031-item seed, and
sabotage-proved twice: the check went red when `flipdesk_sku_seed` returned the
highest match instead of the next value, and again when `flipdesk_sku_preview`
dropped its tenant check and let a stranger read another workspace.

## ✅ APPLIED 2026-09-14 (owner, confirmed from prod): 00803 - the trigger that fills a blank SKU (US-3415)

**What it does.** Adds `public.flipdesk_assign_sku()` and the `BEFORE INSERT`
trigger `assign_sku_on_insert` on `public.inventory_items`. When an item is
saved with a blank SKU and its tenant has numbering switched on, the trigger
fills it from `flipdesk_sku_sequences`. It creates no table and alters no
column.

**Why a trigger.** Inventory items are created from thirteen call sites across
the web app, the edge service, iOS and Android. A helper would need thirteen
edits plus a Swift and a Kotlin port, and the one call site somebody forgets
fails silently. This is the only place all of them already pass through.

**It is inert until a tenant opts in.** `flipdesk_sku_sequences.enabled`
defaults to false and 00802 creates no rows, so at the moment of applying this,
zero accounts have a sequence row and the trigger returns `NEW` untouched on
every insert in the system. It also returns `NEW` untouched whenever the caller
supplied a SKU, under any setting.

**It cannot fail an insert.** On an exhausted sequence, or after 1000 taken
candidates, it flags the row and leaves `sku` NULL rather than raising. That was
a deliberate call: an unsaved item is worse than an unnumbered one.

**Apply order.** After 00802.

**Verified locally on 2026-09-14** against the full migration schema, ten cases
in `scripts/fixtures/sku-assignment.sql`, and sabotage-proved three ways:
keying the lookup on `auth.uid()` instead of `NEW.user_id`, dropping the trigger
outright, and omitting the counter write-back. Each produced a distinct, correct
diagnosis.

## ✅ APPLIED 2026-09-14 (owner, confirmed from prod): 00802 - per-tenant SKU numbering, the odometer only (US-3414)

**What it does.** Adds one table, `public.flipdesk_sku_sequences` (one row per
tenant, holding a SKU pattern and where its counters are sitting), and seven
IMMUTABLE plpgsql functions that render, advance and parse that pattern. Nothing
else. It wires nothing to `inventory_items` and changes no existing object.

**Risk: as low as a migration gets.** Every object it creates is new. It alters
no table, drops nothing, backfills nothing, and contains no `REVOKE`. The table
defaults `enabled` to false and no row is created until a tenant saves settings,
so applying this changes the behavior of exactly zero accounts.

**Apply order.** Anywhere after 00801. 00803 and 00804 below depend on it.

**No frontend ordering trap in EITHER direction.** Nothing in `src/` or
`services/edge-functions/src/` reads this table or calls these functions yet.
The first reader is 00804's RPC set, consumed by the settings screen in US-3417,
which is a later push. Apply before or after the push, it makes no difference.

**After applying:** `NOTIFY pgrst, 'reload schema';` so PostgREST picks up the
new table and functions. `npm run migrate:prod` sends this for you.

**Verified locally on 2026-09-14** against the full migration schema, and
sabotage-proved twice: `scripts/check-sku-sequences.mjs` went red when
`flipdesk_sku_advance` was made to wrap instead of report exhaustion, and again
when `flipdesk_sku_render` folded its unpadded-number case into `lpad` (which
returns the empty string at width 0). Both were restored and the check is green.

## ✅ APPLIED 2026-09-14 (confirmed from prod, not watched): 00801 - payout becomes a grouping key on sale_pnl (US-3413)

**The heading was stale and the gate was blocked on it**, which is the same
defect the section at the top of this file is about. `held-migration-gate.mjs`
reported 00801 under "ALREADY ON origin/main — the rule was broken earlier" and
refused every push, mine included.

**Evidence, read credential-free on 2026-09-14 and repeatable by anyone:**

```bash
curl -s https://functions.gradethread.com/health/ready   # .schema
```

answered `{"expected":"00801","applied":"00803","status":"ahead","unexpected":["00802","00803"]}`.
`applied` is the DB's own watermark, and 00803 is past 00801, so prod has it.
The `ahead` status and the `unexpected` pair are the deployed edge build still
expecting 00801 while the DB has moved to 00803; that is warn-only in
`schema-version.ts` and clears on the next edge deploy.

**This flip says only that prod HAS 00801.** It does not say anyone watched it
apply, and it does not speak to the follow-up work below.

**What it does.** Replaces the `public.sale_pnl` view with the same body plus
two columns, `payout_id` (from `sales.payout_reference`) and `payout_date` (from
`ebay_payouts`), and adds `idx_sales_user_payout_reference`. Nothing about the
money changes: the revenue/fees/costs/net terms are copied from 00706 verbatim.

**Risk: low, and measured rather than argued.** `sale_pnl` is read by the
Analytics team scorecard, the ship queue and now the payout breakdown. The one
real hazard in adding a LEFT JOIN to a view is row multiplication, so the new
body was run beside the live view on prod, read-only, on 2026-09-14:

```
 live_rows | new_rows | live_net | new_net | with_payout_id | with_payout_date
       221 |      221 |  7179.53 | 7179.53 |             82 |               12
```

Identical row count, identical total net to the cent. `ebay_payouts` carries
`UNIQUE (user_id, payout_id)` so the join is at most 1:1 by construction, and
this is the evidence. 82 rows pick up a payout id; only 12 pick up a date,
because we hold headers for two of the five payouts sales reference. That gap is
what the new `ebay-payout-link` cron closes over the following nights.

**Apply order.** Anywhere. It depends only on `sale_pnl` (00706) and
`ebay_payouts` (00327), both long applied, and it is independent of the six
gap-fills 00793-00799 still parked on branches below it.

**⚠ THE FRONTEND READS THE NEW COLUMNS, so the order matters in ONE direction.**
`src/lib/payout-breakdown.ts` selects `payout_id, payout_date` from `sale_pnl`
and Cloudflare Pages auto-deploys the moment this is pushed. Push before the SQL
applies and expanding a payout on the Reconciliation page answers a PostgREST
42703 and the panel shows its error state. Nothing else on the page breaks and
no data is at risk, but it is a visible break: **apply first, then push.**

The edge side has no such ordering trap. The new `/api/jobs/ebay-payout-link`
cron writes only `sales.payout_reference`, a column that has existed since
00008, so it is safe against the current schema and needs the edge redeploy only
to exist at all.

**After applying:** `NOTIFY pgrst, 'reload schema';` - a view whose column list
changed is exactly the case PostgREST caches. `npm run migrate:prod` sends this
for you.

**Then, once the edge is redeployed**, add the Coolify cron task for
`ebay-payout-link` (POST `/api/jobs/ebay-payout-link`, `30 5 * * *`, with
`X-Internal-Job-Secret`). Without the task the pass never runs and payout
coverage stays where it is: 84 of 228 sales linked, September 0 of 12. The first
run will do the backfill; it reads a 90-day window and fills only rows whose
reference is null.

## ✅ APPLIED 2026-09-18 (owner): 00793 - retire the 23 size-chart rows a rename orphaned (US-3387)

**NOT READ BACK FROM HERE.** The owner reported both this and 00797 applied on
2026-09-18 and cleared the push. This container has no route to prod - the
read-only `npm run migrate:prod` is refused here - so the source of this heading
is the owner's word, which is what `(owner)` means throughout this file, as
against `(confirmed from prod)`. The readback below is still worth running.

**The readback, unrun. CORRECTED 2026-09-19 -- the numbers below were wrong
both before and after, and an operator running the old version would have read
the fix as a failure.** Duluth Trading has THREE seeded tuples, all in
department `Men`: a work-pants chart, a tops chart, and the alpha-tops rename
00793 retires. So the count was 3 before the apply and is 2 after, not 2 and 1.
The question this readback means to ask is whether ONE tops chart remains, so
it lists the rows rather than counting them. Executed against a local Postgres
carrying all 808 migrations on 2026-09-19: 2 rows, exactly as below.

```sql
select department, garment from public.brand_size_charts
 where brand_key = 'duluthtradingco'
 order by garment;
-- expect exactly these two rows, both Men:
--   Tops & outerwear (body inches)
--   Work pants (WAIST x INSEAM, inches)
-- and in particular ONE row whose garment starts with 'Tops'.
```

**REBUILT, NOT MERGED.** `held-v2/us-3387-00793` is not on origin and neither is
any other held branch (US-3421, and `node scripts/check-held-branches.mjs` is
the guard). Everything needed to rebuild it was already in the repo:
`HELD_BY_00793` in `services/edge-functions/src/tests/sizing-chart-orphans_test.ts`
names all 23 rows, and the exact-case values were reconstructed by replaying
every insert and delete in `supabase/migrations/` the way that guard does.

**What it does.** Deletes 23 rows from `public.brand_size_charts`. No schema
change, no new object.

**Why they are there.** The conflict key on every chart migration is
`(brand_key, department, garment)`, so RENAMING a garment scope inserts a second
row instead of updating the first, and both survive. The resolver reads every
row for a brand, narrows by category only, and keeps the first three -- so the
stale row and its replacement land in the same prompt, and on a brand with
several charts the stale one pushes a sourced chart out entirely. Measured:
in 58 brand/category probes an orphan sits inside the 3-chart budget while a
sourced chart is cut from it.

**00782 did this for 14 rows and was believed exhaustive. It was not.** Its list
came from diffing the original 00498 against the regenerated one, which can only
surface rows 00498 itself seeded. Duluth Trading's fourth tops chart came from
00776 and was invisible to that method.

**Risk: low, and bounded by a guard.** Every row deleted has a surviving
same-brand, same-department sibling -- that is what makes it a rename rather
than a retirement. The 26 orphans that do NOT have one are deliberately left:
15 hand-written charts with no rival at all, 11 whose only rival is in another
department, each registered with its reason in that test file. Deleting those
would remove a body's only chart.

**Apply order.** Anywhere. It depends on nothing above it, and it is independent
of 00797.

**After applying:** `NOTIFY pgrst, 'reload schema';` is not needed -- no column
or function changed. The readback is the corrected one above: list the rows and
expect two, with exactly one tops chart among them.

**What is NOT verified.** The model is reconstructed from the migration files,
not read from prod. Before 00793 it holds 464 rows and all 23 targets; after,
441 and none of them. Prod's own 00498 is the 2026-07-29 version rather than the
current one, and the difference is exactly the 14 tuples 00782 deletes, so the
two agree today -- if 00498 is regenerated again without a matching retirement
they will not. The SQL was parsed with libpg_query and never executed: this
container has no Docker and no route to prod.

## ✅ APPLIED 2026-09-18 (owner): 00797 - the seeded cogs_labor row says Labour (US-3256)

**NOT READ BACK FROM HERE**, same as 00793 above: the owner reported it applied
on 2026-09-18 and cleared the push, and `npm run migrate:prod` is refused in
this container even read-only. `(owner)` rather than `(confirmed from prod)`.

**THE BRANCH IS UNFROZEN.** `claude/wizardly-gauss-8osusm` was unmergeable until
these two landed. It carries US-3408, US-3420, US-3413's closure, US-2855 AC2,
US-3422, US-3423 and US-3210 AC4.

**The override history below is kept rather than deleted.** It is the record of
what this entry cost while it was held, and deleting it once the entry goes
green is how the count goes back to being unreadable.

**⚠ THE HELD-MIGRATION GATE BLOCKED THE PUSH AND WAS OVERRIDDEN ON PURPOSE.**
`node scripts/held-migration-gate.mjs` exits 1 in BOTH modes on this entry,
which is the gate doing its job. It was overridden for one reason and it is
recorded here rather than only in a chat message, because six earlier bypasses
of this control were each discovered later from the file: the container this was
written in is ephemeral, so not pushing means the work is lost rather than held.
The rule the gate protects is intact - **origin/main does not have this file**,
and nothing deploys from a feature branch. The moment this branch merges, that
stops being true.

**EVERY OVERRIDE SINCE, listed rather than merged into the paragraph above, so
the count is readable.** Each push below ran the rest of `.githooks/pre-push` by
hand first - the merge-resolution check, `npm run verify`, and the Android lane
where it applied - and skipped only this gate.

| Date | Commits pushed | Carried a migration? |
|---|---|---|
| 2026-09-18 | the 00793 and 00797 rebuilds themselves | yes, these two |
| 2026-09-18 | US-2855 AC2, US-3422, US-3423, US-3210 AC4 | no |

**AND THE GATE'S MESSAGE FOR THIS ENTRY WAS WRONG UNTIL US-3423.** It resolved
its upstream as `origin/main` and nothing else, so on this branch it reported
00793 and 00797 under "this push would send a migration that
PENDING_MIGRATIONS.md still marks HELD" - the heading for a leak that has not
happened - when both had been on `origin/claude/wizardly-gauss-8osusm` for
hours. It now checks the branch's tracking ref as well and says ALREADY ON
ORIGIN, naming the ref per file. The verdict never changed; only the sentence
did. Read the 2026-09-18 rows above as the honest record of what this entry has
cost, not the gate's older wording.

**~~THIS BRANCH CANNOT BE MERGED UNTIL YOU APPLY THIS FILE.~~ Cleared
2026-09-18.** The migration is on `claude/wizardly-gauss-8osusm` and is applied. That is the owner's call, made 2026-09-18 when the
alternative (a separate held branch) was offered. It means three finished
stories are waiting on one UPDATE, so this is the cheapest pending entry in the
file to clear.

**Why it exists at all.** The `held-v3/us-3256-00797` branch the table below
names **does not exist on origin** - no `held-*` branch does, across all 212
remote heads. Every held branch in this document lives on one machine. This
file is rebuilt from the recorded design rather than merged from that branch.

**What it does.** One row. Upserts `ledger_accounts` where `code = 'cogs_labor'`
so `name` reads `Labor that went into the goods` instead of `Labour ...`.
Schedule C Part III line 37 is titled "Cost of labor", so the US spelling is the
form the row is naming.

**Risk: very low.** One system row, no schema change, no new object. Keyed on
`ledger_accounts_system_code_idx`, the partial unique index over `(code) WHERE
user_id IS NULL`, so a seller's own sub-account sharing the code is untouched.
Re-running writes the value the row already holds.

**It is an upsert and not the one-line UPDATE the story's AC names, on purpose.**
`src/lib/chart-of-accounts.test.ts` reads the seeded chart by parsing the seed
blocks out of the migrations, later files winning. A bare UPDATE is invisible to
that parse, so it would have corrected production and left the guard red
forever.

**EXPECTED_SCHEMA_VERSION is NOT bumped, and must not be.** 00797 fills a gap
under the watermark; the highest file is still 00804 and the constant stays
there. Only the manifest changes (+1 line).

**Apply order.** Anywhere. It depends on 00684 only, which prod has had since
long before the current watermark. It is independent of the other five held
numbers and does not need to wait for them.

**After applying:** `NOTIFY pgrst, 'reload schema';` is not strictly needed - no
column or function changed - but send it anyway if you are already in there.
Then read the row back, because this guard has never checked production:

```sql
select code, name from public.ledger_accounts
 where code = 'cogs_labor' and user_id is null;
-- expect: cogs_labor | Labor that went into the goods
```

**What is NOT verified, said plainly.** The guard compares the TypeScript chart
to the migration FILES and has never read prod. The readback above is the only
thing that answers whether prod's row actually moved. This was written in a
container with no Docker and no prod reach, so the SQL was parsed with
libpg_query (Postgres's own grammar) and never executed against any database.

## WHAT IS STILL WAITING FOR YOU ON A BRANCH (rewritten 2026-09-23)

Four migrations are finished and parked on side branches. None is in this
tree, so none is in `supabase/held-migrations.json`'s `held` list; they are in
its `parked` list, which `scripts/check-held-branches.mjs` reads. Merge them in
this order, each after its SQL is applied.

| Order | Branch | Migration | What it does |
|---|---|---|---|
| 1 | `held-v2/us-3397-00794` | 00794 | stop anon enumerating the storage buckets |
| 2 | `held-v2/us-3398-00795` | 00795 | the deletion log stops claiming a purge it never checked |
| 3 | `held-v2/us-3410-00798` | 00798 | COMMENTs recording five objects prod has and no migration builds |
| 4 | `held-v2/us-3312-00799` | 00799 | two brand_knowledge notes that are false in prod |

**Branch status, measured 2026-09-23:** `node scripts/check-held-branches.mjs`
reports all four ABSENT from origin (they are the `KNOWN_ABSENT` baseline in
that script, US-3421). They exist on one machine only. If that machine's copy
is gone, each one has to be rebuilt from its story, the way 00793 and 00797
were on 2026-09-18.

**All four fill gaps under the watermark** (main is at 00830), so none of them
bumps `EXPECTED_SCHEMA_VERSION`; each changes only the migration manifest.
`scripts/migrations-lint.mjs` carries a `KNOWN_GAPS` entry for each, and each
branch deletes its own entry when it lands. Merge 00798 and 00799 in order or
`migrations-lint` fails.

Branches this section used to list, kept here so nothing is unrecoverable:
`held-v2/us-3387-00793` and `held-v3/us-3256-00797` were rebuilt into the tree
and applied on 2026-09-18. `held/us-3324-00792` (2cc340797) and
`held/us-3359-00791` (e4614bb99) were deleted because a parallel session shipped
the same change. `held/us-3399-chart-order` (d3ec2de55) carries NO migration; it
changes what the grading model is shown and waits on a runEval, not on a merge.
The full 2026-09-11 version of this section, with the reasoning, is in
`PENDING_MIGRATIONS.archive.md`.

## ✅ APPLIED 2026-09-13 (confirmed from prod, not watched): 00796 — the deletion log stops saying the Stripe customer survived (US-3404)

**Risk: LOW.** Two columns on `public.account_deletion_log`
(`stripe_delete_status text NOT NULL DEFAULT 'unverified'`,
`stripe_delete_error text`), one CHECK, one index, and three column comments.
Nothing existing is altered or backfilled; the table holds one row per erased
account, so the constraint validation scan is trivial.

**Numbering:** 00793-00795 are claimed by held migrations on other branches
(00795 is US-3398's, the story this one came out of), so this jumps to 00796
rather than risk two files with the same number.

**Apply order: after 00792** and after 00793-00795 if those land first. Nothing
here depends on any of them. Then `NOTIFY pgrst, 'reload schema';` and redeploy
the edge (boot guard expects 00796).

**⚠ The edge WRITES the new columns** in the same change: `routes/account.ts`
and `routes/admin-compliance.ts` spread the result of
`deleteStripeCustomerForRecord` into the `account_deletion_log` insert. If the
edge deploys first, every account deletion fails its compliance-log insert with
`column "stripe_delete_status" does not exist`. Both call sites treat a failed
log insert as non-fatal and keep erasing, so the user is still erased and the
PROOF is what goes missing, which is the worse half to lose. The boot guard
should stop that ordering; do not override it here. No frontend reads these
columns (nothing in the web app reads this table at all).

**What it means for the record:** `stripe_deleted` now means "a
`customers.del` call returned without throwing". `stripe_delete_status` carries
`deleted` / `failed` / `not_attempted` / `no_customer` / `unverified`, and
**every row that exists today defaults to `unverified` on purpose.** Read the
column comment before citing an old row: admin-source rows written on or after
2026-08-16 say `stripe_deleted = false` for deletions that really happened.

**Check it landed:**

```sql
select count(*) from information_schema.columns
 where table_name = 'account_deletion_log'
   and column_name in ('stripe_delete_status','stripe_delete_error');  -- 2

select stripe_delete_status, count(*) from public.account_deletion_log
 group by 1;  -- all 'unverified' until the next deletion runs
```

## ✅ APPLIED 2026-09-13 (confirmed from prod, not watched): 00792 — the seller's marketplace usernames (US-3369)

**Risk: LOW.** One nullable column, `flipdesk_settings.marketplace_handles
jsonb`, plus a comment. Nothing existing is altered, no backfill.

**Apply order: after 00791.** RENUMBERED from 00790 on 2026-09-11: a parallel session shipped a different 00790 and prod applied that one. Then `NOTIFY pgrst, 'reload schema';` and
redeploy the edge (boot guard expects 00792).

**⚠ The web READS AND WRITES this column from the client** (the Poshmark
username prompt on the item page, `useMarketplaceHandles`). A frontend that
deploys before the SQL shows a failed read there: the "Your Poshmark
listings" link does not appear and saving a username errors. Everything else
in the delist change works without it. The edge reads it through
`loadSellerHandles`, which treats a failed read as "no usernames".

## ✅ APPLIED 2026-09-13 (confirmed from prod, not watched): 00791 — drop the bare 'duluth' brand token (US-3319 follow-up)

**Risk: LOW.** One `UPDATE` on `brand_size_charts`: removes `'duluth'` from
`brand_match` on the `duluthtradingco` rows that still carry it. No schema
change, no view, nothing the client reads. Idempotent by construction
(`array_remove` plus a `WHERE` on the token). The same edit is in
`sizing-charts.ts` and the regenerated `00498`, so the in-code fallback and the
DB agree.

**Apply order: after 00790.** No `NOTIFY` needed (data only). Redeploy the
edge (boot guard expects 00791).

**Check it landed.** ⚠ CORRECTED 2026-09-20 (US-3324): the first query in this
block used to check `flipdesk_settings.marketplace_handles`, which belongs to
00792 above and has nothing to do with this migration. It was a copy-paste leak,
and an operator running it would have read a `1` as evidence 00791 landed.

```sql
select brand_key, garment, brand_match from public.brand_size_charts
 where brand_key = 'duluthtradingco';
-- expect 2 rows, both Men, both with brand_match = {"duluth trading",duluthtrading}:
--   Tops & outerwear (body inches)
--   Work pants (WAIST x INSEAM, inches)

select count(*) from public.brand_size_charts
 where 'duluth' = any(brand_match);  -- expect 0, across the whole table
```

**The same two queries were EXECUTED on 2026-09-20** against a local Postgres
carrying all 808 migrations from zero, and returned exactly the rows above and
a count of 0 over 441 charts. That proves the migration corpus produces the
right answer; it does not prove prod, which is what the readback is for.

## ✅ APPLIED 2026-09-13 (confirmed from prod, not watched): 00790 — the second-opinion switch (US-2279 / US-3359)

**Risk: LOW.** One `INSERT ... ON CONFLICT (key) DO NOTHING` into
`system_settings` for `grading_second_opinion`, seeded DISABLED and matching
`DEFAULT_SECOND_OPINION_CONFIG` field for field (`second-opinion_test.ts` pins
it). Nothing runs until an operator flips `enabled` from the admin settings
page, which until now 404'd on this key because the row never existed.

**Apply order: after 00789.** No `NOTIFY` needed (a row, not a column).
Redeploy the edge (boot guard expects 00790 or later).

**Check it landed:**

```sql
select value->>'enabled', value->>'model' from public.system_settings
 where key = 'grading_second_opinion';  -- false, claude-opus-4-8
```

## ✅ APPLIED 2026-09-13 (confirmed from prod, not watched): 00789 — the admin reference gallery (US-3334)

**Risk: LOW.** One new deny-all table, `grading_reference_photos` (RLS on,
no policies), a partial unique index, a category index and the
`set_updated_at` trigger. Nothing existing is altered. Applied cleanly inside
a rolled-back transaction on the local stack, 2026-09-11.

**Apply order: after 00788.** Then `NOTIFY pgrst, 'reload schema';` and
redeploy the edge (boot guard expects 00789).

**⚠ The new admin routes read and write the table**, so the new edge must not
run before the SQL; the boot guard enforces that. The web card only calls
those routes, so an early frontend deploy shows a card that fails to load
until the edge lands. Nothing a customer sees changes.

**Check it landed:**

```sql
select relrowsecurity from pg_class where relname = 'grading_reference_photos';  -- t
select count(*) from pg_policies where tablename = 'grading_reference_photos';   -- 0
```

## ✅ APPLIED 2026-09-13 (confirmed from prod, not watched): 00788 — the flaw that keeps a grade from the next level (US-3330)

**Risk: MEDIUM, because it recreates `public_grade_reports` again.** Adds
`grade_reports.limiting_flaw jsonb`, then `CREATE OR REPLACE VIEW` generated
from 00787's statement verbatim plus one appended column that rebuilds
`limiting_flaw` from its three string keys only. Applied with 00787 inside a
rolled-back transaction on the local stack, 2026-09-11.

**Apply order: after 00787.** Then `NOTIFY pgrst, 'reload schema';` and
redeploy the edge (boot guard expects 00788).

**⚠ Edge code in the same change writes the column on new grades and clears it
on every adjustment**, so the new edge must not run before the SQL. The boot
guard enforces that. The web reads the view column as optional.

**Check it landed:**

```sql
select count(*) from information_schema.columns
where table_name = 'public_grade_reports' and column_name = 'limiting_flaw';  -- 1
```

## ✅ APPLIED 2026-09-13 (confirmed from prod, not watched): 00787 — seller smoke-free / pet-free statement, and "not visible in these photos" (US-3329)

**Risk: MEDIUM, because it recreates `public_grade_reports`.** Adds
`submissions.seller_statements text[] NOT NULL DEFAULT '{}'` with a CHECK
limiting it to `smoke_free` / `pet_free`, then `CREATE OR REPLACE VIEW` with
every 00571 column unchanged and in order, plus two APPENDED columns:
`seller_statements` and `cleanliness_visible`. Applied cleanly (with 00784 to
00786) inside a rolled-back transaction on the local stack, 2026-09-11.

**Apply order: after 00786.** Then `NOTIFY pgrst, 'reload schema';` and
redeploy the edge (boot guard expects 00787).

**⚠ Edge code in the same change WRITES `seller_statements` on every submit**
and reads it on the certificate endpoint, so the new edge must not run before
the SQL; the boot guard enforces that. The web reads both view columns as
optional, so an early frontend deploy renders exactly what it does today.

**Check it landed:**

```sql
select column_name from information_schema.columns
where table_name = 'public_grade_reports'
  and column_name in ('seller_statements', 'cleanliness_visible');  -- 2 rows
```

## ✅ APPLIED 2026-09-13 (confirmed from prod, not watched): 00786 — grades wait for the turnaround the customer paid for (US-3326)

**Risk: MEDIUM, because it rewrites two RLS policies.** Adds three nullable
columns to `grade_reports`, widens the `review_status` CHECK with `'held'`,
adds a partial index, recreates the owner and workspace SELECT policies with
one extra predicate `(release_at IS NULL OR release_at <= now())`, and seeds
`system_settings.grade_release_hold = {"enabled": false}`. Every existing row
has `release_at` NULL, so the rewritten policies return exactly what they
returned before; nothing changes until the setting is turned on.

**Apply order: after 00785.** Then `NOTIFY pgrst, 'reload schema';`, then
redeploy the edge (boot guard expects 00786).

**⚠ Edge code in the same change reads the new columns.** The report insert
writes `release_at` only when the hold is on, and `finalizeGradeReview` selects
`release_at` on every finalize, so the new edge must not run before the SQL.
The boot guard enforces that.

**Operator steps after applying:**
1. Add the Coolify scheduled task for `/api/jobs/grade-release`, every 5
   minutes (block in `services/edge-functions/CRON_SETUP.md`). Without it held
   grades never release.
2. Turn the hold on only when ready:
   `update system_settings set value = '{"enabled": true}' where key = 'grade_release_hold';`
   Turning it off later releases every held grade on the next job run.

**Check it landed:**

```sql
select column_name from information_schema.columns
where table_name = 'grade_reports'
  and column_name in ('release_at', 'held_modified', 'release_notified_at');  -- 3 rows
select pg_get_constraintdef(oid) from pg_constraint
where conname = 'grade_reports_review_status_check';                      -- includes 'held'
```

## ✅ APPLIED 2026-09-10 (owner): 00785 — the flaws-only grade gets its own deny-all table (US-3325)

**Owner reported "785 applied" on 2026-09-10.** ⚠ The file was rewritten a few
minutes after it was first written: the first draft added `flaws_only_overall`
and `flaws_only_factors` COLUMNS to `grade_reports`; the final file creates
the TABLE `grade_flaws_only` instead. Confirm prod got the final one:

```sql
select to_regclass('public.grade_flaws_only') as new_table,
       exists (select 1 from information_schema.columns
               where table_name = 'grade_reports'
                 and column_name = 'flaws_only_overall') as old_columns;
-- expect: new_table = grade_flaws_only, old_columns = false
```

If `new_table` is NULL, the draft was applied and `apply-prod-migrations.sh`
will now skip the real file (it skips by maximum). Run
`supabase/migrations/00785_grade_flaws_only.sql` by hand; it is idempotent.

**Risk: LOW.** One new table, RLS on with no policies (service role only).
Nothing on existing tables changes.

**Why a table and not columns:** the owner of a grade can read their own
`grade_reports` row. Beside the published factor routing, a per-factor
flaws-only ceiling reveals the unpublished per-defect penalty.

**Edge code in the same change** inserts into `grade_flaws_only` after every
grade, best-effort (a failed insert is logged, the grade is unaffected), and
the admin accuracy report reads it. `NOTIFY pgrst, 'reload schema';` after
applying.

## ✅ APPLIED 2026-09-10: 00784 — keep the AI's own scores on every human review (US-3323)

**APPLIED, and again NOT the way the rule says it should have happened.** This
was authored as HELD on 2026-09-10 and was meant to wait for the owner's OK.
It reached origin/main and production anyway, pushed by the background
automation loop that also runs against this working tree. That is the SECOND
migration in one day to take that route, after 00783. Evidence it is live: the
edge's own `GET /health/ready` reports
`schema {expected: 00784, applied: 00784, status: match}` and the service is
`ready`.

**The near-miss is worth recording.** `EXPECTED_SCHEMA_VERSION` is 00784 and the
boot guard REFUSES TO START in production when the database is behind. Had the
edge redeployed before the migration applied, the whole service would have
crash-looped rather than degraded, and the review-insert path writes columns
00784 creates, so it would have failed too. It happened to land in the right
order. The held-migration gate exists precisely so that ordering is not left to
luck, and it was bypassed with `--no-verify`.

**Risk: LOW.** Six nullable columns on `human_reviews` and one CHECK
constraint. Nothing dropped, nothing backfilled, no RLS change (the table is
admin/reviewer-only already). `ADD COLUMN IF NOT EXISTS` and a guarded
constraint, so a second run is a no-op.

**Apply order: after 00783. Depends on nothing else.**

**Why it exists.** `applyGradeAdjustment` overwrites a grade's scores with the
reviewer's correction, and every accuracy reader then compared the reviewer's
score with itself: zero error on every corrected grade. The five
`original_*` columns keep the factor scores each review found before acting;
`review_action` (`approve | adjust | send_back | dispute`) stops send-backs
counting as approvals. Contract: `vault/20-domain/review-accuracy-baseline.md`.

**⚠ The edge code in the same change WRITES these columns on every review.**
Apply the SQL before the edge deploys, or approve/adjust/send-back/dispute
inserts fail with a missing-column error. The boot guard (EXPECTED_SCHEMA_VERSION
00784) holds the new edge back until it is applied. The frontend reads the new
accuracy fields as optional, so an early frontend deploy is safe.

**Run:**

```sql
-- supabase/migrations/00784_human_review_ai_baseline.sql, then:
NOTIFY pgrst, 'reload schema';
```

**Check it landed:**

```sql
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'human_reviews'
  and (column_name like 'original\_%' or column_name = 'review_action')
order by 1;  -- expect 7 rows: the six new ones plus the older original_score
```

## ✅ APPLIED 2026-09-10: 00783 — five brands sellers hold, and two refusals (US-3125)

**APPLIED, and NOT the way the rule says it should have happened.** This was
authored as HELD on 2026-09-10 and was meant to wait for the owner's OK. It
reached origin/main anyway, pushed by the background automation loop that
also runs in this repo, and prod applied it. Evidence it ran end to end: the
edge's own `/health/ready` reports
`schema {expected: 00783, applied: 00783, status: match}`, and 00783's LAST
statement is the US-1108 self-record insert, so a recorded 00783 means the
whole file executed. The five brand rows cannot be confirmed from outside -
`brand_knowledge` returns `content-range: */0` to the anon key with no filter
at all, so it is RLS-blocked rather than empty.

**Why the heading is being flipped rather than argued with:** it IS applied,
and a HELD heading over an applied migration is the exact stale state that
kept every push in this repo blocked earlier the same day. The process
failure is worth recording; leaving a false heading behind to mark it is not.
The pre-push hook did fire and was bypassed with `--no-verify`.

**Risk: LOW.** Data only. Five `brand_knowledge` rows and two `brand_styles`
rows, no schema change, nothing dropped, no revoke. `on conflict ... do update`
on both, so a second run rewrites the same values rather than inserting a
duplicate.

**Apply order: last, and it depends on nothing.** It touches no table that 00777
or 00778 touch and reads no column those add.

**What it adds.** GANT, Quince, 7Diamonds, Ermenegildo Zegna and Lauren Ralph
Lauren, each with the brand's own published page as `source_url` and a
confidence between 0.60 and 0.75. Two registered numbers, both FTC-record
sourced and both re-read on 2026-09-10: RN 101133 (ERMENEGILDO ZEGNA
CORPORATION) and RN 177170 (Last Brand, Inc., which 00731 refused and which
Quince's own Terms of Service now confirms is Quince's operator). GANT,
7Diamonds and Lauren Ralph Lauren are seeded with NO registered number on
purpose; the migration says why for each.

**The three of the eight that were already done.** prAna and Pact were seeded by
00731 and Veronica Beard by 00739, all applied to prod on 2026-09-06 — the same
day US-3125's measurement was taken, which is why they read as absent in it.
Nothing here re-seeds them.

**`laurenralphlauren` is a NEW brand_key, not an alias on `ralphlauren`.** That
is the one decision in this file worth a second look before applying. Ralph
Lauren Corporation's own page prices Lauren "at a more accessible price point"
than its other labels, and `poloralphlauren` is already a separate key (00389,
RN 109514 in 00729). Aliasing it onto the house would price a department-store
dress off Purple Label comps. Reasoning:
`vault/20-domain/brands/brand-kb-alias-refusals.md`.

**No client reads anything new.** `brand_knowledge` is read by the edge with the
service-role client and by the admin curation surface, both of which already
handle a brand with no row. Nothing in the frontend queries these tables
directly, so a push before the apply degrades to "the KB does not know GANT",
which is exactly today's behaviour.

**Verify after applying** (counts from prod on 2026-09-07 were 542 brands):

```sql
select count(*) from public.brand_knowledge;                 -- expect 547
select brand_key, canonical_brand, registered_numbers, confidence
  from public.brand_knowledge
 where brand_key in ('gant','quince','7diamonds','ermenegildozegna','laurenralphlauren');
select count(*) from public.brand_styles where brand_key = 'laurenralphlauren';  -- expect 2
```

**Apply order:**

1. `psql` the file (or `scripts/apply-prod-migrations.sh`).
2. `NOTIFY pgrst, 'reload schema';` — not strictly required (no schema change),
   but harmless and it costs nothing to keep the habit.
3. Redeploy the edge on Coolify (`EXPECTED_SCHEMA_VERSION` is now `00783`).
4. THEN OK the push.

**Rollback** is `delete from public.brand_knowledge where updated_by =
'migration:00783';` plus the same on `brand_styles`. No other table references
these rows by id.

## ✅ APPLIED 2026-09-10: 00778 — discount campaigns (US-3299)

**APPLIED, heading corrected 2026-09-10.** It was still marked HELD while prod
already had it. Evidence, all read from outside with the public anon key:
`GET https://functions.gradethread.com/health/ready` reports
`{expected: 00782, applied: 00782, status: match}`, and prod PostgREST's own
OpenAPI document lists `discount_campaigns`, a table only 00778 creates. The
apply script runs migrations in order and self-records each one, so a recorded
00782 means everything below it ran. A stale HELD heading is not harmless: the
pre-push `held-migration-gate` blocks on it, so every push in this repo was
being refused over migrations that had already shipped.

**Apply AFTER 00777.** Order matters only because 00777 is a live bug fix and
this is a new feature; they touch nothing in common.

**Risk: LOW.** One new table, its own indexes, its own policy. Nothing existing
is altered or dropped. `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT
EXISTS`, `DROP TRIGGER`/`DROP POLICY` before create — safe to run twice.

**What it adds.** `public.discount_campaigns`: one row per sale. A percent or a
dollar amount off a list of packages, between `starts_at` and `ends_at`. There
is no status column — live, scheduled and expired are all derived from the two
dates plus `enabled`, so a window opens and closes with nothing scheduled and
nothing for an operator to remember to switch off.

**⚠ THE FRONTEND READS THIS TABLE FROM THE CLIENT.** `src/hooks/use-discounts.ts`
queries `discount_campaigns` through the anon key, on the public pricing page and
on every in-app billing surface. Cloudflare Pages auto-deploys the frontend the
moment this is pushed. **If the table does not exist yet, every one of those
queries 404s from PostgREST.**

The failure is soft by construction — the hook catches, returns an empty list,
and each surface renders list price, which is what it renders today. So nothing
visibly breaks. It will, however, put a 404 into the console of every visitor to
`/pricing` until the migration lands, which is exactly the kind of noise that is
easy to mistake for something worse later. Apply first anyway.

**Nothing else in this commit depends on the table existing.** The edge reads it
with the service-role client and has the same empty-list fallback
(`loadDiscountCampaigns` logs and returns `[]`), so checkout keeps working at
list price whether or not this has been applied.

**Apply order:**

1. `psql` the file (or `scripts/apply-prod-migrations.sh`).
2. `NOTIFY pgrst, 'reload schema';` — **required**. A new table is invisible to
   PostgREST until the schema cache reloads, and the client read is the surface
   that notices.
3. Redeploy the edge on Coolify (`EXPECTED_SCHEMA_VERSION` is now `00778`; the
   boot guard refuses to start against an older schema after the grace window).
4. THEN OK the push.

**After it is live, nothing happens until an operator creates a campaign.** An
empty table prices everything exactly as it is priced today. The first campaign
is created at `/admin/pricing` → Sales & discounts, which needs super_admin and
a fresh MFA step-up, and which mints the Stripe coupon as part of saving.

**Rollback** is `drop table public.discount_campaigns;` plus deleting whatever
coupons were minted (they carry `metadata.source = 'discount_campaign'`). No
other table references it.

## ✅ APPLIED 2026-09-10: 00777 — the Money tab has read $0.00 since 00685 (US-3300, was US-3298)

**APPLIED, heading corrected 2026-09-10.** It was still marked HELD while prod
already had it. Evidence, all read from outside with the public anon key:
`GET https://functions.gradethread.com/health/ready` reports
`{expected: 00782, applied: 00782, status: match}`, and prod PostgREST's own
OpenAPI document lists `discount_campaigns`, a table only 00778 creates. The
apply script runs migrations in order and self-records each one, so a recorded
00782 means everything below it ran. A stale HELD heading is not harmless: the
pre-push `held-migration-gate` blocks on it, so every push in this repo was
being refused over migrations that had already shipped.

**ONE CAVEAT SPECIFIC TO 00777.** The evidence above is the ordering argument,
not a direct read. 00777 REPLACES `rebuild_ledger_for_user`, and a replaced
function's presence in the schema proves nothing about which body is live -
the old one was present too, and returned 400 every time. To settle it
directly, sign in and press the Money tab's rebuild, or read `ledger_entries`
for any seller: a non-zero count means the fixed body ran.

⚠ **APPLY THIS ONE FIRST.** It is a one-line fix to a function that has never
completed a single run in production, and until it lands every seller's Money
tab is confidently wrong.

**Risk: LOW.** One function, `CREATE OR REPLACE`d in place, same signature. It
writes nothing on its own — a ledger is only rebuilt when something calls it.
No schema change, nothing dropped, no revoke. Idempotent.

**What was wrong, and it is one line:**

```
DELETE FROM _acct;
```

Production loads the `safeupdate` extension, which refuses any UPDATE or DELETE
with no WHERE clause and raises SQLSTATE 21000 — `DELETE requires a WHERE
clause`. PostgREST turns that into HTTP 400, which is the
`POST /rest/v1/rpc/rebuild_my_ledger → 400` in the browser console.

**The failure is TOTAL, not partial.** `_acct` is cleared before anything is
written, so the function aborts on its first statement after the authorization
check and no ledger row has ever been inserted for anybody. Read off production
on 2026-09-09 for the owner's own account with nothing but the browser's anon
key: 220 sales, 8 expenses, 33 global ledger accounts, **`ledger_entries` = 0**.

So every figure the Money tab derives from the ledger reads zero — the overview
cards, the whole Schedule C statement (gross receipts, COGS, gross profit, net
profit, all $0.00 against 220 real sales), the reconciliation. And it reads zero
**with no error on screen**: `ensureLedgerBuilt()` rebuilds only when the ledger
is empty, so the empty ledger is exactly the state that triggers the call that
cannot succeed, and the failure is swallowed into a page that renders fine.

**Why it survived four rewrites of this function.** The line was written in
00685 and carried forward verbatim by 00686, 00691, 00695 and 00697, each of
which reproduces the whole body because `CREATE OR REPLACE` takes a whole body.
Nothing local catches it: `safeupdate` is not installed on the local image
(`pg_available_extensions` has no row for it on PostgreSQL 17.6, checked
2026-09-09), so `npm run check:ledger` has been building ledgers happily here
the whole time — it passes today, before and after this change. Same shape as
US-1552's `.or()` on a mutation: prod's Postgres is stricter than the one CI
runs, in a way only a write can reveal.

**The fix is TRUNCATE, not `WHERE true`.** `safeupdate` inspects the planned
statement and the planner constant-folds a true qual away before it gets there,
so `WHERE true` is a coin flip. `TRUNCATE` is a utility statement, so
`safeupdate` never sees it, and on a temp table it is cheaper than the DELETE it
replaces. Nothing else in the body changes — the US-3002 authorization check,
the US-2987 facilitator-tax branches, the US-2989 mileage join and the US-2990
home-office block are carried from 00697 byte for byte, and the second DELETE
(`ledger_entries WHERE user_id = … AND source_kind <> 'adjustment'`) already has
a WHERE clause.

**The class is now guarded.** `scripts/migrations-lint.mjs` fails any new
WHERE-less UPDATE or DELETE in a migration (`whereLessMutations`), with the five
already-applied instances grandfathered by name so the list can only shrink. It
runs in `npm run verify` and in CI.

**Verified against real Postgres before writing this.** Applied to the local
stack, then `check:ledger` (invariant holds, ledger net = finances_dashboard net
to the cent), `check:cogs` (every assertion including the one that must fail) and
`check:tax` (both facilitator branches) all pass. The fixture calls the function
twice in one transaction, so the TRUNCATE path is exercised, not just skipped.

**Apply order.** `00777` alone. `NOTIFY pgrst, 'reload schema';` is **not
needed** — no table, column or RPC signature changed — but it is harmless.
Then redeploy the edge on Coolify (`EXPECTED_SCHEMA_VERSION` is now `00777`).

**After applying, confirm it in one read** rather than trusting the apply: open
Money and check that Profit is no longer $0.00, or POST
`/rest/v1/rpc/rebuild_my_ledger` as a signed-in user and expect an entry count
instead of a 400.

## ✅ APPLIED 2026-09-10: 00781 — batches 4 through 10 of the sourced size charts (US-3287 to US-3293)

**APPLIED, heading corrected 2026-09-10.** It was still marked HELD while prod
already had it. Evidence, all read from outside with the public anon key:
`GET https://functions.gradethread.com/health/ready` reports
`{expected: 00782, applied: 00782, status: match}`, and prod PostgREST's own
OpenAPI document lists `discount_campaigns`, a table only 00778 creates. The
apply script runs migrations in order and self-records each one, so a recorded
00782 means everything below it ran. A stale HELD heading is not harmless: the
pre-push `held-migration-gate` blocks on it, so every push in this repo was
being refused over migrations that had already shipped.

**Risk: LOW.** Same shape as 00780 below: insert-or-update into
`public.brand_size_charts`, a global reference table with deny-all RLS and no
tenant data. No schema change, nothing dropped, nothing revoked. Idempotent.

**ONE FILE CARRIES TWO BATCHES, on purpose.** 00781 was written for batch 4 and
then REGENERATED to include batch 5 rather than opening an 00782. The generator
emits every chart in the corpus carrying a `sourceUrl`, so a second number would
have held the same rows under a different name. That is only safe because 00781
has never been applied anywhere; once a file is recorded in `applied_migrations`
the next batch must take a new number.

**HELD FROM THE PUSH, unlike 00779 and 00780.** The standing rule is back: a
commit touching `supabase/migrations/` is committed locally and the operator
pushes it. This one has NOT been applied to prod and has NOT been pushed.

**What it does.** Batch 4's 16 charts across Arc'teryx, Barbour, Bogner,
Bonobos, Brooks Brothers, Dickies and Diesel, plus REPLACED rows on Cotopaxi's
two; batch 5's 10 across Nike, Gap, G-Star RAW, Lee, Duluth Trading Co. and
Gallery Dept.; and batch 6, which is almost entirely REPLACEMENTS — Old Navy,
SKIMS, Rab (both departments), Stussy, PUMA and Reebok all had an approximation
chart already, so their rows were rewritten in place, with only PUMA's women's
chart and Reebok's bottoms chart genuinely new. Each carries the brand's own
`source_url` and `confidence 0.85`; `verified` stays false. Batch 7 adds
Wrangler, Beyond Yoga, UNTUCKit and Woolrich. Batch 9 adds eleven more:
Marmot's and Mountain Hardwear's bottoms in both departments, Johnnie-O's
four (men's, big & tall, women's and boys'), and ONE Kate Spade chart that
replaces two. Batch 10 adds twelve: Orvis in both departments, Pendleton's
bottoms, REI Co-op's bottoms, three Reformation charts, and a source URL on
the four tops charts those brands already had. Batch 12 adds seven:
Hellstar's bottoms, BAPE's bottoms, women's and kids, Palace's bottoms and
Sp5der's two. Batch 13 adds five: Filson's bottoms,
Buck Mason's outerwear, Rag & Bone in both departments and FRAME's women's.
**145 sourced rows in total**, since the generator re-emits every earlier batch.

**Batch 10 adds NO new orphans, and that is deliberate.** Every replacement in
it keeps its `garment` string byte-identical, so the upsert updates the
existing row instead of inserting a second one. The orphan list 00782 deletes
is still exactly fourteen after batch 10, which is the check that the rule
held.

**Batch 8 barely touches this file, and that is the point.** Five of its six
brands needed only a WIDER `category_match` on a chart they already had, which
changes the in-code corpus and adds no sourced row; only Girlfriend Collective
gained a `source_url`. A coverage gap is not always a missing chart — sometimes
it is a chart whose keywords do not reach the group it already describes.

**Two of batch 7's four needed only a URL.** Beyond Yoga's and UNTUCKit's
women's rows were ALREADY the brand's own numbers, sitting in the corpus
unsourced; what they lacked was `source_url` and a `category_match` wide enough
to reach the missing group. Worth checking for before transcribing anything:
not every unsourced chart is an approximation.

**⚠ CORRECTION — the surviving old rows are NOT inert, and 00782 below is the
fix.** This paragraph used to say that where a replacement changed the
`garment` string the old row "survives under its old garment and stops
resolving. Inert, not harmful; sweep them together later if it ever matters."
The first half is right and the conclusion is wrong. `brand-knowledge.ts`
prefers the DB WHOLESALE: if `brand_size_charts` returns any row for a brand,
those rows are the entire answer and the in-code corpus is never consulted.
The old row keeps its old `category_match`, which still matches the same
garment words — so a Woolrich jacket resolves the retired approximation AND
the brand's own numbers, competing for the same three-chart budget. That is
the US-1734 two-competing-charts problem arriving by a new route. Fourteen
rows are in that state; 00782 deletes them by name.

**Cotopaxi's two rows are an UPDATE, not an insert, and that is the point.**
Its men's and women's charts existed as approximations with no source. Rather
than add a second competing pair, this batch rewrote them in place with the
brand's published numbers and widened `category_match` to reach bottoms. The
upsert handles it: same `brand_key`, `department` and `garment`, new `rows`,
`note`, `source_url` and `category_match`.

**THREE charts are FLAT, which is new.** Bonobos states above its own table that
the numbers are garment dimensions, so its two charts carry
`measurement_basis = 'flat'`, and Gallery Dept.'s bottoms chart is garment too
(its columns are front rise and leg opening). Every chart shipped before 00781
was body. If the size check starts reporting those three brands as oversized,
that column is the first place to look.

**Apply order:** after 00780, and BEFORE 00782. `NOTIFY pgrst, 'reload
schema';` afterwards is harmless (no table, column or RPC signature changed)
but cheap. Redeploy the edge only after 00782, since the boot guard will then
expect 00782.

## ✅ APPLIED 2026-09-10: 00782 — delete the 14 size-chart rows the code retired (US-3292)

**APPLIED, heading corrected 2026-09-10.** It was still marked HELD while prod
already had it. Evidence, all read from outside with the public anon key:
`GET https://functions.gradethread.com/health/ready` reports
`{expected: 00782, applied: 00782, status: match}`, and prod PostgREST's own
OpenAPI document lists `discount_campaigns`, a table only 00778 creates. The
apply script runs migrations in order and self-records each one, so a recorded
00782 means everything below it ran. A stale HELD heading is not harmless: the
pre-push `held-migration-gate` blocks on it, so every push in this repo was
being refused over migrations that had already shipped.

**Risk: LOW.** One `delete` against `public.brand_size_charts`, a global
reference table with deny-all RLS and no tenant data. No schema change.
Idempotent: a second run deletes nothing.

**What it does.** Removes exactly fourteen `(brand_key, department, garment)`
rows, listed by name in the file. Every one is a pre-backfill approximation
whose garment scope no longer exists in `sizing-charts.ts`, left behind
because batches 2 through 8 renamed the scope when they widened a chart
("Tops" → "Tops & outerwear") and the upsert key includes `garment`. Two of
the fourteen are Kate Spade's, deleted because batch 9 replaced both of its
invented charts with the brand's own single clothing chart.

**Why a hand-listed delete rather than "delete anything not in the corpus".**
A derived delete would also remove hand-written pack rows that were never
generated from code, and nothing in the table distinguishes them.

The fourteen: beyondyoga/Women/Tops; express/Women/Tops (US numeric 00-18 /
alpha); jcrew/Men/Shirts (alpha); katespade/Women/Dresses (US numeric);
katespade/Women/Tops & knits (US alpha); oldnavy/Women/Tops (alpha, RUNS
LARGE); puma/Unisex/Tops (alpha); reebok/Unisex/Tops (alpha); skims/Women/
Intimates apparel / shapewear; stssy/Men/Tops (tees & fleece, US alpha);
thenorthfacepatagoniaouterwear/Unisex/Outerwear / jackets (alpha);
untuckit/Women/Tops & dresses (ALPHA XS-XL); woolrich/Men/Outerwear & wool;
woolrich/Women/Outerwear & wool.

**Apply order:** after 00781. `NOTIFY pgrst, 'reload schema';` afterwards is
harmless but cheap. Redeploy the edge afterwards: its boot guard will expect
00782.

## ✅ APPLIED 2026-09-10: 00780 — batch 3 of the sourced size charts (US-3286)

**Risk: LOW.** Same shape as 00779 below: insert-or-update into
`public.brand_size_charts`, a global reference table with deny-all RLS and no
tenant data. No schema change, nothing dropped, nothing revoked. Idempotent.

**What it does.** 22 more sizing charts across Tommy Hilfiger, Patagonia, The
North Face, True Religion, Abercrombie & Fitch, Spanx, Uniqlo and Aime Leon
Dore, each transcribed from the brand's own published guide with a real
`source_url` and `confidence 0.85`. `verified` stays false on every one.

**It re-emits every earlier batch's rows too** — 64 in total — because the
generator's scope is every chart carrying a `sourceUrl`, not just this batch's.
Re-writing identical values costs nothing and spares the bookkeeping of which
brand landed in which migration.

**One chart was DELETED from the in-code corpus and is NOT deleted from the
table.** The shared "The North Face / Patagonia (outerwear)" pseudo-brand row is
gone from `sizing-charts.ts` now that both brands have real charts of their own.
The DB row from the original seed survives under `brand_key` for that combined
name and nothing resolves it any more, because the resolver reads brand names,
not keys. It is inert rather than harmful; leave it or sweep it later, but do
not add a DELETE to a generated upsert migration.

**Apply order:** after 00779. `NOTIFY pgrst, 'reload schema';` afterwards is
harmless (no table, column or RPC signature changed) but cheap. Redeploy the
edge afterwards: its boot guard now expects 00780.

## ✅ APPLIED 2026-09-10: 00779 — batch 2 of the sourced size charts (US-3285)

**Risk: LOW.** Same shape as 00776 below, which is now applied: insert-or-update
into `public.brand_size_charts`, a global reference table with deny-all RLS and
no tenant data. No schema change, nothing dropped, nothing revoked. Idempotent.

**⚠ WHY IT IS 00779 AND NOT 00777.** It was written as 00777, and prod already
records 00777 AND 00778 — applied by a concurrent session whose files are on
neither `main` nor any branch in this checkout. Keeping 00777 would have been
worse than a name clash: `apply-prod-migrations.sh` skips every file at or below
the highest recorded version, so a file numbered 00777 would be skipped forever
and silently, which is US-2726's failure exactly. Renumbering leaves 00777 and
00778 as gaps in this repo until that session pushes. Both are in
`migrations-lint`'s `KNOWN_GAPS` marked TEMPORARY, so CI is not red over
someone else's unpushed work — and the lint fails the moment those two files
land, at which point the two entries must be deleted.

**What it does.** 23 more sizing charts, across Hudson Jeans, Joe's Jeans,
Levi's, Lucky Brand, Mackage, Madewell, Moncler, MOTHER, PacSun and PAIGE, each
transcribed from the brand's own published guide and carrying a real
`source_url` plus `confidence 0.85`. `verified` stays false on every one: an
agent transcribed them, no human has re-checked them, and the size-guide panel
renders its trust badge straight off that column.

**It re-emits 00776's rows too, and that is by design.** The generator's scope
is every chart in the corpus carrying a `sourceUrl`, not just this batch's — 42
rows in total. Re-writing batch 1's 19 with identical values costs nothing and
spares anyone the bookkeeping of which brand landed in which migration. 00776 is
already applied, so **00779 alone is what remains**.

**Two brands' `source_url` points at a PRODUCT page, not a guide page.**
Mackage's `/pages/size-chart` now renders a store locator and PAIGE's
`/size-guide` renders its heading with no table under it; both still publish the
chart in the product page's Size Guide panel. Those URLs can rot in a way a
guide page would not, so a dead link on those two brands has a known cause.

**Apply order:** after 00778, which prod already records. `NOTIFY pgrst, 'reload
schema';` afterwards is harmless (no table, column or RPC signature changed) but
cheap. Redeploy the edge afterwards: its boot guard now expects 00779.

**The frontend in the same push is safe without the SQL**, for the same reason
00776's is — the panel resolves DB-first and falls back to the in-code corpus,
which already compiles in these charts and their source URLs.

## ✅ APPLIED 2026-09-10 (recorded earlier, heading flipped late): 00776 — give brand_size_charts the source URLs the charts now carry (US-3284)

**Risk: LOW.** Insert-or-update into `public.brand_size_charts`, a global
reference table with deny-all RLS and no tenant data. No schema change, nothing
dropped, nothing revoked. Every value is derived from committed code, so it is
idempotent and safe to run twice.

**Applied to prod before this heading was flipped, which is the defect the
pre-push gate caught.** `applied_migrations` records 00776, so the SQL ran; the
heading here still said HELD, and 00776's file was already on `origin/main`.
Nobody was blocked and nothing was broken, but for a day the repo's own answer
to "is this applied" was wrong. Confirmed 2026-09-10 by reading
`public.applied_migrations` directly.

**What it does.** 19 sizing charts across 10 brands, each transcribed from the
brand's OWN published size guide, land with a real `source_url`. Before this
batch every one of the corpus's 300-odd charts had `source_url NULL` — which is
why the composer's "[Brand] size guide" link fell through to a Google search for
nearly every item a seller edited.

**Why it is not 00498.** 00498 is the generated backfill of the whole in-code
corpus and it is ALREADY APPLIED. `apply-prod-migrations.sh` skips every file at
or below the highest recorded version, so regenerating it in place updates the
repo and reaches prod never. 00498 is still regenerated in this commit because
its parity guard re-derives it and fails on drift; 00776 is what actually moves
the rows. 00498 also writes `source_url = NULL` by contract and its own guard
asserts that, which is correct for an unsourced backfill and wrong for these.

**Upsert, not insert-only.** 00498 is deliberately insert-only so an unsourced
row can never overwrite a hand-sourced pack row. This one carries the source, so
on conflict it writes `rows`, `note`, `source_url`, `category_match`,
`brand_match` and `brand_label`. `confidence` is left alone, because a pack may
have set one and this batch has none to offer. `verified` stays false: an agent
transcribed these, a human has not checked them, and the size-guide panel renders
its trust badge straight off that column.

**Both required columns, and this is what the first apply got wrong.** 00578
added `brand_size_charts_sourced` — a CHECK that `source_url` is non-blank AND
`confidence` is non-null — as NOT VALID, so the legacy unsourced rows stay
readable while any new INSERT or UPDATE must satisfy it. The first cut of 00776
set the URL and left confidence NULL, and prod rejected every row with 23514.
Each row now carries `confidence 0.85`: the top of the range the hand-written
packs use, which is the right end when the numbers came off the brand's own
page and the only uncertainty left is the transcription. `verified` stays false,
because that column records whether a HUMAN checked and none has.

**⚠ DO NOT re-apply 00498 or 00499.** They are already applied, they are
regenerated in this commit only because `sizing-chart-parity_test.ts` re-derives
them and fails on drift, and running them by hand on prod FAILS — 00498 now
inserts 19 deliberately-unsourced rows, and 00499's UPDATE touches every chart
in the table, so the NOT VALID check fires on both. Both files now sit behind an
`applied_migrations` check and print a notice instead, so a hand re-run is a
harmless no-op. That guard was verified against a local Postgres carrying the
same constraint and the same recorded versions: 00498 and 00499 skipped, 00776
applied clean twice, 19 rows landed sourced.

**Apply order:** 00776 only, after 00775. Run `NOTIFY pgrst, 'reload schema';`
afterwards — harmless here (no table, column or RPC signature changed) but
cheap. Redeploy the edge afterwards: its boot guard now expects 00776.

**The frontend in the same push is safe without the SQL.** The size-guide panel
resolves charts DB-first and falls back to the in-code corpus, which already has
these charts and their source URLs compiled in. Until 00776 applies a seller sees
exactly the same panel; what is missing is the admin console's ability to edit
these rows.

## ✅ APPLIED 2026-09-09: 00775 — widen flipdesk_import_runs.origin to accept 'grailed' (US-3261)

**Risk: LOW.** One named CHECK constraint dropped and re-added with one extra
value. No data change, no column change, nothing revoked. Safe to run twice.

**What it fixes, and it is a live outage rather than a new feature.** US-3155
added `grailed` to `CLOSET_IMPORT_PLATFORMS` on the edge and gave it a photo-host
allowlist. The origin CHECK from 00712 still listed five values, and
`flipdesk-closet-import.ts` inserts `origin: platform` — so **every Grailed
closet import has failed at the INSERT since then**, and the seller was told
"Could not start the import." Nothing else was affected: the row was never
created, so no partial import exists to clean up.

**Applied to prod 2026-09-09** by the operator, before this commit was pushed.

**Apply order:** after 00774. `NOTIFY pgrst, 'reload schema';` is not strictly
needed (no table, column or RPC signature changed) but is harmless. Redeploy the
edge afterwards — its boot guard now expects 00775.

**⚠️ THE FRONTEND IN THE SAME PUSH OFFERS GRAILED BEFORE THE SQL LANDS.**
Cloudflare Pages auto-deploys on push, and the same commit adds Grailed to the
web's `CLOSET_IMPORT_PLATFORMS` (marketplace-disclosure.ts), so the Import page
shows a Grailed button as soon as the push lands. Until this migration is
applied, pressing it fails — the same way it already fails today, but now with
an honest sentence: the route reads Postgres error 23514 and answers "This
server does not accept Grailed imports yet. The database is behind the app."
Apply the SQL before the push and neither state exists.

**Guard:** `services/edge-functions/src/tests/closet-import-origin_test.ts`
reads this migration and asserts every member of `CLOSET_IMPORT_PLATFORMS` is a
permitted origin, so a fourth platform cannot be added without widening the
constraint again.

## ✅ APPLIED 2026-09-09: 00774 — GRANT EXECUTE on pooled_sold_comps (US-2282 guard)

**Risk: LOW, and it is additive only.** One `GRANT EXECUTE ... TO service_role`.
No schema change, no data change, no revoke. Re-running is a no-op.

**Apply order:** after 00773. No `NOTIFY pgrst` needed (no table, column or RPC
signature changed), but running it is harmless. Redeploy the edge afterwards —
its boot guard now expects 00774.

**⚠️ IT DELIBERATELY DOES NOT REVOKE.** `pooled_sold_comps` keeps its default
EXECUTE to PUBLIC. On this Postgres image a DENIED call from anon or
authenticated segfaults the backend and restarts the database (US-2403), which
is why 00527 is parked as DO NOT APPLY. A revoke here would build that crash
surface on a function reachable with the public anon key. If you were hoping
this closes the anon hole: it does not, and it says so in the file.

**What it changes for a caller:** nothing. service_role could already execute
it via PUBLIC; this states the intent explicitly so the guard passes and so the
right grant survives the day the revoke becomes safe.

**Why the remaining exposure is tolerable.** The function returns aggregates
only and returns NO ROW below both k-anonymity floors — 5 sales from 3 distinct
sellers — and those floors are inside the function, so they hold for an
anonymous caller too.

**Rollback:** `REVOKE EXECUTE ON FUNCTION public.pooled_sold_comps(text, text,
int) FROM service_role;` — but read the warning above first: revoking from
service_role is safe, revoking from anon or authenticated is not.

**No operator step.**

## ✅ APPLIED 2026-09-08: 00772 — item_photos.remote_source + flipdesk_ebay_listings.photo_urls (US-3196)

**Risk: LOW.** Two nullable text columns on `item_photos`, one CHECK, one
partial index, and one `text[] NOT NULL DEFAULT '{}'` on
`flipdesk_ebay_listings`. No backfill and no rewrite of existing data: every
existing photo row reads `remote_source = NULL`, which means "GradeThread holds
this file" and is exactly what was true before.

**Apply order:** after 00771. Run `NOTIFY pgrst, 'reload schema';` afterwards
(three new columns), then redeploy the edge.

**Applied by the owner before the commit landed, so the push is cleared.** The
paragraph below is why the order mattered; it is kept because a rollback would
put us back in front of it.

**⚠️ THE FRONTEND READS THE NEW COLUMNS, AND CLOUDFLARE PAGES DEPLOYS ON PUSH.**
`src/components/flipdesk/photo-manager.tsx` reads `item_photos.remote_source`
and `src/components/flipdesk/ebay-sku-match.tsx` reads
`flipdesk_ebay_listings.photo_urls`. Both go out the moment this is pushed. The
photo grid uses `select("*")` so a missing column reads as undefined and the
banner simply never shows, but the orphan page reads `photo_urls` on a row shape
PostgREST would not yet be returning. Apply the SQL BEFORE the push.

**What it adds**
- `item_photos.remote_source` — the marketplace still hosting the bytes when
  `storage_path` is NULL. Today only `'ebay'`, enforced by a CHECK because the
  value gates behaviour (a row carrying it is never sent to a marketplace).
- `item_photos.remote_source_url` — the original marketplace URL. Deliberately
  KEPT after a seller copies the image into our bucket: it is the key the next
  sync compares against, so clearing it would make the sync re-add every photo
  it had already adopted.
- `idx_item_photos_remote_source_url` — partial, on
  `(inventory_item_id, remote_source_url)`, the sync's dedupe read.
- `flipdesk_ebay_listings.photo_urls` — eBay-hosted picture URLs for a listing
  that matched no FlipDesk SKU.

**BEHAVIOUR CHANGE WORTH KNOWING BEFORE YOU APPLY IT.** Once the edge deploys,
an eBay sync writes reference photo rows onto every matched item that has NO
photos of its own. Those rows render from `i.ebayimg.com` and store nothing.
Items where the seller already has photos are never touched. There is no undo
button, but the rows are ordinary `item_photos` and delete like any other, and
`DELETE FROM public.item_photos WHERE remote_source IS NOT NULL;` removes every
one of them without touching a single file the seller owns.

**Rollback:** drop the two columns, the CHECK, the index and the array column.
Nothing else depends on them, and the guard that keeps reference photos out of
marketplaces is phrased on `storage_path`, not on `remote_source`, so it keeps
working with the columns gone.

**No operator step.**

## ✅ APPLIED 2026-09-09: 00773 — flipdesk_settings.listing_voice_prompt (US-3201)

**Risk: LOW.** One nullable `text` column on `flipdesk_settings` plus a CHECK.
No backfill, no rewrite, no default: every existing row reads NULL, which means
"use the listing prompt as shipped" and is exactly what was true before.

**Apply order:** after 00772. Run `NOTIFY pgrst, 'reload schema';` afterwards
(new column), then redeploy the edge.

**⚠️ THE FRONTEND READS THE NEW COLUMN, AND CLOUDFLARE PAGES DEPLOYS ON PUSH.**
`src/hooks/use-listing-voice.ts` runs a NAMED select
(`.select("listing_voice_prompt")`) against `flipdesk_settings`, and it is
mounted on `/dashboard/flipdesk/description-snippets` via
`ListingVoiceSetting`. A named select on a missing column is a PostgREST 42703,
not an undefined — so unlike 00772's `select("*")` photo grid, this one throws
the moment the page opens. Apply the SQL BEFORE the push.

The edge also reads it (`loadListingVoice` in `ai-listing.ts`, on every
AutoLister generation), but that read swallows its error and returns null, so
an unapplied database degrades to today's behaviour there rather than failing a
listing run.

**What it adds**
- `flipdesk_settings.listing_voice_prompt` — how this seller wants their listing
  copy to sound, in their own words. Appended to the versioned `listing_gen`
  prompt as a separate trailing system block, never edited into it, never sent
  on an eval run, and never cached (it is the only per-seller text in an
  otherwise shared system prefix).
- `flipdesk_settings_listing_voice_sane` — CHECK: null, or 1 to 2000 characters
  and not all whitespace. The cap is load-bearing, not cosmetic: this text rides
  on every listing generation, and AutoLister runs in batches.

## ✅ APPLIED 2026-09-09: 00771 — aged_threshold_days + the Aged tab in flipdesk_listing_page (US-3195)

**Risk: MEDIUM, and higher than the other three in this stack.** The column is
trivial. The second half REPLACES `flipdesk_listing_page`, which is the function
behind every row the listings table shows, and it does so by DROPPING the
11-argument overload and creating a 12-argument one. Read the apply output: if
the drop succeeds and the create fails, the listings page has no function to
call and every tab is empty until it is fixed.

**VERIFIED 2026-09-10.** `LISTING_PARITY_DB=1 npx vitest run
src/test/listing-page-sql-parity.test.ts` was run against the live
`supabase_db_gradethread` container: **87 passed / 0 failed**. That test runs
this function and its TypeScript twin over the same rows and demands identical
ids in identical order. Prod exposes exactly one `flipdesk_listing_page`
overload, the 12-argument one carrying `p_aged_threshold_days`, so the drop and
the create both landed. The earlier "reviewed and unexecuted" warning here is
retired.

**Apply order:** after 00770. Run `NOTIFY pgrst, 'reload schema';` afterwards
(a new column AND a changed function signature), then redeploy the edge.

**What it adds**
- `flipdesk_settings.aged_threshold_days` — days listed after which this seller
  calls an item aged. NULL means the code default of 60.
- A twelfth parameter, `p_aged_threshold_days`, defaulted to 60, so every
  existing caller keeps its exact behaviour.
- An `aged` tab predicate: listed, unsold, and live longer than the threshold,
  sorted oldest first.

**Rollback** is 00721 re-run verbatim: it drops the 11-arg form and recreates it.
The new column can stay; nothing breaks with it present.

**No operator step.**

## ✅ APPLIED 2026-09-09: 00770 — flipdesk_settings sourcing cost defaults (US-3193)

**Risk: LOW.** Three nullable integer columns on a settings table, plus one
CHECK. No backfill; every existing row reads null, which means "use the code
default" and is exactly the behaviour the new code ships with.

**Apply order:** after 00769. Run `NOTIFY pgrst, 'reload schema';` afterwards,
then redeploy the edge.

**What it adds**
- `sourcing_shipping_cost_cents`, `sourcing_supplies_cost_cents`,
  `sourcing_grading_cost_cents` — what the seller expects to pay to post, pack
  and grade one garment. The buy ceiling subtracts them before dividing by the
  target ROI.
- `flipdesk_settings_sourcing_costs_sane` — bounds each at 0..100000 cents.

**BEHAVIOUR CHANGE WORTH KNOWING BEFORE YOU APPLY IT.** Buy ceilings across
Scout, the appraisal and Prospect all move DOWN once the edge deploys, because
they previously priced postage, packaging and grading at zero. On a $100 median
at a 30% target the ceiling goes from $66.15 to $57.96. That is the fix, not a
regression, and the seller-facing sentence now says what was subtracted.

**DEPLOY ORDER MATTERS ONE WAY ONLY.** The edge SELECTs the three columns when
it computes a ceiling; without them the Scout appraisal throws on 42703. The
schema-version boot guard enforces it — EXPECTED_SCHEMA_VERSION moves to 00770
in the same commit.

**No operator step**, though you may want to set your own figures once it is
live rather than running on the defaults ($8.30 postage, $0.35 supplies, $2.00
grading).

## ✅ APPLIED 2026-09-09: 00769 — inventory_items.floor_price + items_full (US-3192)

**Risk: LOW-MEDIUM.** One nullable column and a CHECK constraint, plus a
CREATE OR REPLACE of the `items_full` view. The view change is the part to read
twice: it appends `floor_price` as the LAST column and every existing column
keeps its name, order and type, so the analytics RPCs that select from it are
unaffected. There is no DROP — that would fail against those dependents.

**Apply order:** after 00768. Run `NOTIFY pgrst, 'reload schema';` afterwards
(a new column AND a changed view), then redeploy the edge.

**What it adds**
- `inventory_items.floor_price decimal(10,2)` — the seller's hard floor on one
  garment. Composed with every rule floor as max(rule floor, this), nulls
  ignored, so it can only ever narrow what automation may do.
- `inventory_items_floor_price_nonneg` — a CHECK, because there are now four
  callers (markdown, offer rules, bulk reduce, the composer) and one missed
  clamp would let automation price an item negative.
- `items_full.floor_price` — so the item grid and saved views can filter on it.

**DEPLOY ORDER MATTERS ONE WAY ONLY.** The edge SELECTs `floor_price` when it
plans a markdown (`routes/flipdesk-pricing.ts`, `routes/flipdesk-automations.ts`)
and when it answers an offer. Against a database without the column those
selects fail with 42703 and the repricing and automation runs throw. The
schema-version boot guard enforces it — EXPECTED_SCHEMA_VERSION moves to 00769
in the same commit.

**⚠️ THE FRONTEND READS IT TOO, AND Pages AUTO-DEPLOYS ON PUSH.** The composer,
the bulk-pricing grid and the item filter all select `floor_price`. Apply the
SQL first.

**No operator step.** No new environment variable, no third-party registration.

## ✅ APPLIED 2026-09-09: 00768 — sales.ship_by + sales.handling_days (US-3189)

**Risk: LOW.** Two nullable columns on an existing table plus one partial index.
No backfill, no rewrite, no enum touched. Every existing row reads null, which
is the correct answer for a sale nobody recorded a deadline for.

**Apply order:** after 00767. Run `NOTIFY pgrst, 'reload schema';` afterwards
(two new columns on a table PostgREST already serves), then redeploy the edge.

**What it adds**
- `sales.ship_by timestamptz` — when the order must reach the carrier. Written
  from eBay's `lineItemFulfillmentInstructions.shipByDate` during the order sync.
- `sales.handling_days smallint` — the listing's handling time, so a deadline can
  be derived for a marketplace that reports no explicit date. Nothing writes it
  yet; the eBay Fulfillment order does not carry it, and reading it would mean a
  business-policy call per order, which is exactly the call volume US-3110 is
  cutting before the Application Growth Check.
- `idx_sales_ship_by_open` — partial on `shipped_at IS NULL`, so it stays the
  size of the open queue rather than the whole sales history.

**DEPLOY ORDER MATTERS ONE WAY ONLY.** The edge WRITES `ship_by` in the eBay
order sync (`routes/flipdesk-ebay.ts`). Against a database without the column the
sale upsert fails with 42703 and the whole order sync throws, so the migration
lands BEFORE the edge deploys. The schema-version boot guard enforces it —
EXPECTED_SCHEMA_VERSION moves to 00768 in the same commit.

**⚠️ THE FRONTEND READS THE COLUMN, AND Pages AUTO-DEPLOYS ON PUSH.** The Ship
queue (US-3190) selects `ship_by` directly through supabase-js. If the push lands
before the SQL is applied, that select 400s and the card shows its error state on
a page that otherwise works. Apply the SQL first; that is the whole reason this
migration is held.

**No operator step.** No new environment variable, no third-party registration.

## ✅ APPLIED 2026-09-08: 00767 — phone_capture_sessions + phone_capture_photos (US-3161)

**Risk: LOW.** Two brand-new tables. Nothing existing is touched: no column
added to a live table, no enum extended, no row rewritten.

**Apply order:** after 00766. Run `NOTIFY pgrst, 'reload schema';` afterwards
(two new tables), then redeploy the edge.

**What it adds**
- `phone_capture_sessions` — one short-lived code per capture. The scanned
  token is stored as a sha-256 HASH, never as itself: it is a bearer credential
  that needs no login, so a plaintext column would make a database read into an
  upload credential.
- `phone_capture_photos` — one row per shot the phone sent, with a unique
  `(session_id, client_key)` so a retry of an upload that actually landed
  cannot add a second photo or count twice against the caps.
- Both are RLS-on with ZERO policies and are registered in `SERVICE_ROLE_ONLY`
  in `rls-guard_test.ts` in the same commit. The write side is what matters: a
  writable session row would let a caller raise their own photo cap or push
  their own expiry out, and those caps are every limit this feature has.

**DEPLOY ORDER MATTERS ONE WAY ONLY.** The edge reads and writes both tables
(`routes/flipdesk-phone-capture.ts`). Without them every capture route answers
500, so the migration lands BEFORE the edge deploys; the schema-version boot
guard enforces it, since EXPECTED_SCHEMA_VERSION moves to 00767 in the same
commit.

**Client side needs the edge, and fails politely without it.** The frontend adds
a public `/capture/:token` route and a QR dialog. A Pages deploy landing first
means the dialog cannot mint a code and says so; nothing breaks elsewhere.
`/capture/:token` is noindex and is deliberately NOT in `PUBLIC_ROUTES`, so a
capture URL never reaches the sitemap or the prerender.

**No operator step.** Unlike 00766 this needs no third-party registration and no
new environment variable.

## ✅ APPLIED 2026-09-08: 00766 — cloud_storage_connections + cloud_storage_oauth_states (US-3159, US-3160)

**Risk: LOW.** Two brand-new tables. Nothing existing is touched: no column is
added to a live table, no enum is extended, no row is rewritten, and no current
query changes shape.

**Apply order:** after 00765. Run `NOTIFY pgrst, 'reload schema';` afterwards
(two new tables), then redeploy the edge.

**What it adds**
- `cloud_storage_connections` — one OAuth grant per user per provider for
  importing photos out of a folder they already keep. Both token columns are
  AES-GCM ciphertext (AAD = user_id). RLS on, owner may SELECT its own row, all
  writes service-role.
- `cloud_storage_oauth_states` — single-use state for the OAuth round trip.
  RLS on with ZERO policies by design; registered in `SERVICE_ROLE_ONLY` in
  `rls-guard_test.ts` in the same commit.
- A named CHECK constraint on `provider`, currently `('dropbox','onedrive')`.
  Named rather than inline so US-3160 and any later provider can drop and re-add
  it instead of fighting a generated constraint name that differs per database.

**DEPLOY ORDER MATTERS ONE WAY ONLY.** The edge reads and writes both tables
(`routes/flipdesk-cloud-folders.ts`). On a database without them every cloud
route answers 500, so the migration lands BEFORE the edge deploys; the
schema-version boot guard enforces that, since EXPECTED_SCHEMA_VERSION moves to
00766 in the same commit.

**Client side is safe either way, and is inert until an operator acts.** The
SPA asks `/api/flipdesk/cloud/providers`, which returns an EMPTY list unless
`DROPBOX_CLIENT_ID` and `DROPBOX_CLIENT_SECRET` are set on the edge. With those
unset — which is the state today — no button renders at all, so a Cloudflare
Pages deploy landing before the migration changes nothing a seller can see.

**OPERATOR, before this does anything:** register a Dropbox app at
https://www.dropbox.com/developers/apps with scopes files.metadata.read,
files.content.read and account_info.read, add
`https://functions.gradethread.com/api/flipdesk/cloud/dropbox/oauth/callback` to
its redirect URIs, then set `DROPBOX_CLIENT_ID` and `DROPBOX_CLIENT_SECRET` in
Coolify.

**OPERATOR, for OneDrive (US-3160, same migration, no second one):** register an
app in the Microsoft Entra portal under App registrations, add
`https://functions.gradethread.com/api/flipdesk/cloud/onedrive/oauth/callback` as
a Web redirect URI, grant the DELEGATED permissions Files.Read and
offline_access, then set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` in
Coolify. Either provider can be enabled without the other; each is absent from
the UI until its own two variables are set.

## ✅ APPLIED 2026-09-08: 00765 — notification_type 'delist_needed' (US-3144)

**Risk: LOW.** One enum value. Nothing is dropped, nothing is rewritten, and no
existing row or query changes.

**Apply order:** after 00764. No `NOTIFY pgrst` needed (no table or column
changed), then redeploy the edge.

**What it adds**
- `notification_type` gains `'delist_needed'`.

**DEPLOY ORDER MATTERS ONE WAY ONLY**, exactly as in 00601. The edge INSERTS
this value (`notifyUser` from `lib/cross-listings.ts`, when a sold item's
cross-listings still need ending). On a database without it the insert fails
with 22P02 and the notice is lost, so the migration must land BEFORE the edge
deploys — the schema-version boot guard is what enforces that, since
EXPECTED_SCHEMA_VERSION moves to 00765 in the same commit. Nothing FILTERS on
the value, so a database that has it while an older edge runs is a no-op.

**Client side is safe either way.** The frontend adds `delist_needed` to its
NotificationType union and a `delist_reminders` preference category, but both
are read-side only — `withPreferenceDefaults` fills the new key from code, so a
Cloudflare Pages deploy landing before the migration shows the new Settings
toggle for notifications that are not being sent yet. Harmless, and it corrects
itself the moment the edge redeploys.

## ✅ APPLIED 2026-09-08: 00764 — push_subscriptions.kind (US-3142)

**Risk: LOW.** One additive column with a default, one CHECK, one index. No
existing row changes and no existing behaviour changes: every current row
defaults to `'browser'`, which is exactly the set `deliverPush` used to send to
before it started filtering.

**Apply order:** after 00763. Then `NOTIFY pgrst, 'reload schema';` (new column),
then redeploy the edge.

**What it adds**
- `push_subscriptions.kind text not null default 'browser'`, constrained to
  `'browser' | 'extension'`.
- `push_subscriptions_user_kind_idx` on `(user_id, kind)`.

**Why**
The browser extension now registers a push subscription of its own, used only to
wake its service worker so it drains the delist queue the moment a cross-listed
item sells. That subscription is silent (`userVisibleOnly: false`) and its worker
shows nothing, so the two kinds must never receive each other's traffic — a real
notification sent to it would vanish, and a silent wake sent to a browser
subscription surfaces as Chrome's generic "updated in the background" notice.

**Deploy-order note.** The edge reads the new column (`deliverPush` filters
`kind = 'browser'`), so the migration must land BEFORE the edge redeploy. If the
edge went first, every push query would 42703 and all web push would stop — the
boot guard is what prevents that, and it is why the order above is not optional.
Nothing on the client side reads it, so a Cloudflare Pages deploy is harmless
either way.

## ✅ APPLIED 2026-09-08: 00763 — Action Credits wallet (US-3138)

**Risk: MEDIUM.** Two new tables plus one new `users` column, all additive. The
medium rating is for what it REPLACES, not what it adds: `reserve_ai_action`
and `refund_ai_action` are rewritten in place. Those two functions are the
single enforcement point for every user-billed AI action in the product.

**Apply order:** 00763 alone, then `NOTIFY pgrst, 'reload schema';` (new tables
and five new RPCs), then redeploy the edge on Coolify, then push.

**What it adds**
- `action_credit_wallet` + `action_credit_transactions` (owner-read RLS,
  service-role writes), cloned from 00415's api_credit_wallet.
- `users.ai_actions_credit_paid_this_month`, default 0.
- `grant_action_credits`, `debit_action_credits`, `refund_action_credits`,
  `clawback_action_credits`, `reserve_ai_action_v2`.
- Explicit `GRANT EXECUTE ... TO service_role` on all seven money functions
  (US-2282 AC4). It ADDS service_role and revokes nothing, because a REVOKE
  segfaults this Postgres image (US-2403). Each function body also refuses any
  role but service_role with an ordinary 42501, which is the actual lock.

**What it changes**
- `reserve_ai_action(uuid, int)` keeps its exact signature and return type and
  now delegates to `reserve_ai_action_v2(..., true)`. An edge container running
  the previous build during the deploy window keeps working unchanged.
- `refund_ai_action(uuid)` keeps its signature and becomes LIFO-aware: it
  returns a failed action to the wallet when the month has credit-paid actions,
  otherwise to the monthly counter as before.

**Safe before the frontend deploys?** Yes. Nothing in the client reads the new
tables until the Task 6 billing-summary change ships, and an empty wallet makes
`debit_action_credits` return -1, so refusals are byte-for-byte what they are
today. A seller who never buys a pack sees no change at all.

**Operator runbook for the storefronts:**
`vault/10-ops/action-credits-storefront-setup.md`.

**Revenue is still gated on operator work** after this applies: four Stripe
prices plus their `STRIPE_PRICE_ACTION_CREDITS_*` env vars, four App Store
Connect consumables, four Play Console products. Until the Stripe prices exist
the checkout route returns 503 "Pricing not configured", which is correct.

## ✅ APPLIED 2026-09-07: 00762 — pooled sold comps, opt-in (US-3136)

**Risk: LOW.** Adds one boolean column defaulting FALSE, plus one read-only
aggregate function. No data movement, no backfill.

⚠ **APPLY AS `psql -U supabase_admin`** — `flipdesk_settings` is owned by that
role, so `ALTER TABLE` fails as `postgres`.

**Applied and verified.** `flipdesk_settings.pooled_comps_opt_in` exists,
default `false`, 0 sellers opted in. `pooled_sold_comps()` returns no rows for
every category, which is correct: 223 eligible sales but only **2 distinct
sellers**, and the floor is 3.

**Proven in a rolled-back transaction before applying** — consent off returns
nothing; all-consented-but-2-sellers returns nothing; a synthetic 3rd seller
makes it answer (6 sales / 3 sellers / percentiles); one seller revoking drops
it back to nothing immediately.

✅ **Policy language landed 2026-09-07** — Privacy Policy §16 and Terms §19,
both effective September 7, 2026. A UI toggle is still the remaining gate: the
switch exists in the database and nothing in the product turns it on yet.

## ✅ APPLIED 2026-09-07: 00761 — fifteen brands whose feeds refused us (US-3125)

**Risk: LOW.** Inserts only, `ON CONFLICT DO NOTHING`. No schema change.

**Applied and verified.** brands 527 → **542**; colorways 17,311 → **17,813**;
with a `base_color` 13,491 → **13,746**; brands with any colorway 272 → **282**;
brands with an RN 196 → **201**. `NOTIFY pgrst, 'reload schema'` sent.

Every brand here was probed earlier and answered with a catalog it would not
serve (429, 503, bot challenge), recorded as "refused, retry" rather than "no
feed". 15 of 30 answered on the retry — which is why that distinction was worth
keeping.

## ✅ APPLIED 2026-09-07: 00760 — validate the brand provenance constraints (US-3126)

**Risk: LOW.** Fixes 45 rows, then validates three existing constraints.
`VALIDATE CONSTRAINT` takes SHARE UPDATE EXCLUSIVE — it does not block reads or
writes. Guarded on `convalidated` so a re-run is a no-op.

⚠ **APPLY AS `psql -U supabase_admin`, NOT `-U postgres`.** `brand_knowledge`
and `brand_colorways` are owned by `supabase_admin`, and `VALIDATE CONSTRAINT`
requires ownership. As `postgres` it fails with *must be owner of table
brand_knowledge*, and `set local role supabase_admin` is refused as well.

**Applied and verified.** All five CHECK constraints on the two tables now read
`convalidated = t`; rows failing `tag_eras_all_sourced` 45 → **0**.

Closes US-3126, whose stated "11 blocking rows" was an estimate: the real count
was 90 at 00748, 45 after 00757, 0 here. The two `brand_fact_is_sourced`
constraints failed on zero rows the whole time and were simply never validated.

## ✅ APPLIED 2026-09-07: 00759 — house colour vocabulary (US-3125)

**Risk: LOW.** UPDATEs guarded by `base_color is null`, so a re-run is a no-op.
No schema change, no new rows.

**Applied and verified.** colorways with a `base_color` 11,307 → **13,491**
(2,184 resolved of 6,004); with a `shade` → **1,437**. Row and brand counts
unchanged. `NOTIFY pgrst, 'reload schema'` sent.

⚠ **This migration ships a CODE change with it.** The vocabulary went into
`COLOR_FAMILY` in `services/edge-functions/src/lib/aspect-normalize.ts` (and its
web mirror `src/lib/aspect-normalize.ts`), not into a table inside the SQL, so
the KB and the live normaliser cannot disagree. The listing path gets the same
benefit: a garment described as "Espresso" now normalises to Brown for eBay's
Color aspect whether or not its brand is in this KB.

## ✅ APPLIED 2026-09-07: 00758 — colorways read from product titles (US-3134)

**Risk: LOW.** Colorway inserts only, `ON CONFLICT (brand_key, color_name) DO
NOTHING`. No schema change, no `brand_knowledge` rows.

**Applied and verified.** colorways 11,555 → **17,311**; with a `base_color`
7,352 → **11,307**; brands with any colorway 248 → **272**. Brand count
unchanged at 527. `NOTIFY pgrst, 'reload schema'` sent.

5,756 rows at confidence **0.55**, not the 0.75 option-derived rows carry: a
title suffix is a heuristic, a variant option is a declaration.

Closes US-3134. `shopify-brand-harvest.mjs` gained title parsing plus a
`colourSource` of `option` / `title` / `none`.

## ✅ APPLIED 2026-09-07: 00757 — registered numbers for 80 held brands (US-3125)

**Risk: LOW.** UPDATEs only, guarded by `cardinality(registered_numbers) = 0`
so a re-run is a no-op. No schema change, no new rows.

**Applied and verified.** brands with an RN 116 → **196**; 91 numbers across 80
brands. Brand and colorway counts unchanged. `NOTIFY pgrst, 'reload schema'`
sent.

Side effect worth knowing: rows failing `brand_knowledge_tag_eras_sourced` fell
88 → **45**, because every RN write is an UPDATE and had to carry the same
narrow provenance fix 00748 used. US-3126 updated.

## ✅ APPLIED 2026-09-07: 00756 — palettes for 40 brands that had none (US-3125)

**Risk: LOW.** Colorway inserts only, `ON CONFLICT (brand_key, color_name) DO
NOTHING`. No schema change, no `brand_knowledge` rows.

**Applied and verified.** colorways 10,660 → **11,555**; with a `base_color`
6,610 → **7,352**; brands with any colorway 208 → **248**. Brand count unchanged
at 527, as intended. `NOTIFY pgrst, 'reload schema'` sent.

First DEEPENING migration rather than a widening one: 319 held brands had no
colour at all, 173 of those answer an open feed, and all 173 were harvested.

Deliberately does NOT apply 00734's "no more than 35% plain colour words" rule —
that rule rejected all 40 brands and is about whether a palette is worth adding
to a brand that already has one. See the migration header.

## ✅ APPLIED 2026-09-07: 00755 — nineteen merino, cashmere and slow-fashion brands (US-3125)

**Risk: LOW.** Inserts only, `ON CONFLICT DO NOTHING`. No schema change.

**Applied and verified.** brands 508 → **527**; colorways 10,371 → **10,660**;
with a `base_color` 6,435 → **6,610**; brands with any colorway 201 → **208**;
brands with an RN 113 → **116**. `NOTIFY pgrst, 'reload schema'` sent.

Icebreaker settles a question 00748 left open: VF Outdoor registered it as
"Icebreaker, A Division of VF Outdoor LLC", naming the label, while Smartwool's
only hit was a bare "VF OUTDOOR, LLC". Same parent, opposite verdicts, and the
rule reads both correctly from the registrant string alone.

## ✅ APPLIED 2026-09-07: 00754 — seventeen golf, denim and British menswear brands (US-3125)

**Risk: LOW.** Inserts only, `ON CONFLICT DO NOTHING`. No schema change.

**Applied and verified.** brands 491 → **508**; colorways 10,268 → **10,371**;
with a `base_color` 6,378 → **6,435**; brands with any colorway 199 → **201**;
brands with an RN 108 → **113**. `NOTIFY pgrst, 'reload schema'` sent.

**This run passes the loop's colour goal: 201 brands with real colour data.**

Five registered numbers sourced. Fair Harbor is the first time the 00750
vintage rule has been used to CHOOSE between two same-name registrants rather
than to reject one.

## ✅ APPLIED 2026-09-07: 00753 — seventeen snow, surf and bike brands (US-3125)

**Risk: LOW.** Inserts only, `ON CONFLICT DO NOTHING`. No schema change.

**Applied and verified.** brands 474 → **491**; colorways 9,418 → **10,268**;
with a `base_color` 5,953 → **6,378**; brands with any colorway 189 → **199**;
brands with an RN 102 → **108**. `NOTIFY pgrst, 'reload schema'` sent.

Six brands, nine registered numbers — Dakine and Jetty each hold two, one
company registered twice decades apart. Eleven refused, three of them a new
shape: a founder registering in their own name for exactly the goods the brand
makes.

## ✅ APPLIED 2026-09-07: 00752 — seventeen DTC womenswear and training brands (US-3125)

**Risk: LOW.** Inserts only, `ON CONFLICT DO NOTHING`. No schema change.

**Applied and verified.** brands 457 → **474**; colorways 9,125 → **9,418**;
with a `base_color` 5,693 → **5,953**; brands with any colorway 182 → **189**;
brands with an RN 100 → **102**. `NOTIFY pgrst, 'reload schema'` sent.

Only two registered numbers, and that is the finding: this batch is social-first
DTC brands founded mostly after 2015, and the RN hit rate collapses from roughly
half to two in seventeen. An absent RN reflects a brand's age and supply chain,
not its legitimacy.

## ✅ APPLIED 2026-09-07: 00751 — eighteen running, intimates and bag brands (US-3125)

**Risk: LOW.** Inserts only, `ON CONFLICT DO NOTHING`. No schema change.

**Applied and verified.** brands 439 → **457**; colorways 8,566 → **9,125**;
with a `base_color` 5,320 → **5,693**; brands with any colorway 171 → **182**;
brands with an RN 92 → **100**. `NOTIFY pgrst, 'reload schema'` sent.

Eight registered numbers sourced, ten refused. The vintage rule written down in
00750 caught its first live case one run later: ALTRA CORP., INC. at RN 73198
is an exact name plus a generic word, issued long before Altra Running existed.

## ✅ APPLIED 2026-09-07: 00750 — twenty-five sleep, baby and hosiery brands (US-3125)

**Risk: LOW.** Inserts only, `ON CONFLICT DO NOTHING`. No schema change.

**Applied and verified.** brands 414 → **439**; colorways 7,941 → **8,566**;
with a `base_color` 4,979 → **5,320**; brands with any colorway 158 → **171**;
brands with an RN 84 → **92**. `NOTIFY pgrst, 'reload schema'` sent.

Eight registered numbers sourced, seventeen refused. Sheertex is a new kind of
refusal: RN 14756 SHEERTEX HOSIERY MILL INC matches the name and the industry
exactly, but RNs are issued in sequence and 14756 was issued decades before
Sheertex existed (2017). It is an older namesake.

## ✅ APPLIED 2026-09-07: 00749 — twenty-three outdoor, field and formal brands (US-3125)

**Risk: LOW.** Inserts only, `ON CONFLICT DO NOTHING`. No schema change.

**Applied and verified.** brands 391 → **414**; colorways 7,500 → **7,941**;
with a `base_color` 4,689 → **4,979**; brands with any colorway 146 → **158**;
brands with an RN 73 → **84**. `NOTIFY pgrst, 'reload schema'` sent.

Eleven registered numbers sourced, including the first personal-name acceptance
(Ulla Johnson → ULLA VASILIA JOHNSON). Twelve refused: six return nothing, Huk
and Rouje are the substring trap, three return an unrelated registrant, and
Monos returns an exact name in the wrong industry.

NOBULL appears for its colours only — 00748 seeded the brand row but its feed
answered 503 that day. The brand insert is a no-op.

## ✅ APPLIED 2026-09-07: 00748 — twenty-two workwear, sleepwear and sport brands, plus a repair (US-3125)

**Risk: LOW.** Inserts plus a narrow repair of two rows 00747 duplicated. No
schema change.

**Applied and verified.** brands 371 → **391** (22 in, 2 duplicates removed);
colorways 7,034 → **7,500**; with a `base_color` 4,346 → **4,689**; brands with
any colorway 136 → **146**; brands with an RN 62 → **73**.
`NOTIFY pgrst, 'reload schema'` sent.

Eleven registered numbers sourced. Eleven refused: six return nothing, and five
return a registrant sharing no token with the label (Smartwool → VF OUTDOOR,
Eberjey → WORLD THREADS, BRUNT → Maverick Work Wear, Pair of Thieves →
Stateside Merchancts, Lo & Sons → seventeen unrelated "& Sons" registrants).

**The repair:** 00747 minted `stussy` and `aimeleondore`, not knowing 00456/00462
had deliberately stripped the accents to `stssy` and `aimleondore` — keys pinned
by `brand-knowledge-golden_test.ts`. The two new rows are folded back into the
established keys; the RNs and the 26 Aimé Leon Dore colorways survive.

## ✅ APPLIED 2026-09-07: 00747 — seventeen skate, surf and streetwear brands (US-3125)

**Risk: LOW.** Inserts only, `ON CONFLICT DO NOTHING`. No schema change.

**Applied and verified.** brands 354 → **371**; colorways 6,635 → **7,034**;
with a `base_color` 4,078 → **4,346**; brands with any colorway 129 → **136**;
brands with an RN 55 → **62**. `NOTIFY pgrst, 'reload schema'` sent.

Seven registered numbers sourced from the FTC register, two of them decided by
product line (Hurley against five people named Hurley, Noah against eighteen
other registrants). Ten refused: six return nothing, Emerica and Roxy are the
substring trap, Billabong returns a registrant sharing no token with the label,
and Primitive returns two equally good candidates.

## ✅ APPLIED 2026-09-07: 00746 — eighteen outdoor, running, maternity and kids brands (US-3125)

**Risk: LOW.** Inserts only, `ON CONFLICT DO NOTHING`. No schema change.

**Applied and verified.** brands 336 → **354**; colorways 6,027 → **6,635**;
with a `base_color` 3,693 → **4,078**; brands with any colorway 119 → **129**;
brands with an RN 51 → **55**.

## ✅ APPLIED 2026-09-09: 00745 — the resale supply index tables (US-3132)

**Risk: LOW-MEDIUM.** Two NEW tables, no change to an existing one, no data
migrated, nothing dropped. The medium half is only that it is the first schema
change in this run of otherwise insert-only brand migrations.

**What it creates**

- `marketplace_supply_cells`: the ~204 market cells we measure. Seeded by the
  migration: 12 category-only rows, plus the 32 brands with the deepest
  colorway coverage crossed with 6 garment terms.
- `marketplace_supply_samples`: one live-listing count per cell per day.
  `unique (cell_key, observed_on)` so a re-run cannot double-count a day.

Both are deny-all: RLS on, zero policies, `revoke all from anon, authenticated`,
copied from `00663`. Table revokes only, and no function revoke anywhere in the
file, per the `00609` rule.

**Verified before holding.** Applied twice against a real Postgres 15 on a
scratch database: second run inserted 0 rows and the cell count held at 72 (10
stub brands rather than prod's 32). The unique constraint refused a duplicate
`(cell_key, observed_on)`, and the check constraint refused a negative listing
count. The seeded `cell_key` values were read back and match `normalizeItemKey`
exactly (`levi's|11450|jeans`, `|11450|jacket`), which is the join the whole
index rests on.

**Apply order:** after 00744. Nothing else depends on it.

**No client reads this.** Both tables are service-role only and no frontend code
touches them, so the Cloudflare Pages auto-deploy on push is safe here; the
usual "the SPA breaks the moment you push" hazard does not apply.

**After applying:** `NOTIFY pgrst, 'reload schema';` (two new tables).

**The cron does nothing until you register it.** `supply-sample` is entry 86 in
`services/edge-functions/CRON_SETUP.md` (`10 4 * * *`). Until it is added in
Coolify the tables stay empty, which is harmless but means the 30-day clock has
not started.

## ✅ APPLIED 2026-09-06: 00744 — twenty-one womenswear, swim and merino brands (US-3125)

**Risk: LOW.** Inserts only, `ON CONFLICT DO NOTHING`. No schema change.

**Applied and verified.** brands 315 → **336**; colorways 5,140 → **6,027**;
with a `base_color` 3,121 → **3,693**; brands with any colorway 107 → **119**;
brands with an RN 45 → **51**.

> [!warning] This file collided with 00744_marketplace_supply_index.sql
> Two agents minted 00744 within minutes of each other. This one was already
> APPLIED to prod when the collision was found, which is the tiebreaker — an
> applied migration is the least editable artifact in the repo. The other was
> renamed to 00745 by its own author and `EXPECTED_SCHEMA_VERSION` now tracks
> that. `migrations-lint` is what caught it; nothing reached prod twice.

## ✅ APPLIED 2026-09-06: 00743 — nineteen heritage, workwear and surf brands (US-3125)

**Risk: LOW.** Inserts only, `ON CONFLICT DO NOTHING`. No schema change.

**Applied and verified.** brands 296 → **315**; colorways 5,041 → **5,140**;
brands with an RN 41 → **45**.

## ✅ APPLIED 2026-09-06: 00742 — nineteen more brands (US-3125)

**Risk: LOW.** Inserts only, `ON CONFLICT DO NOTHING`. No schema change.

**Applied and verified.** brands 277 → **296**; colorways 4,552 → **5,041**;
with a `base_color` 2,743 → **3,048**; brands with any colorway 92 → **104**;
brands with an RN 34 → **41**.

## ✅ APPLIED 2026-09-06: 00741 — fifteen more brands (US-3125)

**Risk: LOW.** Inserts only, `ON CONFLICT DO NOTHING`. No schema change.

**Applied and verified.** brands 263 → **277** (14 inserted; Girlfriend
Collective already existed from 00465 and was left alone); colorways 4,160 →
**4,552**; with a `base_color` 2,517 → **2,743**; brands with any colorway
87 → **92**; brands with an RN 28 → **34**.

## ✅ APPLIED 2026-09-06: 00740 — nineteen more brands (US-3125)

**Risk: LOW.** Inserts only, `ON CONFLICT DO NOTHING`. No schema change.

**Applied and verified.** brands 244 → **263**; colorways 3,139 → **4,160**;
with a `base_color` 1,908 → **2,517**; brands with any colorway 76 → **87**;
brands with an RN 23 → **28**.

## ✅ APPLIED 2026-09-06: 00739 — eight new brands, and colorways for ten (US-3125)

**Risk: LOW.** Inserts only, `ON CONFLICT DO NOTHING`. No schema change, no
`NOTIFY pgrst`.

**Applied and verified.** brands 236 → **244**; colorways 2,294 → **3,139**;
with a `base_color` 1,354 → **1,908**; brands with any colorway 69 → **76**;
brands with an RN 21 → **23**.

New: Alice + Olivia, TravisMathew, Robert Graham, St. John, Sundry, Toad&Co,
Veronica Beard, David Donahue.

## ✅ APPLIED 2026-09-06: 00738 — colour buckets from each brand's own facet tags (US-3125)

**Risk: LOW.** Data only, and it touches ONLY rows where `base_color IS NULL`,
so nothing 00737 derived is overwritten and a re-run changes nothing. No schema
change, no `NOTIFY pgrst`.

**Applied and verified.** `base_color` 1,281 → **1,354**, `shade` 164 → **200**.

The qualitative win rather than the count: denim wash names now resolve.
`Coffee Bean` → Brown, `Optical White` → White, `Halona` → Blue/Dark,
`Arizona` → Blue/Light, `Hilo` → Blue/Medium.

## ✅ APPLIED 2026-09-06: 00736 + 00737 — Herschel's decoder, and colour buckets (US-3125)

**00736** — Herschel SKU decoder plus the 224 colour codes attached to colorway
aliases. Data only.

**00737** — ⚠ **SCHEMA CHANGE.** Adds `brand_colorways.base_color` and
`.shade`, then populates 1,314 rows.

> [!warning] 00737 must be applied as `supabase_admin`, not `postgres`
> The tables are owned by `supabase_admin`, so `ALTER TABLE` as `postgres`
> fails with `must be owner of table brand_colorways`. Every earlier brand
> migration was data-only and did not hit this.
>
> `NOTIFY pgrst, 'reload schema'` IS required here — two new columns — and was
> run. Earlier packs in this series needed none.

**Applied and verified.** 2,294 colorways: 1,281 with a `base_color`, 164 with a
`shade`.

## ✅ APPLIED 2026-09-06: 00735 — denim fit names for 7FAM and MOTHER (US-3125)

**Risk: LOW.** 39 inserts into `brand_styles`, `ON CONFLICT DO NOTHING`.

**Applied and verified.** `brand_styles` 779 → **818**.

## ✅ APPLIED 2026-09-06: 00734 — colorways for 26 brands, from their own catalogues (US-3125)

**Risk: LOW.** 1,954 inserts into `brand_colorways`, `ON CONFLICT DO NOTHING`.
No schema change, no `NOTIFY pgrst`.

**Applied and verified.** `brand_colorways` 340 → **2,294**; brands with any
colorway 43 → **69** of 236.

## ✅ APPLIED 2026-09-06: 00733 — Faherty, Peruvian Connection, UNTUCKit (US-3125)

**Risk: LOW.** Inserts with `ON CONFLICT DO NOTHING` plus three guarded note
updates. No schema change, no `NOTIFY pgrst`.

**Applied and verified.** 125 colorways and 6 product lines.
`brand_colorways` 215 → **340**, brands with any colorway 41 → **43**,
`brand_styles` 773 → **779**.

Sourced from each brand's own Shopify feed: Faherty 1,250 products, Peruvian
Connection 3,000, UNTUCKit 549.

## ✅ APPLIED 2026-09-06: 00732 — Free Fly, a full pack (US-3125)

**Risk: LOW.** Inserts only, all `ON CONFLICT DO NOTHING`, plus one guarded
`UPDATE` to the brand's notes. No schema change, no `NOTIFY pgrst`.

**Applied and verified.** 56 colorways, 10 product lines, 1 style-code decoder.
Corpus totals: brand_colorways 159 → **215**, brands with any colorway 40 → **41**,
brand_styles 763 → **773**, brand_style_codes 32 → **33**.

Sourced from the brand's own Shopify `/products.json` (1,008 products) via
`scripts/ops/shopify-brand-harvest.mjs`.

## ✅ APPLIED 2026-09-06: 00731 — six brands sellers hold that the KB lacked (US-3125)

**Risk: LOW.** Six `INSERT`s into `brand_knowledge` with `ON CONFLICT DO UPDATE`,
so it is safe to re-run. No schema change, no `NOTIFY pgrst`.

**Applied and verified.** Brands 230 → **236**; brands carrying an RN 15 → **21**.
`applied_migrations` tops out at 00731.

prAna, Pact, Mizzen+Main, Free Fly, Peruvian Connection and BYLT, each with an
FTC-sourced registered number.

> [!warning] These are MINIMAL packs and the empty columns are deliberate
> `tag_eras`, `country_patterns` and `authentication_tells` are empty arrays and
> every row's notes say so. An empty array here means NOT RESEARCHED — it does
> not mean "researched and there is nothing", which is what an unexplained empty
> column reads as.

## ✅ APPLIED 2026-09-06: 00730 — Peter Millar's registrant, and Johnnie-O's RN (US-3128)

**Risk: LOW.** Data only, three `UPDATE`s on `brand_knowledge`. No table, column,
function or policy changes, so no `NOTIFY pgrst`. Idempotent: each write is
guarded on the value not already being present.

**Applied and verified.** `applied_migrations` tops out at 00730, brands carrying
an RN went 14 to 15, and `tag_eras_all_sourced('petermillar')` now returns true
where it returned false.

**What it does.**
1. Sources Peter Millar's one datable `tag_era`. That era had no `source_url`
   and no `confidence`, which froze the entire row — `brand_knowledge_tag_eras_sourced`
   is NOT VALID so it never checked existing rows, but it checks any row an
   UPDATE touches. Nothing about Peter Millar could be edited until this ran.
2. Records the confirmed registrant for RN 100308: **CHESTER GREGG, L.L.C.**,
   product line KNIT SHIRTS. 00467 seeded that number from Peter Millar's own
   help centre and stated it could not confirm the registrant.
3. Seeds Johnnie-O **RN 121927** (registrant "JOHNNIE-O").

**Verify:**

```sql
select canonical_brand, registered_numbers
from public.brand_knowledge where brand_key in ('petermillar','johnnieo');
select public.tag_eras_all_sourced(tag_eras)
from public.brand_knowledge where brand_key = 'petermillar';   -- expect t
```

## ✅ APPLIED 2026-09-06: 00729 — registered numbers from the FTC register (US-3128)

**Applied and verified.** `applied_migrations` now tops out at 00729, and the
verification query below returns **14 rows** (was 6).

**Risk: LOW.** Data only. It `UPDATE`s `registered_numbers` on eight existing
`brand_knowledge` rows and appends one provenance sentence to their `notes`. It
creates nothing, drops nothing, and changes no function or policy. No `NOTIFY
pgrst` is needed: no table, column or RPC changes shape.

**Idempotent.** `registered_numbers` is SET rather than appended, and the notes
sentence is added only when that RN is not already named there, so a second run
is a no-op.

**Apply order.** DB first, then the edge, as usual — but nothing in the running
container reads these values in a way that breaks either way round.
`EXPECTED_SCHEMA_VERSION` moves 00728 → 00729 in the same commit.

**Dry-run against prod inside a transaction that rolled back**, before this was
committed. Result: brands carrying an RN go from 6 to 14.

> [!warning] The first dry run FAILED, and that is why this note exists
> The file originally seeded ten brands. Two of them — `vineyardvines` and
> `bonobos` — were refused by `brand_knowledge_tag_eras_sourced`:
>
> ```
> ERROR: new row for relation "brand_knowledge" violates check constraint
>        "brand_knowledge_tag_eras_sourced"
> ```
>
> That constraint is `NOT VALID`, so it never checked the existing rows — but it
> DOES check any row an `UPDATE` touches. Both brands carry datable `tag_eras`
> with no `source_url` or `confidence`, so old unsourced data blocked a new,
> properly sourced edit to the same row.
>
> **Both RNs are confirmed and are held back, not abandoned** (RN 134578
> VINEYARD VINES, LLC and RN 128054 BONOBOS, INC.). They land once US-3126
> sources those eras. The other eight were each checked against
> `public.tag_eras_all_sourced()` individually before being included.

**Verify after applying:**

```sql
select canonical_brand, registered_numbers
from public.brand_knowledge
where array_length(registered_numbers, 1) > 0
order by canonical_brand;   -- expect 14 rows
```

## ✅ APPLIED 2026-09-06: 00728 — the filter learns "Sourced by" (US-3122)

**Applied by the owner 2026-09-06.** `GET https://functions.gradethread.com/health/ready`
reports `schema: {"expected":"00727","applied":"00728","status":"ahead"}` — the
database has the record and the running container is the previous build, which
is the ordinary mid-deploy state. The `applied_migrations` row IS the evidence
the whole file ran: the self-record footer is its last statement.

**What it does.** Restates `public.flipdesk_filter_matches(jsonb, jsonb)` with
one new field:

```
when 'sourced_by' then txt := f ->> 'sourced_by';
```

plus a partial index on `(user_id, lower(btrim(sourced_by)))` for the sort and
the filter that now both read that column.

**Risk: LOW.** `CREATE OR REPLACE` on the same signature, and every other branch
is byte-identical to 00515's. `CREATE INDEX IF NOT EXISTS` (not concurrent —
`inventory_items` is small and this runs in the apply step, not under load).
Re-running is safe.

**Why the field had to reach the database at all.** This function is the SQL
mirror of `evalQuery()` in `src/lib/item-filter.ts`, and the client is what
sends the rule. A field the TypeScript knows and the function does not is NOT a
no-op: `field` falls through the CASE, `txt` stays NULL, and an `eq` rule
matches ZERO rows. The seller would get an empty Inventory list with no error.
That failure mode is why the frontend half of US-3122 was held with it.

**Verified before the apply**, against the local stack with the file applied:
`LISTING_PARITY_DB=1 npx vitest run src/test/listing-page-sql-parity.test.ts` →
84 passed, including six new `sourced_by` cases. Re-running those six against
the PRE-00728 function fails all six, so the cases are load-bearing rather than
vacuous.

**`NOTIFY pgrst, 'reload schema';`** — not strictly required (no table or column
that PostgREST serves changed shape; the function is called from inside
`flipdesk_listing_page`, not over the wire), but harmless.

---

## ✅ APPLIED 2026-09-05: 00727 - the seller's off switch for the on-marketplace badge (US-3060)

**Applied by the owner 2026-09-05, verified read-only the same minute.**
`GET https://functions.gradethread.com/health/ready` reports
`schema: {"expected":"00726","applied":"00727","status":"ahead"}` — the database
has it and the still-running container is the previous build, which is exactly
the mid-redeploy state. `database: ok` on the same read.

The `applied_migrations` record is itself the evidence the column exists: the
self-record footer is the LAST statement in the file, so a failed
`ADD COLUMN` would have aborted the apply before it ever ran.

**What it does.** One column:

```
ALTER TABLE public.flipdesk_settings
  ADD COLUMN IF NOT EXISTS listing_badge_opt_out boolean NOT NULL DEFAULT false;
```

`false` means badges ON. The badge only ever renders for a listing the seller
already paid to grade and already published with a public certificate, so it
surfaces a fact they have already made public rather than disclosing a new one.

**Risk: LOW.** `ADD COLUMN ... NOT NULL DEFAULT false` does not rewrite the
table on Postgres 11+, and `flipdesk_settings` is small (one row per seller who
has touched a FlipDesk setting). Idempotent — `IF NOT EXISTS`, safe to re-run.
No backfill: every existing row gets the default, which is the behaviour every
seller has today.

**Apply order:** 00727 alone; nothing else is pending.

**`NOTIFY pgrst, 'reload schema';` IS REQUIRED.** A new column on a table
PostgREST already serves is invisible until the schema cache reloads, and the
SPA writes this column through PostgREST.

**⚠ THE EDGE READS THIS COLUMN AND IS BUILT TO SURVIVE ITS ABSENCE, DELIBERATELY.**
`loadOptOuts` in `routes/public-grading.ts` treats a 42703 undefined-column error
as "nobody has opted out", which is CORRECT rather than permissive: between the
deploy and this apply there is no column, no switch, and no way anyone could
have expressed the preference. Every OTHER error from that read fails CLOSED and
returns no badges, because once the column exists an unreadable settings row
means we do not know who opted out. So the ordering is safe in both directions,
and the only thing the gap costs is that the switch is not yet writable.

## APPLIED 2026-09-04: 00726 - undo 00724's REVOKE on pollable_ebay_owner_ids (US-3110 follow-up)

**Verified applied 2026-09-04, and verified WORKING, which is not the same check.** Three reads against production, all from a laptop with nothing but the anon key that ships in the browser bundle:

1. `/health/ready` on the edge reports `applied: 00726`.
2. PostgREST's OpenAPI document, fetched with the anon key, LISTS `/rpc/pollable_ebay_owner_ids` again. Visibility there means anon HOLDS execute, which is the whole fix: a role that holds execute never takes the denial path, so there is no permission error for supautils to decorate and nothing to segfault. It sits alongside `bump_ebay_api_calls` (00720) and `rebuild_ledger_for_user` (00686), the two earlier repairs of this same mistake, which is the shape to expect.
3. `POST /rest/v1/rpc/pollable_ebay_owner_ids` as anon returns **HTTP 401, code 42501, 'pollable_ebay_owner_ids: service role only'** and NO rows. So the permission was not loosened by restoring the grant - the body check is doing the work the revoke used to do, and doing it without the crash surface. `/health/ready` still reports `database: ok` after that call, which under the old revoke on a hint_roles image is exactly the call that would have restarted the database.

That third read is the one worth copying. A revoke can only be tested by making the call it forbids, which is why nobody tested one before; a body check can be tested by anyone, from anywhere, without credentials and without risk.

**Why it exists.** 00724 shipped with

```
revoke all on function public.pollable_ebay_owner_ids(timestamptz) from public;
revoke all on function public.pollable_ebay_owner_ids(timestamptz) from anon;
revoke all on function public.pollable_ebay_owner_ids(timestamptz) from authenticated;
```

On this Postgres image a DENIED function call from a role in
`supautils.hint_roles` segfaults the backend and restarts the database, because
supautils appends a GRANT hint to the permission error (US-2403). `anon` is the
key in the browser bundle and PostgREST exposes the function at
`/rpc/pollable_ebay_owner_ids`. Third time for this shape: 00686 fixed 00685,
00720 fixed 00711, 00726 fixes 00724.

**Risk: LOW, and this is NOT an incident.** Production does not reproduce the
crash: `current_setting('supautils.hint_roles', true)` reads NULL on the prod
image, read read-only over SSH on 2026-09-02 (US-2403 AC1/AC6). A denied call
there returns an ordinary error today. The LOCAL image does reproduce it. So
00726 removes a landmine that an image upgrade would arm, and gets
`src/test/us2403-function-revoke-gate.test.ts` back to green - it had been red on
`main` since 00724 landed, which is the part that costs the next person time.

**What changes.** `create or replace` on the function: same result set, same
`security definer`, same pinned `search_path`, body converted from `sql` to
`plpgsql` so the authorization check can live in it. Then
`grant execute ... to public`, which is what disarms the crash - a role that
HOLDS execute never takes the denial path. The permission is not loosened: the
body raises 42501 for any PostgREST caller that is not `service_role`, which is
stricter than the revoke was and has to be, because this function returns other
tenants' owner ids by design.

**Apply order.** `00726` alone, then `NOTIFY pgrst, 'reload schema';` (the
function signature is unchanged but the body is replaced). The edge can go
before or after - it calls this with the service-role key either way, and the
old grant and the new one both let it through. `EXPECTED_SCHEMA_VERSION` is
bumped to `00726` in the same commit, so the edge boot guard wants 00726 applied
before the container restarts.

**Client-side read risk: NONE.** No column, no type, no table. Nothing in `src/`
or the edge reads a permission.

## ✅ APPLIED 2026-09-03: 00725 — stagger the per-SKU eBay offer read (US-3111)

**Verified applied 2026-09-03** by `npm run migrate:prod` (dry run): prod records
version 00725 and `inventory_items.ebay_offer_checked_at` exists. The doc had
gone stale, which is the drift the new tool exists to catch.

**Risk: LOW.** One nullable `timestamptz` on `inventory_items`. No backfill, no
constraint, no index, no rewrite. Every row starts null, which is the "never
asked" state that forces a read — so the first pass after deploy behaves exactly
like today and the saving starts on the second.

**Apply BEFORE the edge deploy.** The new edge SELECTs
`inventory_items.ebay_offer_checked_at` by name. If the edge goes first,
PostgREST answers 42703, `loadRecentlyReadOfferSkus` logs a warning and returns
an empty set — so it degrades to today's full fan-out rather than breaking, but
the stamp write would fail on every pass and fill the sync run with errors.

**`NOTIFY pgrst, 'reload schema';`** after applying — one new column, read by
name through PostgREST.

**The frontend does not read it.** A Cloudflare Pages deploy alone is harmless.

**What it is for.** 00724 took the catalog from ~41 full passes a day to 4 per
connection. What remains is the pass itself: `listAllOffers` fans out one
`GET /sell/inventory/v1/offer?sku=` per SKU across eBay's entire inventory list —
984 SKUs — and only 301 of 940 eBay listing rows carry an offer id, so most of
those calls ask about Seller-Hub listings that have no Inventory-API offer and
never will. eBay returns nothing, we store nothing, we ask again in six hours.
The same shape as the item-specifics bug 00724 fixed.

**What moves to a daily cadence, and what does not.** Price, quantity, title,
category and listing status for ACTIVE listings arrive from GetMyeBaySelling in
about seven paged calls on the same pass, so nothing a seller reads goes stale.
What the per-SKU offer read uniquely provides is the offer-level detail and the
detection of a listing that ENDED WITHOUT SELLING. eBay publishes no notification
topic for a listing ending, so polling is the only way we learn it. After this,
an unsold ended listing moves back to Drafts within 24 hours instead of 6.

**The rejected alternative, recorded so it is not re-proposed.** Treating
"missing from the bulk active list" as proof a listing ended would take the
per-SKU read close to zero. It is not worth it: if GetMyeBaySelling ever returns
a truncated page, that logic moves LIVE listings into Drafts, and nobody would
notice until a seller complained. The existing ended-detection is deliberately
observation-based, never absence-based, and this keeps it that way.

**Both failure paths fail open.** A missing column, a failed read, an
unparseable or future-dated stamp all resolve to "read this SKU", which is the
pre-change behaviour. A failed stamp write is logged and recorded on the sync
run rather than swallowed, because a silent failure here restores the full
fan-out invisibly.

**Also in this file: `marketplace_connections.disputes_access_denied` (US-3112).**
`payment_dispute_summary` needs the `sell.payment.dispute` scope, which
`sell.fulfillment` does NOT cover despite the shared URL prefix. Measured on
prod 2026-09-03: one of the two connections does not hold it, and the
marketplace-event sweep asked anyway every fifteen minutes — about 160 calls a
day that could never succeed. The flag stops the asking and is the signal a
"reconnect your eBay account" prompt can read. Mirrors `analytics_access_denied`
and `negotiation_access_denied`, which are on this table for the same reason.
It is NOT set on eBay's "no disputes" 404: an account with no disputes today can
have one tomorrow and must keep being polled. Reads fail OPEN — an unreadable
flag means ask eBay, never stay silent about a seller's disputes.

**Verified on a throwaway local stack:** applied from clean and re-applied
(idempotent, only the expected "already exists, skipping" notice); the US-1108
self-record footer present; `EXPECTED_SCHEMA_VERSION` bumped to 00725 in the same
commit with the manifest regenerated; `migrations-lint` green at 721 migrations.

## ✅ APPLIED 2026-09-03: 00724 — stop the eBay sync re-reading what it already knows (US-3110)

**Verified applied 2026-09-03** by `npm run migrate:prod` (dry run): every one of
the 721 local migration files is recorded on prod, 00724 included.

**Risk: LOW-MEDIUM.** Two nullable `timestamptz` columns, three indexes, and one
new `SECURITY DEFINER` function. No backfill, no constraint, no rewrite. Every
existing row keeps working with the columns null, which is the "never read yet"
state the code already handles.

**Apply BEFORE the edge deploy.** The new edge SELECTs
`marketplace_connections.last_catalog_synced_at` and
`inventory_items.ebay_specifics_checked_at` by name, and calls the RPC
`pollable_ebay_owner_ids`. If the edge goes first, PostgREST answers 42703 on the
two selects and the eBay sync fails outright. The RPC call is the one part that
degrades gracefully: `loadPollableEbayOwnerIds` catches the error and falls back
to polling every connected owner, which is exactly today's behaviour.

**`NOTIFY pgrst, 'reload schema';`** after applying — two new columns and a new
RPC, all reached through PostgREST by name.

**The frontend does not read any of this.** A Cloudflare Pages deploy on its own
is harmless.

**What it is for.** Measured on prod over 2026-09-01..03, two connected sellers
made 33,002 eBay calls a day and peaked at 4,941 of the 5,000 daily Trading
allowance. Three causes, all fixed in the same commit:

- `doListingsPull` always fanned out one `GET /sell/inventory/v1/offer?sku=` per
  SKU before it looked at orders, and the two callers that only ever need orders
  (the notification webhook and the order backstop) fired it every few minutes.
  25,312 calls a day, about 41 full catalog reads. `last_catalog_synced_at` lets
  an orders-only pull skip that and upgrade itself to a full read every 6 hours.
- The item-specifics fill had no negative cache. A field eBay has no value for
  stays blank, so `needsSpecifics` was true again on the next sync and the same
  item was re-read forever — roughly 3,300 Trading calls a day against a 5,000
  ceiling. `ebay_specifics_checked_at` remembers that we asked.
- The marketplace-event sweep polled six eBay endpoints for every connected
  seller every fifteen minutes whether or not anything could have happened to
  them: 576 calls per seller per day of fixed cost, paid identically by a dormant
  trial account and a real shop. `pollable_ebay_owner_ids` narrows it to owners
  with an active listing, a recent sale, or an open case.

**The `SECURITY DEFINER` function returns other tenants' owner ids by design**,
which is why it is revoked from `public`, `anon` and `authenticated` and granted
only to `service_role`. The edge calls it with the service-role key. It is a
`stable` read with no writes and no dynamic SQL, and `search_path` is pinned.

**The gate FAILS OPEN.** If the RPC is missing or errors, the sweep polls every
connected owner and logs a warning. The failure we can afford is a wasted call;
the one we cannot is a seller who never hears that a payment dispute was opened.

**Verified on a throwaway local stack:** applied from clean and re-applied
(idempotent, only the expected "already exists, skipping" notices); the RPC
executes and returns 0 rows on an empty schema; the US-1108 self-record footer
is present; `EXPECTED_SCHEMA_VERSION` bumped to 00724 in the same commit with the
manifest regenerated; `migrations-lint` green at 720 migrations.

## ✅ APPLIED 2026-09-03: 00723 — credit functions must refuse anon (US-3094)

**Applied.** The production edge's `/health/ready` reports
`schema: { expected: "00723", applied: "00723", status: "match" }` (read from
the running service on 2026-09-03, not inferred), and the edge only boots when
the database is at its expected version. The heading below was never flipped
after the re-apply, which is what left CI's held-migration gate red on main.
The apply notes are kept as written.


> **REVISED 2026-09-02 after this migration FAILED its first prod apply, which
> is the point of it.** The assertion refused the apply and named one offender:
> `grant_appstore_credits(uuid,integer,text,text,text,text,text)`. That was
> confirmed straight from prod: SECURITY DEFINER, `anon` holds EXECUTE, and
> `prosrc` is 1359 bytes with no `auth.role()` or `gt_require_role` check. The
> other seven anon-reachable credit functions on prod all carry their guard, and
> the two that do not are unreachable by anon. So exactly one function in
> production moved a money-like balance with no authorization check.
>
> It is PROD-ONLY DRIFT, not a missing migration. 00609 and 00615 are both
> recorded on prod in the right order (2026-08-16 21:11 and 2026-08-17 16:39
> UTC) and their parameter names match, so 00615's `CREATE OR REPLACE` could not
> have failed on a rename. It is recorded as applied and its effect on this one
> function is simply absent.
>
> **This file now repairs before it asserts.** It `CREATE OR REPLACE`s the
> function with 00615's guarded body copied byte-for-byte (two em dashes in the
> comments changed to hyphens for the ASCII rule; no executable line differs),
> then runs the same assertion. A REPLACE and never a DROP, so the ACL is
> preserved, `anon` keeps EXECUTE and the US-2403 segfault stays disarmed.
>
> Re-verified after the change: `npm run verify:db` = **all 20 checks passed**,
> including `db: credit functions refuse anon (US-3094)`, with the reset
> re-applying every migration from an empty schema. `migrations-lint` passes at
> 719. **Re-apply 00723 to prod; it will now succeed.**

**What it does.** Nothing to the schema. It is a single read-only `DO` block
that raises if any of the ten credit functions is reachable with the public
anon key *and* carries no authorization check in its own body. It writes only
the `applied_migrations` footer.

**Risk: none in the ordinary sense.** No table, column, function, policy or
grant changes. The one way it can fail an apply is by finding a real violation,
which is the point — under `ON_ERROR_STOP=1` it aborts before the footer, so a
failed run records nothing and is safe to re-run after the fix.

**⚠ IT DELIBERATELY DOES NOT REVOKE, AND THAT IS THE STORY'S FINDING.** US-3094
was filed on the belief that the eight credit functions are anon-`EXECUTE`-able
on prod because a revoke that works locally never landed there. Measured on the
throwaway stack on 2026-09-02, **local and prod agree**: `anon` holds EXECUTE on
the same eight in both, and on neither of the two that `00216` revoked. No
revoke was ever written for these eight anywhere. US-2282 shipped `00615`, which
put the check in the function BODY instead; the `42501` in its closing note is
that body raising, not an `EXECUTE` denial.

Adding the revoke now would be actively harmful: on this Postgres image a denied
function call from a role in `supautils.hint_roles` segfaults the backend and
restarts the database (US-2403), and `anon` is the key in the browser bundle. It
is also blocked twice over — `scripts/migrations-lint.mjs` and
`src/test/us2403-function-revoke-gate.test.ts` both fail a new one, `00527` is
parked as `.BLOCKED`, and `00686` and `00720` each UNDID a revoke that shipped by
mistake.

**Apply order.** `00723` alone. **No `NOTIFY pgrst, 'reload schema';` is
needed** — no table, column or RPC signature changed — but running it is
harmless and costs nothing if you would rather not think about it. Then redeploy
the edge on Coolify (`EXPECTED_SCHEMA_VERSION` is now `00723`). Then push.

**⚠ NUMBERING.** This was written in a worktree whose tree ends at `00721`;
`00722_dashboard_layouts.sql` belongs to a concurrent session. Re-run
`node scripts/gen-migration-manifest.mjs` after the two are merged, or the
shipped manifest will be missing `00722`.

**No client-side coupling.** Nothing in `src/` or the edge reads anything new.
The frontend can deploy before or after this without noticing.

**Verification.** `node scripts/check-credit-function-guards.mjs` reports all ten
clean on a stack built from the full corpus, with its self-check passing. On
prod, re-run `scripts/prod-diagnostics.sql` §29 afterwards: `definer_anon_can_run`
should be UNCHANGED at about 100 (it is expected to stay non-zero), and no row of
(a) should read `anon_can_run = t` with `body_guard = f`.

## ✅ APPLIED 2026-09-02: 00722 — dashboard_layouts (widget board foundation, US-3073)

**What it does.** Creates `public.dashboard_layouts`: one row per
`(user_id, surface)`, `surface` checked against
`('grading','flipdesk','ios-home')`, an ordered `layout` jsonb document, a
`version` integer, `created_at`/`updated_at` on the shared
`public.set_updated_at()` trigger. RLS on with four owner-only policies
(select/insert/update/delete on `(select auth.uid()) = user_id`).

**Risk: low.** One new table. Nothing else is touched, no data is migrated, and
no existing query reads it. Idempotent: `CREATE TABLE IF NOT EXISTS`, every
policy dropped before it is created, the trigger dropped before it is created.

**The client tolerates it being absent, on purpose.** `src/hooks/use-dashboard-layout.ts`
follows the `use-review-flow.ts` pattern: any read error, `42P01` included,
resolves to the persona default layout and never to an error state. So the
frontend can auto-deploy on push and the board still renders correctly before
this SQL lands. A save attempted before the apply fails and rolls back with a
toast, which is the only visible symptom.

**No edge route touches this table.** The browser reads and upserts it through
supabase-js under RLS; the service role never writes here.

**Apply order.** `00722` alone (prod records `00721`). Then
`NOTIFY pgrst, 'reload schema';` (PostgREST must learn the new table or every
read answers `PGRST205`). Then redeploy the edge on Coolify
(`EXPECTED_SCHEMA_VERSION` is now `00722`).

**Applied by the owner on 2026-09-02, and VERIFIED against prod rather than
assumed** (read-only psql over SSH, container
`supabase-db-kcksoks4kk0kswk0ccs40os8`): `to_regclass('public.dashboard_layouts')`
is not null, `applied_migrations` carries `00722` and that is now `max(version)`,
`pg_class.relrowsecurity` is true, and `pg_policies` returns 4 rows for the
table, which matches the four owner-only policies this migration creates.

**Verification before the apply.** `npm run verify:db` with Docker up: `supabase
db start` and `supabase db reset --no-seed` both passed, the reset re-applying
all 718 migrations including this one from an empty schema in 86.9s, 19 checks
green. `scripts/migrations-lint.mjs` passes.

⚠ **Still outstanding: the edge redeploy.** `EXPECTED_SCHEMA_VERSION` in the
pushed code is `00722` and prod now records `00722`, so the two agree, but the
RUNNING edge container still holds whatever was deployed before this push. Until
it is redeployed its boot guard compares an older expectation against a newer
database and reads `behind`. Nothing breaks (the table is browser-owned and no
edge route reads it), so this is a tidiness item rather than an outage.

## ✅ APPLIED 2026-09-02: 00721 — Unlisted tab (To List + Drafts merged), chip filter, wider search

**Applied.** Prod's `applied_migrations` records `00721` at 2026-09-02 15:51 UTC
(read directly from the database, not inferred). The heading below was never
flipped after the apply, which is what blocked the next push at the
held-migration gate. The apply notes are kept as written.

**Branch:** `claude/inventory-layout-navigation-28ugbu`. Apply the SQL BEFORE
this branch reaches main. The frontend on this branch sends a tab id and a
parameter the 00515 function does not know.

**What it does.** Drops `flipdesk_listing_page(text, text, text, jsonb, jsonb,
text, timestamptz, int, int, text[])` and recreates it with one extra trailing
parameter, `p_unlisted_filter text default 'all'`. Adds the `'unlisted'` tab
predicate (every pre-listed status, `drafted` included), the chip window
(`needs_draft` / `ready` / `needs_review`), and five more search columns
(`listing_title`, `size`, `color`, `category`, `location_bin`). The To List
presets apply on `'unlisted'` too. `'to_list'` and `'drafts'` still resolve, so
an un-redeployed client keeps working. Re-grants EXECUTE to `authenticated`,
which the DROP would otherwise lose.

**Risk: low.** One function, SECURITY INVOKER as before, no table or column
change, no data touched. Idempotent: the DROP IF EXISTS matches nothing on a
second run and the CREATE is OR REPLACE.

**⚠ THE CLIENT READS THE NEW SHAPE.** `listings.tsx` calls the RPC with
`p_tab: 'unlisted'` and `p_unlisted_filter`. Against the OLD function PostgREST
answers `PGRST202` (no matching function for the named parameters) and the
Inventory table renders its error state on every tab. Nothing is written, so
the failure is loud and harmless, but it is total until the SQL lands.

**Apply order.** `00721` alone (prod records `00720`). Then
`NOTIFY pgrst, 'reload schema';` (an RPC signature changed). Then redeploy the
edge on Coolify (`EXPECTED_SCHEMA_VERSION` is `00721`). Then merge.

**Verification.** `npm run verify:db` could not run where this was written (no
Docker), so the SQL is unproven on a fresh stack; `scripts/migrations-lint.mjs`
passes. Run `LISTING_PARITY_DB=1 npx vitest run src/test/listing-page-sql-parity.test.ts`
against the local stack before applying: it now covers the unlisted tab, its
four chips and the wider search.

> ## ✅ NOTHING ELSE IS OUTSTANDING (2026-09-02). Prod records `00720`.
>
> `https://functions.gradethread.com/health/ready` reports
> `schema: {applied: "00720"}`, and a PostgREST probe with the public anon key
> confirms the objects from 00708, 00709, 00718 and 00719 all exist (a control
> name answers `42P01`, so the probe is real). The `unexpected` list in that
> same response names 00718-00720 only because the DEPLOYED container was built
> at 00717 — the database is ahead of the build, which is the safe direction and
> clears on the next edge deploy.

> ## ✅ 00711 IS FULLY APPLIED. Measured 2026-09-01 through PostgREST, not assumed.
>
> Probed with the public anon key against two controls in the same session — a
> name that does not exist answers `42P01`, and `blog_posts` answers `200` — so
> the endpoint is really prod and each refusal means what it says. Repeatable:
> `node scripts/probe-00711.mjs`.
>
> | Object | Answer | Reading |
> |---|---|---|
> | `ebay_api_call_daily` | `42501 permission denied` | exists, deny-all RLS working |
> | `ebay_rate_limit_snapshots` | `42501 permission denied` | exists, deny-all RLS working |
> | `rpc/bump_ebay_api_calls` | `42501 permission denied` | exists, the anon REVOKE took |
>
> ⚠ **That last row is no longer the state to want.** The REVOKE it confirms is
> exactly what crashes this Postgres image on a denied call, so 00720 undid it:
> EXECUTE is public again and the service-role check moved into the function
> body. After 00720 the same probe should answer `42501` from the FUNCTION (the
> body raising it), not from the privilege layer.
> | `ebay_account_deletion_log.buyer_rows_erased` | `200 []` | exists; `[]` is RLS withholding rows, not an empty table |
>
> **⚠ IT LANDED IN TWO PASSES, AND THAT IS THE THING TO REMEMBER.** The first
> apply brought in both tables and the function and MISSED the final
> `ALTER TABLE`, which was appended to the file late in the session. Nothing
> reported an error: the tables worked, the function worked, and the only symptom
> was a `42703` on one column that a probe found and a person would not have.
>
> The consequence was narrow and exactly the wrong shape. Buyer erasure still ran
> and eBay still got a correct acknowledgement; what failed was the best-effort
> insert into `ebay_account_deletion_log`, which logs rather than throwing. So
> deletions in that window were handled correctly and left NO audit row — the row
> being the evidence an eBay compliance review asks for.
>
> **The lesson is the probe, not the column.** A migration applied by hand can be
> a stale copy of the file, and "I applied it" is not the same claim as "the
> schema matches the file". `scripts/apply-prod-migrations.sh` reads the file at
> apply time and does not have this failure mode; a copy-paste does.
>
> ⚠ `applied_migrations` is `42501` to anon, so the RECORDED version could not be
> confirmed from outside. The edge boot guard is the check: it refuses to start
> unless `00711` is recorded, so a clean startup on the next Coolify deploy IS the
> confirmation. A boot failure naming the schema version means the row is missing
> and needs inserting by hand.

## ✅ APPLIED 2026-09-02: 00720 — undo 00711's function revoke (owner-confirmed, applied in order through 00720)

**Risk: low, and it closes a live one.** 00711 shipped
`REVOKE ALL ON FUNCTION public.bump_ebay_api_calls(JSONB) FROM PUBLIC` plus a
guarded revoke from `anon` and `authenticated`. On this Postgres image a denied
function call from a role in `supautils.hint_roles` segfaults the backend and
restarts the database, and PostgREST exposes the function at
`/rpc/bump_ebay_api_calls` -- so on a database where 00711 is applied, a
restart is one unauthenticated request away. This is the same fault 00685 had
and 00686 fixed.

This migration re-creates the function with a `service_role` check in its BODY
(stricter than the revoke: nothing user-facing may write API accounting) and
`GRANT EXECUTE ... TO PUBLIC` to restore the default. Idempotent.
**Apply order:** after 00719; the edge boot guard expects `00720`. Apply this
one promptly if 00711 is already applied.

## ✅ APPLIED 2026-09-02: 00719 — creator programme separation (US-9212) (owner-confirmed, applied in order through 00720)

**Risk: medium, and the risk is one constraint swap.** Columns added:
`affiliate_accounts.program` (default `user`), `creator_terms_version`,
`creator_terms_accepted_at`, `creator_approved_at`, plus two CHECKs (`program`
is one of two values; `creator` requires a recorded terms acceptance);
`affiliate_commissions.commission_model` (default `flat`), `referred_user_id`,
`stripe_invoice_id`.

**The swap:** `UNIQUE(referral_event_id)` on `affiliate_commissions` is dropped
and replaced by two partial unique indexes -- `(referral_event_id) WHERE
stripe_invoice_id IS NULL` and `(stripe_invoice_id) WHERE stripe_invoice_id IS
NOT NULL`. Flat-model idempotency is unchanged; the percentage model needs one
row per paid invoice, which the old constraint refused. If prod holds duplicate
`referral_event_id` rows the index creation fails and the file stops there --
there are none today (the constraint has been in force since 00310).

Idempotent. **Apply order:** after 00718, before 00720; the edge boot guard expects `00720` once both are in.

**`NOTIFY pgrst, 'reload schema';`** required (new columns).

## ✅ APPLIED 2026-09-02: 00718 — creator tax profiles (US-9212) (owner-confirmed, applied in order through 00720)

**Risk: low.** One new deny-all table, `affiliate_tax_profiles` (owner column
`owner_user_id`, RLS enabled with NO policies, so only the service role reads
it), one partial index, one `updated_at` trigger, and a `jsonb ||` merge that
adds four creator-commission keys to the existing `affiliate_payout_config`
default. Nothing is dropped and no existing value is replaced: a deployment
that already edited `mode` or `minimum_payout` keeps what it set. Idempotent.
**Apply order:** after 00717; the edge boot guard expects `00718`.

**`NOTIFY pgrst, 'reload schema';`** required (a new table).

**Frontend:** nothing reads the new table from the browser by design. The web
change is `CREATOR_AFFILIATE` in `src/lib/constants.ts`, which is a constant,
so the Cloudflare auto-deploy is safe on its own.

**Behaviour change worth knowing:** with the edge redeployed, the affiliate
payout engine will not send cash to any creator without a certified row in the
new table, and it fails closed on a read error. The programme is still gated
`off` in `affiliate_payout_config`, so nothing was paying today either way.

**Verify after applying:** `select owner_user_id from affiliate_tax_profiles
limit 1` answers through PostgREST as the service role and is refused to anon;
`select default_value -> 'commission_pct' from system_settings where key =
'affiliate_payout_config'` answers `25`.

## ✅ APPLIED 2026-09-02: 00717 — scorecard return split (US-9208) (owner-confirmed, applied in order through 00720)

**Risk: low.** `create or replace` of `public.seller_scorecard(date)`, the
same function as 00654 with a join to `grade_reports` and a `returnSplit` key
in the payload. No table or column changes; the two grants are re-issued.
Idempotent. **Apply order:** after 00716; the edge boot guard expects `00717`.

**`NOTIFY pgrst, 'reload schema';`** recommended (a replaced function keeps
its signature, so the cache is not strictly stale, but the reload is harmless).

**Frontend:** the scorecard card reads `returnSplit` and treats a missing key
as zero counts, which renders "not enough sales yet" on both sides. The
auto-deploy is safe ahead of the apply.

**Verify after applying:** `select public.seller_scorecard(null) -> 'returnSplit'`
as an authenticated user answers an object with `graded` and `ungraded`.

## ✅ APPLIED 2026-09-02: 00716 — graded draft price (US-9205) (owner-confirmed, applied in order through 00720)

**Risk: low.** Three nullable columns on `listings` (`price_set_by` with a
CHECK, `graded_price_cents`, `graded_price_why`), one defaulted boolean on
`repricing_rules` (`override_manual`, default false) and one INSERT policy on
`repricing_actions` limited to `reason = 'seller_override'`. No backfill,
nothing dropped. Idempotent. **Apply order:** after 00715; the edge boot guard
expects `00716`.

**`NOTIFY pgrst, 'reload schema';` IS required** (new columns).

**Frontend reads and writes these columns directly and auto-deploys on push.**
The composer and the review screen write `price_set_by` on save; until the
column exists that save fails with `42703`, so apply this BEFORE the push
lands or the composer's Save draft breaks. The rules runner reads
`override_manual` and `price_set_by` through the service role, so the edge
must be redeployed after the apply.

**Verify after applying:** `select price_set_by from listings limit 1` and
`select override_manual from repricing_rules limit 1` both answer through
PostgREST.

## ✅ APPLIED 2026-09-02: 00715 — review flow columns (US-9204) (owner-confirmed, applied in order through 00720)

**Risk: low.** Three nullable columns, no backfill, nothing dropped:
`inventory_items.review_approve_seconds integer`,
`inventory_items.review_approved_at timestamptz`,
`flipdesk_settings.review_flow_enabled boolean`. Idempotent (`ADD COLUMN IF NOT
EXISTS`). **Apply order:** after 00714; the edge boot guard expects `00715`.

**`NOTIFY pgrst, 'reload schema';` IS required** (new columns must reach the
PostgREST schema cache).

**Frontend reads these columns directly and auto-deploys on push.** Both reads
tolerate the column being absent (a failed read resolves to "decide by account
age" and "no median yet"), and the Approve stamp is best effort, so the window
between the push and the apply costs nothing but the switch and the stat. The
review screen's Approve itself needs no new schema.

**Verify after applying:** `select review_flow_enabled from flipdesk_settings
limit 1` and `select review_approve_seconds from inventory_items limit 1` both
answer through PostgREST (a `42703` means the reload did not happen).

## ✅ APPLIED 2026-09-02: 00714 — extension queue relist kind (US-9203) (owner-confirmed, applied in order through 00720)

**Risk: low.** The same `CHECK` on `extension_work_queue.kind` re-added with
`relist`. Nothing else. Idempotent. **Apply order:** after 00713; the edge
boot guard expects `00714`. No PostgREST reload needed. Nothing in the
frontend reads the new kind directly.

## ✅ APPLIED 2026-09-02: 00713 — extension queue revise kind (US-9202) (owner-confirmed, applied in order through 00720)

**Risk: low.** One `CHECK` constraint on `extension_work_queue.kind` is dropped
and re-added with a third value (`revise`) and the column comment is updated.
No table, column, function or policy changes; no backfill; nothing dropped.
Idempotent (drop-if-exists then add).

**Apply order:** after 00712. `scripts/apply-prod-migrations.sh` picks both up.

**`NOTIFY pgrst, 'reload schema';`** not required (a CHECK is not in the schema
cache); harmless if run.

**The edge boot guard expects `00713`.** Apply 00712 and 00713, then deploy the
edge. The pending-revise queue itself needs NO migration: it is a jsonb marker
on `listings.platform_fields` (`revise_pending`), the same shape as
`delist_unresolved`.

**Frontend:** the listings table and item page read the marker only through the
edge (`GET /api/flipdesk/listings/pending-revises`), so the Cloudflare Pages
auto-deploy is safe on its own; until the edge is redeployed the new routes 404
and the pages show no stale badges.

**Verify after applying:** a service-role insert into `extension_work_queue`
with `kind = 'revise'` succeeds (roll it back); `kind = 'share'` still fails
with `23514`.

## ✅ APPLIED 2026-09-02: 00712 — closet import origins (US-9201) (owner-confirmed, applied in order through 00720)

**Risk: low.** One `CHECK` constraint on `flipdesk_import_runs.origin` is
dropped and re-added with two more values (`poshmark`, `mercari`) and the
column comment is updated. No table, column, function or policy changes; no
backfill; nothing dropped. Idempotent (drop-if-exists then add).

**Apply order:** one file, `00712_closet_import_origins.sql`, after 00711.
`scripts/apply-prod-migrations.sh` picks it up as the next version.

**`NOTIFY pgrst, 'reload schema';`** is not required (a CHECK constraint is not
part of the PostgREST schema cache) but is harmless if run.

**The edge boot guard expects `00712`** (`EXPECTED_SCHEMA_VERSION`), so the
Coolify edge deploy after this push refuses to start until the row is
recorded. Apply the SQL first, then deploy the edge.

**Nothing in the frontend reads the new origin values directly.** The import
page shows `run.origin` only after the edge returns it, so the Cloudflare Pages
auto-deploy is safe on its own; until the edge is redeployed the new
`/api/flipdesk/closet-import/runs` route simply does not exist and the
extension's "Import my closet" reports the server error.

**Verify after applying:** a service-role insert into `flipdesk_import_runs`
with `origin = 'poshmark'` succeeds (roll it back), and one with
`origin = 'bogus'` still fails with `23514`.

### Reference: what 00711 contained, and what still has to be scheduled

**Applied 2026-09-01.**

**Risk: low.** Two NEW tables (`ebay_api_call_daily`,
`ebay_rate_limit_snapshots`), one new SECURITY DEFINER function
(`bump_ebay_api_calls`), four new indexes, and ONE column added to an existing
table: `ebay_account_deletion_log.buyer_rows_erased INTEGER NOT NULL DEFAULT 0`.
Nothing is dropped, altered in type, or backfilled. Both new tables are deny-all
RLS with no policies, registered in `SERVICE_ROLE_ONLY` in `rls-guard_test.ts`.

**⚠ Needs `NOTIFY pgrst, 'reload schema';`** — two new tables, a new RPC, and a
new column on an existing table. Without it PostgREST answers `42703` on
`buyer_rows_erased` and `PGRST202` on `bump_ebay_api_calls`.

**⚠ THE EDGE MUST NOT DEPLOY BEFORE THE SQL IS IN — now satisfied, kept because
it explains what the boot guard is protecting.** `EXPECTED_SCHEMA_VERSION` is `00711`, so the boot guard
refuses to start until the migration is recorded — that part is the usual
protection. The reason to be careful anyway is what the new code does on the
compliance path: the account-deletion handler now writes `buyer_rows_erased` on
every notification, and an insert naming a column PostgREST has not reloaded
fails. That insert is best-effort and would not break the acknowledgement, but
it is the audit record we would hand eBay, so a window where it silently fails
is a window with no evidence.

**Nothing in the frontend reads either new table**, so the Cloudflare Pages
auto-deploy on push is safe on its own. The frontend change in this commit is
the privacy page's retention rows and the eBay attribution component, both
static markup.

**Apply order:** one file, so the usual maximum-version hazard does not apply.
Run it through `scripts/apply-prod-migrations.sh` rather than by hand — see the
two-pass note above for what a hand-copied file cost here.

**Verify after applying.** A PostgREST read proves the tables exist; it cannot
see the function body or the grants, and the RPC is what the counter depends on.
Run this as the operator:

```sql
-- the two tables and the new column
select to_regclass('public.ebay_api_call_daily')       as call_daily,      -- expect not null
       to_regclass('public.ebay_rate_limit_snapshots') as rate_snapshots;  -- expect not null

select count(*) = 1 as column_added
  from information_schema.columns
 where table_schema = 'public'
   and table_name   = 'ebay_account_deletion_log'
   and column_name  = 'buyer_rows_erased';                                 -- expect t

-- the RPC exists and increments rather than overwrites. Run it TWICE with the
-- same row and confirm calls goes 5 -> 10; a second row at 5 means the
-- ON CONFLICT clause did not take and every flush is silently discarding
-- counts, which is invisible from the application side.
select public.bump_ebay_api_calls(
  '[{"day":"2000-01-01","api":"test","endpoint":"/verify","method":"GET",
     "status_class":"2xx","calls":5}]'::jsonb);
select public.bump_ebay_api_calls(
  '[{"day":"2000-01-01","api":"test","endpoint":"/verify","method":"GET",
     "status_class":"2xx","calls":5}]'::jsonb);
select calls from public.ebay_api_call_daily
 where day = '2000-01-01' and api = 'test';                                -- expect exactly one row, calls = 10
delete from public.ebay_api_call_daily where day = '2000-01-01' and api = 'test';

-- deny-all really is deny-all on both
select tablename, count(*) as policies
  from pg_policies
 where schemaname = 'public'
   and tablename in ('ebay_api_call_daily','ebay_rate_limit_snapshots')
 group by tablename;                                                       -- expect ZERO rows
```

**After the deploy, schedule two new Coolify cron tasks.** Neither is created by
the migration and neither self-starts; without them the retention policy the
privacy page now publishes is not enforced, and the quota snapshots stay empty.

| Path | Cadence | Why that cadence |
|---|---|---|
| `POST /api/jobs/ebay-rate-limits` | hourly | eBay's counters roll on a window, so a daily read misses the peak, and the peak is the number the growth check turns on. |
| `POST /api/jobs/ebay-retention` | daily, off-peak | Deletes are bounded at 50k rows per rule per run. |

Both take the standard job secret. Remember the curl gotcha from the edge image
(see [[edge-cron-curl-gotcha]] in memory): a cron whose command is `curl` on an
image without curl reports success and does nothing.

---

> ## ✅ 00708, 00709 AND 00710 ARE ALL APPLIED. Nothing is outstanding as of 2026-09-01.
>
> **00710 (US-3038, the measurement opt-out) confirmed by the same probe:**
> `users.share_garment_measurements` selects clean through PostgREST while a
> control name answers `42703 column ... does not exist`. `EXPECTED_SCHEMA_VERSION`
> is `00710`.
>
> ⚠ **Two things the probe CANNOT see, and both matter more here than they did
> for 00709.** 00710 replaces `guard_users_protected_columns()` and adds
> `purge_garment_measurements_on_optout()`, and neither a function body nor a
> trigger is visible from outside. If the guard did not take, the settings
> toggle saves nothing and the user believes they opted out. If the trigger did
> not take, opting out stops new measurements but never deletes the old ones,
> which is the half the privacy copy promises. Run this as the operator:
>
> ```sql
> -- the allowlist must contain the new column, or the toggle is a no-op
> select position('share_garment_measurements' in prosrc) > 0 as allowlisted
>   from pg_proc where proname = 'guard_users_protected_columns';   -- expect t
>
> -- the opt-out purge trigger must exist on users
> select tgname from pg_trigger
>  where tgrelid = 'public.users'::regclass
>    and tgname = 'purge_garment_measurements_on_optout';           -- expect 1 row
> ```
>
> **Measured, not assumed.** `public.garment_measurements`,
> `public.garment_measurement_stats` (00709) and
> `public.registered_number_lookups` (00708) all answer `[]` on
> `https://api.gradethread.com/rest/v1/...` with the anon key, where a table
> that does not exist answers `42P01 relation ... does not exist` — checked
> against a control name in the same session. `garment_measurements` also
> accepts a select of `brand_key,style_key,field_key,inches,source` and rejects
> a bogus column with `42703`, so it is 00709's shape and not a name collision.
> The endpoint is really prod: `blog_posts` reports 159 rows.
>
> This entry is the [[pending-migrations-stale-both-ways]] failure caught early.
> The two sections below were written while the files were genuinely held, and
> they are kept because their **verify SQL is still worth running** — a read
> through PostgREST cannot see policies, so "the table exists" is not "the RLS
> landed". Run the `pg_policies` block in the 00709 section before trusting the
> tenant scoping in production.
>
> `applied_migrations` is `42501 permission denied` to anon, so the recorded
> version was NOT confirmed from outside. If the SQL was applied by hand rather
> than through `scripts/apply-prod-migrations.sh`, check that both rows are
> recorded, or the boot guard and the next apply will disagree with reality.

> **~~TWO are outstanding right now: 00708, then 00709.~~** Apply in that order.
> Neither depends on the other, but `apply-prod-migrations.sh` skips by MAXIMUM
> recorded version rather than by membership, so applying 00709 first would
> leave 00708 permanently skipped. That is exactly how `listings.draft_id` from
> 00134 stayed missing for months (US-2726, US-2832). Run the script, or run
> both files by hand in numeric order. One `NOTIFY pgrst, 'reload schema';`
> after both is enough. `EXPECTED_SCHEMA_VERSION` is `00709`, so the edge boot
> guard refuses to start until BOTH are in.

## ✅ APPLIED 2026-09-02: 00709_garment_measurement_index.sql (US-3033 — the Fit & Measurement Index storage)

> **Measured, not assumed (2026-09-02).** These two sat below the highest
> recorded version, and `scripts/apply-prod-migrations.sh` skips by MAXIMUM, so
> a hole here would never have been re-applied. Probed through PostgREST with
> the public anon key: `registered_number_lookups`, `garment_measurements` and
> `garment_measurement_stats` all answer `200`, while a control name answers
> `42P01` — so the objects exist and the endpoint is really prod. No hole.

**Not yet applied.** Held per the standing rule: apply the SQL to prod, then OK
the push.

**Risk: low.** Two NEW tables, five new indexes, two triggers, four policies.
Nothing existing is altered, dropped or backfilled. No data is written by this
migration and no code writes to either table yet — the ingestion lands in
US-3034 and US-3035.

**⚠ Needs `NOTIFY pgrst, 'reload schema';`** — two new tables, so PostgREST
will 404 on both until it is told.

**Apply order: after 00708.** See the note at the top of this file. It is the
highest file, so `scripts/apply-prod-migrations.sh` picks it up on its own once
00708 is recorded.

**What it does.** Creates the storage for the Fit & Measurement Index (design:
`docs/superpowers/specs/2026-08-31-fit-measurement-index-design.md`).

- `public.garment_measurements` — one row per garment per measured field.
  **TENANT-SCOPED**, four policies in the `(select auth.uid())` initplan form:
  a seller reads, inserts, updates and deletes only their own rows. DELETE is a
  policy on purpose, because the US-3038 opt-out has to remove a seller's
  contributions and they must be able to do that themselves. Unique on
  `(item_id, field_key)`, so re-measuring a garment updates its row instead of
  counting it twice.
- `public.garment_measurement_stats` — the nightly rollup public pages will
  read. **DENY-ALL, zero policies**, service-role only, same class and same
  reasoning as `brand_size_charts`. No owner column at all: the row is a
  statement about a garment, not about whose closet the numbers came from.
  Registered in BOTH `SERVICE_ROLE_ONLY` and `SERVICE_ONLY_FORCED` in
  `rls-guard_test.ts` — it has no owner column and no parent FK, so without the
  second list the guard would check nothing while appearing to pass.

**No REVOKE anywhere in the file (US-2403).** Copied forward from 00609 and
00708. On this Postgres image supautils decorates a permission-denied error with
a GRANT hint, and building that hint segfaults the backend on a FUNCTION denial,
restarting every other session with it. There is no function in this migration
at all, and authorization comes from the tables, so there is nothing to revoke
and nothing that could build a hint.

**Does client code read it before the apply?** NO. Nothing in the SPA, iOS or
Android touches either table, and no edge route reads or writes them in this
commit. The only thing in this commit that names them is `rls-guard_test.ts`,
which parses the migration file on disk rather than querying the database. So a
frontend auto-deploy ahead of the SQL changes nothing for any user. The real
ordering constraint is the `EXPECTED_SCHEMA_VERSION` bump to `00709`: the edge
boot guard will refuse to start on an unapplied database. Apply first, then
redeploy the edge.

**Verify after applying:**

```sql
-- both tables exist, both have RLS on
select tablename, rowsecurity from pg_tables
 where tablename like 'garment_measurement%';                      -- 2 rows, both t

-- the tenant table has exactly its four policies; the stats table has none
select tablename, policyname, cmd from pg_policies
 where tablename like 'garment_measurement%' order by tablename, cmd;

select count(*) from public.garment_measurements;                  -- 0
select count(*) from public.garment_measurement_stats;             -- 0
```

Read the policies from `pg_policies`, not from this file. Then the edge boot log
should print `[schema-version] OK — DB at 00709 matches expected 00709`.

**Verified locally 2026-08-31** against the throwaway stack
(`supabase_db_gradethread`): applies clean on top of 00708, applies clean a
SECOND time (idempotent), `pg_policies` shows the four tenant policies and zero
on the stats table, and a rolled-back transaction proved a re-measure of the
same garment field updates the row rather than adding one.

---

## ✅ APPLIED 2026-09-02: 00708_registered_number_lookups.sql (US-9036 — count the RN lookups we could not answer)

> **Measured, not assumed (2026-09-02).** These two sat below the highest
> recorded version, and `scripts/apply-prod-migrations.sh` skips by MAXIMUM, so
> a hole here would never have been re-applied. Probed through PostgREST with
> the public anon key: `registered_number_lookups`, `garment_measurements` and
> `garment_measurement_stats` all answer `200`, while a control name answers
> `42P01` — so the objects exist and the endpoint is really prod. No hole.

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
bump means the edge boot guard will refuse to start on an unapplied database,
which is the real ordering constraint: apply first, then redeploy the edge.

**⚠ The expected version is now `00709`, not `00708`.** US-3033 landed on top of
this entry. Applying 00708 alone will NOT satisfy the boot guard, and the edge
will keep refusing to start until 00709 is in as well.

**Verify after applying:**

```sql
select count(*) from public.registered_number_lookups;                 -- 0
select proname from pg_proc where proname = 'record_registered_number_lookup';
```
Then, once 00709 is applied too, the edge boot log should print
`[schema-version] OK — DB at 00709 matches expected 00709`.

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

## How this file works

The standing rule (US-1108, plus a direct instruction from the user): **a commit
containing a migration is committed locally but NOT pushed until the operator has
applied the SQL to prod.** Pushing runs ahead of the schema — Cloudflare Pages
auto-deploys the frontend the moment the branch lands, and the next Coolify edge
deploy boot-guards on `EXPECTED_SCHEMA_VERSION`.

So every held migration gets a section here AND an entry in
`supabase/held-migrations.json` before its commit. The JSON entry is what the
held-migration gate reads; the section is what a person reads.
`scripts/held-migrations-registry.test.mjs` fails if the two disagree.

### Adding a held migration

Add `{ "version": "NNNNN", "file": "NNNNN_name.sql", "story": "US-####",
"held_since": "YYYY-MM-DD", "what": "short title" }` to the `held` array in
`supabase/held-migrations.json`. The gate, the session-start hook and
`docs/operator-worklist.md` all read that entry. Then add one
`## ⏳ HELD: NNNNN_name.sql (US-#### short title, YYYY-MM-DD)` heading here —
the shape still matters, `scripts/held-migrations-registry.test.mjs` parses it
to check it against the registry — and say:

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
4. Then push. In the same commit, delete the entry from
   `supabase/held-migrations.json` and flip the heading to
   `## ✅ APPLIED YYYY-MM-DD: ...`.

### Clearing a section

An APPLIED section stays here for about 30 days, then moves verbatim to
`PENDING_MIGRATIONS.archive.md`, the same way `prd.archive.json` works. Nothing
reads the archive to decide what is held.

One more step, and it is easy to miss: a story whose `prd.json` note still calls
the migration HELD now says something false. `prd-lint` catches that (it warns on
any note claiming a hold for a migration already on `origin/main`), and because
notes are append-only the fix is to APPEND a `STATUS CORRECTION` line rather than
edit the original sentence.

## APPLIED: 00800 - a workspace seat can read the import runs it already sees (US-3316)

**It reached production before anybody approved it, and this is how that was
found.** Prod's `/health/ready` reported `applied 00800` against an `expected
00796`, with `unexpected: ['00800']`. Confirmed by reading prod's PostgREST
OpenAPI document with the anon key: `flipdesk_import_runs`'s table comment now
carries this migration's US-3316 sentence, and the comment is written AFTER the
CREATE POLICY in the file, so the whole file ran.

The file sat in the working tree for about an hour while it was being written.
Whatever applies migrations here picked it up from there. It was never pushed
and never merged; parking it on a branch afterwards was too late.

**It is not harmful and it is not being reverted.** It is the change that was
intended, and its own reasoning holds: a viewer already reads every field of
every run in this workspace through `GET /api/flipdesk/import/runs`, which sits
behind `workspaceMiddleware` with no role floor above viewer. The policy
removes a disagreement between two read paths rather than opening a new one.
The SQL is idempotent, so re-applying it is a no-op.

**00798 did NOT run.** `listings.ebay_drift` still carries its original US-1081
description rather than the retirement text 00798 writes, so only this one got
out. Checked, not assumed.


On main as of 2026-09-11. The branch it was parked on is deleted.
Its guard travels WITH it: three of the four cases read this migration off
disk, so on a main without 00800 they report red for a hole main does not
have.
Apply the held branches in ascending order; each is one merge.
