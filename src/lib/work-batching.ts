// Worth My Time, R1 08/12 (US-3173): pull nearby items and do similar work
// together.
//
// The scheduler (R1 07/12) already charges setup once per CONTIGUOUS run of a
// family, so a batched order is cheaper without anything else changing. What
// it deliberately did not do was REORDER to create those runs, because
// reordering overrides the ranker and that had to be its own decision. This is
// that decision.
//
// ── A BIN IS A LABEL, NOT A COORDINATE (AC3) ────────────────────────────────
// `location_bin` is a string a seller wrote on a tote. It is not a position,
// there is no map, and two bins called A-14 and A-15 may be in different
// rooms. So this groups items that share a bin and stops there. It computes no
// route, claims no distance, and orders bins by the rank of their best item
// rather than by any notion of nearness. A planner that invented a walking
// order would send sellers the wrong way round their own garage with
// confidence.
//
// ── NO CLAIMED SAVING (AC4) ─────────────────────────────────────────────────
// There is no `minutesSaved` field here and there should never be one. The
// setup charge a batch avoids is avoided against a HYPOTHETICAL plan nobody
// ran, and presenting that as time the seller saved is the same overclaim the
// duration estimator refuses. The plan is simply shorter; the seller can see
// that it is.
//
// ── URGENCY OUTRANKS CONVENIENCE (AC2) ──────────────────────────────────────
// A convenient bin group may never displace a shipment that has to go today.
// Urgent tasks keep their exact order and stay in front, and the grouping
// happens only among what is left.

import { estimateDuration, isUnestimated, type TaskFamily } from "@/lib/work-duration";
import type { RankedTask } from "@/lib/work-ranker";

export const BATCHING_VERSION = 1;

/** What the seller is told when an item's bin was never recorded (AC3). */
export const UNKNOWN_BIN_LABEL = "Location not recorded";

export interface WorkGroup {
  /** Stable and human-readable: the family and the bin it works out of. */
  id: string;
  family: TaskFamily;
  /** The bin label, or null when nobody recorded one. */
  bin: string | null;
  taskKeys: string[];
}

export interface PullListEntry {
  bin: string | null;
  /** What to say on screen. Never a route step, never a distance. */
  label: string;
  itemIds: string[];
}

export interface BatchResult {
  /** The ranked list, reordered into contiguous groups. */
  ordered: RankedTask[];
  groups: WorkGroup[];
  /** One entry per bin, in group order. A list to pull, not a route. */
  pullList: PullListEntry[];
  version: number;
}

export interface BatchInput {
  ranked: readonly RankedTask[];
  /** Bin label per item id. Absent or blank means not recorded. */
  binOf?: Readonly<Record<string, string | null>>;
}

function familyOf(task: RankedTask): TaskFamily | null {
  const d = estimateDuration({ action: task.action });
  return isUnestimated(d) ? null : d.family;
}

function binFor(task: RankedTask, input: BatchInput): string | null {
  const raw = input.binOf?.[task.itemId];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Screen work is grouped by family alone, never by bin.
 *
 * Pricing and draft review happen at a laptop and it does not matter which
 * tote the garment is in. Splitting them by bin would create several one-task
 * groups that each cost nothing to set up, which is noise on the screen and
 * buys the seller nothing.
 */
function groupKeyFor(family: TaskFamily, bin: string | null): string {
  if (family === "screen") return "screen|";
  return `${family}|${bin ?? ""}`;
}

/**
 * Reorder ranked work into contiguous groups.
 *
 * Deterministic (AC1). Groups are ordered by the RANK OF THEIR BEST MEMBER, so
 * the seller's most important work still leads and the grouping only decides
 * what travels with it. Within a group the ranker's order is preserved.
 */
export function batchWork(input: BatchInput): BatchResult {
  const urgent: RankedTask[] = [];
  const rest: RankedTask[] = [];
  for (const task of input.ranked) {
    // AC2: a convenient bin group may never displace a shipment that has to go
    // today. Urgent work keeps its exact order and stays in front.
    if (task.tier === "urgent_shipping") urgent.push(task);
    else rest.push(task);
  }

  const groupsByKey = new Map<string, {
    key: string;
    family: TaskFamily;
    bin: string | null;
    tasks: RankedTask[];
    bestRank: number;
  }>();
  const ungroupable: RankedTask[] = [];

  rest.forEach((task, index) => {
    const family = familyOf(task);
    if (family === null) {
      // Nothing is known about how to do it, so it cannot join a batch. Kept
      // in rank order at the end rather than dropped.
      ungroupable.push(task);
      return;
    }
    const bin = binFor(task, input);
    const key = groupKeyFor(family, bin);
    const existing = groupsByKey.get(key);
    if (existing) {
      existing.tasks.push(task);
    } else {
      groupsByKey.set(key, { key, family, bin, tasks: [task], bestRank: index });
    }
  });

  const ordered = orderGroups([...groupsByKey.values()]);

  const groups: WorkGroup[] = ordered.map((g) => ({
    id: g.key,
    family: g.family,
    bin: g.bin,
    taskKeys: g.tasks.map((t) => t.key),
  }));

  const orderedTasks = [
    ...urgent,
    ...ordered.flatMap((g) => g.tasks),
    ...ungroupable,
  ];

  return {
    ordered: orderedTasks,
    groups,
    pullList: buildPullList(urgent, ordered, input),
    version: BATCHING_VERSION,
  };
}

interface Group {
  key: string;
  family: TaskFamily;
  bin: string | null;
  tasks: RankedTask[];
  bestRank: number;
}

/**
 * Order groups by their best member, then fix any dependency a grouping would
 * have inverted (AC2).
 *
 * THE CASE THIS EXISTS FOR: an item needs photographing and then its draft
 * reviewing. Photography groups by bin and draft review groups with all other
 * screen work, and the screen group can easily have a better-ranked member. A
 * naive sort would then put the draft review first, which is putting photos
 * after the listing that needs them.
 *
 * A cycle is impossible on the fixed prep ladder (measure, then photo, then
 * screen), but the guard is here anyway: an order that cannot be resolved
 * falls back to rank order rather than looping or silently dropping work.
 */
function orderGroups(groups: Group[]): Group[] {
  const byRank = [...groups].sort((a, b) =>
    a.bestRank !== b.bestRank
      ? a.bestRank - b.bestRank
      : a.key < b.key
      ? -1
      : 1
  );

  const keyOfTask = new Map<string, string>();
  for (const g of groups) for (const t of g.tasks) keyOfTask.set(t.key, g.key);

  // group key -> the groups it must follow
  const needs = new Map<string, Set<string>>();
  for (const g of groups) {
    const set = new Set<string>();
    for (const t of g.tasks) {
      for (const prereq of t.prerequisiteKeys) {
        const owner = keyOfTask.get(prereq);
        if (owner && owner !== g.key) set.add(owner);
      }
    }
    needs.set(g.key, set);
  }

  const out: Group[] = [];
  const placed = new Set<string>();
  const remaining = [...byRank];
  while (remaining.length > 0) {
    const next = remaining.findIndex((g) =>
      [...(needs.get(g.key) ?? [])].every((k) => placed.has(k))
    );
    if (next === -1) {
      // Unresolvable. Fall back to rank order for what is left rather than
      // looping or dropping it; a plan in the wrong batch order is recoverable
      // and a plan missing work is not.
      out.push(...remaining);
      break;
    }
    const [g] = remaining.splice(next, 1);
    out.push(g!);
    placed.add(g!.key);
  }
  return out;
}

/**
 * What to fetch, in group order.
 *
 * ONE ENTRY PER BIN, deduplicated across groups, and it is a LIST rather than
 * a route (AC3). Urgent items come first because they are done first, not
 * because their bin is nearer.
 */
function buildPullList(
  urgent: readonly RankedTask[],
  groups: readonly Group[],
  input: BatchInput,
): PullListEntry[] {
  const order: (string | null)[] = [];
  const items = new Map<string, string[]>();

  const add = (task: RankedTask) => {
    const family = familyOf(task);
    // Screen work needs nothing fetched: the garment stays where it is.
    if (family === "screen") return;
    const bin = binFor(task, input);
    const k = bin ?? "";
    if (!items.has(k)) {
      items.set(k, []);
      order.push(bin);
    }
    const list = items.get(k)!;
    if (!list.includes(task.itemId)) list.push(task.itemId);
  };

  for (const t of urgent) add(t);
  for (const g of groups) for (const t of g.tasks) add(t);

  return order.map((bin) => ({
    bin,
    label: bin ?? UNKNOWN_BIN_LABEL,
    itemIds: items.get(bin ?? "") ?? [],
  }));
}
