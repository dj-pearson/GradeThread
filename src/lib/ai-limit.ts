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

// The AI allowance resets at 00:00 UTC on the 1st, on the server's clock,
// so the date is computed and printed in UTC. Local time put it a day early
// for anyone west of Greenwich on the evening of the last day.
export function nextAiResetLabel(now: Date = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

// What the typed cap will actually do. A cap can only LOWER the plan's
// allowance (effectiveAiLimit), and a cap below the plan also stops Action
// Credits from topping it up, so a number that looks harmless can either be
// ignored or quietly switch something off. Say which.
export function aiCapHint(typed: string, planLimit: number): string {
  const t = typed.trim();
  if (t === "") {
    return planLimit < 0
      ? "Blank uses your plan's allowance, which is unlimited."
      : `Blank uses your plan's allowance of ${planLimit} a month.`;
  }
  if (!/^\d+$/.test(t)) return "Enter a whole number, or leave it blank.";
  const n = Number.parseInt(t, 10);
  if (n === 0) return "0 turns AI off. No AI actions will run.";
  if (planLimit >= 0 && n >= planLimit) {
    return `No effect: your plan already stops at ${planLimit} a month.`;
  }
  return `Stops at ${n} a month, and Action Credits won't be used past it.`;
}
