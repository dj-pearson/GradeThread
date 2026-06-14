// Staged prompt rollout / canary bucketing (US-896).
//
// Pure, DB-free helpers so the active-vs-canary selection is unit-testable
// without a vision call or a database. The grading path (ai-grading.ts
// resolveActivePrompt) loads the active + canary prompt rows for a (stage,
// scope) slot once, caches them, and then calls shouldUseCanary() per
// submission to decide which prompt that submission's grade uses.

import { stableBucket } from "./feature-flags.ts";

export interface ResolvedPrompt {
  text: string;
  versionName: string;
}

export interface CanaryPrompt {
  prompt: ResolvedPrompt;
  /** Percentage [0–100] of live traffic this canary takes for its slot. */
  rolloutPercentage: number;
}

/** The resolved prompts for one (stage, scope) slot. */
export interface SlotResolution {
  active: ResolvedPrompt;
  canary: CanaryPrompt | null;
}

// One DB row's canary-relevant fields (subset of ai_prompt_versions).
export interface SlotPromptRow {
  version_name: string;
  prompt_text: string | null;
  garment_scope: string | null;
  is_active: boolean;
  is_canary: boolean;
  rollout_percentage: number | null;
}

/**
 * Deterministic [0, 100) bucket for one submission within one slot. Namespacing
 * by the slot key means a submission that lands in the canary band for the
 * composite slot is bucketed INDEPENDENTLY for the per-image slot, and the same
 * submission always resolves the same way (no flicker across replicas / cache
 * refreshes), exactly like the feature-flag percentage rollout (US-886).
 */
export function canaryBucket(slotKey: string, bucketKey: string): number {
  return stableBucket(`grading-canary:${slotKey}:${bucketKey}`);
}

/**
 * Decide whether this submission's grade should use the canary prompt for a
 * slot. A 0% (or absent) canary is never used; a 100% canary always is. With no
 * bucketKey (eval / dry-run / quick-grade paths that aren't real submissions) we
 * never canary — those must stay on the active prompt.
 */
export function shouldUseCanary(
  slot: SlotResolution,
  slotKey: string,
  bucketKey: string | undefined,
): boolean {
  const pct = slot.canary?.rolloutPercentage ?? 0;
  if (!slot.canary || pct <= 0 || !bucketKey) return false;
  if (pct >= 100) return true;
  return canaryBucket(slotKey, bucketKey) < pct;
}

/** Pick the active prompt for a submission: canary when bucketed in, else champion. */
export function pickPromptForBucket(
  slot: SlotResolution,
  slotKey: string,
  bucketKey: string | undefined,
): ResolvedPrompt {
  return shouldUseCanary(slot, slotKey, bucketKey) && slot.canary
    ? slot.canary.prompt
    : slot.active;
}

/**
 * Resolve a slot's active + canary prompts from the DB rows for a stage.
 * Mirrors the legacy active-only resolution: prefer a garment_scope-specific row
 * over the global (null-scope) row, then fall back to the code default. A row
 * with empty prompt_text means "use the code default TEXT but attribute to this
 * version_name" (how the seeded default rows work). The canary is resolved with
 * the same scope preference and only counts when its percentage is > 0.
 */
export function resolveSlotFromRows(
  rows: SlotPromptRow[],
  garmentScope: string | null,
  codeDefault: ResolvedPrompt,
): SlotResolution {
  const promptText = (row: SlotPromptRow): string =>
    row.prompt_text && row.prompt_text.trim().length > 0
      ? row.prompt_text
      : codeDefault.text;

  const pickScoped = (candidates: SlotPromptRow[]): SlotPromptRow | undefined => {
    const scoped = garmentScope
      ? candidates.find((r) => r.garment_scope === garmentScope)
      : undefined;
    const global = candidates.find((r) => !r.garment_scope);
    return scoped ?? global;
  };

  const activeRow = pickScoped(rows.filter((r) => r.is_active));
  const active: ResolvedPrompt = activeRow
    ? { text: promptText(activeRow), versionName: activeRow.version_name }
    : codeDefault;

  const canaryRow = pickScoped(
    rows.filter((r) => r.is_canary && (r.rollout_percentage ?? 0) > 0),
  );
  // A challenger that has been promoted to champion (is_active) is no longer a
  // canary — never route to it as one.
  const canary: CanaryPrompt | null =
    canaryRow && !canaryRow.is_active
      ? {
          prompt: { text: promptText(canaryRow), versionName: canaryRow.version_name },
          rolloutPercentage: Math.max(0, Math.min(100, canaryRow.rollout_percentage ?? 0)),
        }
      : null;

  return { active, canary };
}
