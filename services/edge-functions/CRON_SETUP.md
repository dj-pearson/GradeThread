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

### 15. comp-read
**Frequency:** `25 * * * *`  ·  _200 with {ok:true, skipped:true, reason:"comp_read feature flag is off"} until the flag is enabled — it ships OFF pending the US-2842 spike. Also skips on a breached comp_read budget._

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/comp-read
```

### 16. comp-read-reclaim
**Frequency:** `*/10 * * * *`  ·  _200 with {ok:true, requeued:0, failed:0} on a healthy queue. Runs whether or not the flag is on: a queue left by a disabled worker still needs draining._

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/comp-read-reclaim
```

### 17. condition-alerts
**Frequency:** `*/15 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/condition-alerts
```

### 18. condition-index-refresh
**Frequency:** `0 8 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/condition-index-refresh
```

### 19. condition-index-seedgen
**Frequency:** `0 9 * * 1`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/condition-index-seedgen
```

### 20. confidence-calibration
**Frequency:** `0 13 * * 0`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/confidence-calibration
```

### 21. consignor-payouts
**Frequency:** `*/30 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/consignor-payouts
```

### 22. content-digest
**Frequency:** `0 14 * * 1`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $CONTENT_INTERNAL_JOB_SECRET" http://localhost:8787/api/content/scheduler/digest
```

### 23. content-refresh
**Frequency:** `30 4 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/content-refresh
```

### 24. content-tick
**Frequency:** `0 * * * *`  ·  _200 with skipped:true when idle (cadence gate) — NOT ok:true_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $CONTENT_INTERNAL_JOB_SECRET" http://localhost:8787/api/content/scheduler/tick
```

### 25. content-watchdog
**Frequency:** `0 */3 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/content-watchdog
```

### 26. credentials-refresh
**Frequency:** `40 5 * * *`  ·  _200 with {ok:true, revised, up_to_date, capped:false}; revised is 0 on a steady-state run, and unparseable + blocks_disagree must be 0 (US-3028: above zero means live stale badges this job cannot reach)_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/credentials-refresh
```

### 27. cron-fleet-health
**Frequency:** `17 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/cron-fleet-health
```

### 28. data-retention
**Frequency:** `0 4 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/data-retention
```

### 29. delist-nudge
**Frequency:** `*/30 * * * *`  ·  _200 with {ok:true, scanned, notified, skipped{nothing_old_enough, drained_since, told_recently}}; notified is 0 on most runs and `capped:true` means the scan hit its row ceiling_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/delist-nudge
```

### 30. demand-matches
**Frequency:** `30 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/demand-matches
```

### 31. drip-tick
**Frequency:** `0 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $DRIP_INTERNAL_JOB_SECRET" http://localhost:8787/api/drip/tick
```

### 32. durability-aggregate
**Frequency:** `0 2 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/durability-aggregate
```

### 33. ebay-leave-feedback
**Frequency:** `0 10 * * *`  ·  _200; no-op unless system setting feedback.auto_leave=true_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/jobs/leave-feedback
```

### 34. ebay-notification-reconcile
**Frequency:** `17 */6 * * *`  ·  _200 with {ok:true, healthy:true, missingBuckets:[]}; created/enabled empty on a steady-state run_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/ebay-notification-reconcile
```

### 35. ebay-order-backstop
**Frequency:** `*/30 * * * *`  ·  _200 with {ok:true, candidates, started, alreadyRunning, ...}; started/candidates can be 0 when every connection synced recently_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/ebay-order-backstop
```

### 36. ebay-payout-link
**Frequency:** `30 5 * * *`  ·  _200 {owners,eligible_owners,payouts_upserted,sales_linked,sales_still_unlinked,failed_owners}; sales_linked falls toward 0 once the backlog drains and sales_still_unlinked is normal — those are orders whose deposit has not settled yet. skipped:true with reason ebay_not_configured is healthy in an env with no keyset_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/ebay-payout-link
```

### 37. ebay-pending-webhooks
**Frequency:** `*/15 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/ebay-pending-webhooks
```

### 38. ebay-performance-sync
**Frequency:** `0 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/sync/performance
```

### 39. ebay-promoted-sync
**Frequency:** `0 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/jobs/promoted-sync
```

### 40. ebay-publish-due
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/jobs/publish-due
```

### 41. ebay-rate-limits
**Frequency:** `7 * * * *`  ·  _200 with {ok:true, resourcesRecorded>0, tightest:{...}}; skipped:true with reason ebay_not_configured is healthy in an env with no keyset_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/ebay-rate-limits
```

### 42. ebay-retention
**Frequency:** `40 3 * * *`  ·  _200 with {ok:true, results:[...]}; totalRows 0 is normal once the backlog drains. ok:false means a table was skipped and the published policy is only half-applied_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/ebay-retention
```

### 43. ebay-search-terms
**Frequency:** `25 6 * * *`  ·  _200 with {ok:true, owners, stored, no_campaign, ...}; owners is 0 on an account with no Priority campaigns_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/ebay-search-terms
```

### 44. ebay-token-refresh
**Frequency:** `0 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/oauth/refresh
```

### 45. email-retry
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/email-retry
```

### 46. equity-snapshot
**Frequency:** `15 5 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/equity-snapshot
```

### 47. exemplar-assembly
**Frequency:** `0 12 * * 0`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/exemplar-assembly
```

### 48. expense-recurrence
**Frequency:** `20 5 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/expense-recurrence
```

### 49. extension-queue-stale
**Frequency:** `50 16 * * *`  ·  _200 with {ok:true, scanned, candidates, notified, suppressed, skipped{...}}; notified is 0 on most days and `capped:true` means the scan hit its row ceiling and under-reported_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/extension-queue-stale
```

### 50. flipdesk-import-reclaim
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/flipdesk-import-reclaim
```

### 51. google-sheet-sync
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/google/sync/push
```

### 52. googleplay-expiry-sweep
**Frequency:** `50 1 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/googleplay-expiry-sweep
```

### 53. grade-release
**Frequency:** `*/5 * * * *`  ·  _200 with {ok:true, hold_enabled, released, preliminary_notices, failures:[]}; released and preliminary_notices are 0 while the hold is off_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/grade-release
```

### 54. grading-batch-reclaim
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/grading-batch-reclaim
```

### 55. grading-monitor
**Frequency:** `0 */12 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/grading-monitor
```

### 56. grading-self-consistency
**Frequency:** `20 4 * * 1`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/grading-self-consistency
```

### 57. growth-dispatch
**Frequency:** `*/15 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/growth-dispatch
```

### 58. gsc-sync
**Frequency:** `30 6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/gsc-sync
```

### 59. guarantee-pool
**Frequency:** `0 4 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/guarantee-pool
```

### 60. integrity-scan
**Frequency:** `0 7 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/integrity-scan
```

### 61. journey-tick
**Frequency:** `30 13 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/journey-tick
```

### 62. keyword-research
**Frequency:** `0 6 * * 1`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/keyword-research
```

### 63. listing-prompt-promote
**Frequency:** `0 9 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/listing-prompt-promote
```

### 64. marketplace-events
**Frequency:** `*/15 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/marketplace-events
```

### 65. measurement-aggregate
**Frequency:** `40 3 * * *`  ·  _200 with {ok:true, cohorts, sufficient, upserted, retired}; every count can be 0 before any garment is measured_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/measurement-aggregate
```

### 66. measurement-text-backfill
**Frequency:** `*/15 * * * *`  ·  _ONE-OFF at launch (idempotent; disable once drained); 200 with {ok:true, scanned, withMeasurements, ingested, drained}; scanned 0 with drained:true once the backlog is read_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/measurement-text-backfill
```

### 67. newsletter-ab-finalize
**Frequency:** `*/15 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/newsletter-ab-finalize
```

### 68. newsletter-dispatch
**Frequency:** `0 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/newsletter-dispatch
```

### 69. newsletter-kickoff
**Frequency:** `0 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $NEWSLETTER_INTERNAL_JOB_SECRET" http://localhost:8787/api/newsletter/scheduler/tick
```

### 70. newsletter-topic-bank-refill
**Frequency:** `0 5 * * 1`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/newsletter-topic-bank-refill
```

### 71. newsletter-tuning
**Frequency:** `45 12 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/newsletter-tuning
```

### 72. north-star-digest
**Frequency:** `0 14 * * 1`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/north-star-digest
```

### 73. operator-brief
**Frequency:** `0 13 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/operator-brief
```

### 74. passport-backfill
**Frequency:** `*/15 * * * *`  ·  _ONE-OFF at launch (idempotent; disable once drained)_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/passport-backfill
```

### 75. passport-integrity-scan
**Frequency:** `0 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/passport-integrity-scan
```

### 76. photo-archive
**Frequency:** `0 4 * * *`  ·  _200 {owners,eligible_owners,archived,freed_bytes,...}; skipped:true with reason r2_not_configured is healthy, and archived 0 is normal once the backlog drains_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/photo-archive
```

### 77. portfolio-alerts
**Frequency:** `0 7 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/portfolio-alerts
```

### 78. publish-batch-reclaim
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/publish-batch-reclaim
```

### 79. push-token-prune
**Frequency:** `0 3 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/push-token-prune
```

### 80. qbo-token-refresh
**Frequency:** `0 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/qbo/oauth/refresh
```

### 81. radar-aggregate
**Frequency:** `20 * * * *`  ·  _200 with {ok:true, events, venues, aggregates, suppressed, removed, kFloor, pruned}; suppressed > 0 is NORMAL and means the k-anonymity floor withheld those venues_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/radar-aggregate
```

### 82. reconciliation-sweep
**Frequency:** `0 5 * * *`  ·  _200 {owners,eligible_owners,auto_matched,ambiguous,...}; ambiguous is not an error — those rows are queued for the seller on purpose_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/reconciliation-sweep
```

### 83. reprice-rules
**Frequency:** `0 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/reprice-rules
```

### 84. reprice-scan
**Frequency:** `0 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/reprice-scan
```

### 85. reward-nudges
**Frequency:** `0 15 * * *`  ·  _200 with {ok:true, evaluated, sent, holdout, skipped, scanned, converted}; sent can be 0 — most evaluated users are frequency-capped or have no true candidate_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/reward-nudges
```

### 86. rewards-sweep
**Frequency:** `30 6 * * *`  ·  _200 with {ok:true, queued, swept, marksGranted, xpAdded, leveledUp, failed}; marksGranted settles near 0 once the backfill has drained_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/rewards-sweep
```

### 87. stuck-submissions
**Frequency:** `*/10 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/stuck-submissions
```

### 88. style-code-discovery
**Frequency:** `10 3 * * *`  ·  _200 with {ok:true, considered, crawled, deferred, scanned, inspected, declared, codes, newCodes, names}; newCodes falls toward 0 as a brand's pages are exhausted, and deferred is non-zero whenever more brands are eligible than the budget covers_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/style-code-discovery
```

### 89. style-code-sweep
**Frequency:** `35 * * * *`  ·  _200 with {ok:true, considered, swept, deferred, learned, noHits}; swept is 0 once every known code is confirmed or cooling off_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/style-code-sweep
```

### 90. supply-sample
**Frequency:** `10 4 * * *`  ·  _200 with {ok:true, cells, sampled, failed, basis}; basis 'headroom' or 'no_snapshot' means the pass was capped and the rest roll to tomorrow, which is normal_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/supply-sample
```

### 91. sync-reaper
**Frequency:** `*/15 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/sync-reaper
```

### 92. thumbnail-backfill
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/thumbnail-backfill
```

### 93. trial-expiry
**Frequency:** `15 0 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/trial-expiry
```

### 94. webhook-retry
**Frequency:** `*/5 * * * *`  ·  _200 with {ok:true, reclaimed, scanned, delivered, retried, exhausted, cancelled, skipped}; exhausted counts customer endpoints that ran out of attempts and is not a failure of this job_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/webhook-retry
```
<!-- cron-setup:end -->
