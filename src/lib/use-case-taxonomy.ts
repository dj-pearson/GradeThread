import type { UserUseCase } from "@/types/database";

// US-2535: one use-case taxonomy, and the iOS mapping onto it.
//
// The two onboardings asked different questions. Web writes users.use_case as
// seller | buyer | consignment | developer (the DB CHECK in migration 00022
// allows exactly those four) and personalises the dashboard, the activation
// checklist and the first-run CTA from it. iOS asked reseller | grader | store
// and sent the answer only to telemetry, so an iOS user's column stayed NULL
// for ever.
//
// THE DECISION (owner, 2026-08-14): map all three iOS answers to `seller`, and
// keep reseller/grader/store as telemetry only.
//
// The reasoning, recorded because the collapse looks lossy and is not: the four
// canonical values answer "what is this person here to do", and all three iOS
// answers are "sell". reseller vs grader is a VOLUME distinction and store is a
// CHANNEL one; neither changes which dashboard, checklist or first action fits.
// Widening the CHECK to carry volume as a second dimension was the alternative
// and was declined — it costs a migration and forces dashboard.tsx to branch on
// values that would change nothing.
//
// This module is the SPEC the Swift side implements. It is not a second source
// of truth: iOS writes the canonical value this mapping produces, and nothing
// on the phone re-derives what a use case means.

/** The four values users.use_case may hold. Mirrors the 00022 CHECK exactly. */
export const USER_USE_CASES: readonly UserUseCase[] = [
  "seller",
  "buyer",
  "consignment",
  "developer",
];

/** The three answers iOS onboarding offers (OnboardingUseCase in Swift). */
export const IOS_ONBOARDING_ANSWERS = ["reseller", "grader", "store"] as const;
export type IosOnboardingAnswer = (typeof IOS_ONBOARDING_ANSWERS)[number];

/**
 * iOS answer -> the value written to users.use_case.
 *
 * Exhaustive over IosOnboardingAnswer on purpose: adding a fourth iOS option
 * becomes a type error here rather than an answer that silently writes nothing
 * and leaves the column NULL, which is the exact bug this story is about.
 */
export const IOS_USE_CASE_MAP: Record<IosOnboardingAnswer, UserUseCase> = {
  reseller: "seller",
  grader: "seller",
  store: "seller",
};

/**
 * Resolve an iOS onboarding answer to the column value.
 *
 * Named `iosAnswerToUseCase`, not `useCaseFromIosAnswer`: anything starting
 * with `use` trips react-hooks/rules-of-hooks the moment it is called in a
 * loop, which a test over the three answers does.
 *
 * Returns null for anything unrecognised rather than guessing. A wrong
 * personalisation is worse than the default branch, which already lands on the
 * seller experience.
 */
export function iosAnswerToUseCase(
  answer: string | null | undefined,
): UserUseCase | null {
  const key = (answer ?? "").trim().toLowerCase() as IosOnboardingAnswer;
  return IOS_USE_CASE_MAP[key] ?? null;
}

/** Whether a value may be written to users.use_case without violating the CHECK. */
export function isWritableUseCase(value: unknown): value is UserUseCase {
  return (
    typeof value === "string" && (USER_USE_CASES as readonly string[]).includes(value)
  );
}
