// US-9119: what a single conversation is allowed to do.
//
// Rate limits (US-9105) stop a flood. They do not stop a well-paced mistake:
// forty publishes over forty minutes is inside every per-minute budget and is
// still a seller's whole store live at the wrong price. This is the ceiling
// that makes "the AI did it" a bounded sentence.
//
// ENFORCED IN THE DISPATCHER, not per handler. A per-handler cap is a cap the
// next tool forgets, and the next tool is the one nobody reviewed as carefully.
//
// FAIL CLOSED ON THE WRITE PATH. If the counter store is unreachable we cannot
// know how much has been spent, and "unknown" must not read as "none" for an
// action that ends listings. Reads stay open: refusing to answer "what is in my
// inventory" during a counter outage helps nobody.
//
// The numbers live in ONE place so the US-9101 plan decision changes them
// without hunting call sites.

import { supabaseAdmin } from "./supabase.ts";
import { redactError } from "./log-redact.ts";

/** The classes of action worth capping separately. */
export type BudgetKind =
  | "publish"
  | "price_change"
  | "end_listing"
  | "grade"
  | "ai_spend_cents";

export interface BudgetLimit {
  kind: BudgetKind;
  /** Window length. Publishes are hourly; grades are daily. */
  windowMs: number;
  max: number;
  /** What the seller is told when they hit it. */
  label: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Conservative on purpose. A seller who hits a ceiling asks for it to be
 * raised, which is a conversation; a seller whose store went live at the wrong
 * price asks for something else.
 *
 * US-9101 decides whether these vary by plan and whether they share
 * FLIPDESK_PLANS.aiActionsPerMonth. Until then one table applies to everyone,
 * and it is the tight one.
 */
export const DEFAULT_BUDGETS: Record<BudgetKind, BudgetLimit> = {
  publish: { kind: "publish", windowMs: HOUR, max: 20, label: "listings published" },
  price_change: { kind: "price_change", windowMs: HOUR, max: 50, label: "price changes" },
  end_listing: { kind: "end_listing", windowMs: HOUR, max: 20, label: "listings ended" },
  grade: { kind: "grade", windowMs: DAY, max: 200, label: "grades submitted" },
  ai_spend_cents: {
    kind: "ai_spend_cents",
    windowMs: DAY,
    max: 2000,
    label: "cents of AI spend",
  },
};

export interface BudgetVerdict {
  allowed: boolean;
  kind: BudgetKind;
  /** Used within the window, INCLUDING the request being judged. */
  used: number;
  max: number;
  /** ISO time the window rolls over, so a caller can say when to come back. */
  resetsAt: string;
  /** Present when refused. */
  message?: string;
}

/** Counts the actions a subject has already taken inside a window. */
export type BudgetCounter = (
  subject: string,
  kind: BudgetKind,
  sinceIso: string,
) => Promise<number>;

/**
 * The live counter reads the audit log (US-9113), which is already written for
 * every tool call. That is deliberate: a separate counter table would be a
 * second record of the same events, and the two would disagree the first time
 * one of them failed to write.
 */
export const auditLogCounter: BudgetCounter = async (subject, kind, sinceIso) => {
  const toolNames = TOOLS_BY_KIND[kind];
  if (toolNames.length === 0) return 0;

  const { count, error } = await supabaseAdmin
    .from("mcp_tool_calls")
    .select("id", { count: "exact", head: true })
    .eq("api_key_id", subject)
    .eq("result_status", "ok")
    .in("tool_name", toolNames)
    .gte("created_at", sinceIso);

  if (error) {
    // Surfaced as a THROW so the caller's fail-closed policy applies. Returning
    // 0 here would silently mean "nothing spent", which is the wrong default
    // for a cap on ending listings.
    throw new Error(`budget counter unavailable: ${redactError(error)}`);
  }
  return count ?? 0;
};

/**
 * Which tools count against which budget.
 *
 * Kept next to the budgets rather than on the tool definitions so the mapping
 * is reviewable as a whole: "what can spend money" should be one list someone
 * can read, not an annotation spread across a dozen files.
 */
export const TOOLS_BY_KIND: Record<BudgetKind, string[]> = {
  publish: ["gradethread_publish_listing"],
  price_change: ["gradethread_reprice_apply", "gradethread_set_price"],
  end_listing: ["gradethread_end_listing", "gradethread_relist"],
  grade: ["gradethread_grade_item", "gradethread_grade_batch"],
  ai_spend_cents: [],
};

/** The budget a tool spends from, or null when it spends from none. */
export function budgetKindForTool(toolName: string): BudgetKind | null {
  for (const [kind, names] of Object.entries(TOOLS_BY_KIND)) {
    if (names.includes(toolName)) return kind as BudgetKind;
  }
  return null;
}

export interface CheckArgs {
  subject: string;
  kind: BudgetKind;
  /** How much this request would spend. Publishes cost 1; AI spend costs cents. */
  cost?: number;
  budgets?: Record<BudgetKind, BudgetLimit>;
  counter?: BudgetCounter;
  nowMs?: number;
}

/**
 * Would this action fit inside the budget?
 *
 * Throws nothing: a counter outage becomes `allowed: false` with a message
 * saying so, because the caller's job is to refuse, not to decide policy.
 */
export async function checkBudget(args: CheckArgs): Promise<BudgetVerdict> {
  const nowMs = args.nowMs ?? Date.now();
  const budgets = args.budgets ?? DEFAULT_BUDGETS;
  const limit = budgets[args.kind];
  const cost = args.cost ?? 1;
  const windowStart = new Date(nowMs - limit.windowMs).toISOString();
  const resetsAt = new Date(nowMs + limit.windowMs).toISOString();
  const counter = args.counter ?? auditLogCounter;

  let alreadyUsed: number;
  try {
    alreadyUsed = await counter(args.subject, args.kind, windowStart);
  } catch (err) {
    console.error("[mcp-budget] counter unavailable:", redactError(err));
    return {
      allowed: false,
      kind: args.kind,
      used: 0,
      max: limit.max,
      resetsAt,
      message:
        "Cannot verify how much of this hour's allowance has been used, so this action is " +
        "refused rather than risked. Try again shortly.",
    };
  }

  const used = alreadyUsed + cost;
  if (used > limit.max) {
    return {
      allowed: false,
      kind: args.kind,
      used: alreadyUsed,
      max: limit.max,
      resetsAt,
      message:
        `Connector limit reached: ${alreadyUsed} of ${limit.max} ${limit.label} in the last ` +
        `${Math.round(limit.windowMs / HOUR)} hour(s). This resets by ${resetsAt}. ` +
        `Do this from the dashboard if it cannot wait.`,
    };
  }

  return { allowed: true, kind: args.kind, used, max: limit.max, resetsAt };
}
