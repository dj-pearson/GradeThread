// US-1852: the write half of quests — loading definitions and paying completions.
//
// Split from rewards-quests.ts on purpose: that file is pure (window maths and a
// predicate table, unit-testable with no DB), and this one is the only place
// that touches Supabase or the feature flag. Keeping them apart is also what
// avoids a module cycle — grantReward lives in rewards-engine.ts and this file
// calls it, while rewards-engine.ts calls back into `evaluateQuests`.
//
// A completion is paid through grantReward like everything else, so all the
// existing protections apply unchanged: the UNIQUE(user_id, event_type,
// reference_id) dedupe key is what makes "one payout per quest run" true, and
// the reference is the quest's INSTANCE key — `<quest_key>:<window-start>` — so
// next week's run of a repeating quest is a different key and pays again, while
// re-evaluating this week's is free.

import { supabaseAdmin } from "./supabase.ts";
import { isFeatureEnabled } from "./feature-flags.ts";
import type { RewardEventInput } from "./rewards-engine.ts";
import {
  clampQuestXp,
  computeQuestBoard,
  type QuestDefinition,
  questDefinitionFromRow,
  type QuestProgress,
  QUESTS_FLAG_KEY,
} from "./rewards-quests.ts";

/** Nothing is served or paid unless an operator has switched quests on. */
export async function questsEnabled(): Promise<boolean> {
  // Fail-closed, matching the tangible rail: a missing flag row or a DB blip
  // pays nobody rather than everybody.
  return await isFeatureEnabled(QUESTS_FLAG_KEY, { defaultEnabled: false });
}

/** Every enabled definition, in display order. Empty on error (fail-closed). */
export async function loadQuestDefinitions(): Promise<QuestDefinition[]> {
  const { data, error } = await supabaseAdmin
    .from("quest_definitions")
    .select("*")
    .eq("enabled", true)
    .order("sort_order", { ascending: true })
    .limit(50);
  if (error) {
    console.error("[quests] definition load failed:", error.message);
    return [];
  }
  return (data ?? []).map((r) => questDefinitionFromRow(r as Record<string, unknown>));
}

/**
 * Score the caller's quest board and pay anything newly finished.
 *
 * Deliberately evaluated on the SAME pass that grants a reward rather than
 * behind a "claim" button: a quest the user finished but forgot to collect is a
 * reward that punishes forgetfulness, which is the opposite of what a quest is
 * for. Best-effort throughout — a quest failure must never fail the act that
 * triggered it.
 */
export async function evaluateQuests(
  userId: string,
  events: RewardEventInput[],
  nowMs: number,
  grant: (
    userId: string,
    instanceKey: string,
    xp: number,
    quest: QuestProgress,
  ) => Promise<unknown>,
): Promise<QuestProgress[]> {
  if (!(await questsEnabled())) return [];
  const defs = await loadQuestDefinitions();
  if (defs.length === 0) return [];

  const board = computeQuestBoard(defs, events, nowMs);
  for (const q of board) {
    if (!q.complete) continue;
    const xp = clampQuestXp(q.xpReward);
    try {
      await grant(userId, q.instanceKey, xp, q);
    } catch (err) {
      console.error(
        `[quests] payout failed for ${q.instanceKey}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return board;
}
