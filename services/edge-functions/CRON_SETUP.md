# Coolify Scheduled Tasks — one-time setup run-down

A ready-to-paste list of **every** scheduled job. Register each one on the
**edge-functions** resource in Coolify: **Settings → Scheduled Tasks → New**.

For every entry below:

- **Name** = the heading (e.g. `condition-alerts`).
- **Container** = the edge-functions service (same for all).
- **Frequency** = the value shown (standard 5-field cron, **UTC**).
- **Command** = the fenced line — copy it verbatim. It runs *inside* the
  container, so `localhost:8787` reaches the edge over the internal network, and
  `$FLIPDESK_INTERNAL_JOB_SECRET` (already set on the resource) is injected by
  the shell. A few jobs use their own secret env var — it's baked into the
  command, so just paste as-is.

A healthy **Run Now** returns `200 {"ok":true,...}` (idle runs report zero/skipped
counts — not a failure). Every hit is recorded in the `cron_runs` table.

> This list is **generated from `src/lib/cron-runs.ts` CRON_REGISTRY** and
> drift-guarded (`cron-registry-drift_test.ts`). Don't hand-edit between the
> markers — after changing the registry run
> `deno run --allow-env --allow-net --allow-read scripts/render-cron-setup.ts`
> and paste.

<!-- cron-setup:start (generated - see src/lib/cron-runs.ts + scripts/render-cron-setup.ts; drift-guarded by cron-registry-drift_test.ts) -->
### 1. abuse-scan
**Frequency:** `0 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/abuse-scan
```

### 2. ads-conversions-upload
**Frequency:** `30 8 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/ads-conversions-upload
```

### 3. ads-sync
**Frequency:** `0 8 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/ads-sync
```

### 4. affiliate-payouts
**Frequency:** `15 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/affiliate-payouts
```

### 5. agent-eval
**Frequency:** `0 15 * * 0`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/agent-eval
```

### 6. agent-tick
**Frequency:** `*/10 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/agent-tick
```

### 7. ai-budget-guardrails
**Frequency:** `*/15 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/ai-budget-guardrails
```

### 8. appstore-expiry-sweep
**Frequency:** `45 1 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/appstore-expiry-sweep
```

### 9. audit-anomaly-scan
**Frequency:** `5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/audit-anomaly-scan
```

### 10. autolister-reclaim
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/autolister-reclaim
```

### 11. automation-rules
**Frequency:** `0 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/automation-rules
```

### 12. billing-reconciliation
**Frequency:** `0 5 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/billing-reconciliation
```

### 13. buyer-digest
**Frequency:** `0 13 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/buyer-digest
```

### 14. cert-integrity-backfill
**Frequency:** `0 6 * * *`  ·  _ONE-OFF at launch (idempotent; disable once drained)_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/cert-integrity-backfill
```

### 15. condition-alerts
**Frequency:** `*/15 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/condition-alerts
```

### 16. condition-index-refresh
**Frequency:** `0 8 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/condition-index-refresh
```

### 17. condition-index-seedgen
**Frequency:** `0 9 * * 1`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/condition-index-seedgen
```

### 18. confidence-calibration
**Frequency:** `0 13 * * 0`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/confidence-calibration
```

### 19. consignor-payouts
**Frequency:** `*/30 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/consignor-payouts
```

### 20. content-digest
**Frequency:** `0 14 * * 1`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $CONTENT_INTERNAL_JOB_SECRET" http://localhost:8787/api/content/scheduler/digest
```

### 21. content-refresh
**Frequency:** `30 4 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/content-refresh
```

### 22. content-tick
**Frequency:** `0 * * * *`  ·  _200 with skipped:true when idle (cadence gate) — NOT ok:true_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $CONTENT_INTERNAL_JOB_SECRET" http://localhost:8787/api/content/scheduler/tick
```

### 23. content-watchdog
**Frequency:** `0 */3 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/content-watchdog
```

### 24. credentials-refresh
**Frequency:** `40 5 * * *`  ·  _200 with {ok:true, revised, up_to_date, capped:false}; revised is 0 on a steady-state run_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/credentials-refresh
```

### 25. cron-fleet-health
**Frequency:** `17 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/cron-fleet-health
```

### 26. data-retention
**Frequency:** `0 4 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/data-retention
```

### 27. demand-matches
**Frequency:** `30 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/demand-matches
```

### 28. drip-tick
**Frequency:** `0 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $DRIP_INTERNAL_JOB_SECRET" http://localhost:8787/api/drip/tick
```

### 29. durability-aggregate
**Frequency:** `0 2 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/durability-aggregate
```

### 30. ebay-leave-feedback
**Frequency:** `0 10 * * *`  ·  _200; no-op unless system setting feedback.auto_leave=true_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/jobs/leave-feedback
```

### 31. ebay-notification-reconcile
**Frequency:** `17 */6 * * *`  ·  _200 with {ok:true, healthy:true, missingBuckets:[]}; created/enabled empty on a steady-state run_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/ebay-notification-reconcile
```

### 32. ebay-order-backstop
**Frequency:** `*/30 * * * *`  ·  _200 with {ok:true, candidates, started, alreadyRunning, ...}; started/candidates can be 0 when every connection synced recently_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/ebay-order-backstop
```

### 33. ebay-pending-webhooks
**Frequency:** `*/15 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/ebay-pending-webhooks
```

### 34. ebay-performance-sync
**Frequency:** `0 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/sync/performance
```

### 35. ebay-promoted-sync
**Frequency:** `0 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/jobs/promoted-sync
```

### 36. ebay-publish-due
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/jobs/publish-due
```

### 37. ebay-search-terms
**Frequency:** `25 6 * * *`  ·  _200 with {ok:true, owners, stored, no_campaign, ...}; owners is 0 on an account with no Priority campaigns_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/ebay-search-terms
```

### 38. ebay-token-refresh
**Frequency:** `0 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/oauth/refresh
```

### 39. email-retry
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/email-retry
```

### 40. equity-snapshot
**Frequency:** `15 5 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/equity-snapshot
```

### 41. exemplar-assembly
**Frequency:** `0 12 * * 0`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/exemplar-assembly
```

### 42. expense-recurrence
**Frequency:** `20 5 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/expense-recurrence
```

### 43. flipdesk-import-reclaim
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/flipdesk-import-reclaim
```

### 44. google-sheet-sync
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/google/sync/push
```

### 45. googleplay-expiry-sweep
**Frequency:** `50 1 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/googleplay-expiry-sweep
```

### 46. grading-batch-reclaim
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/grading-batch-reclaim
```

### 47. grading-monitor
**Frequency:** `0 */12 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/grading-monitor
```

### 48. grading-self-consistency
**Frequency:** `20 4 * * 1`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/grading-self-consistency
```

### 49. growth-dispatch
**Frequency:** `*/15 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/growth-dispatch
```

### 50. gsc-sync
**Frequency:** `30 6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/gsc-sync
```

### 51. guarantee-pool
**Frequency:** `0 4 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/guarantee-pool
```

### 52. integrity-scan
**Frequency:** `0 7 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/integrity-scan
```

### 53. journey-tick
**Frequency:** `30 13 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/journey-tick
```

### 54. keyword-research
**Frequency:** `0 6 * * 1`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/keyword-research
```

### 55. listing-prompt-promote
**Frequency:** `0 9 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/listing-prompt-promote
```

### 56. marketplace-events
**Frequency:** `*/15 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/marketplace-events
```

### 57. newsletter-ab-finalize
**Frequency:** `*/15 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/newsletter-ab-finalize
```

### 58. newsletter-dispatch
**Frequency:** `0 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/newsletter-dispatch
```

### 59. newsletter-kickoff
**Frequency:** `0 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $NEWSLETTER_INTERNAL_JOB_SECRET" http://localhost:8787/api/newsletter/scheduler/tick
```

### 60. newsletter-topic-bank-refill
**Frequency:** `0 5 * * 1`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/newsletter-topic-bank-refill
```

### 61. newsletter-tuning
**Frequency:** `45 12 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/newsletter-tuning
```

### 62. north-star-digest
**Frequency:** `0 14 * * 1`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/north-star-digest
```

### 63. operator-brief
**Frequency:** `0 13 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/operator-brief
```

### 64. passport-backfill
**Frequency:** `*/15 * * * *`  ·  _ONE-OFF at launch (idempotent; disable once drained)_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/passport-backfill
```

### 65. passport-integrity-scan
**Frequency:** `0 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/passport-integrity-scan
```

### 66. photo-archive
**Frequency:** `0 4 * * *`  ·  _200 {owners,eligible_owners,archived,freed_bytes,...}; skipped:true with reason r2_not_configured is healthy, and archived 0 is normal once the backlog drains_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/photo-archive
```

### 67. portfolio-alerts
**Frequency:** `0 7 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/portfolio-alerts
```

### 68. publish-batch-reclaim
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/publish-batch-reclaim
```

### 69. push-token-prune
**Frequency:** `0 3 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/push-token-prune
```

### 70. radar-aggregate
**Frequency:** `20 * * * *`  ·  _200 with {ok:true, events, venues, aggregates, suppressed, removed, kFloor, pruned}; suppressed > 0 is NORMAL and means the k-anonymity floor withheld those venues_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/radar-aggregate
```

### 71. reconciliation-sweep
**Frequency:** `0 5 * * *`  ·  _200 {owners,eligible_owners,auto_matched,ambiguous,...}; ambiguous is not an error — those rows are queued for the seller on purpose_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/reconciliation-sweep
```

### 72. reprice-rules
**Frequency:** `0 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/reprice-rules
```

### 73. reprice-scan
**Frequency:** `0 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/reprice-scan
```

### 74. reward-nudges
**Frequency:** `0 15 * * *`  ·  _200 with {ok:true, evaluated, sent, holdout, skipped, scanned, converted}; sent can be 0 — most evaluated users are frequency-capped or have no true candidate_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/reward-nudges
```

### 75. stuck-submissions
**Frequency:** `*/10 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/stuck-submissions
```

### 76. style-code-discovery
**Frequency:** `10 3 * * *`  ·  _200 with {ok:true, considered, crawled, deferred, scanned, inspected, declared, codes, newCodes, names}; newCodes falls toward 0 as a brand's pages are exhausted, and deferred is non-zero whenever more brands are eligible than the budget covers_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/style-code-discovery
```

### 77. style-code-sweep
**Frequency:** `35 * * * *`  ·  _200 with {ok:true, considered, swept, deferred, learned, noHits}; swept is 0 once every known code is confirmed or cooling off_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/style-code-sweep
```

### 78. sync-reaper
**Frequency:** `*/15 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/sync-reaper
```

### 79. thumbnail-backfill
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/thumbnail-backfill
```

### 80. trial-expiry
**Frequency:** `15 0 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/trial-expiry
```
<!-- cron-setup:end -->
