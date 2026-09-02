---
title: Running the comp-read calibration spike (US-2842)
type: runbook
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/scripts/comp-read-calibration.ts
  - services/edge-functions/src/lib/comp-read-calibration.ts
  - services/edge-functions/src/routes/public-grading.ts
reviewed: 2026-09-02
tags: [ops, grading, comps, condition-index, spike]
summary: How to run the US-2842 calibration spike against production, what each number it prints means, and why it stops short of a verdict.
---

# Running the comp-read calibration spike (US-2842)

> **Re-reviewed 2026-09-02.** Drift flagged `routes/public-grading.ts` for
> US-9202 and US-9203, which add two PUBLIC extension callbacks to that file --
> `/public/revise-listed` and `/public/relist-listed`, both host-pinned and both
> about a listing the seller's own browser just edited. Neither reads a comp,
> and the calibration numbers below come from the comps path, which is
> untouched. Nothing here changed.


> **Re-reviewed 2026-08-31.** Drift flagged `public-grading.ts`, which grew the
> anonymous tag reader for the RN lookup (US-9033). Nothing to carry: the
> addition is 150 new lines behind `POST /tag-read` and touches no part of the
> `/scan` comp path this runbook drives. The flag is file-level on a 2,000-line
> route module, so it fires on any edit to it.

The condition-priced comps bet (US-2841) rests on one unmeasured assumption:
that reading a stranger's listing photos for condition produces a number close
enough to price with. This spike measures that, and it is the gate the comp read
worker (US-2845) waits behind.

It cannot run from a development container. It needs production credentials and
real AI calls, so it is operator-run, by the founder.

## What it does

Takes garments we have **certified** ourselves, finds the **listing photos** of
the same garments, and re-reads them through `/grade-from-url`, which is the
same public endpoint a comp read would use. The gap between the certified grade
and the re-read is the error the whole bet inherits.

A garment qualifies only if all three hold:

1. a certified `grade_reports` row (certificate published, score present),
2. a `flipdesk_grading_submissions` row linking it to an inventory item,
3. at least one **http(s)** photo on that item.

When nothing qualifies the script names which of the three failed. That matters:
"no candidates" reads as "we have no graded garments" and is almost never what
actually happened.

## Before you start

The endpoint allows **20 grades per IP per hour**
(`EXT_GRADE_PER_IP_PER_HOUR`). The script paces itself under that rather than
around it: one read every ~3.1 minutes by default. So

- 20 garments, single pass: about an hour.
- 20 garments with `--retest`: about two hours.

Do not raise the limit to go faster. Lower `--limit`, or run it twice.

## Environment

Export these; the script never reads a file.

| Variable | What |
|---|---|
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | production database |
| `CALIBRATION_EDGE_BASE_URL` | `https://functions.gradethread.com` — the EDGE host. `/api/*` does not exist on `api.gradethread.com`; see [[dns-and-routing]] |
| `CALIBRATION_EXTENSION_TOKEN` | optional, raises the per-call image cap above the anonymous tier |

## Run it

```bash
cd services/edge-functions

# 1. See what it would read. Zero AI calls.
deno run --allow-net --allow-env scripts/comp-read-calibration.ts \
  --owner <your-user-uuid> --dry-run

# 2. One pass.
deno run --allow-net --allow-env scripts/comp-read-calibration.ts \
  --owner <your-user-uuid> --limit 20 --confirm

# 3. With test-retest, and keep the raw rows.
deno run --allow-net --allow-env scripts/comp-read-calibration.ts \
  --owner <your-user-uuid> --limit 20 --retest --confirm --out spike.json
```

`--owner` or `--all-tenants` is **required**. There is no default, because
reading your own garments and reading every seller's are different acts.

## What the numbers mean

| Number | What it tells you |
|---|---|
| `mean signed error` | **Bias.** Positive means comp reads run HIGH: we would think other people's listings are in better condition than they are, and price a seller's item down against them. A bias is correctable with an offset. It is the better failure. |
| `mean absolute error` | **Noise.** Not correctable. This is the number that decides whether a fitted slope means anything. |
| `mean retest delta` | How much the reader disagrees with **itself** on identical photos. Whatever this is, the error above cannot be smaller. It is the floor under everything. |
| `by grade band` | A reader can be tight at 8.5 and wild at 4.0. The overall mean hides that, and the cheap worn items are exactly what a reseller buys most of. |
| `failed` | Reads that produced no score. Counted, never dropped: a reader that answers confidently on the easy half and refuses the rest posts a beautiful mean and is useless. |
| `dollars per read` | Measured from the `ai_budget_status` delta, not estimated from token counts. It includes **all** grading spend in the window, so run it when nothing else is grading. |

Cost needs a `grading` budget on the `day` period to exist, or there is no
counter to difference. See [[ai-spend-failure-domain]].

## It does not decide

The script prints numbers and stops. US-2842 ends in a written GO or NO-GO, and
that is the founder's to write. A threshold picked in advance by the person who
wants the answer to be yes is not a gate.

The decision it feeds: `comp_read` becomes an `ai_usage_events` feature with its
own budget at action `kill` before the US-2845 worker runs at all.
