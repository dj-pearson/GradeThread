import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import type { SkuSegment } from "@/lib/sku-presets";

// US-3417: the tenant's SKU numbering row, and the next SKU it will hand out.
//
// This hook computes NOTHING. The next value comes from the flipdesk_sku_preview
// RPC, which runs the same Postgres functions the insert trigger runs, so what
// the seller is shown and what they get cannot disagree. Rendering it here in
// TypeScript would be a second copy of the carry rule, and
// src/test/sku-odometer-single-home.test.ts exists to stop exactly that.
//
// flipdesk_sku_sequences carries a SELECT policy for the owner and workspace
// viewers (00802), so the row reads through Supabase directly. Every WRITE goes
// through flipdesk_sku_save instead -- the table has no write policy at all.

export type SkuSequenceRow = {
  user_id: string;
  enabled: boolean;
  pattern: SkuSegment[];
  counters: number[];
  reset_on_date_change: boolean;
  exhausted: boolean;
};

export const SKU_SEQUENCE_KEY = "sku_sequence";
export const SKU_PREVIEW_KEY = "sku_preview";

export type UseSkuSequence = {
  sequence: SkuSequenceRow | null;
  /** The next SKU an item saved right now would receive, or null. */
  nextSku: string | null;
  /** Numbering will actually fire: switched on and not used up. */
  isEnabled: boolean;
  isExhausted: boolean;
  isLoading: boolean;
};

/**
 * Pass an explicit `ownerId` to pin the tenant; otherwise this resolves the
 * ACTIVE WORKSPACE OWNER, which is what the trigger reads.
 *
 * The default is the owner and not the signed-in user on purpose. A member
 * inserting into somebody else's workspace writes inventory_items.user_id =
 * the owner, so the number they are about to receive comes from the OWNER's
 * counter. Defaulting to `user.id` would show a member a number from their own
 * (usually empty) sequence, and the two are indistinguishable on a solo
 * account, which is how that kind of bug survives review.
 *
 * Read straight off the auth store rather than through useWorkspace(): this
 * renders inside the inventory shell, and useWorkspace pulls in the supabase
 * client, the query client and sonner for a value that is two selectors.
 */
export function useSkuSequence(ownerId?: string): UseSkuSequence {
  const user = useAuthStore((s) => s.user);
  const activeOwnerId = useAuthStore((s) => s.activeWorkspaceOwnerId);
  const owner = ownerId ?? activeOwnerId ?? user?.id;

  const row = useQuery({
    queryKey: [SKU_SEQUENCE_KEY, owner],
    enabled: Boolean(owner),
    // Config, not data. It changes when the seller changes it, and the save
    // invalidates this key.
    staleTime: 30 * 60 * 1000,
    queryFn: async (): Promise<SkuSequenceRow | null> => {
      // Keep the builder bound to the client; destructuring `from` off it
      // loses `this` and the call fails at runtime.
      const { data, error } = await supabase
        .from("flipdesk_sku_sequences")
        .select("*")
        .eq("user_id", owner as string)
        .maybeSingle();
      if (error) throw error;
      // tsc -b resolves .data as never for several tables; the cast is the
      // house workaround.
      return (data ?? null) as SkuSequenceRow | null;
    },
  });

  const sequence = row.data ?? null;
  const isExhausted = Boolean(sequence?.exhausted);
  const isEnabled = Boolean(sequence?.enabled) && !isExhausted;

  const preview = useQuery({
    // The pattern and counters are in the key so the preview refetches when the
    // row moves. They are stable objects from the query cache, not new literals
    // per render -- a fresh [] here would change identity every render and spin
    // the query into a refetch loop (React error #185).
    queryKey: [SKU_PREVIEW_KEY, owner, sequence?.counters, sequence?.pattern],
    enabled: Boolean(owner) && isEnabled,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<string[]> => {
      // `as never` on both arguments: src/types/database.ts declares no
      // Functions block, so the generated client types every rpc name and
      // payload as undefined. Same cast every other rpc call site uses.
      const { data, error } = await supabase.rpc("flipdesk_sku_preview" as never, {
        p_owner: owner as string,
        p_pattern: sequence?.pattern ?? [],
        p_counters: sequence?.counters ?? [],
        p_count: 1,
      } as never);
      if (error) throw error;
      return (data ?? []) as string[];
    },
  });

  return {
    sequence,
    // noUncheckedIndexedAccess is on, so [0] is string | undefined.
    nextSku: preview.data?.[0] ?? null,
    isEnabled,
    isExhausted,
    isLoading: row.isLoading,
  };
}
