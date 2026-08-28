// US-2962: switch a description section on or off across a whole batch.
//
// Turning `measurements` off across forty drafts is a bulk operation. Typing
// forty intros is not — so this is the TOGGLE SET only, and no block text is
// editable here. That split is the design's, and it is what keeps a bulk action
// from being a way to paste the same paragraph onto a batch.
//
// THREE STATES PER SECTION, not two. A checkbox would force a value onto every
// section the seller did not touch: unticking "measurements" and pressing Apply
// would also assert "and switch the grade badge off, because its box is
// unticked too". `keep` is the default and means the block's own `on` survives.
//
// DRAFTS ONLY, checked against the database at apply time rather than trusted
// from the grid. The grid already queries `listing_status = 'draft'`, but a
// batch left open while another tab publishes is exactly how a bulk action ends
// up rewriting live copy, and the seller would never see it happen.

import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import { useMeasurementPrefs } from "@/stores/measurement-prefs";
import { BLOCK_LABELS } from "@/lib/description-blocks";
import type { DescriptionBlock, DescriptionBlockKey } from "@/types/database";

export type BlockToggle = "keep" | "on" | "off";
export type BlockToggleSet = Partial<Record<DescriptionBlockKey, BlockToggle>>;

/**
 * The sections the bulk grid offers, in render order.
 *
 * Three of the eleven block types are deliberately absent:
 *
 *   * `snippet` and `text` hold per-listing content, and a blanket switch over
 *     "whatever text happens to be in this slot" is not one decision.
 *   * `disclosure` is the defect disclosure built from the grade report.
 *     Removing it is a change a seller should make one listing at a time with
 *     the preview in front of them, not forty at once from a toolbar.
 */
export const BULK_TOGGLE_KEYS: readonly DescriptionBlockKey[] = [
  "intro",
  "features",
  "attributes",
  "condition",
  "measurements",
  "grade",
  "credentials",
  "facts",
];

export const BULK_TOGGLE_LABELS: Record<string, string> = BLOCK_LABELS;

/** True when the seller has actually asked for something. */
export function hasChanges(toggles: BlockToggleSet): boolean {
  return BULK_TOGGLE_KEYS.some((k) => toggles[k] === "on" || toggles[k] === "off");
}

/**
 * Apply the toggle set to one listing's blocks.
 *
 * Only `on` is ever written. Text, refs, units, separators and the array ORDER
 * all come through untouched, and a block whose key is not in the set comes back
 * by reference — which is what makes this safe to run over a legacy conversion
 * whose blocks this grid has never seen.
 *
 * Returns the SAME array when nothing would change, so the caller can skip the
 * round trip rather than re-rendering a description to identical bytes.
 */
export function applyToggleSet(
  blocks: DescriptionBlock[],
  toggles: BlockToggleSet,
): DescriptionBlock[] {
  let changed = false;
  const out = blocks.map((b) => {
    const want = toggles[b.key];
    if (want !== "on" && want !== "off") return b;
    const on = want === "on";
    if (b.on === on) return b;
    changed = true;
    return { ...b, on };
  });
  return changed ? out : blocks;
}

export interface BulkBlockResult {
  /** Drafts whose description was re-rendered and saved. */
  applied: number;
  /** Drafts already in the asked-for state, so nothing was written. */
  unchanged: number;
  /** Selected listings that are not drafts, or are not the caller's. */
  skipped: number;
  /** Drafts the server refused or that failed to load. */
  failed: number;
}

interface StatusRow {
  id: string;
  listing_status: string | null;
}

/**
 * Run the toggle set over the selected listings.
 *
 * Sequential on purpose: each listing is a GET, a render and a row write, and
 * forty of those at once is a connection-pool incident on the self-hosted stack
 * while the seller watches a spinner in a toolbar.
 */
export async function applyBlockToggles(
  listingIds: readonly string[],
  toggles: BlockToggleSet,
): Promise<BulkBlockResult> {
  const result: BulkBlockResult = { applied: 0, unchanged: 0, skipped: 0, failed: 0 };
  if (listingIds.length === 0 || !hasChanges(toggles)) return result;

  // Re-read the status now. RLS means a row belonging to someone else simply
  // does not come back, which lands in `skipped` alongside the published ones —
  // the honest answer either way is "this one was not touched".
  const { data, error } = await supabase
    .from("listings")
    .select("id, listing_status")
    .in("id", listingIds as string[]);
  if (error) {
    result.failed = listingIds.length;
    return result;
  }

  const rows = (data ?? []) as StatusRow[];
  const drafts = rows.filter((r) => r.listing_status === "draft").map((r) => r.id);
  result.skipped = listingIds.length - drafts.length;

  const unit = useMeasurementPrefs.getState().unit;

  for (const id of drafts) {
    try {
      const res = await edgeFetch(
        `/api/flipdesk/description/${id}/blocks?unit=${unit}`,
      );
      if (!res.ok) {
        result.failed++;
        continue;
      }
      const body = (await res.json()) as { blocks?: DescriptionBlock[] };
      if (!Array.isArray(body.blocks)) {
        result.failed++;
        continue;
      }
      // A listing whose description_blocks is null comes back already converted
      // by the legacy parse, so its other sections survive this untouched.
      const next = applyToggleSet(body.blocks, toggles);
      if (next === body.blocks) {
        result.unchanged++;
        continue;
      }
      const saved = await edgeFetch(`/api/flipdesk/description/${id}/save`, {
        method: "POST",
        json: { blocks: next, unit },
      });
      if (saved.ok) result.applied++;
      else result.failed++;
    } catch {
      result.failed++;
    }
  }

  return result;
}

/** What to tell the seller when the run finishes. */
export function bulkBlockSummary(r: BulkBlockResult): string {
  const parts: string[] = [
    `Updated ${r.applied} draft${r.applied === 1 ? "" : "s"}.`,
  ];
  if (r.unchanged > 0) {
    parts.push(
      r.unchanged === 1
        ? "1 was already set that way."
        : `${r.unchanged} were already set that way.`,
    );
  }
  if (r.skipped > 0) {
    parts.push(
      r.skipped === 1
        ? "1 skipped, because it is no longer a draft."
        : `${r.skipped} skipped, because they are no longer drafts.`,
    );
  }
  if (r.failed > 0) {
    parts.push(
      r.failed === 1 ? "1 did not save." : `${r.failed} did not save.`,
    );
  }
  return parts.join(" ");
}
