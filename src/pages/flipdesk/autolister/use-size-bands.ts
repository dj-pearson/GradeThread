// US-2919: one band-table fetch per distinct brand + garment + gender in a batch.
//
// The band table depends only on those three, so a 40-item batch spanning six
// brands issues SIX requests. Fetching per item would be forty requests for six
// answers, on a screen the seller opens once per batch and scrolls, which is how
// a review screen earns its own rate limit.
//
// Each pair is its own query so TanStack caches them independently and a second
// batch sharing a brand pays nothing. The endpoint marks the response cacheable
// for half an hour and the answer does not depend on the caller, so a stale
// table is never wrong, only old.

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { fetchSizeBands, sizeBandsQueryKey } from "@/lib/size-bands";
import type { SizeBandsResponse } from "@/lib/size-check";
import {
  sizeBandPairs,
  type SizeBandPair,
  type SizeCheckableDraft,
} from "@/pages/flipdesk/autolister/group-warnings";

export function useSizeBandsForDrafts(
  drafts: readonly SizeCheckableDraft[],
  enabled = true,
): Record<string, SizeBandsResponse | undefined> {
  // Recompute the pair list only when the pairs themselves change, not on every
  // keystroke in the grid above it.
  const pairKey = drafts
    .map((d) => `${d.brand ?? ""}|${d.garment ?? ""}|${d.gender ?? ""}|${d.size ?? ""}`)
    .sort()
    .join("\n");
  const pairs = useMemo<SizeBandPair[]>(
    () => sizeBandPairs(drafts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pairKey],
  );

  const results = useQueries({
    queries: pairs.map((p) => ({
      queryKey: sizeBandsQueryKey(p.brand, p.garment, p.gender),
      enabled,
      staleTime: 30 * 60 * 1000,
      queryFn: () => fetchSizeBands(p.brand, p.garment, p.gender),
    })),
  });

  return useMemo(() => {
    const out: Record<string, SizeBandsResponse | undefined> = {};
    pairs.forEach((p, i) => {
      out[p.key] = results[i]?.data;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairs, results.map((r) => (r.data ? "1" : "0")).join("")]);
}
