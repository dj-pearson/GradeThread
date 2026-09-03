import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchCapped } from "@/lib/paged-read";
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
    queryFn: () =>
      fetchCapped<ScheduledDropRow>(async (limit) => {
        const { data, error } = await supabase
          .from("listings")
          .select(
            "id, inventory_item_id, listing_title, listing_price, scheduled_publish_at, promo_opt_out, promo_rate_pct",
          )
          .eq("listing_status", "draft")
          .not("scheduled_publish_at", "is", null)
          .order("scheduled_publish_at", { ascending: true })
          .limit(limit);
        if (error) throw error;
        return (data ?? []) as ScheduledDropRow[];
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

/** Move one drop to a new instant. */
export function useRescheduleDrop() {
  const invalidate = useInvalidateDrops();
  return useMutation({
    mutationFn: async ({ id, at }: { id: string; at: string }) => {
      const { error } = await supabase
        .from("listings")
        .update({ scheduled_publish_at: at } as never)
        .eq("id", id)
        // Only a draft is schedulable. A published listing that somehow still
        // carried a schedule must not be moved by this surface.
        .eq("listing_status", "draft");
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

/** Unschedule a drop. The draft stays exactly as it is. */
export function useCancelDrop() {
  const invalidate = useInvalidateDrops();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const { error } = await supabase
        .from("listings")
        .update({ scheduled_publish_at: null } as never)
        .eq("id", id)
        .eq("listing_status", "draft");
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

/**
 * Shift a set of drops by the same number of minutes, keeping their order and
 * the gaps between them. Each row moves relative to ITS OWN time, so a day's
 * staggered drops stay staggered.
 */
export function useShiftDrops() {
  const invalidate = useInvalidateDrops();
  return useMutation({
    mutationFn: async ({
      drops,
      minutes,
    }: {
      drops: { id: string; scheduled_publish_at: string }[];
      minutes: number;
    }) => {
      // One UPDATE per row: they all move to DIFFERENT times, so there is no
      // single-statement version of this. Sequential rather than parallel —
      // a burst of writes on the same table is what the rate limiter is for.
      for (const d of drops) {
        const next = new Date(
          new Date(d.scheduled_publish_at).getTime() + minutes * 60_000,
        ).toISOString();
        const { error } = await supabase
          .from("listings")
          .update({ scheduled_publish_at: next } as never)
          .eq("id", d.id)
          .eq("listing_status", "draft");
        if (error) throw error;
      }
    },
    onSuccess: invalidate,
  });
}
