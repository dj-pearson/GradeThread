// What does an AI action actually COST us, and does the plan that sold it cover
// it? US-2924.
//
// WHY THIS IS A SCRIPT AND NOT A NUMBER SOMEBODY WROTE DOWN. The billing unit is
// "one AI action", and an AI action is not a unit of cost. Margin depends on
// customer BEHAVIOUR, not on the price list, and the only record of that
// behaviour is ai_usage_events.
//
// THE MISTAKE THE FIRST VERSION MADE, WRITTEN DOWN BECAUSE IT IS THE WHOLE
// LESSON. It grouped every row by `submission_id` and called each group one
// billed action. On production 1,915 of 1,942 rows carry NO submission — only
// grading writes one — so it derived "cost per action" from three grading
// submissions, multiplied that by each plan's AI-action allowance, and reported
// every paid plan as catastrophically underwater. Every number was real. The
// arithmetic joined two things that are not the same unit, and the output looked
// exactly like a finding.
//
// So the phases are CLASSIFIED, and a phase this script does not recognise is
// reported rather than quietly bucketed:
//
//   operator   The platform's own spend. `content` is blog and newsletter
//              generation behind /api/content/blog/* (admin-only in main.ts);
//              `agent:*` is the internal cron fleet. No user triggers these and
//              no allowance covers them. It is a fixed monthly bill.
//   grading    per_image + composite. Billed as GRADE CREDITS, a separate system
//              on purpose (see lib/ai-metering.ts). Counting it against the
//              AI-action allowance double-counts.
//   action     What reserve_ai_action actually gates. These routes reserve once
//              and make one model call, so cost-per-call is cost-per-action.
//
// READ-ONLY. It writes nothing.
//
//   deno run --allow-net --allow-env scripts/unit-economics.ts [--days 30] [--json]
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
//
// EXIT CODES. 0 means both reads - the ledger and the plan lookup - came back
// in full. 1 means one of them failed and no table was printed (US-3396).

import { createClient } from "@supabase/supabase-js";
import { FALLBACK_MATRIX } from "../src/lib/pricing-config.ts";
// US-3145: the phase classification moved to src/lib so the token profile and
// this script cannot drift apart. Adding a feature to OPERATOR_PHASES there now
// fixes both reports at once; two copies would have fixed one and left the
// other quietly attributing platform spend to customers.
import {
  classifyPhase as classify,
  isRecognisedPhase as isRecognised,
  type SpendBucket as Bucket,
} from "../src/lib/ai-token-profile.ts";

const url = Deno.env.get("SUPABASE_URL")?.trim();
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  Deno.exit(1);
}
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
// which the edge cannot import (frontend-side). Allowances come from the shared
// FALLBACK_MATRIX, so only the PRICE is duplicated here.
const PLAN_PRICE_CENTS: Record<string, number> = {
  free: 0,
  starter: 2900,
  pro: 5900,
  business: 9900,
};

// The phase sets and both classifiers now live in src/lib/ai-token-profile.ts
// and are imported above. The comments that explained WHY a phase belongs to a
// bucket moved with them, so this script keeps the plan arithmetic and the
// taxonomy has one home.

const db = createClient(url, key, { auth: { persistSession: false } });
const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();

interface UsageRow {
  user_id: string | null;
  submission_id: string | null;
  phase: string;
  model: string;
  cost_usd: string | number;
}

async function readUsage(): Promise<UsageRow[]> {
  const page = 1000;
  const out: UsageRow[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await db
      .from("ai_usage_events")
      .select("user_id, submission_id, phase, model, cost_usd")
      .gte("created_at", since)
      // Ordered so paging is stable: without an order the same event can appear
      // on two pages and its cost is counted twice (US-3396).
      .order("id", { ascending: true })
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

if (usage.length === 0) {
  console.log(
    `No ai_usage_events in the last ${DAYS} days. Either nothing ran, or the ` +
      `cost ledger stopped being written - check before reading this as $0 spend.`,
  );
  Deno.exit(0);
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ── Spend by phase, with its bucket ─────────────────────────────────────────
interface PhaseStat { phase: string; bucket: Bucket; calls: number; cost: number }
const phases = new Map<string, PhaseStat>();
for (const r of usage) {
  const e = phases.get(r.phase) ??
    { phase: r.phase, bucket: classify(r.phase), calls: 0, cost: 0 };
  e.calls += 1;
  e.cost += usd(r);
  phases.set(r.phase, e);
}
const phaseList = [...phases.values()].sort((a, b) => b.cost - a.cost);
const bucketTotal = (b: Bucket) =>
  phaseList.filter((p) => p.bucket === b).reduce((a, p) => a + p.cost, 0);
const bucketCalls = (b: Bucket) =>
  phaseList.filter((p) => p.bucket === b).reduce((a, p) => a + p.calls, 0);

const operatorCost = bucketTotal("operator");
const gradingCost = bucketTotal("grading");
const actionCost = bucketTotal("action");
const actionCalls = bucketCalls("action");
const total = operatorCost + gradingCost + actionCost;

// ── What ONE user AI action costs ───────────────────────────────────────────
//
// These routes reserve one action and make one model call, so cost-per-call is
// cost-per-action. The BLENDED figure is what an average month costs; the
// WORST FEATURE is what a user who only ever uses the expensive one costs, and
// that is the number a plan has to survive.
const blendedPerAction = actionCalls > 0 ? actionCost / actionCalls : 0;
const actionPhases = phaseList
  .filter((p) => p.bucket === "action")
  .map((p) => ({ ...p, perCall: p.calls > 0 ? p.cost / p.calls : 0 }))
  .sort((a, b) => b.perCall - a.perCall);
const worstPhase = actionPhases[0];
const worstPerAction = worstPhase?.perCall ?? 0;

// ── Does the FULL allowance fit inside the price? ───────────────────────────
const planRisk = Object.entries(FALLBACK_MATRIX).map(([plan, cfg]) => {
  const priceUsd = (PLAN_PRICE_CENTS[plan] ?? 0) / 100;
  const allowance = cfg.aiActionsPerMonth;
  return {
    plan,
    priceUsd,
    aiActionsPerMonth: allowance,
    costAtBlended: allowance * blendedPerAction,
    costAtWorstFeature: allowance * worstPerAction,
    marginAtBlended: priceUsd - allowance * blendedPerAction,
    marginAtWorstFeature: priceUsd - allowance * worstPerAction,
  };
});

// ── Who spent what ──────────────────────────────────────────────────────────
const byUser = new Map<string, number>();
for (const r of usage) {
  if (!r.user_id) continue;
  if (classify(r.phase) === "operator") continue; // not theirs
  byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0) + usd(r));
}
const userIds = [...byUser.keys()];
const plans = new Map<string, string>();
// FATAL on error (US-3396). This read was the one place the file's own opening
// lesson repeated itself: a dropped error left `plans` empty, every account fell
// through to the `?? "free"` default below, every free account has $0 revenue,
// and so EVERY account landed in `underwater`. The headline "N accounts
// underwater" is the number this script exists to produce, and a failed user
// lookup produced its worst possible value while looking exactly like a finding.
for (let i = 0; i < userIds.length; i += 200) {
  const { data, error } = await db
    .from("users")
    .select("id, flipdesk_plan")
    .in("id", userIds.slice(i, i + 200));
  if (error) {
    console.error(
      `! users read failed for batch ${i}-${i + 200}: ${error.message}\n` +
        `! Every account with no plan row defaults to 'free', which has $0 ` +
        `revenue, which puts it underwater. Refusing to print a margin table ` +
        `built on a failed plan lookup.`,
    );
    Deno.exit(1);
  }
  for (const u of (data ?? []) as Array<{ id: string; flipdesk_plan: string | null }>) {
    plans.set(u.id, u.flipdesk_plan ?? "free");
  }
}
// A user id with spend but no row in `users` is a DELETED account, not a free
// one. It is counted and labelled rather than folded into `free`, so the
// underwater list says how much of itself it cannot explain (US-3396).
const planUnknown = userIds.filter((id) => !plans.has(id));
const accounts = [...byUser.entries()]
  .map(([userId, costUsd]) => {
    const plan = plans.get(userId) ?? "free";
    const revenueUsd = ((PLAN_PRICE_CENTS[plan] ?? 0) / 100) * (DAYS / 30);
    return { userId, plan, costUsd, revenueUsd, marginUsd: revenueUsd - costUsd };
  })
  .sort((a, b) => a.marginUsd - b.marginUsd);
const underwater = accounts.filter((a) => a.marginUsd < 0);

const summary = {
  windowDays: DAYS,
  callsRecorded: usage.length,
  totalCostUsd: round(total, 2),
  operatorCostUsd: round(operatorCost, 2),
  gradingCostUsd: round(gradingCost, 2),
  userActionCostUsd: round(actionCost, 2),
  operatorSharePct: total > 0 ? round((operatorCost / total) * 100, 1) : 0,
  userActionCalls: actionCalls,
  costPerActionBlended: round(blendedPerAction),
  worstFeature: worstPhase?.phase ?? null,
  costPerActionWorstFeature: round(worstPerAction),
  payingAccounts: accounts.filter((a) => a.revenueUsd > 0).length,
  accountsUnderwater: underwater.length,
  /** Spending ids with no `users` row. Counted as free above, but SAY SO. */
  accountsWithNoPlanRow: planUnknown.length,
};

if (AS_JSON) {
  console.log(JSON.stringify({ summary, planRisk, phases: phaseList, accounts }, null, 2));
} else {
  console.log(`AI unit economics, last ${DAYS} days\n`);
  console.log(`${usage.length} Anthropic call(s), $${round(total, 2)} total.\n`);

  console.log("── who the spend belongs to ──");
  console.log(`  operator (blog, newsletter, agent fleet)  $${round(operatorCost, 2).toFixed(2)}  ${summary.operatorSharePct}%`);
  console.log(`  grading  (billed as grade credits)        $${round(gradingCost, 2).toFixed(2)}`);
  console.log(`  user AI actions                           $${round(actionCost, 2).toFixed(2)}  over ${actionCalls} action(s)`);
  console.log("  Only the last line is what an AI-action allowance has to cover.");

  console.log("\n── cost per USER AI action ──");
  console.log(`  blended        $${round(blendedPerAction)}`);
  if (worstPhase) {
    console.log(`  worst feature  $${round(worstPerAction)}  (${worstPhase.phase}, ${worstPhase.calls} calls)`);
  }
  for (const p of actionPhases) {
    console.log(`    ${p.phase.padEnd(26)} ${String(p.calls).padStart(5)} calls  $${round(p.cost, 2).toFixed(2)}  = $${round(p.perCall)}/action`);
  }

  console.log("\n── operator spend (no allowance covers this) ──");
  for (const p of phaseList.filter((x) => x.bucket === "operator").slice(0, 8)) {
    console.log(`  ${p.phase.padEnd(28)} ${String(p.calls).padStart(5)} calls  $${round(p.cost, 2).toFixed(2)}`);
  }
  const agentCost = phaseList
    .filter((p) => p.phase.startsWith("agent:"))
    .reduce((a, p) => a + p.cost, 0);
  console.log(`  (agent:* fleet subtotal: $${round(agentCost, 2).toFixed(2)})`);

  console.log("\n── does the FULL allowance fit inside the price? ──");
  console.log("  allowance x cost per action, against the monthly price.");
  console.log("  'worst' = every action spent on the most expensive feature.\n");
  for (const r of planRisk) {
    if (r.priceUsd === 0) {
      console.log(`  ${r.plan.padEnd(9)} free      ${String(r.aiActionsPerMonth).padStart(5)} actions  costs up to $${round(r.costAtWorstFeature, 2).toFixed(2)} per user, recovered from nobody`);
      continue;
    }
    const b = r.marginAtBlended >= 0 ? `+$${round(r.marginAtBlended, 2).toFixed(2)}` : `-$${round(-r.marginAtBlended, 2).toFixed(2)}`;
    const w = r.marginAtWorstFeature >= 0 ? `+$${round(r.marginAtWorstFeature, 2).toFixed(2)}` : `UNDERWATER $${round(-r.marginAtWorstFeature, 2).toFixed(2)}`;
    console.log(
      `  ${r.plan.padEnd(9)} $${String(r.priceUsd).padStart(3)}/mo  ${String(r.aiActionsPerMonth).padStart(5)} actions  ` +
        `blended ${b.padStart(9)}   worst ${w}`,
    );
  }

  const unknown = phaseList.filter((p) => !isRecognised(p.phase));
  if (unknown.length > 0) {
    console.log("\n── phases this script does not recognise ──");
    console.log("  Counted as USER ACTIONS above. If one is really operator spend,");
    console.log("  add it to OPERATOR_PHASES or the plan math overstates customer cost.");
    for (const p of unknown) {
      console.log(`  ${p.phase.padEnd(28)} ${String(p.calls).padStart(5)} calls  $${round(p.cost, 2).toFixed(2)}`);
    }
  }

  console.log("\n── accounts underwater this window ──");
  if (planUnknown.length > 0) {
    console.log(
      `  NOTE: ${planUnknown.length} of ${userIds.length} spending account(s) have ` +
        `no users row (deleted). Their plan is UNKNOWN, not free; they are priced ` +
        `at $0 below, so they will read as underwater.`,
    );
  }
  if (underwater.length === 0) {
    console.log(`  none of ${accounts.length} account(s) with recorded spend.`);
  } else {
    for (const a of underwater.slice(0, 15)) {
      console.log(`  ${a.userId.slice(0, 8)}  ${a.plan.padEnd(9)} cost $${round(a.costUsd, 2).toFixed(2)}  paid $${round(a.revenueUsd, 2).toFixed(2)}`);
    }
  }
}
