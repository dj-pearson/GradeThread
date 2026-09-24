// The intake form's decisions, pulled out of intake.tsx so they can be tested
// without rendering the page.
//
//   resolveIntakeSource   existing source, a new one to create, or none.
//   buildIntakeInsert     the inventory_items row the form saves, including the
//                         garment fields grading needs (US-1423) and the AI
//                         provenance of each field the extractor filled.
//   photoShortfallMessage what the seller reads when some staged photos did
//                         not upload after the item was saved (US-2546 AC2).

import type {
  AiFieldSource,
  InventoryItemInsert,
  ItemCategory,
  ItemStatus,
} from "@/types/database";
import { deriveGarmentDefaults } from "@/lib/garment-mapping";
import { acquiredDateZoneFor } from "@/lib/acquired-date-zone";
import {
  resolveIntakeSourceChoice,
  type IntakeSourceChoice,
} from "@/lib/intake-save-plan";

export type { IntakeSourceChoice };

export interface IntakeFormState {
  title: string;
  sku: string;
  container: string;
  brand: string;
  style: string;
  size: string;
  color: string;
  material: string;
  item_category: ItemCategory | "";
  source_id: string;
  source_new: string; // new source name (used when source_id === "__new")
  sourced_by: string;
  purchase_date: string;
  purchase_price: string;
  description: string;
  condition_notes: string;
  status: ItemStatus;
}

export function priceOrNull(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function trimOrNull(v: string): string | null {
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Which source the save links to. "__new" with a name means create it (via
 * get_or_create_source online, or by name at flush time offline); "__new" with
 * a blank name is refused before this is reached, and reads as none here so a
 * stray blank never creates a source. The rule itself lives beside the save
 * plan in src/lib/intake-save-plan.ts so the offline queue reads the same one.
 */
export function resolveIntakeSource(
  form: Pick<IntakeFormState, "source_id" | "source_new">,
): IntakeSourceChoice {
  return resolveIntakeSourceChoice(form.source_id, form.source_new);
}

export function buildIntakeInsert(args: {
  form: IntakeFormState;
  ownerId: string;
  sourceId: string | null;
  aiFields: Iterable<string>;
  aiMeta: Record<string, { source: string; confidence: number }>;
  /** Garment values the AI extractor returned, if any. */
  aiGarment: { garment_type: string | null; garment_category: string | null };
  measurements: Record<string, number | string>;
  /** SNAP-13: a target price in dollars carried from a snap's median comp. */
  targetPrice?: number | null;
  now?: Date;
}): InventoryItemInsert {
  const { form, ownerId, sourceId, aiFields, aiMeta, aiGarment, measurements } = args;

  // Record which fields were AI-filled (and still are) for provenance.
  const aiFieldSources: Record<string, AiFieldSource> = {};
  for (const field of aiFields) {
    const meta = aiMeta[field];
    aiFieldSources[field] = {
      source: meta?.source ?? "text",
      confidence: meta?.confidence ?? 0,
      accepted: true,
    };
  }
  const hasAiFields = Object.keys(aiFieldSources).length > 0;

  // US-1423: grading requires garment_type + garment_category, which intake
  // never asked for — so every clothing item had to be re-classified in
  // ItemCanvas before it could be graded. Derive them here (preferring any
  // garment values the AI extractor returned) so catalog captures them once.
  const itemCategory = form.item_category === "" ? null : form.item_category;
  const garment = deriveGarmentDefaults(itemCategory, aiGarment);

  return {
    user_id: ownerId,
    title: form.title.trim(),
    sku: trimOrNull(form.sku),
    container: trimOrNull(form.container),
    brand: trimOrNull(form.brand),
    style: trimOrNull(form.style),
    size: trimOrNull(form.size),
    color: trimOrNull(form.color),
    material: trimOrNull(form.material),
    item_category: itemCategory,
    garment_type: garment.garment_type,
    garment_category: garment.garment_category,
    source_id: sourceId,
    sourced_by: trimOrNull(form.sourced_by),
    acquired_date: form.purchase_date || null,
    acquired_date_tz: acquiredDateZoneFor(form.purchase_date),
    acquired_price: priceOrNull(form.purchase_price),
    description: trimOrNull(form.description),
    condition_notes: trimOrNull(form.condition_notes),
    status: form.status,
    ...(args.targetPrice != null && Number.isFinite(args.targetPrice) && args.targetPrice > 0
      ? { target_price: args.targetPrice }
      : {}),
    // US-2546 AC4: captured at intake rather than on a later visit to prep.
    measurements:
      Object.keys(measurements).length > 0 ? measurements : undefined,
    ai_field_sources: hasAiFields ? aiFieldSources : undefined,
    ai_enriched_at: hasAiFields ? (args.now ?? new Date()).toISOString() : undefined,
  };
}

/**
 * US-2546 AC2: a photo failure must not read as a failed save. The item
 * exists, so say how many photos are missing and where to finish. Null when
 * every staged photo went up.
 */
export function photoShortfallMessage(staged: number, uploaded: number): string | null {
  const missing = staged - uploaded;
  if (missing <= 0) return null;
  return `Saved the item, but ${missing} photo${
    missing === 1 ? "" : "s"
  } didn't upload. Add them from the item page.`;
}
