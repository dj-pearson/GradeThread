# Platform: DB/migrations, security & tenant isolation, CI, ops

Health: **needs-work**

This area has more guards than most repos: a schema-version boot guard, a migration lint, a held-migration gate, an rls-guard, MCP tool coverage, and a 10,410-line tenant-isolation suite. The live problems are elsewhere. A HELD migration (00823) is on origin/main right now, so main CI is red. Two protections were never extended to their neighbours: nothing checks that every HTTP router has a cross-tenant test case (the MCP tools have that check), and nothing checks that service-role-only tables keep their REVOKEs (permission removals). Prod ops is still the biggest risk: no backup cron, plaintext offsite dumps, and alert channels set to empty.

## Actions

### 1. Clear the HELD 00823 that is already on origin/main

Impact: high | Effort: S | Story: US-3308

**Why:** PENDING_MIGRATIONS.md:75 heads 00823_imported_sales_shipped.sql as HELD. Commit 2ef1969 ('shipping', 2026-09-22) is an ancestor of origin/main (checked with git merge-base --is-ancestor). `node scripts/held-migration-gate.mjs --ci` prints BLOCKED, so the ci.yml:65 build job is red on main. EXPECTED_SCHEMA_VERSION is already '00823' (schema-version.ts:67). If prod has not applied it, the next Coolify roll will wait out the 8x5s grace window (schema-version.ts:130-131) and then crash-loop.

**Steps:**
- Owner runs `npm run migrate:prod` (read-only) to see if 00823 is recorded on prod
- If not recorded: owner runs `npm run migrate:prod -- --apply --yes` (one UPDATE, a dry run on prod gave 51 rows)
- Flip PENDING_MIGRATIONS.md:75 to '## APPLIED <date>:' in one commit and confirm a green ci.yml run
- Check that /health/ready reports expected=applied=00823 before the next edge deploy

### 2. Add a router-level tenant-isolation coverage test, like mcp-tenant-coverage_test.ts

Impact: high | Effort: M | Story: none

**Why:** mcp-tenant-coverage_test.ts:1-40 fails the build when an MCP tool has no case in tenant-isolation_test.ts. HTTP routers have no such check. Of the 155 app.route mounts in main.ts, these user-facing FlipDesk ones are never named in tenant-isolation_test.ts: /api/flipdesk/depop, demand, google, google/photos, photo-profiles, product, return-shield, sheets, webhooks. The skill requires a case for every route. The clearest gap is POST /api/flipdesk/depop/orders/:saleId/ship (flipdesk-depop.ts:404-425). It takes a sale id from the URL. The scoping through inventory_items.user_id looks right, but no test proves it.

**Steps:**
- Write tests/router-isolation-coverage_test.ts: read the app.route prefixes from main.ts and require each one to appear in tenant-isolation_test.ts, or to be on an allowlist with a reason (public, job-secret, webhook, admin covered by admin-scope-coverage)
- Seed the allowlist with today's uncovered mounts, each with a one-line reason, so the test starts green and the list can only get shorter
- Add a real cross-tenant case for depop /orders/:saleId/ship (foreign saleId returns 404) and take depop off the allowlist
- Sabotage-check it: remove the .eq('inventory_items.user_id') and watch the case fail

### 3. Guard that service-role-only tables keep a table-level REVOKE

Impact: high | Effort: M | Story: US-3355

**Why:** US-3355 retrofitted REVOKEs onto 94 tables (00810-00812). Nothing stops the next operator table from shipping without one. rls-guard_test.ts only mentions 'revoke' in comments (lines 366-446). migrations-lint.mjs:227-283 checks only REVOKE ON FUNCTION. A grep for role_table_grants/has_table_privilege across scripts/, the edge tests and .github finds one unrelated script (check-work-override-storage.mjs). The db-migrations.yml lane does not run the GRANT ALL block, so grant state there is still real and could be asserted.

**Steps:**
- In rls-guard_test.ts (or migrations-lint.mjs), require every SERVICE_ROLE_ONLY table to have a `revoke ... on [public.]<table> from anon, authenticated` somewhere in supabase/migrations
- Add scripts/check-service-role-grants.mjs --dsn: on the freshly reset db lane, query information_schema.role_table_grants for anon/authenticated on those tables and expect zero rows
- Wire it into db-migrations.yml and the verify:db lane; sabotage it by dropping one revoke

### 4. Stop the integration lanes' GRANT ALL from wiping every REVOKE

Impact: medium | Effort: S | Story: US-3350

**Why:** tenant-isolation.yml:85 and money-cert-integration.yml:97 run `GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role`. CLAUDE.md records that this destroys all 83+ migration REVOKEs (US-3350). So the security lane runs against a privilege model prod does not have, and can never catch an anon-grant regression. CLAUDE.md already has the fix: replay each migration's revoke statements after the grant.

**Steps:**
- Add a small script that pulls every `revoke ...;` from supabase/migrations/*.sql in filename order, with -- comments removed
- Run it right after the GRANT step in both workflows
- Narrow the grant where possible (service_role only, plus the explicit tables the fixture needs)
- Confirm tenant isolation still passes 183/0 and the money lane still passes 11/0

### 5. Close out US-3355 now that 00810-00812 are applied

Impact: medium | Effort: S | Story: US-3355

**Why:** PENDING_MIGRATIONS.md:734-743 marks 00810, 00811 and 00812 APPLIED 2026-09-20. US-3355 is still open in prd.json at priority 7. Its last note says only the operator apply and an OpenAPI path count (449 down to about 356) are left. An open story for finished work pulls future agents back into it.

**Steps:**
- Fetch prod's PostgREST OpenAPI root with the anon key and count the paths
- If about 356: record the count and close with `node scripts/prd-story.mjs done US-3355 --note ...`
- If still 449: the grants did not take, so reopen with the evidence

### 6. Make held-migration state machine-readable instead of regex over prose headings

Impact: medium | Effort: M | Story: US-3308

**Why:** held-migration-gate.mjs:48-103 describes the heading regex failing silently at least five times (HELD spelled differently, dated prefixes, multi-version headings), each time printing 'no HELD migrations - OK' while a migration was held. US-3308's notes say a held branch turns main red once on every normal merge. PENDING_MIGRATIONS.md is 13,115 lines, so the gate's input is also the repo's biggest hand-edited file.

**Steps:**
- Add a small registry (for example supabase/held-migrations.json listing version, story and held_since) as the gate's only input
- Have held-migration-gate.mjs and check-held-branches.mjs read the registry; keep PENDING_MIGRATIONS.md as prose only
- Add a test that fails when a HELD heading in the .md is missing from the registry, during the transition
- Optionally, in --ci on push to main, accept a held version that prod's /health/ready already reports as applied, so a stale heading does not redden main

### 7. Archive applied PENDING_MIGRATIONS entries and fix stale version comments

Impact: low | Effort: S | Story: US-3421

**Why:** PENDING_MIGRATIONS.md has 302 '## ' headings and 289 of them are APPLIED. The 'WHAT IS STILL WAITING FOR YOU, 2026-09-11' section at line 1396 lists branches that were since rebuilt, and 00794/00795/00798/00799 are still not in the tree (US-3421). schema-version.ts:39-40 says the highest file is 00634 (it is 00823). schema-version.ts:61 says 00793 is skipped, but 00793_retire_renamed_size_chart_orphans.sql exists.

**Steps:**
- Move APPLIED entries older than about 30 days into PENDING_MIGRATIONS.archive.md, the same way prd.archive.json works
- Rewrite the 2026-09-11 waiting section so it lists only 00794, 00795, 00798 and 00799 and their branch status
- Fix the two schema-version.ts comments; drop the file name from the 'highest' comment so it cannot go stale again

### 8. Operator: install the backup cron, encrypt offsite dumps, and set an alert channel

Impact: high | Effort: M | Story: US-2003, US-2002, US-2416

**Why:** US-2003's notes (a prod read on 2026-09-02) found system_settings ops_alert_email and ops_alert_webhook_url both empty, so every ops alert goes nowhere. US-2002: the prod backup cron was never installed. US-2416: offsite dumps upload as plaintext. These are the largest real risks in the module, and all three are operator steps with runbooks already in vault/10-ops/backups.md.

**Steps:**
- Set ops_alert_email or ops_alert_webhook_url in system_settings and trigger one test alert
- Install the backup cron on the DB host and confirm a dump plus checksum lands offsite
- Set up age keys and an rclone crypt remote per the MANUAL callout in vault/10-ops/backups.md, then run one restore drill from a real offsite dump

### 9. Let db-rls-initplan-check accept the Postgres 16 plan format

Impact: low | Effort: S | Story: none

**Why:** scripts/db-rls-initplan-check.mjs:143 only matches `(InitPlan N).colN`. Postgres 16 prints the same hoisted plan as `$0`. So the only db check that cannot run on the cloud-session cluster fails for a formatting reason (CLAUDE.md, US-3435 note).

**Steps:**
- Extend usesInitPlan to also accept the PG16 `InitPlan N (returns $0)` plus `$0` form
- Keep the bare-policy negative probe so the check still proves it can tell the two apart
- Run it against the local PG16 cluster and the CI image

## Risks

- 00823 is HELD but already on origin/main; if prod has not applied it, the next edge roll crash-loops after the grace window
- A new service-role table without a REVOKE ships unnoticed: no test checks table grants
- The tenant-isolation CI lane runs after GRANT ALL, so it cannot see privilege regressions
- Nine user-facing FlipDesk routers have no cross-tenant case, and nothing forces one when a route is added
- Prod alerts go nowhere, backups are not scheduled, and offsite dumps are plaintext (operator-only fixes)
- GoTrue (the Supabase login service) cannot be run in cloud sessions, so authenticated edge routes can only be integration-tested in CI
