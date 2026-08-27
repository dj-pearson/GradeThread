// What does an AI action actually COST us, and does the plan that sold it cover
// it? US-2924.
//
// WHY THIS IS A SCRIPT AND NOT A NUMBER SOMEBODY WROTE DOWN. The billing unit is
// "one AI action", and an AI action is not a unit of cost. quick-grade.ts sends
// ONE Anthropic call per image up to MAX_QUICK_IMAGES = 4, plus a composite
// call, so a single reserved action buys between two and five model calls
// depending on how many photos the seller happened to attach. The margin on a
// plan therefore depends on customer BEHAVIOUR, not on the price list, and the
// only place that behaviour is recorded is ai_usage_events.
//
// It answers four questions, in the order they matter:
//
//   1. What does an action cost at the 50th, 90th and 99th percentile?
//      An average hides the case that loses money. If p99 x allowance exceeds
//      the plan price, the plan is underwritten by users who scan less.
//   2. Which features spend the money?
//   3. Which accounts are underwater, and by how much?
//   4. Does each plan's full allowance, at the measured cost, fit inside the
//      plan's price?
//
// READ-ONLY. It writes nothing.
//
//   deno run --allow-net --allow-env scripts/unit-economics.ts [--days 30] [--json]
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "@supabase/supabase-js";
import { FALLBACK_MATRIX } from "../src/lib/pricing-config.ts";

const url = Deno.env.get("SUPABASE_URL")?.trim();
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  Deno.exit(1);
}
// A key that is not header-safe fails PER QUERY rather than at connect time, so
// supabase-js reports it as "this table is unreadable" and a caller that treats
// an unreadable table as "no rows" prints a confident, empty, wrong report.
const badChar = /[^\x21-\x7e]/.exec(key);
if (badChar || key.split(".").length !== 3 || key.length < 100) {
  console.error(
    `! SUPABASE_SERVICE_ROLE_KEY is not a usable JWT (${key.length} characters, ` +
      `${key.split(".").length} segments${
        badChar ? `, bad character at index ${badChar.index}` : ""
      }). Refusing to run rather than report a confident zero.`,
  );
  Deno.exit(1);
}

const args = Deno.args;
function flag(name: string, fallback: number): number {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const DAYS = flag("--days", 30);
const AS_JSON = args.includes("--json");

// Monthly plan prices in cents. Mirrors FLIPDESK_PLANS in src/lib/constants.ts,
// which the edge cannot import (it is frontend-side). The allowances come from
// the shared FALLBACK_MATRIX, so only the PRICE is duplicated here.
const PLAN_PRICE_CENTS: Record<string, number> = {
  free: 0,
  starter: 2900,
  pro: 5900,
  business: 9900,
};

const db = createClient(url, key, { auth: { persistSession: false } });
const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();

interface UsageRow {
  user_id: string | null;
  submission_id: string | null;
  phase: string;
  model: string;
  cost_usd: string | number;
  created_at: string;
}

async function readUsage(): Promise<UsageRow[]> {
  const page = 1000;
  const out: UsageRow[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await db
      .from("ai_usage_events")
      .select("user_id, submission_id, phase, model, cost_usd, created_at")
      .gte("created_at", since)
      .range(from, from + page - 1);
    if (error) {
      console.error(`! ai_usage_events unreadable: ${error.message}`);
      Deno.exit(1);
    }
    const rows = (data ?? []) as unknown as UsageRow[];
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

const usage = await readUsage();
const usd = (r: UsageRow) => Number(r.cost_usd) || 0;
const total = usage.reduce((a, r) => a + usd(r), 0);

if (usage.length === 0) {
  console.log(
    `No ai_usage_events in the last ${DAYS} days. Either nothing ran, or the ` +
      `cost ledger stopped being written - check before reading this as $0 spend.`,
  );
  Deno.exit(0);
}

// ── 1. What one BILLED ACTION costs ─────────────────────────────────────────
//
// Grouped by submission_id, because that is the closest thing in this ledger to
// "one thing the user asked for": quick-grade writes one row per image plus a
// composite row, all carrying the same submission. Rows with no submission are
// counted separately rather than folded in - they are a different population and
// averaging them together would flatter the per-action figure.
const bySubmission = new Map<string, number>();
let orphanCost = 0;
let orphanRows = 0;
for (const r of usage) {
  if (!r.submission_id) {
    orphanCost += usd(r);
    orphanRows += 1;
    continue;
  }
  bySubmission.set(r.submission_id, (bySubmission.get(r.submission_id) ?? 0) + usd(r));
}
const actionCosts = [...bySubmission.values()].sort((a, b) => a - b);
const pct = (p: number) =>
  actionCosts.length === 0
    ? 0
    : actionCosts[Math.min(actionCosts.length - 1, Math.floor(actionCosts.length * p))]!;
const p50 = pct(0.5), p90 = pct(0.9), p99 = pct(0.99);
const mean = actionCosts.reduce((a, b) => a + b, 0) / (actionCosts.length || 1);

// Calls per action - the multiplier that makes "one action" not a unit of cost.
const callsPerAction = new Map<string, number>();
for (const r of usage) {
  if (!r.submission_id) continue;
  callsPerAction.set(r.submission_id, (callsPerAction.get(r.submission_id) ?? 0) + 1);
}
const callCounts = [...callsPerAction.values()].sort((a, b) => a - b);
const maxCalls = callCounts[callCounts.length - 1] ?? 0;
const meanCalls = callCounts.reduce((a, b) => a + b, 0) / (callCounts.length || 1);

// ── 2. Where the money goes ─────────────────────────────────────────────────
const byPhase = new Map<string, { rows: number; cost: number }>();
for (const r of usage) {
  const e = byPhase.get(r.phase) ?? { rows: 0, cost: 0 };
  e.rows += 1;
  e.cost += usd(r);
  byPhase.set(r.phase, e);
}
const byModel = new Map<string, { rows: number; cost: number }>();
for (const r of usage) {
  const e = byModel.get(r.model) ?? { rows: 0, cost: 0 };
  e.rows += 1;
  e.cost += usd(r);
  byModel.set(r.model, e);
}

// ── 3. Who is underwater ────────────────────────────────────────────────────
const byUser = new Map<string, number>();
for (const r of usage) {
  if (!r.user_id) continue;
  byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0) + usd(r));
}
const userIds = [...byUser.keys()];
const plans = new Map<string, string>();
for (let i = 0; i < userIds.length; i += 200) {
  const { data } = await db
    .from("users")
    .select("id, flipdesk_plan, subscription_status")
    .in("id", userIds.slice(i, i + 200));
  for (const u of (data ?? []) as Array<{ id: string; flipdesk_plan: string | null }>) {
    plans.set(u.id, u.flipdesk_plan ?? "free");
  }
}

interface Account {
  userId: string;
  plan: string;
  costUsd: number;
  revenueUsd: number;
  marginUsd: number;
}
const accounts: Account[] = [...byUser.entries()]
  .map(([userId, costUsd]) => {
    const plan = plans.get(userId) ?? "free";
    // Prorated to the window, so a 7-day run is not compared against a full
    // month of revenue.
    const revenueUsd = ((PLAN_PRICE_CENTS[plan] ?? 0) / 100) * (DAYS / 30);
    return { userId, plan, costUsd, revenueUsd, marginUsd: revenueUsd - costUsd };
  })
  .sort((a, b) => a.marginUsd - b.marginUsd);
const underwater = accounts.filter((a) => a.marginUsd < 0);

// ── 4. Does the FULL allowance fit inside the price? ────────────────────────
//
// The question a margin average cannot answer: a plan is only sound if a user
// who spends every action they were sold still leaves a margin. Measured at p90
// rather than the mean, because the mean is dragged down by accounts that barely
// use the product and those are not the ones who will call the bluff.
const planRisk = Object.entries(FALLBACK_MATRIX).map(([plan, cfg]) => {
  const priceUsd = (PLAN_PRICE_CENTS[plan] ?? 0) / 100;
  const allowance = cfg.aiActionsPerMonth;
  return {
    plan,
    priceUsd,
    aiActionsPerMonth: allowance,
    fullUseCostAtP50: allowance * p50,
    fullUseCostAtP90: allowance * p90,
    marginAtP90: priceUsd - allowance * p90,
    underwaterIfFullyUsed: priceUsd - allowance * p90 < 0,
  };
});

const summary = {
  windowDays: DAYS,
  callsRecorded: usage.length,
  billedActionsSeen: actionCosts.length,
  totalCostUsd: round(total),
  costPerAction: { mean: round(mean), p50: round(p50), p90: round(p90), p99: round(p99) },
  anthropicCallsPerAction: { mean: round(meanCalls), max: maxCalls },
  rowsWithNoSubmission: orphanRows,
  costWithNoSubmissionUsd: round(orphanCost),
  accountsSeen: accounts.length,
  accountsUnderwater: underwater.length,
  underwaterCostUsd: round(underwater.reduce((a, x) => a + -x.marginUsd, 0)),
};

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

if (AS_JSON) {
  console.log(JSON.stringify({ summary, planRisk, byPhase: [...byPhase], byModel: [...byModel], accounts }, null, 2));
} else {
  console.log(`AI unit economics, last ${DAYS} days\n`);
  console.log(`${usage.length} Anthropic call(s) across ${actionCosts.length} billed action(s), $${round(total)} total.\n`);

  console.log("── what one action costs ──");
  console.log(`  mean   $${round(mean)}`);
  console.log(`  p50    $${round(p50)}`);
  console.log(`  p90    $${round(p90)}`);
  console.log(`  p99    $${round(p99)}`);
  console.log(`  Anthropic calls per action: mean ${round(meanCalls)}, max ${maxCalls}`);
  if (orphanRows > 0) {
    console.log(`  (plus ${orphanRows} call(s) with no submission, $${round(orphanCost)} - counted separately, not averaged in)`);
  }

  console.log("\n── where it goes ──");
  for (const [phase, e] of [...byPhase.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
    console.log(`  ${phase.padEnd(26)} ${String(e.rows).padStart(6)} calls  $${round(e.cost)}`);
  }
  console.log("");
  for (const [model, e] of [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
    console.log(`  ${model.padEnd(32)} ${String(e.rows).padStart(6)} calls  $${round(e.cost)}`);
  }

  console.log("\n── does the FULL allowance fit inside the price? ──");
  console.log("  (allowance x measured p90 cost per action, against the monthly price)");
  for (const r of planRisk) {
    const verdict = r.priceUsd === 0
      ? "free tier - pure cost"
      : r.underwaterIfFullyUsed
      ? `UNDERWATER by $${round(-r.marginAtP90)}`
      : `ok, $${round(r.marginAtP90)} left`;
    console.log(
      `  ${r.plan.padEnd(9)} $${String(r.priceUsd).padStart(5)}/mo  ` +
        `${String(r.aiActionsPerMonth).padStart(5)} actions  ` +
        `= $${String(round(r.fullUseCostAtP90)).padStart(8)}  ${verdict}`,
    );
  }

  console.log("\n── accounts underwater this window ──");
  if (underwater.length === 0) {
    console.log("  none.");
  } else {
    console.log(`  ${underwater.length} of ${accounts.length}, costing $${round(underwater.reduce((a, x) => a + -x.marginUsd, 0))} more than they paid.`);
    for (const a of underwater.slice(0, 15)) {
      console.log(
        `  ${a.userId.slice(0, 8)}  ${a.plan.padEnd(9)} ` +
          `cost $${String(round(a.costUsd)).padStart(8)}  ` +
          `paid $${String(round(a.revenueUsd)).padStart(7)}  ` +
          `margin -$${round(-a.marginUsd)}`,
      );
    }
  }
}
