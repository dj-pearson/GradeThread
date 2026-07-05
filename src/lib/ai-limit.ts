// US-1631: the single source of truth for a user's effective AI-action cap.
//
// A seller can set a self-imposed AI cap (users.ai_action_limit) — but it may
// only LOWER the plan's limit, never raise it above what the plan allows. This
// logic was duplicated (correctly) in billing.tsx / usage-meter / sidebar and
// (incorrectly, as `userLimit ?? planLimit`) in use-plan-usage + settings, so
// the surfaces disagreed when a user's cap exceeded the plan. Centralize it.
//
// Convention: `-1` means unlimited (plan default for the top tier).
export function effectiveAiLimit(planLimit: number, userLimit: number | null): number {
  if (planLimit === -1 && userLimit == null) return -1;
  if (planLimit === -1) return userLimit ?? -1;
  if (userLimit == null) return planLimit;
  return Math.min(planLimit, userLimit);
}
