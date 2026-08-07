---
title: What blocks the backlog — five gates, and what each one unblocks
aliases: [BLOCKED-WORK, gates, unblock]
type: runbook
status: current
source_of_truth: vault
code_refs:
  - PENDING_MIGRATIONS.md
reviewed: 2026-08-07
tags: [ops, backlog, blockers]
summary: Five external gates hold up most remaining stories. Each entry says what to do and exactly which stories it releases.
---
# What blocks the backlog (as of 2026-07-19)

> [!info] How the loop now handles these
> A gate listed here only stops the loop if its story's TITLE carries
> `[OPERATOR]`, `USER ACTION REQUIRED` or `DEFERRED for agent loop`. For a gate
> discovered mid-story — nobody knew until an agent tried — the agent ends with
> `<promise>STORY_BLOCKED</promise>` and the runner drops that story for the rest
> of the run, records it in `progress.txt`, and lists it at the end. It does NOT
> mark the story done. Before this existed the loop re-picked such a story every
> iteration; US-1997 burned three runs proving the same thing. See
> `scripts/ralph/CLAUDE.md`.

A large share of the open backlog is not waiting on engineering. It is waiting on
**five things that can only be done outside an agent sandbox.** They are listed
worst-leverage-last, with the stories each one releases.

This note exists because the blockers are recorded per-story in `prd.json`, where
the cross-cutting shape is invisible — you cannot see that one env var gates six
stories by reading six separate notes.

---

## 1. Docker is down → six migrations are unverified

`npm run verify:db` boots a throwaway local stack purely to prove migrations
apply on a **fresh** schema. It has not run against any of:

| Migration | What it does | Why a fresh-schema check matters |
|---|---|---|
| `00480_grading_governance` | 2 columns, partial-index rebuild | index predicate change |
| `00481_consignor_payout_reversal` | **2 enum values** + 4 columns | enum-before-use ordering |
| `00482_inventory_distinct_brands` | **RPC + GRANT** | grant statements fail differently on a clean DB |
| `00483_inventory_items_submission_unique` | de-dupe UPDATE + unique index | the UPDATE is the risky half |
| `00484_sales_currency` | 1 nullable column | low risk |
| `00485_equity_owner_discovery` | **RPC + GRANT/REVOKE** | as 00482 |

**Do:** start Docker, `npm run verify:db`.
**Releases:** confidence in all six. Nothing else in the backlog needs Docker
except the tenant-isolation fixture work (US-2078, US-2014).

> ⚠️ These are **held, not pushed** — the standing rule is that a commit
> containing a migration is applied to prod BEFORE the push. See
> `PENDING_MIGRATIONS.md` for apply order and the two ordering hazards
> (00481's enum values are written by the edge at boot; 00482's RPC is called by
> the frontend, which auto-deploys on push).

---

## 2. No alert channel is configured → every critical event goes nowhere

`MONITOR_ALERT_WEBHOOK` / `UPTIME_ALERT_WEBHOOK` are unset, so `emitOpsEvent`'s
fan-out has nowhere to deliver. **This is the highest-leverage gate**, because a
lot of recent work emits critical events that currently cannot reach a human:

- cron stall detection (US-2004)
- data-retention sweep stall (US-2006)
- consignor payout clawback failure (US-2022)
- grading model-not-qualified (US-2036)
- golden-set shrink (US-2037)
- webhook dead-letter, unmappable price, failed duplicate refund (US-2011)

**Do:** set the two secrets, break a target, confirm it reaches a phone, record
the date in the launch checklist.
**Releases:** US-2003, and the *value* (not the code) of all six above.

> A deploy with no channel now reports `alerting` as **degraded** on
> `/health/ready` rather than silently no-opping — but a degraded flag is not a
> page, and configuration is not evidence.

---

## 3. No deploy since the current work → three things will self-report

Three findings become answerable the moment the edge rolls, with no psql session:

- **The phantom `00479`** — prod records a migration version with no file in this
  repo. `checkSchemaCompleteness()` (US-2009) will name it in the boot log.
- **The retention backlog size** — US-2006's stall event carries
  `past_cutoff_remaining`, which is exactly what US-2006 AC3 asks for.
- **Whether `00451` was actually applied** — US-1927's open caveat; the same
  completeness check names it if it was cherry-pick-skipped.

**Do:** deploy the edge.
**Releases:** answers for US-2009 AC2, US-2006 AC3, US-1927's caveat, and
US-2001 AC2/AC3 (measure `/health` for a real release SHA).

> Expect two alarming-but-correct things on that first boot: every prompt version
> has `qualified_model = NULL` so activation is blocked until an eval re-runs
> (US-2036), and the completeness check may report historical gaps it has never
> been able to see before.

---

## 4. Two Grading decisions → the domain named first in every work request

Neither is an engineering question. One is now answered; it is kept here because
the gate moved rather than lifting, and a reader who only sees "answered" will
pick the story up expecting to finish it.

- **US-1997** — ~~activate or remove the category-rubric scaffolding~~
  **ANSWERED 2026-07-23: ACTIVATE.** Non-clothing grading (sports cards,
  watches, shoes) is on the roadmap, so the scaffolding is built out rather than
  removed. The gate MOVED rather than closing: what now blocks the feature is
  not a decision but a **non-clothing golden set**, which does not exist and
  cannot be fabricated — golden cases grow from real human-corrected grades, and
  the per-category composite prompts (plus the `DefectType` extension they need)
  reach live traffic only through shadow → eval gate → canary. So Phase 2 needs
  someone to grade real non-clothing behind a flag and collect expert
  corrections FIRST. That is operator work, not agent work.
  Everything safely completable without it has landed: the client/edge drift
  fixture, the cert column allowlist, the rubric-driven weighted overall, and
  the defect-routing repair described in [[shipped-but-unwired]].
- **US-2035** — is a regrade of identical photos allowed to return a different
  score? `ai-config.ts` documents a determinism guarantee the default model does
  not provide. Either restore it or stop claiming it — but the comment cannot
  keep asserting a property the code lacks.

**Do:** answer US-2035; for US-1997, start collecting the non-clothing golden
set (grade real cards/watches/shoes behind a flag, then have an expert correct
them) — no amount of engineering substitutes for it.
**Releases:** US-2035, and the only remaining Grading work that is not
prod-data-bound. US-1997's remaining phase does NOT release on a decision any
more; it releases on the golden set.

---

## 5. Smaller, single-action gates

| Gate | Action | Releases |
|---|---|---|
| `VITE_SAMPLE_CERTIFICATE_ID` unset on Pages | set to a cert from `sitemap-certs.xml` (`cce9b573-6b29-45e3-ba45-7c0fe1578418` verified live) | **US-1945** — a launch blocker down to one env var |
| Stripe MCP not authorized | authorize | US-2033 (verify the partial-refund clawback against a real sequence), US-2031 AC1 |
| macOS unavailable | a macOS session | US-1995 (iOS title-sync), most Android/iOS stories |
| Counsel review not done | US-2114 | the entire US-2115…US-2125 compliance batch — **all P0/P1** |
| No product screenshots | design assets | US-1949 AC1 |

---

## What is genuinely NOT blocked

Very little. The remaining unblocked work is large-feature build-out —
US-1662 (Whatnot publish), US-1968 (bulk eBay listing migration), US-1980 (eBay
video), US-2112 AC1 (route-table splitting) — each a real project rather than a
fix, and each carrying a design decision that should be made deliberately rather
than picked up because it was next.

## Related

- [[migrations-process]] — the held-migration rule these six are sitting under
- [[launch-checklist]] — where the alert drill gets recorded
- [[incident-response]] — the runbook that gate 2 currently has no trigger for
