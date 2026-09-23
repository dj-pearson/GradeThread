# Module plan checklist

Every action from the eight module plans, in the order they will be worked.
`[x]` done and pushed, `[~]` in progress, `[ ]` not started, `[owner]` needs the owner (prod access, a decision, or a secret).
Each line names the plan file and action number.

## Round 1: now

- [owner] Apply HELD 00823 on prod and flip PENDING_MIGRATIONS.md (platform 1)
- [owner] Install the backup cron, encrypt offsite dumps, set the ops alert channel (platform 8)
- [owner] Seed the 83 help articles on prod (web-growth 1, seed half)
- [owner] Set ANDROID_CERT_SHA256 so app links work (mobile 4, secret half)
- [x] Tenant-scope get_or_create_source, migration 00824 (flipdesk-inventory 1)
- [x] Close the api_keys self-upgrade policy, migration 00825 (extensions-api 1)
- [x] close_period rebuilds the ledger first, migration 00826 (money 2)
- [x] publish-due attempt cap, migration 00827 plus edge code (marketplaces 1)
- [x] Never upload the camera original to the public bucket (flipdesk-inventory 2)
- [x] Remove legacy /api/payments/subscribe (money 4)
- [x] ensureLedgerBuilt rebuilds a stale ledger (money 1)
- [x] Clear eval_passed when prompt text changes (grading 2)
- [x] Android: every push category, contract test (mobile 1)
- [x] Android: AiFieldWriter keeps untouched JSONB (mobile 2)

## Round 2: next

- [x] NEW: close_period closing_figures covered every seller, migration 00829 (already-closed prod periods keep the bad figures; see PENDING_MIGRATIONS.md)
- [x] Weighted overall rounding at .x5 midpoints, all three sites (grading 1) (new grades only; owner decides on resealing old ones, US-3470)
- [x] Extension queue stale-claim reclaim (marketplaces 2)
- [x] Harden public phone-capture upload (flipdesk-inventory 3)
- [x] Ledger rebuild must not rewrite closed periods (money 3)
- [x] Subscription webhooks safe against out-of-order events (money 5)
- [x] Webhook secret customers can get, signed timestamp (extensions-api 2), migration 00830
- [x] One webhook delivery per account, retries survive restart (extensions-api 3)
- [x] Router-level tenant-isolation coverage test (platform 2)
- [x] Guard that service-role-only tables keep a REVOKE (platform 3)
- [x] Integration lanes stop wiping REVOKEs with GRANT ALL (platform 4)
- [x] Cert SSR gallery uses stable photo URLs (grading 5)
- [x] iOS payout dates one day early west of UTC (mobile 3)
- [x] Ship the SERP title and description rewrite (web-growth 2)
- [x] Stop an empty /help from being indexed (web-growth 1, code half)
- [x] FlipDesk grading and the label photo, one required-photo source (grading 4) (default: label photo required, owner may override)
- [x] Backlog cleanup: close stories already done in code (extensions-api 7, marketplaces 4, mobile 5, money 7, platform 5)

## Round 3: later

- [x] Golden set eval in CI (grading 3); [owner] set EDGE_JOB_SECRET repo secret, run prod reads, promote real cases (job stays red until then)
- [x] Shadow runs startable from admin, per-image too (grading 6)
- [x] Unreadable-label handling (grading 7)
- [x] Grading prompt cache (grading 8)
- [x] Stale references to the required-photo list (grading 9)
- [x] Offline intake fixes (flipdesk-inventory 4)
- [x] Board Photographed rule matches auto-advance (flipdesk-inventory 5)
- [x] Behavior tests for board, intake, sources (flipdesk-inventory 6)
- [x] Sources page counts in SQL (flipdesk-inventory 7), migration 00831
- [x] Board batch advance and filters (flipdesk-inventory 8)
- [x] AutoLister timeout stops work, no duplicate eBay drafts (marketplaces 3), migration 00832
- [x] Split flipdesk-ebay.ts by concern (marketplaces 5), round 4
- [x] Marketplaces page render test (marketplaces 6)
- [x] Show ledger-vs-dashboard disagreement to the seller (money 6)
- [x] Nested cards on the homepage (web-growth 3)
- [x] Lighthouse on the SSR pages (web-growth 4)
- [x] Accessibility and phone-width checks in a real browser (web-growth 5)
- [x] Break up SettingsPage (web-growth 6)
- [x] iOS coverage floor, grow GradeThreadCore (mobile 6), partly: floor is a 5% placeholder until the first Mac CI run; EdgeAPI DTOs not moved; nothing compiled here
- [x] Android strings and plurals (mobile 7); not compiled here, first Android CI run is the check
- [x] Android screenshot lane (mobile 8)
- [x] SDK builds and is tested (extensions-api 4); [owner] npm publish
- [x] Webhook settings in the dashboard (extensions-api 5)
- [x] Less DB work in API key auth (extensions-api 6); 30s key cache dropped on purpose (a revoked key could keep working)
- [x] Machine-readable held-migration state (platform 6)
- [x] Archive applied PENDING_MIGRATIONS entries (platform 7)
- [x] db-rls-initplan-check accepts Postgres 16 plans (platform 9)

## Round 4: follow-ups found while fixing

- [x] Guard test held a literal backspace instead of \b, so it never matched (grading-cache-premium_test)
- [x] ensureLedgerBuilt dropped a getSession error (unchecked-read baseline)
- [x] Offline intake: photo failures, idempotent photo retries, attempt counting; board facet case
- [x] AutoLister: abandoned-draft test, read retry, friendly duplicate-draft errors, 00832 made race-safe
- [x] Grading: shadow refusal on active rows, vault note, eval workflow hints, streamed-call context
- [x] Web: export state across tabs, elevation test, Lighthouse report matching, 2 contrast failures, drift banner on past ranges
- [x] Platform: worklist and session hook read held-migrations.json, restore 12 lost lines
- [x] iOS test target links Core, symbol guards; SDK 5xx retry vs idempotency; developers page install copy
- [x] Split flipdesk-ebay.ts into 12 route files, same 124 routes (marketplaces 5)
- [owner] Publish the SDK to npm (the developers page will say it is not published yet)
- [owner] Native speaker review of the flagged Spanish Android strings
- [owner] Raise the iOS coverage floor to the first green Mac CI number
- [owner] Decide whether to reseal certificates graded with the old rounding (US-3470)
- [owner] Refund policy when an API grade debit errors but may have gone through (credits could be lost; no double charge now)
- [owner] Say whether 00823 was applied on prod (the gate still lists it as held while it is on main)

## Round 5: last reds and loose ends

- [x] sold-at-provenance red from the SDK commit; notification-surface matrix parser; sku-sequences DSN test
- [x] eBay /promotions/:id swallows /performance and /stack-check; per-file plan-gate check for sync and post-sale
- [x] Offline queue retry edge cases, export flag per user, codex hook and worklist read the held registry, SDK README
- [x] Two old lint errors in extension-unified/lister/common.js (dead pickFromList, useless escape)

## Final state (2026-09-23)

- Type check clean. Lint 0 errors. UI check clean.
- Web tests: 11,297 passed, 3 failed. All 3 were red before this work: cross-post-setup, mobile-tab-bar, reselling-guide-links.
- Script tests: 985 passed, 4 failed. All 4 need esm.sh, which this cloud box blocks.
- Edge tests: only the known imagescript stand-in failures (text rendering and rotate).
- Held migrations waiting on the owner: 00823 through 00832.
