# Master action plan

## Module summary

| Module | Health | Top action |
|---|---|---|
| Grading engine and certificates | ok | Fix the rounding bug at exact .x5 midpoints. Some grades land 0.1 too low, and a few drop a tier. |
| FlipDesk inventory pipeline | ok | Scope `get_or_create_source` to the caller. Today any signed-in user can write sources into another seller's account. |
| Marketplaces, listing and crosslisting | ok | Put an attempt cap on scheduled publish. A broken draft retries every 10 minutes with no end. |
| Money: payments, billing, books, taxes | ok | Stop books screens and the tax packet from reading a stale ledger. |
| Web app UX, marketing, SEO | ok | Seed the 83 help articles, and keep an empty /help out of the index. |
| Mobile apps (iOS and Android) | ok | Add the 8 push categories Android does not know, and test against the push contract. |
| Extensions, SDK and public API | needs work | Close the api_keys policy. Users can raise their own rate tier and clear their own quota. |
| Platform: DB, security, CI, ops | needs work | Clear the HELD migration 00823. It is on main, so main CI is red. |

## Top 10 across all modules

Ranked by impact per effort. All ten are high impact and small (S) effort.

1. **Clear HELD 00823 on main**: CI is red, and the next edge deploy may crash-loop. (Platform, S, operator)
2. **Scope `get_or_create_source` to the caller**: it is a live cross-tenant write and name probe in prod. (FlipDesk, S)
3. **Drop the api_keys self-update policy**: users can raise their own rate tier and quota. (API, S)
4. **Never upload the camera original to the public bucket**: when compression fails, the photo goes out with GPS still in it. (FlipDesk, S)
5. **Remove the legacy `/api/payments/subscribe` route**: it can open a second paid subscription. (Money, S)
6. **Rebuild the ledger inside `close_period`**: a closed month can leave out every recent sale. (Money, S)
7. **Cap publish-due attempts at 5**: this ends about 144 eBay calls a day per broken draft. (Marketplaces, S)
8. **Clear eval_passed when prompt text is edited**: today a prompt can pass the eval, be edited, then go live. (Grading, S)
9. **Android: add the 8 missing push categories and a contract test**: dispute and case alerts go to a muted channel. (Mobile, S)
10. **Android: stop AiFieldWriter flattening JSONB**: each Android apply destroys AI source data that other apps wrote. (Mobile, S)

These are also small and high impact, and just missed the list:

- Seed the Help Center. (Web, operator)
- Ship the SERP title rewrite. (Web)
- Set `ANDROID_CERT_SHA256` so app links work. (Mobile, operator)

## Cross-module themes

- **Database rules that trust the caller.** `get_or_create_source`, the api_keys UPDATE policy, service-role tables with no REVOKE (permission removal) guard, and the CI GRANT ALL that wipes those REVOKEs. One pattern shows up in four places. It needs one guard: a `--dsn` proof script, which runs against a real test database.
- **The same rule kept in two places, and drifting apart.** Required photos differ between grading, FlipDesk, the board rules and the API routes (US-2304). The push categories differ between the edge and Android. The rounding code sits in three places. Each pair needs one source of truth or a test that pins them together.
- **Background queues missing the full job rules.** Publish-due has no attempt cap. The extension queue never takes back a stale claim. Webhook retries live only in memory. An AutoLister timeout does not stop the work. The durable-jobs rules should apply to all of them.
- **Backlog says less is done than really is.** US-2727, US-3362, US-3355, US-3014, US-2911, US-2011 and others are done in code but still open. Duplicates exist too: US-3412 and US-9017, US-3430 and US-3449. Agents keep getting pulled back to finished work.
- **Operator steps block the real risk.** The backup cron, encrypted offsite dumps, the alert channel, the help seed, the 00823 apply, assetlinks and the Sentry grant. Code cannot close any of these.

## Suggested order

**Wave 1: now (this week)**

- Operator session. Apply 00823, set the ops alert channel, install the backup cron, seed help articles, set `ANDROID_CERT_SHA256`, grant Sentry read.
- Security fixes: `get_or_create_source`, the api_keys policy, the GPS upload fallback, and removing `/subscribe`.
- Money correctness: `close_period` rebuild, and the stale-ledger check in `ensureLedgerBuilt`.
- Publish-due attempt cap, and the eval_passed reset.
- Android push categories and the AiFieldWriter fix.

**Wave 2: next (2 to 4 weeks)**

- Rounding fix in all three places, with midpoint test cases. Before shipping, the owner decides whether old certificates get resealed.
- Extension queue stale-claim reclaim, and the phone-capture fixes: real insert errors, an atomic cap, a rate limit.
- Ledger rebuild must not rewrite closed periods. Handle subscription webhooks that arrive out of order.
- Webhook secret, signed timestamp, and one delivery per account with retries kept in the database.
- Guards: a test that every router has a cross-tenant case, a check that REVOKEs stay in place, and a REVOKE replay in the CI lanes.
- Cert gallery uses stable photo URLs. Fix the iOS payout date. Ship the SERP titles. Backlog cleanup across all modules.

**Wave 3: later**

- Golden set filled and running in CI. Shadow runs startable from admin. The label re-read fix. Prompt cache tuning.
- Build, test and publish the SDK. Webhook settings in the dashboard. Less database work in API key auth.
- Split `flipdesk-ebay.ts`. A unique index on eBay drafts, with a cleanup first.
- Behavior tests for pipeline, intake, sources and marketplaces. Break up SettingsPage.
- Lighthouse on the SSR pages. Axe (accessibility checker) in Playwright (browser tests). iOS coverage floor. Android plurals and strings. Screenshot lane made to block.
- A file that lists held migrations, which the CI gate reads. Archive old PENDING_MIGRATIONS entries. Postgres 16 support in the initplan check.

**Not verified:** no module agent ran the edge Deno suite, the database scripts, or a live eBay call. The only things actually run were the extension tests and one number check in node. Every other finding comes from reading the code.

## Module plans

- [Grading engine & certificates](./grading.md) (ok, 9 actions)
- [FlipDesk inventory pipeline (source, catalog, measure, photograph)](./flipdesk-inventory.md) (ok, 8 actions)
- [Marketplaces, listing & crosslisting (eBay, autolister, publish, sync)](./marketplaces.md) (ok, 6 actions)
- [Money: payments, billing, sales, books & taxes](./money.md) (ok, 7 actions)
- [Web app UX, marketing site, SEO/GEO & content](./web-growth.md) (ok, 6 actions)
- [Mobile apps (iOS + Android)](./mobile.md) (ok, 8 actions)
- [Browser extensions, SDK & public API](./extensions-api.md) (needs-work, 7 actions)
- [Platform: DB/migrations, security & tenant isolation, CI, ops](./platform.md) (needs-work, 9 actions)
