import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

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
