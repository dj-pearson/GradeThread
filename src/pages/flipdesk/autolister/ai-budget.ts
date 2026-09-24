// AL-08: how many AI actions the seller can spend right now.
//
// The page counted the monthly allowance only, so a seller with 5 actions and
// 200 Action Credits was told a 20-item batch would not fit, when the edge
// (checkQuota) funds the overage from the wallet. Credits count only when the
// PLAN is the binding cap: a seller's own self-cap (users.ai_action_limit)
// below the plan is a spending guard, and the edge never answers it with the
// wallet. Mirrors creditsAllowedFor in services/edge-functions/src/lib/ai-quota.ts.

export interface AiActionBudget {
  /** Allowance left plus spendable credits. */
  remaining: number;
  /** Monthly allowance left. */
  allowance: number;
  /** Action Credits that count toward `remaining` (0 when not spendable). */
  credits: number;
}

export function aiActionBudget(args: {
  planCap: number;
  selfCap: number | null | undefined;
  used: number;
  creditBalance: number | null | undefined;
}): AiActionBudget {
  const { planCap, selfCap, used } = args;
  const limit = selfCap != null ? Math.min(planCap, selfCap) : planCap;
  const allowance = Math.max(0, limit - used);
  const creditsAllowed = selfCap == null || selfCap >= planCap;
  const credits = creditsAllowed ? Math.max(0, Math.floor(args.creditBalance ?? 0)) : 0;
  return { remaining: allowance + credits, allowance, credits };
}
