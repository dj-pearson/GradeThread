/**
 * US-2358: what the platform spends on grading it never charges for.
 *
 * THE COUPLING. Migration 00110 auto-elevates any `role = 'super_admin'` row to
 * Business/enterprise, and `grade-billing.ts` gives super_admins UNCAPPED free
 * grading — no counter increment, no credit debit, a zero-delta ledger row. So
 * granting the role is also granting unlimited Claude Vision spend, in one
 * action, with no separate decision and no ceiling.
 *
 * THE DECISION (AC1): the coupling STAYS AUTOMATIC. The platform owner grading
 * their own inventory for free is the intended behaviour, the bootstrap is
 * genuinely clean (no seed migration, no env allowlist, no script mints a
 * super_admin — the first one must be set by direct database access), and
 * splitting it into a second grant would add a column, a migration and a second
 * thing to forget. What was actually wrong is that the spend was INVISIBLE:
 * nothing anywhere separated comped grading from paid grading, so a second
 * super_admin — a contractor, a support lead — could run up unbounded vision
 * spend that looked exactly like revenue-generating usage on the dashboard.
 *
 * So this is AC2: the spend is attributable. `ai_usage_events` already records
 * every Anthropic call with a `user_id` and a `cost_usd`, so no schema change is
 * needed — the missing piece was ever asking the question.
 *
 * Pure aggregation, injectable input, so the arithmetic is testable without a
 * database.
 */

export interface UsageEvent {
  user_id: string | null;
  submission_id: string | null;
  cost_usd: number | string;
  model: string;
}

export interface CompedSpendSummary {
  /** Distinct submissions graded on the comp. */
  grades: number;
  /** Anthropic calls made for them (a grade is N per-image + 1 composite). */
  calls: number;
  costUsd: number;
  /** Per super-admin, biggest spender first — a runaway has a name. */
  byUser: Array<{ userId: string; grades: number; calls: number; costUsd: number }>;
  byModel: Array<{ model: string; calls: number; costUsd: number }>;
}

/**
 * Roll up the comped events.
 *
 * `cost_usd` arrives as a STRING from PostgREST: the column is
 * `numeric(12,6)`, and supabase-js hands numerics back as strings to avoid
 * float rounding. Summing them with `+` would concatenate — "0.01" + "0.02" =
 * "0.010.02" — and the total would read as NaN or as a nonsense number rather
 * than failing. Parsed explicitly for that reason.
 */
export function summarizeCompedSpend(
  events: readonly UsageEvent[],
): CompedSpendSummary {
  const byUser = new Map<
    string,
    { grades: Set<string>; calls: number; costUsd: number }
  >();
  const byModel = new Map<string, { calls: number; costUsd: number }>();
  const submissions = new Set<string>();
  let calls = 0;
  let costUsd = 0;

  for (const e of events) {
    const cost = typeof e.cost_usd === "number" ? e.cost_usd : Number(e.cost_usd);
    // A row whose cost failed to parse is counted as a CALL but contributes 0 to
    // the money — dropping the row entirely would understate the volume too.
    const safeCost = Number.isFinite(cost) ? cost : 0;
    calls++;
    costUsd += safeCost;
    if (e.submission_id) submissions.add(e.submission_id);

    const uid = e.user_id ?? "(deleted user)";
    const u = byUser.get(uid) ?? { grades: new Set<string>(), calls: 0, costUsd: 0 };
    u.calls++;
    u.costUsd += safeCost;
    if (e.submission_id) u.grades.add(e.submission_id);
    byUser.set(uid, u);

    const m = byModel.get(e.model) ?? { calls: 0, costUsd: 0 };
    m.calls++;
    m.costUsd += safeCost;
    byModel.set(e.model, m);
  }

  const round = (n: number) => Math.round(n * 1e6) / 1e6;

  return {
    grades: submissions.size,
    calls,
    costUsd: round(costUsd),
    byUser: [...byUser.entries()]
      .map(([userId, u]) => ({
        userId,
        grades: u.grades.size,
        calls: u.calls,
        costUsd: round(u.costUsd),
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    byModel: [...byModel.entries()]
      .map(([model, m]) => ({ model, calls: m.calls, costUsd: round(m.costUsd) }))
      .sort((a, b) => b.costUsd - a.costUsd),
  };
}

/** Period window in days, matching the AI-spend dashboard's own vocabulary. */
export function periodStartIso(period: string, nowMs: number): string {
  const days = period === "today" ? 1 : period === "7d" ? 7 : period === "90d" ? 90 : 30;
  return new Date(nowMs - days * 24 * 60 * 60_000).toISOString();
}
