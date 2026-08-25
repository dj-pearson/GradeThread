import {
  activationProgress,
  activationStepsFor,
  type ActivationState,
  type ActivationStep,
  type ActivationStepKey,
} from "@/lib/activation-steps";
import type { UserUseCase } from "@/types/database";

// US-2873. One instruction at a time, from photo to published.
//
// AC5 IS THE WHOLE DESIGN CONSTRAINT: "rather than being a fifth parallel
// checklist". US-2859 spent a story collapsing FOUR overlapping first-run
// lists into src/lib/activation-steps.ts, and the failure it fixed was three
// lists with three different first steps, three progress queries and three
// dismissals. A guided path built as its own sequence would be the fifth.
//
// So this file adds NO steps and NO state. It is a FILTER and an ORDERING over
// the steps that already exist, and every question it answers is answered from
// the same ActivationState the checklist reads:
//
//   "where did I stop?"      activationProgress().firstIncomplete
//   "am I finished?"          every path step isDone
//   "what do I do now?"       that step's own title, reason and route
//
// That is also why AC3 needs no bookmark. A step is done when THE REAL THING
// happened -- a grade exists, an item exists, eBay is connected -- so leaving
// halfway and coming back a week later resumes correctly by construction, on
// any device, with nothing stored.

/**
 * The steps that make up a first listing, in the order a garment moves.
 *
 * A SUBSET, deliberately. `source` (where you bought it) and `notifications`
 * are real activation steps and belong on the checklist, but neither is on the
 * path from photo to published, and a guided walk that detours through
 * bookkeeping is how a five-minute promise becomes a chore.
 */
export const GUIDED_PATH_KEYS: readonly ActivationStepKey[] = [
  "grade",
  "item",
  "ebay",
];

/** The path for a persona, or [] when that persona has no first listing. */
export function guidedStepsFor(
  useCase: UserUseCase | null,
  opts: { notifications?: boolean } = {},
): ActivationStep[] {
  // Read the persona's real list, then keep the path steps IN ITS ORDER.
  // Filtering the source list rather than re-listing the keys means a persona
  // that never gets `ebay` never gets it here either, without this file
  // knowing which personas those are.
  const all = activationStepsFor(useCase, opts);
  return all.filter((s) => GUIDED_PATH_KEYS.includes(s.key));
}

export interface GuidedPosition {
  step: ActivationStep;
  /** 1-based, for "Step 2 of 3". */
  index: number;
  total: number;
}

/**
 * The one thing to do next, or null when the path is finished or empty.
 *
 * This IS the resume: there is no stored cursor, so it cannot disagree with
 * the account's real data.
 */
export function nextGuidedStep(
  useCase: UserUseCase | null,
  state: ActivationState,
  opts: { notifications?: boolean } = {},
): GuidedPosition | null {
  const steps = guidedStepsFor(useCase, opts);
  if (steps.length === 0) return null;
  const { firstIncomplete } = activationProgress(steps, state);
  if (firstIncomplete === -1) return null;
  return {
    step: steps[firstIncomplete]!,
    index: firstIncomplete + 1,
    total: steps.length,
  };
}

export function isGuidedPathComplete(
  useCase: UserUseCase | null,
  state: ActivationState,
  opts: { notifications?: boolean } = {},
): boolean {
  const steps = guidedStepsFor(useCase, opts);
  return steps.length > 0 && steps.every((s) => s.isDone(state));
}

// ---------------------------------------------------------------------------
// Opting out.
// ---------------------------------------------------------------------------
//
// AC4: "runs exactly once per account by default, and is replayable from
// Help". The "once" half needs NO storage -- the path stops offering itself
// the moment its steps are done, because they are done. What needs storing is
// only the case where somebody wants it gone BEFORE finishing.
//
// localStorage, not a column, and that is a deliberate trade with a cost worth
// writing down: opting out on a laptop will not carry to a phone, so it can
// reappear once on a second device. The alternative is a migration, and
// US-2859 recorded why that is expensive here -- migration 00526 made
// public.users self-updates deny-by-default, so a new column is a migration
// plus an allowlist restatement plus a held push. For a dismissal of an OFFER
// (not data, not money, not a grade) the cheaper answer is the right one.

function optOutKey(userId: string | undefined): string {
  return `gt.guidedPath.optOut:${userId ?? "anon"}`;
}

export function hasOptedOutOfGuidedPath(userId: string | undefined): boolean {
  try {
    return localStorage.getItem(optOutKey(userId)) === "1";
  } catch {
    // Private mode, or storage disabled. Showing the offer is the safer miss:
    // an unwanted banner is a nuisance, a hidden first-run path is the defect
    // this story exists to fix.
    return false;
  }
}

export function setGuidedPathOptOut(
  userId: string | undefined,
  optedOut: boolean,
): void {
  try {
    if (optedOut) localStorage.setItem(optOutKey(userId), "1");
    else localStorage.removeItem(optOutKey(userId));
  } catch {
    /* storage unavailable; the offer simply keeps showing */
  }
}
