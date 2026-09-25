import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchCapped } from "@/lib/paged-read";
import {
  assertFutureDrop,
  dropHealth,
  PUBLISH_CLAIM_STALE_MS,
  shiftInZone,
  type DropShift,
} from "@/lib/scheduling";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";

// US-2522. The drops calendar was a read-only picture of the schedule: every
// interaction was a link into the draft, so moving three drops by an hour meant
// opening three drafts and typing six times.
//
// All three mutations write one column, `listings.scheduled_publish_at`, on
// rows RLS already scopes to the caller. Cancelling a drop sets it to null,
// which is what the 5-minute publish-due cron reads as "not scheduled" — the
// draft itself is untouched, so nothing is lost by cancelling.
//
// NEVER reach for `.or()` on these updates: the self-hosted PostgREST rejects
// logical operators on mutations (US-1552), and CI's newer local stack accepts
// them, so it would pass here and 42703 in production.

export const SCHEDULED_DROPS_KEY = "scheduled_drops";

// -- The read (US-3077 AC7) --------------------------------------------------
//
// Lifted out of src/pages/flipdesk/scheduled-drops.tsx, unchanged: same query
// key, same columns, same order, same cap. It belongs beside the mutations that
// already invalidate it, and it means the calendar page and the overview widget
// count ONE set of rows. Two queries would eventually disagree about what
// "scheduled" means, and a widget promising a drop the calendar does not show
// is worse than no widget.
//
// US-563 background: the 5-minute `publish-due` cron publishes drafts whose
// `scheduled_publish_at` has passed, so these rows are work with a clock on it.

export interface ScheduledDropRow {
  id: string;
  inventory_item_id: string;
  listing_title: string | null;
  listing_price: number | null;
  scheduled_publish_at: string;
  promo_opt_out: boolean | null;
  promo_rate_pct: number | null;
  // SD-3: what the publish-due cron has done with the row so far. Without
  // these a drop failing its fourth attempt looked like a fresh one.
  publish_error: string | null;
  publish_failed_at: string | null;
  publish_attempts: number | null;
  publish_claimed_at: string | null;
  synced_to_ebay_at: string | null;
  /**
   * SD-8: the inventory item's title, embedded in the same read. It used to
   * come from a second, chunked query that waited on this one and swapped the
   * whole calendar for a spinner every time it re-keyed.
   */
  item_title: string | null;
}

/** Columns the drops read asks for. Exported so a test can pin them. */
export const SCHEDULED_DROPS_SELECT =
  "id, inventory_item_id, listing_title, listing_price, scheduled_publish_at, promo_opt_out, promo_rate_pct, publish_error, publish_failed_at, publish_attempts, publish_claimed_at, synced_to_ebay_at, inventory_items(title)";

type RawDropRow = Omit<ScheduledDropRow, "item_title"> & {
  inventory_items?: { title: string | null } | { title: string | null }[] | null;
};

/** Flatten the embedded item into `item_title`. */
function toDropRow({ inventory_items: item, ...rest }: RawDropRow): ScheduledDropRow {
  const embedded = Array.isArray(item) ? item[0] : item;
  return { ...rest, item_title: embedded?.title ?? null };
}

/** The name a drop goes by: its listing title, else its item's, else a placeholder. */
export function dropTitle(row: Pick<ScheduledDropRow, "listing_title" | "item_title">): string {
  return row.listing_title?.trim() || row.item_title?.trim() || "Untitled draft";
}

/** SD-9: how often an open page re-reads, and faster while the cron is busy. */
export const DROPS_REFETCH_MS = 60_000;
export const DROPS_REFETCH_BUSY_MS = 20_000;

/**
 * Re-read every 20s while any drop is publishing or due within ten minutes
 * either side of now, else every minute. The cron runs every five minutes, so
 * a page left open used to show drops it had already published or failed.
 */
export function dropsRefetchInterval(
  rows: readonly ScheduledDropRow[] | undefined,
  now: number = Date.now(),
): number {
  const busy = (rows ?? []).some((r) => {
    if (dropHealth(r, now) === "publishing") return true;
    const t = Date.parse(r.scheduled_publish_at);
    return Number.isFinite(t) && Math.abs(t - now) <= PUBLISH_CLAIM_STALE_MS;
  });
  return busy ? DROPS_REFETCH_BUSY_MS : DROPS_REFETCH_MS;
}

/**
 * Every scheduled drop, soonest first.
 *
 * US-2169: `.limit(500)` rendered as if it were the whole queue meant a seller
 * with more scheduled drops than that saw a calendar quietly missing entries,
 * on the surface whose entire job is telling them what publishes when.
 * fetchCapped asks for one row past the cap so the shortfall is stated.
 */
export function useScheduledDrops() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: [SCHEDULED_DROPS_KEY, user?.id],
    enabled: !!user,
    staleTime: 30_000,
    // Visible tab only, the same posture as the Best Offers inbox (use-ebay.ts).
    refetchInterval: (query) => dropsRefetchInterval(query.state.data?.rows),
    refetchIntervalInBackground: false,
    queryFn: () =>
      fetchCapped<ScheduledDropRow>(async (limit) => {
        const { data, error } = await supabase
          .from("listings")
          // No platform filter: the cron has none, so adding one here would
          // hide drafts it will really publish.
          .select(SCHEDULED_DROPS_SELECT)
          .eq("listing_status", "draft")
          .not("scheduled_publish_at", "is", null)
          .order("scheduled_publish_at", { ascending: true })
          .limit(limit);
        if (error) throw error;
        return ((data ?? []) as unknown as RawDropRow[]).map(toDropRow);
      }),
  });
}

/** How far ahead the overview widget looks (AC7). */
export const DROPS_WINDOW_DAYS = 7;

/**
 * The drops publishing between now and `days` from now, soonest first.
 *
 * Pure, and it drops anything already in the PAST. A row whose
 * scheduled_publish_at has passed is either mid-publish or stuck, and counting
 * it as "due in the next seven days" would tell the seller to wait for
 * something that has already had its turn.
 */
export function dropsDueWithin(
  rows: readonly ScheduledDropRow[],
  days: number = DROPS_WINDOW_DAYS,
  now: number = Date.now(),
): ScheduledDropRow[] {
  const until = now + days * 24 * 60 * 60 * 1000;
  return rows
    .filter((r) => {
      const t = Date.parse(r.scheduled_publish_at);
      return Number.isFinite(t) && t >= now && t <= until;
    })
    .sort(
      (a, b) =>
        Date.parse(a.scheduled_publish_at) - Date.parse(b.scheduled_publish_at),
    );
}

function useInvalidateDrops() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [SCHEDULED_DROPS_KEY] });
    // The item and listing surfaces show the same scheduled time.
    void qc.invalidateQueries({ queryKey: ["items_full"] });
  };
}

/**
 * SD-1: an UPDATE that matched no row. PostgREST answers a filtered update that
 * hits nothing with 200 and no error, so without `.select()` a drop the cron
 * already published, or a row RLS hides from a viewer or member, read as
 * "moved" when nothing was written.
 */
export class DropNotChangedError extends Error {
  constructor(message = "This drop already went live, or you cannot edit it.") {
    super(message);
    this.name = "DropNotChangedError";
  }
}

/**
 * SD-2: a write that would put a drop in the past, where the 5-minute cron
 * publishes it at the next tick. Checked inside the mutations so no caller can
 * publish a drop early by accident, whatever the UI in front of it checked.
 */
export class DropInPastError extends Error {
  constructor(message = "That time has passed. Pick a later time.") {
    super(message);
    this.name = "DropInPastError";
  }
}

function assertFutureOrThrow(iso: string): void {
  const check = assertFutureDrop(iso);
  if (!check.ok) throw new DropInPastError(check.reason);
}

/**
 * Write one row's schedule and say whether it changed. Only a draft is
 * schedulable, so a published listing that somehow still carried a schedule
 * must not be moved by this surface.
 */
async function writeDropTime(id: string, at: string | null): Promise<boolean> {
  const { data, error } = await supabase
    .from("listings")
    .update({ scheduled_publish_at: at } as never)
    .eq("id", id)
    .eq("listing_status", "draft")
    .select("id");
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

/** Move one drop to a new instant. */
export function useRescheduleDrop() {
  const invalidate = useInvalidateDrops();
  return useMutation({
    mutationFn: async ({ id, at }: { id: string; at: string }) => {
      assertFutureOrThrow(at);
      if (!(await writeDropTime(id, at))) throw new DropNotChangedError();
    },
    // onSettled, not onSuccess: a rejected write still means the rows on
    // screen may be stale (the cron published it, for one).
    onSettled: invalidate,
  });
}

/** Unschedule a drop. The draft stays exactly as it is. */
export function useCancelDrop() {
  const invalidate = useInvalidateDrops();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      if (!(await writeDropTime(id, null))) throw new DropNotChangedError();
    },
    onSettled: invalidate,
  });
}

/** What a multi-row write actually did, row by row. */
export interface DropBatchResult {
  moved: number;
  unchanged: number;
  failed: number;
  /** The ids that really moved, so an undo touches only those. */
  movedIds: string[];
}

/**
 * Write each row's new instant and count what really changed. Every target is
 * checked BEFORE any write, so a refused batch leaves the day exactly as it
 * was rather than half moved. Sequential so a partial failure leaves a
 * readable count behind.
 */
async function writeBatch(assignments: { id: string; at: string }[]): Promise<DropBatchResult> {
  for (const a of assignments) assertFutureOrThrow(a.at);
  const result: DropBatchResult = { moved: 0, unchanged: 0, failed: 0, movedIds: [] };
  for (const a of assignments) {
    try {
      if (await writeDropTime(a.id, a.at)) {
        result.moved += 1;
        result.movedIds.push(a.id);
      } else {
        result.unchanged += 1;
      }
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

/**
 * Shift a set of drops by the same amount, keeping their order and the gaps
 * between them. Each row moves relative to ITS OWN time, so a day's staggered
 * drops stay staggered. Whole days move on the wall clock in `timeZone`
 * (SD-6), so a 7:00 PM drop stays at 7:00 PM across a DST change.
 */
export function useShiftDrops() {
  const invalidate = useInvalidateDrops();
  return useMutation({
    mutationFn: async ({
      drops,
      shift,
      timeZone,
    }: {
      drops: { id: string; scheduled_publish_at: string }[];
      shift: DropShift;
      timeZone: string;
    }): Promise<DropBatchResult> => {
      // One UPDATE per row: they all move to DIFFERENT times, so there is no
      // single-statement version of this. These are direct PostgREST writes
      // under the caller's RLS; they never pass through the edge rate limiter.
      const planned = drops.map((d) => ({
        id: d.id,
        next: shiftInZone(d.scheduled_publish_at, timeZone, shift),
      }));
      return writeBatch(planned.map((p) => ({ id: p.id, at: p.next })));
    },
    onSettled: invalidate,
  });
}

/**
 * SD-14: give each drop its own new instant (a spread across time slots).
 *
 * The same per-row path as a shift: every target is checked against the cron's
 * five-minute window before anything is written, and rows that change nothing
 * are counted rather than reported as moved. Not atomic; a one-transaction
 * version needs an RPC and a migration, and is deferred.
 */
export function useSpreadDrops() {
  const invalidate = useInvalidateDrops();
  return useMutation({
    mutationFn: async ({
      assignments,
    }: {
      assignments: { id: string; at: string }[];
    }): Promise<DropBatchResult> => writeBatch(assignments),
    onSettled: invalidate,
  });
}
