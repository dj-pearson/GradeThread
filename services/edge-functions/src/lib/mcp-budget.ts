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
  | "draft_generation"
  | "draft_edit"
  | "extension_queue"
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
  // US-9115. A generation call spends one AI action PER ITEM, but this counts
  // CALLS -- the per-item atomic reservation (US-527) is the authoritative
  // control on the allowance, and this is the runaway-loop ceiling above it.
  draft_generation: {
    kind: "draft_generation",
    windowMs: DAY,
    max: 100,
    label: "draft generations",
  },
  // Editing a draft costs nothing and a model iterating on wording legitimately
  // makes many edits, so this is loose. It exists to stop a loop, not to ration.
  draft_edit: { kind: "draft_edit", windowMs: HOUR, max: 200, label: "draft edits" },
  // US-3065. Sized like publish rather than like draft_edit, and that is the
  // judgement: queueing costs nothing and puts nothing live, but a runaway loop
  // fills the seller's queue with work their browser will dutifully run against
  // real marketplaces the next time they open it. The ceiling is on CALLS, and
  // one call may carry up to MAX_QUEUE_TOOL_ITEMS items across several channels;
  // MAX_QUEUE_DEPTH is the separate cap on how much may be waiting at once.
  extension_queue: {
    kind: "extension_queue",
    windowMs: HOUR,
    max: 20,
    label: "batches queued for the browser",
  },
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
  price_change: [
    "gradethread_reprice_apply",
    "gradethread_set_price",
    // US-9117. Taking one suggestion is a price change on a live listing, so it
    // shares the ceiling rather than getting its own -- the cap is about how much
    // a model may move a seller's prices per hour, not about which tool did it.
    "gradethread_apply_price_suggestion",
    // Dismissing changes no price. It is here because the coverage guard requires
    // every destructive tool to be budgeted, and a runaway loop dismissing every
    // suggestion a seller has is worth stopping even though it costs nothing.
    "gradethread_dismiss_price_suggestion",
  ],
  end_listing: [
    "gradethread_end_listing",
    // US-9118. Bulk end shares the ceiling rather than getting a looser one:
    // the cap is about how many of a seller's listings a model may take off
    // sale per hour, and doing it in one call does not make it fewer.
    "gradethread_end_listings",
    "gradethread_relist",
  ],
  grade: ["gradethread_grade_item", "gradethread_grade_batch"],
  draft_generation: ["gradethread_create_draft"],
  draft_edit: ["gradethread_update_draft"],
  // US-3065. The READ tool is absent on purpose: it mutates nothing, and the
  // coverage guard only requires a budget for tools that do.
  extension_queue: ["gradethread_queue_extension_work"],
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
