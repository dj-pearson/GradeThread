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

### 24. data-retention
**Frequency:** `0 4 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/data-retention
```

### 25. demand-matches
**Frequency:** `30 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/demand-matches
```

### 26. drip-tick
**Frequency:** `0 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $DRIP_INTERNAL_JOB_SECRET" http://localhost:8787/api/drip/tick
```

### 27. durability-aggregate
**Frequency:** `0 2 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/durability-aggregate
```

### 28. ebay-leave-feedback
**Frequency:** `0 10 * * *`  ·  _200; no-op unless system setting feedback.auto_leave=true_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/jobs/leave-feedback
```

### 29. ebay-order-backstop
**Frequency:** `*/30 * * * *`  ·  _200 with {ok:true, candidates, started, alreadyRunning, ...}; started/candidates can be 0 when every connection synced recently_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/ebay-order-backstop
```

### 30. ebay-orders-sync
**Frequency:** `*/30 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/listings/pull
```

### 31. ebay-pending-webhooks
**Frequency:** `*/15 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/ebay-pending-webhooks
```

### 32. ebay-performance-sync
**Frequency:** `0 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/sync/performance
```

### 33. ebay-promoted-sync
**Frequency:** `0 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/jobs/promoted-sync
```

### 34. ebay-publish-due
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/jobs/publish-due
```

### 35. ebay-token-refresh
**Frequency:** `0 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/ebay/oauth/refresh
```

### 36. email-retry
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/email-retry
```

### 37. equity-snapshot
**Frequency:** `15 5 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/equity-snapshot
```

### 38. exemplar-assembly
**Frequency:** `0 12 * * 0`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/exemplar-assembly
```

### 39. google-sheet-sync
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/google/sync/push
```

### 40. googleplay-expiry-sweep
**Frequency:** `50 1 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/googleplay-expiry-sweep
```

### 41. grading-batch-reclaim
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/grading-batch-reclaim
```

### 42. grading-monitor
**Frequency:** `0 */12 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/grading-monitor
```

### 43. growth-dispatch
**Frequency:** `*/15 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/growth-dispatch
```

### 44. gsc-sync
**Frequency:** `30 6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/gsc-sync
```

### 45. guarantee-pool
**Frequency:** `0 4 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/guarantee-pool
```

### 46. integrity-scan
**Frequency:** `0 7 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/integrity-scan
```

### 47. journey-tick
**Frequency:** `30 13 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/journey-tick
```

### 48. keyword-research
**Frequency:** `0 6 * * 1`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/keyword-research
```

### 49. listing-prompt-promote
**Frequency:** `0 9 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/listing-prompt-promote
```

### 50. marketplace-events
**Frequency:** `*/15 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/marketplace-events
```

### 51. newsletter-ab-finalize
**Frequency:** `*/15 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/newsletter-ab-finalize
```

### 52. newsletter-dispatch
**Frequency:** `0 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/newsletter-dispatch
```

### 53. newsletter-kickoff
**Frequency:** `0 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $NEWSLETTER_INTERNAL_JOB_SECRET" http://localhost:8787/api/newsletter/scheduler/tick
```

### 54. newsletter-topic-bank-refill
**Frequency:** `0 5 * * 1`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/newsletter-topic-bank-refill
```

### 55. newsletter-tuning
**Frequency:** `45 12 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/newsletter-tuning
```

### 56. north-star-digest
**Frequency:** `0 14 * * 1`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/north-star-digest
```

### 57. operator-brief
**Frequency:** `0 13 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/operator-brief
```

### 58. passport-backfill
**Frequency:** `*/15 * * * *`  ·  _ONE-OFF at launch (idempotent; disable once drained)_

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/passport-backfill
```

### 59. passport-integrity-scan
**Frequency:** `0 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/passport-integrity-scan
```

### 60. photo-archive
**Frequency:** `0 4 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/images/archive
```

### 61. portfolio-alerts
**Frequency:** `0 7 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/portfolio-alerts
```

### 62. publish-batch-reclaim
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/publish-batch-reclaim
```

### 63. push-token-prune
**Frequency:** `0 3 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/push-token-prune
```

### 64. reconciliation-sweep
**Frequency:** `0 5 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/flipdesk/reconciliation/run
```

### 65. reprice-rules
**Frequency:** `0 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/reprice-rules
```

### 66. reprice-scan
**Frequency:** `0 */6 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/reprice-scan
```

### 67. stuck-submissions
**Frequency:** `*/10 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/stuck-submissions
```

### 68. sync-reaper
**Frequency:** `*/15 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/sync-reaper
```

### 69. thumbnail-backfill
**Frequency:** `*/5 * * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/thumbnail-backfill
```

### 70. trial-expiry
**Frequency:** `15 0 * * *`

```bash
curl -fsS -X POST -H "X-Internal-Job-Secret: $FLIPDESK_INTERNAL_JOB_SECRET" http://localhost:8787/api/jobs/trial-expiry
```
<!-- cron-setup:end -->
