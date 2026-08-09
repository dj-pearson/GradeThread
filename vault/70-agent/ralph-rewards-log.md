---
title: Ralph rewards working log
type: learning
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-08-09
tags: [agent, ralph, rewards]
summary: Traps from the GradeThread Rewards epic (US-1848…): levels, seasons, quests and money-moving grants.
---

> [!info] Read ON DEMAND, not every iteration.
> Split out of [[ralph-learnings]] by US-2445, which had grown to 892 lines
> against its own 800-line rule. Nothing here was deleted or reworded — it is
> the same text, one hop away instead of on every loop iteration.
>
> Read this for the rewards epic. The RULES live in [[reward-ledger]]; this is
> the record of tripping over them.

# Reward levels, seasons and tangible grants

## Reward levels & seasons

- A seller's LEVEL derives from `user_reward_state.xp_peak`, never `xp_total`
  (00542): XP is not debited, but the log CAN shrink (erasure, fraud reversal,
  cascade), and deriving from the live total silently demotes people. Seller
  surfaces show SEASON progress and never a streak — streaks exist only on the
  buyer confirmation flow, with grace + freeze. Level perks are cosmetic and
  have no paid path. Rules: [[reward-ledger]].

- Adding an entry to `REWARD_XP_CATALOG` SILENTLY widens `QUEST_METRICS`, which
  is derived from the catalog's keys — but the allowed quest metrics are ALSO a
  CHECK in 00543, which the new key is not in. So an admin gets a validator that
  passes and an insert that 23514s. Either exclude the new type in the
  `QUEST_METRICS` filter (US-1854 did, for `share_milestone`) or widen the CHECK
  in the same commit. No test catches the mismatch.

## Tangible rewards (money-moving grants)

- XP is NEVER debited — milestones GRANT, they never charge (US-1853). The
  catalog is the `reward_milestones` table (00544), not the compiled
  `TANGIBLE_MILESTONES` list, which is only the fallback for a failed read; an
  EMPTY read must NOT fall back, or the per-milestone disable switch is a lie. A
  reward type with no entry in `FULFILLERS` can never be granted. Rules:
  [[reward-ledger]].

## Related

- [[reward-ledger]] — the rules these bullets are about
- [[ralph-learnings]] — the always-read playbook
- [[INDEX]]
