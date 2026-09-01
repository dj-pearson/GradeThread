// US-3039: fetch the published measurement table for one garment.
//
// One request per distinct (brand, style, group, size, gender), cached by
// TanStack Query for the editing session. The table is a few hundred bytes and
// the endpoint marks it cacheable for half an hour, so the composer autofills
// and checks drift on every keystroke without touching the network again.
//
// A failure here is NOT an error state, for the same reason size-bands.ts gives
// about itself: this is an assist. If the table cannot be fetched the composer
// shows nothing and the seller carries on, exactly as it does for a garment
// with no published cohort. There is no error banner over somebody's draft
// because a reference lookup had a bad minute.

import { edgeFetch } from "@/lib/edge-fetch";
import { NO_INDEX_STATS, type IndexStatsResponse } from "@/lib/measurement-index";

export function measurementStatsQueryKey(
  brand: string | null,
  style: string | null,
  group: string | null,
  size: string | null,
  gender: string | null,
): (string | null)[] {
  return ["measurement-stats", brand, style, group, size, gender];
}

export async function fetchMeasurementStats(
  brand: string | null,
  style: string | null,
  group: string | null,
  size: string | null,
  gender: string | null,
): Promise<IndexStatsResponse> {
  // Brand, group and size are all required to name a cohort. Asking without
  // them would be asking the server to guess, and the server correctly will
  // not, so save the round trip.
  if (!brand?.trim() || !group?.trim() || !size?.trim()) return NO_INDEX_STATS;

  const params = new URLSearchParams({
    brand: brand.trim(),
    group: group.trim(),
    size: size.trim(),
  });
  if (style?.trim()) params.set("style", style.trim());
  if (gender?.trim()) params.set("gender", gender.trim());

  const res = await edgeFetch(`/api/flipdesk/measurement-stats?${params.toString()}`);
  if (!res.ok) return NO_INDEX_STATS;

  const body = (await res.json()) as Partial<IndexStatsResponse>;
  // Trust the shape only as far as the fields the composer reads. A malformed
  // response must render nothing, never a suggestion built on undefined —
  // measurement-drift.ts carries the scar from the version of this that did not
  // check, and took down the whole item editor when a mock returned [].
  if (!Array.isArray(body.fields) || !body.cohort) return NO_INDEX_STATS;
  const fields = body.fields.filter(
    (f) =>
      f && typeof f.field === "string" &&
      Number.isFinite(f.median) && Number.isFinite(f.p25) && Number.isFinite(f.p75) &&
      Number.isFinite(f.sampleCount),
  );
  if (fields.length === 0) return NO_INDEX_STATS;
  return { cohort: body.cohort, fields };
}
