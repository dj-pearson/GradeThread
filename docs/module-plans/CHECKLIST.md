# Module plan checklist

Every action from the eight module plans, in the order they will be worked.
`[x]` done and pushed, `[~]` in progress, `[ ]` not started, `[owner]` needs the owner (prod access, a decision, or a secret).
Each line names the plan file and action number.

## Round 1: now

- [owner] Apply HELD 00823 on prod and flip PENDING_MIGRATIONS.md (platform 1)
- [owner] Install the backup cron, encrypt offsite dumps, set the ops alert channel (platform 8)
- [owner] Seed the 83 help articles on prod (web-growth 1, seed half)
- [owner] Set ANDROID_CERT_SHA256 so app links work (mobile 4, secret half)
- [~] Tenant-scope get_or_create_source, migration 00824 (flipdesk-inventory 1)
- [~] Close the api_keys self-upgrade policy, migration 00825 (extensions-api 1)
- [~] close_period rebuilds the ledger first, migration 00826 (money 2)
- [~] publish-due attempt cap, migration 00827 plus edge code (marketplaces 1)
- [~] Never upload the camera original to the public bucket (flipdesk-inventory 2)
- [~] Remove legacy /api/payments/subscribe (money 4)
- [~] ensureLedgerBuilt rebuilds a stale ledger (money 1)
- [~] Clear eval_passed when prompt text changes (grading 2)
- [~] Android: every push category, contract test (mobile 1)
- [~] Android: AiFieldWriter keeps untouched JSONB (mobile 2)

## Round 2: next

- [ ] Weighted overall rounding at .x5 midpoints, all three sites (grading 1) [owner decides on resealing old certificates]
- [ ] Extension queue stale-claim reclaim (marketplaces 2)
- [ ] Harden public phone-capture upload (flipdesk-inventory 3)
- [ ] Ledger rebuild must not rewrite closed periods (money 3)
- [ ] Subscription webhooks safe against out-of-order events (money 5)
- [ ] Webhook secret customers can get, signed timestamp (extensions-api 2)
- [ ] One webhook delivery per account, retries survive restart (extensions-api 3)
- [ ] Router-level tenant-isolation coverage test (platform 2)
- [ ] Guard that service-role-only tables keep a REVOKE (platform 3)
- [ ] Integration lanes stop wiping REVOKEs with GRANT ALL (platform 4)
- [ ] Cert SSR gallery uses stable photo URLs (grading 5)
- [ ] iOS payout dates one day early west of UTC (mobile 3)
- [ ] Ship the SERP title and description rewrite (web-growth 2)
- [ ] Stop an empty /help from being indexed (web-growth 1, code half)
- [ ] FlipDesk grading and the label photo, one required-photo source (grading 4) [owner decides label rule]
- [ ] Backlog cleanup: close stories already done in code (extensions-api 7, marketplaces 4, mobile 5, money 7, platform 5)

## Round 3: later

- [ ] Golden set filled and run in CI (grading 3) [owner runs prod reads]
- [ ] Shadow runs startable from admin, per-image too (grading 6)
- [ ] Unreadable-label handling (grading 7)
- [ ] Grading prompt cache (grading 8)
- [ ] Stale references to the required-photo list (grading 9)
- [ ] Offline intake fixes (flipdesk-inventory 4)
- [ ] Board Photographed rule matches auto-advance (flipdesk-inventory 5)
- [ ] Behavior tests for board, intake, sources (flipdesk-inventory 6)
- [ ] Sources page counts in SQL (flipdesk-inventory 7)
- [ ] Board batch advance and filters (flipdesk-inventory 8)
- [ ] AutoLister timeout stops work, no duplicate eBay drafts (marketplaces 3)
- [ ] Split flipdesk-ebay.ts by concern (marketplaces 5)
- [ ] Marketplaces page render test (marketplaces 6)
- [ ] Show ledger-vs-dashboard disagreement to the seller (money 6)
- [ ] Nested cards on the homepage (web-growth 3)
- [ ] Lighthouse on the SSR pages (web-growth 4)
- [ ] Accessibility and phone-width checks in a real browser (web-growth 5)
- [ ] Break up SettingsPage (web-growth 6)
- [ ] iOS coverage floor, grow GradeThreadCore (mobile 6)
- [ ] Android strings and plurals (mobile 7)
- [ ] Android screenshot lane (mobile 8)
- [ ] Publish the SDK (extensions-api 4)
- [ ] Webhook settings in the dashboard (extensions-api 5)
- [ ] Less DB work in API key auth (extensions-api 6)
- [ ] Machine-readable held-migration state (platform 6)
- [ ] Archive applied PENDING_MIGRATIONS entries (platform 7)
- [ ] db-rls-initplan-check accepts Postgres 16 plans (platform 9)
