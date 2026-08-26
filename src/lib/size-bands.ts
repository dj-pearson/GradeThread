// US-2918: fetch the expected-size band table for one brand + garment.
//
// One request per distinct (brand, garment, gender), cached by TanStack Query
// for the life of an editing session. The table is a few hundred bytes and the
// endpoint marks it cacheable for half an hour, so the composer looks up a
// verdict on every keystroke without touching the network again.
//
// A failure here is NOT an error state. The size check is an assist: if the
// table cannot be fetched the composer shows no note and the seller carries on,
// which is the same thing that happens for a brand with no chart on file.

import { edgeFetch } from "@/lib/edge-fetch";
import type { SizeBandsResponse } from "@/lib/size-check";

/** What every "we have nothing to say" path returns. */
export const NO_SIZE_BANDS: SizeBandsResponse = {
  tier: "none",
  brandLabel: null,
  department: null,
  garment: null,
  sourceUrl: null,
  sizeSystem: null,
  sizeClass: null,
  measurementBasis: "body",
  rows: [],
};

export function sizeBandsQueryKey(
  brand: string | null,
  garment: string | null,
  gender: string | null,
): (string | null)[] {
  return ["size-bands", brand, garment, gender];
}

export async function fetchSizeBands(
  brand: string | null,
  garment: string | null,
  gender: string | null,
): Promise<SizeBandsResponse> {
  if (!garment?.trim()) return NO_SIZE_BANDS;
  const params = new URLSearchParams({ garment: garment.trim() });
  if (brand?.trim()) params.set("brand", brand.trim());
  if (gender?.trim()) params.set("gender", gender.trim());

  const res = await edgeFetch(`/api/flipdesk/size-bands?${params.toString()}`);
  if (!res.ok) return NO_SIZE_BANDS;
  const body = (await res.json()) as Partial<SizeBandsResponse>;
  // Trust the shape only as far as the fields the check reads. A malformed
  // response must render nothing, never a note built on undefined.
  if (!Array.isArray(body.rows) || !body.tier) return NO_SIZE_BANDS;
  return { ...NO_SIZE_BANDS, ...body, rows: body.rows };
}
