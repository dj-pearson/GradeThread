// Worth My Time, R1 03/12 (US-3168): find the unfinished work already sitting
// in the seller's stock.
//
// THE WHOLE POINT IS THAT THERE IS NO SECOND TASK LIST. A seller who has to
// maintain one would not use this; the work is already implied by the items
// they own and the state each one is in. This module reads that state and says
// what could be done, and nothing here invents a task or remembers one.
//
// ── IT IS BUILT ON nextAction/factsOf, NOT BESIDE THEM (AC1) ────────────────
// lib/workflow.ts already answers "what should happen to this item next", and
// the item grid renders that answer. A planner that computed its own would
// eventually disagree with the badge on the card, and the seller would be
// looking at two different truths about the same garment. So the ladder here
// IMPORTS factsOf and nextAction rather than restating them, and every
// candidate's action is derived from what nextAction already decided.
//
// Two things this module adds that nextAction does not have, because the grid
// does not need them: whether the seller can actually DO the task right now
// (context and tools), and the facts a plan is fitted to (the bin, the
// deadline, the prerequisites).
//
// ── OPTIONAL GRADING STAYS OPTIONAL (AC1) ───────────────────────────────────
// earnedStatus() never gates on a grade and this does not either. A grade
// REVIEW becomes a candidate only for an item already sitting in `graded`,
// which is a thing the seller chose to do. Nothing here ever tells a seller
// they must grade something to move on.

import type { ItemListRow } from "@/lib/item-list-columns";
import type { MarketplaceMechanism } from "@/lib/constants";
import { MARKETPLACE_MECHANISM } from "@/lib/constants";
import { factsOf, nextAction } from "@/lib/workflow";

/** Where the seller is. Mirrors WORK_CONTEXTS in the edge's work-preferences. */
export type WorkContext = "home" | "phone_only";

/** What they have to hand. Mirrors WORK_TOOLS. */
export type WorkTool = "camera" | "measuring_tape" | "steamer" | "packing_supplies";

/**
 * The tasks R1 can offer (AC3).
 *
 * Each one maps to a screen that already exists. A candidate the seller cannot
 * open is worse than no candidate: it is a plan step that dead-ends.
 */
export const CANDIDATE_ACTIONS = [
  "measure",
  "photograph",
  "review_grade",
  "price_research",
  "draft_review",
  "publish",
  "pack_ship",
] as const;
export type CandidateAction = (typeof CANDIDATE_ACTIONS)[number];

export interface BinLocation {
  value: string | null;
  /**
   * `unknown` is a real answer and is never guessed at (AC2). A seller sent to
   * the wrong shelf loses more time than one told to go and look.
   */
  source: "location_bin" | "container" | "unknown";
}

export interface ShipDeadline {
  at: string | null;
  /**
   * `confirmed` is the marketplace's own ship-by. `estimated` is
   * sold_at + handling days, which counts CALENDAR days and so lands early
   * whenever a weekend falls inside the window. `unknown` is neither.
   *
   * AC5: a fixed three-day window is NOT a confirmed deadline and this never
   * invents one. A wrong deadline is worse than no deadline, because it puts a
   * countdown on orders nobody is late on and trains the seller to ignore the
   * queue.
   */
  confidence: "confirmed" | "estimated" | "unknown";
}

export interface WorkCandidate {
  /** `${itemId}:${action}` -- stable across runs, so a plan can be re-derived. */
  key: string;
  itemId: string;
  itemTitle: string | null;
  action: CandidateAction;
  /** Keys of the candidates that must finish first, in order. */
  prerequisiteKeys: string[];
  /**
   * Every step this item still owes to be sale-ready, this one included
   * (WMT-05). The ranker divides the item's value by the minutes of ALL of
   * them, so an item one step from listing outranks one five steps away.
   */
  remainingActions: CandidateAction[];
  /** Contexts this task can run in. A physical task is `home` only. */
  requiredContext: WorkContext[];
  requiredTools: WorkTool[];
  /** What proves it done, so a later story can check rather than ask. */
  completionEvidence: string;
  bin: BinLocation;
  shipBy: ShipDeadline;
}

/**
 * What each action needs, and what counts as having done it.
 *
 * `requiredContext` is the load-bearing column. Measuring, photographing and
 * packing all need the garment in hand at a table, so they are `home` only; a
 * seller on a bus can still review a grade, price, check a draft and publish.
 */
const ACTION_SPEC: Record<CandidateAction, {
  context: WorkContext[];
  tools: WorkTool[];
  evidence: string;
}> = {
  measure: {
    context: ["home"],
    tools: ["measuring_tape"],
    evidence: "measurements recorded on the item",
  },
  photograph: {
    context: ["home"],
    tools: ["camera"],
    evidence: "the required photo roles are all present",
  },
  review_grade: {
    context: ["home", "phone_only"],
    tools: [],
    evidence: "the grade has been opened and accepted or sent back",
  },
  price_research: {
    context: ["home", "phone_only"],
    tools: [],
    evidence: "a target price is set on the item",
  },
  draft_review: {
    context: ["home", "phone_only"],
    tools: [],
    evidence: "the draft listing has been reviewed",
  },
  publish: {
    context: ["home", "phone_only"],
    tools: [],
    evidence: "the listing is live on its marketplace",
  },
  pack_ship: {
    // Packing is physical whatever the screen says, and a steamer is not
    // needed for it. Packing supplies are.
    context: ["home"],
    tools: ["packing_supplies"],
    evidence: "a tracking number is recorded against the sale",
  },
};

/**
 * The prep ladder, in order. A candidate's prerequisites are every step above
 * it that this item has not finished.
 *
 * `review_grade` is NOT in this chain on purpose (AC1): grading is optional, so
 * nothing may list it as a prerequisite. It is offered beside the chain, never
 * inside it.
 */
const PREP_CHAIN: CandidateAction[] = [
  "measure",
  "photograph",
  "price_research",
  "draft_review",
  "publish",
];

/** nextAction's answer to the task this planner would offer, or null. */
function actionForItem(item: ItemListRow): CandidateAction | null {
  const next = nextAction(item);
  switch (next.kind) {
    case "measure":
      return "measure";
    case "photograph":
      return "photograph";
    // `grade` is nextAction nudging the seller to SEND the item for grading.
    // That is an offer, not unfinished work, and treating it as a task would
    // make optional grading feel mandatory -- which AC1 forbids. The seller
    // who wants it has the button on the card. So the planner skips straight
    // to the pricing work that `grade` is standing in front of.
    case "grade":
    case "comp":
      return "price_research";
    case "review_grade":
      return "review_grade";
    case "draft":
      return "draft_review";
    case "list":
      return "publish";
    case "ship":
      return "pack_ship";
    // Everything else is either not work (`sell` is waiting on a buyer,
    // `grading` is a job already running) or is outside R1.
    //
    // `relist` IS THE ONE WORTH NAMING (AC4). nextAction offers a returned
    // item "Relist or write off", which is a DECISION rather than work, and
    // AC3's list does not include it. So a returned item is never
    // automatically ready here, whatever channel it came from -- and it is
    // excluded by landing in this default rather than by a guard of its own.
    //
    // There WAS such a guard, and a sabotage that disabled it changed nothing,
    // because both of its branches returned null: the mechanism check inside
    // it was dead code that read like a rule. It is gone, and this is the one
    // mechanism.
    default:
      return null;
  }
}

/**
 * Which steps this item still owes before `action`.
 *
 * Read from the FACTS rather than from the status, because a status can be set
 * by hand and the facts cannot. An item a seller dragged to `drafted` with no
 * measurements still owes the measuring.
 */
function prerequisitesFor(
  item: ItemListRow,
  action: CandidateAction,
): CandidateAction[] {
  const index = PREP_CHAIN.indexOf(action);
  if (index <= 0) return [];
  const done = doneSteps(item);
  return PREP_CHAIN.slice(0, index).filter((step) => done[step] !== true);
}

/** Which prep steps the item's FACTS say are done. Publish never is here. */
function doneSteps(item: ItemListRow): Record<string, boolean> {
  const facts = factsOf(item);
  return {
    measure: facts.hasMeasurements,
    photograph: facts.hasRequiredPhotos,
    price_research: facts.hasTargetPrice,
    draft_review: facts.hasDraftListing,
  };
}

/**
 * Everything this item still owes from `action` to a live listing: any
 * unfinished step before it, the action itself, and every later PREP_CHAIN
 * step not yet done (WMT-05).
 *
 * The earlier version rebuilt the chain from prerequisite keys, which only
 * ever hold the steps BEFORE the action. nextAction always offers the first
 * unfinished step, so that was the action alone in practice, and the ranker
 * divided an item's whole value by one step's minutes.
 *
 * A step off the chain (review_grade, pack_ship) is just itself: grading is
 * optional and a parcel is the end of the line.
 */
export function remainingStepsFrom(
  item: ItemListRow,
  action: CandidateAction,
): CandidateAction[] {
  const before = prerequisitesFor(item, action);
  const index = PREP_CHAIN.indexOf(action);
  if (index < 0) return [...before, action];
  const done = doneSteps(item);
  const after = PREP_CHAIN.slice(index + 1).filter((step) => done[step] !== true);
  return [...before, action, ...after];
}

/**
 * The bin to walk to (AC2).
 *
 * location_bin is the precise answer and container is the older, coarser one.
 * Falling back to the container is better than nothing -- it still names a
 * tote -- and both are better than a guess. Whitespace-only is not a location.
 */
export function binOf(item: Pick<ItemListRow, "location_bin" | "container">): BinLocation {
  const bin = typeof item.location_bin === "string" ? item.location_bin.trim() : "";
  if (bin) return { value: bin, source: "location_bin" };
  const container = typeof item.container === "string" ? item.container.trim() : "";
  if (container) return { value: container, source: "container" };
  return { value: null, source: "unknown" };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Highest handling time worth believing, mirroring MAX_HANDLING_DAYS in
 * services/edge-functions/src/lib/ship-deadline.ts. Anything past it is a
 * parse artefact rather than a handling time, and turning one into a deadline
 * years out would sort a live order to the bottom of the queue forever.
 *
 * ship-deadline-parity.test.ts reads that file and asserts the two agree, so
 * this copy cannot drift silently.
 */
export const MAX_HANDLING_DAYS = 30;

export interface ShipDeadlineInput {
  /** The marketplace's own ship-by instant. Null when unreported. */
  shipByDate?: string | null;
  soldAt?: string | null;
  handlingDays?: number | null;
}

function parseInstant(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * When this order has to be handed to the carrier, and how much the answer is
 * worth (AC5).
 *
 * Same precedence as resolveShipBy on the edge -- marketplace date, then
 * sold_at + handling days, then null -- with the provenance kept, which is the
 * part the planner needs and the edge's caller does not.
 */
export function shipDeadlineOf(input: ShipDeadlineInput): ShipDeadline {
  const reported = parseInstant(input.shipByDate);
  if (reported !== null) {
    return { at: new Date(reported).toISOString(), confidence: "confirmed" };
  }
  const sold = parseInstant(input.soldAt);
  const days = input.handlingDays;
  if (
    sold === null || typeof days !== "number" || !Number.isFinite(days) ||
    days < 0 || days > MAX_HANDLING_DAYS
  ) {
    return { at: null, confidence: "unknown" };
  }
  return {
    at: new Date(sold + Math.round(days) * MS_PER_DAY).toISOString(),
    confidence: "estimated",
  };
}

/** Item statuses that are not work at all (AC4). */
const EXCLUDED_STATUSES = new Set([
  // The seller took these out of the pipeline on purpose.
  "archived",
  "keeping",
  "wearing",
  // Finished.
  "completed",
  // A job is already running. Offering "grade it" while the AI is mid-grade
  // would have the seller queue a second one.
  "grading",
  // Waiting on a buyer is not work. This is the one exclusion a seller might
  // argue with, and the answer is that there is nothing to DO -- the listing
  // is live and the next event comes from somebody else.
  "listed",
  // Handed to the carrier; nothing physical left.
  "shipped",
]);

/**
 * The sale facts a shipping task needs, keyed by inventory item id.
 *
 * INJECTED RATHER THAN READ OFF THE ITEM, because they are not on the item:
 * `sales.ship_by` and `sales.handling_days` (00768) live on the sale row, and
 * the item list projection does not carry them. A builder that quietly used
 * `sale_date` alone would report every deadline as estimated even where eBay
 * had given a real one, which is the exact overclaim AC5 forbids -- so the
 * caller has to supply them or get `unknown`.
 */
export type SaleFacts = Record<string, ShipDeadlineInput>;

export interface CandidateContext {
  workContext: WorkContext;
  availableTools: WorkTool[];
  /**
   * How each marketplace is reached. Injected rather than imported so a test
   * can describe a deployment where a channel is not live, which is the case
   * AC3 and AC4 both turn on.
   */
  mechanisms?: Record<string, MarketplaceMechanism>;
  /** Per-item ship-by facts from the sale row. Absent means unknown. */
  saleFacts?: SaleFacts;
}

function mechanismFor(
  platform: string | null | undefined,
  ctx: CandidateContext,
): MarketplaceMechanism {
  if (!platform) return "none";
  const table = ctx.mechanisms ??
    (MARKETPLACE_MECHANISM as unknown as Record<string, MarketplaceMechanism>);
  return table[platform] ?? "none";
}

/**
 * Work the seller COULD do but not with the setup they have (WMT-06).
 *
 * Counted rather than dropped in silence. The default setup is camera-only,
 * so every measure job used to vanish with nothing on screen to say why; a
 * count per missing tool is what lets the page say "9 jobs need a tape
 * measure" and offer the one tap that fixes it.
 */
export interface GatedWork {
  itemId: string;
  action: CandidateAction;
  reason: "tools" | "context";
  /** The tools that are missing. Empty for a context gate. */
  missing: WorkTool[];
}

export interface CandidateSet {
  candidates: WorkCandidate[];
  gated: GatedWork[];
}

/**
 * Is this item work the seller can actually start?
 *
 * Returns the candidate, or null with nothing said. Work that is only held
 * back by the seller's setup is reported by candidatesWithGates instead.
 */
export function candidateFor(
  item: ItemListRow,
  ctx: CandidateContext,
): WorkCandidate | null {
  const r = evaluate(item, ctx);
  return r !== null && "key" in r ? r : null;
}

function evaluate(
  item: ItemListRow,
  ctx: CandidateContext,
): WorkCandidate | GatedWork | null {
  const status = String(item.status ?? "");
  if (EXCLUDED_STATUSES.has(status)) return null;

  // A cancelled or refunded sale is not a shipment waiting to happen. Checked
  // before the status ladder because the item can still read `sold` (AC4).
  if (item.sale_status === "cancelled" || item.sale_status === "refunded") {
    return null;
  }
  if (item.sale_cancelled_at != null) return null;

  const action = actionForItem(item);
  if (action === null) return null;

  // Publishing and shipping both need a channel that exists (AC3).
  if (action === "publish" && mechanismFor(item.listing_platform, ctx) === "none") {
    return null;
  }

  const spec = ACTION_SPEC[action];

  // WMT-06: A PAID PARCEL IS NEVER GATED. Somebody has bought it and the
  // clock is the marketplace's, so it goes through to the ranker even with no
  // packing supplies or away from home -- where conflictFor flags it as
  // tools_missing or wrong_context and the seller SEES it. Dropping it here
  // was how a sold item disappeared from the plan on a camera-only setup.
  const soldParcel = action === "pack_ship";

  // The seller has to be somewhere it can be done (AC4).
  if (!soldParcel && !spec.context.includes(ctx.workContext)) {
    return { itemId: item.id, action, reason: "context", missing: [] };
  }

  // ...and hold the tools. A missing tape measure does not make measuring
  // partly possible.
  const missing = spec.tools.filter((t) => !ctx.availableTools.includes(t));
  if (!soldParcel && missing.length > 0) {
    return { itemId: item.id, action, reason: "tools", missing };
  }

  const prerequisites = prerequisitesFor(item, action);

  return {
    key: `${item.id}:${action}`,
    itemId: item.id,
    itemTitle: item.item_title ?? null,
    action,
    prerequisiteKeys: prerequisites.map((p) => `${item.id}:${p}`),
    remainingActions: remainingStepsFrom(item, action),
    requiredContext: spec.context,
    requiredTools: spec.tools,
    completionEvidence: spec.evidence,
    bin: binOf(item),
    shipBy: action === "pack_ship"
      ? shipDeadlineOf(
        ctx.saleFacts?.[item.id] ?? { soldAt: item.sale_date ?? null },
      )
      // A deadline belongs to a sale. Putting one on a measuring task would
      // sort unsold stock into a queue that is about orders.
      : { at: null, confidence: "unknown" },
  };
}

/** Every candidate in a seller's stock, in item order. */
export function candidatesFor(
  items: readonly ItemListRow[],
  ctx: CandidateContext,
): WorkCandidate[] {
  return candidatesWithGates(items, ctx).candidates;
}

/**
 * Every candidate, plus the work held back only by the seller's setup
 * (WMT-06). The planner uses this so the page can count what a missing tool
 * is costing rather than showing a short plan with no reason.
 */
export function candidatesWithGates(
  items: readonly ItemListRow[],
  ctx: CandidateContext,
): CandidateSet {
  const candidates: WorkCandidate[] = [];
  const gated: GatedWork[] = [];
  for (const item of items) {
    const r = evaluate(item, ctx);
    if (r === null) continue;
    if ("key" in r) candidates.push(r);
    else gated.push(r);
  }
  return { candidates, gated };
}
