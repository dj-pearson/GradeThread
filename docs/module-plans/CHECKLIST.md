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

- [~] Golden set eval in CI (grading 3); [owner] prod reads and real cases
- [~] Shadow runs startable from admin, per-image too (grading 6)
- [~] Unreadable-label handling (grading 7)
- [~] Grading prompt cache (grading 8)
- [~] Stale references to the required-photo list (grading 9)
- [~] Offline intake fixes (flipdesk-inventory 4)
- [~] Board Photographed rule matches auto-advance (flipdesk-inventory 5)
- [~] Behavior tests for board, intake, sources (flipdesk-inventory 6)
- [~] Sources page counts in SQL (flipdesk-inventory 7)
- [~] Board batch advance and filters (flipdesk-inventory 8)
- [~] AutoLister timeout stops work, no duplicate eBay drafts (marketplaces 3)
- [ ] Split flipdesk-ebay.ts by concern (marketplaces 5), last, after round 3 merges
- [~] Marketplaces page render test (marketplaces 6)
- [~] Show ledger-vs-dashboard disagreement to the seller (money 6)
- [~] Nested cards on the homepage (web-growth 3)
- [~] Lighthouse on the SSR pages (web-growth 4)
- [~] Accessibility and phone-width checks in a real browser (web-growth 5)
- [~] Break up SettingsPage (web-growth 6)
- [~] iOS coverage floor, grow GradeThreadCore (mobile 6)
- [~] Android strings and plurals (mobile 7)
- [~] Android screenshot lane (mobile 8)
- [~] SDK builds and is tested (extensions-api 4); [owner] npm publish
- [~] Webhook settings in the dashboard (extensions-api 5)
- [~] Less DB work in API key auth (extensions-api 6)
- [~] Machine-readable held-migration state (platform 6)
- [~] Archive applied PENDING_MIGRATIONS entries (platform 7)
- [~] db-rls-initplan-check accepts Postgres 16 plans (platform 9)
