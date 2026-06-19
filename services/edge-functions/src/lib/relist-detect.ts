// Relist detection orchestration (US-1099, Layer-3).
//
// Wraps the PURE matcher (relist-match.ts) with tenant-scoped DB loading +
// on-demand perceptual hashing of the listing's photos. The flow:
//   1. Confirm the inventory item belongs to the workspace owner (US-268).
//   2. Ensure each item_photo has a perceptual hash — compute it ON DEMAND from
//      the stored bytes (item-photos bucket) and cache it on item_photos.phash,
//      reusing the SAME server-side dHash (computePhashFromImage) the rest of
//      the platform uses. Hashing failures are non-fatal (that photo is skipped).
//   3. Load the owner's garment fingerprints (tenant-scoped via the parent
//      garment's created_by), EXCLUDING any garment already linked to this item.
//   4. Rank candidates and return PROBABLE suggestions — never auto-link (AC2).
//
// Privacy (US-276/US-1090): we only ever compare HASHES. The candidate hashes
// come from garment_fingerprints (hashes/aggregates only — no image, no PII),
// and the query hashes are computed from the seller's OWN listing photos in the
// public item-photos bucket. No private grading image is ever fetched or exposed.

import { supabaseAdmin } from "./supabase.ts";
import { computePhashFromImage } from "./perceptual-hash.ts";
import { sniffImageFormat } from "./upload-validation.ts";
import {
  DEFAULT_RELIST_OPTS,
  normalizePhashes,
  rankRelistCandidates,
  type RelistCandidate,
  type RelistMatch,
  type RelistMatchOpts,
} from "./relist-match.ts";

// Bound the work per call (cost + latency): hash at most this many of an item's
// photos, and compare against at most this many of the owner's fingerprints.
const MAX_ITEM_PHOTOS = 12;
const MAX_CANDIDATES = 500;
const MAX_SUGGESTIONS = 10;

interface ItemPhotoRow {
  id: string;
  storage_path: string | null;
  phash: string | null;
}

/**
 * Ensure perceptual hashes exist for an item's photos, computing+caching any
 * that are missing. Returns the de-duplicated set of valid 16-hex hashes.
 * Best-effort: a photo we can't download/decode is simply skipped.
 */
export async function ensureItemPhotoHashes(
  photos: ItemPhotoRow[],
): Promise<string[]> {
  const hashes: string[] = [];
  for (const p of photos.slice(0, MAX_ITEM_PHOTOS)) {
    if (p.phash) {
      hashes.push(p.phash);
      continue;
    }
    if (!p.storage_path) continue;
    try {
      const { data: blob, error } = await supabaseAdmin.storage
        .from("item-photos")
        .download(p.storage_path);
      if (error || !blob) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const format = sniffImageFormat(bytes);
      if (!format) continue;
      const phash = await computePhashFromImage(bytes, format);
      if (!phash) continue;
      hashes.push(phash);
      // Cache so the next detection (or admin fraud sweep) reuses it.
      await supabaseAdmin
        .from("item_photos")
        .update({ phash })
        .eq("id", p.id)
        .then(() => {}, () => {});
    } catch (e) {
      console.error(
        "[relist-detect] hashing item photo failed:",
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  return normalizePhashes(hashes);
}

/** Pull the phash list out of a stored fingerprint payload's phashes map. */
function candidatePhashes(payload: unknown): string[] {
  if (payload && typeof payload === "object" && "phashes" in payload) {
    const ph = (payload as { phashes?: unknown }).phashes;
    if (ph && typeof ph === "object") {
      return normalizePhashes(Object.values(ph as Record<string, unknown>).map(String));
    }
  }
  return [];
}

export interface DetectRelistResult {
  ok: true;
  reason?: "no_item_photos" | "no_hashes" | "no_candidates";
  candidates: RelistMatch[];
}

/**
 * Detect likely relists for an inventory item the owner is drafting. Returns
 * PROBABLE suggestions (never auto-links). Tenant-scoped throughout. Never
 * throws — returns an empty suggestion list on any soft failure.
 */
export async function detectRelistCandidates(
  inventoryItemId: string,
  ownerId: string,
  opts?: Partial<RelistMatchOpts>,
): Promise<DetectRelistResult> {
  // US-268: confirm the item belongs to this owner and read its SKU class +
  // already-linked garment in one query. A non-owned id resolves to no row.
  const { data: itemRow } = await supabaseAdmin
    .from("inventory_items")
    .select("id, brand, garment_type, garment_category, item_category, grade_report_id")
    .eq("id", inventoryItemId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!itemRow) return { ok: true, reason: "no_candidates", candidates: [] };
  const item = itemRow as {
    brand: string | null;
    garment_type: string | null;
    garment_category: string | null;
    item_category: string | null;
    grade_report_id: string | null;
  };

  // Don't suggest linking the item to a passport it's ALREADY linked to.
  let linkedGarmentId: string | null = null;
  if (item.grade_report_id) {
    const { data: gr } = await supabaseAdmin
      .from("grade_reports")
      .select("garment_id")
      .eq("id", item.grade_report_id)
      .maybeSingle();
    linkedGarmentId = (gr as { garment_id: string | null } | null)?.garment_id ?? null;
  }

  const { data: photoRows } = await supabaseAdmin
    .from("item_photos")
    .select("id, storage_path, phash")
    .eq("inventory_item_id", inventoryItemId)
    .order("sort_order", { ascending: true });
  const photos = (photoRows ?? []) as ItemPhotoRow[];
  if (photos.length === 0) return { ok: true, reason: "no_item_photos", candidates: [] };

  const queryHashes = await ensureItemPhotoHashes(photos);
  if (queryHashes.length === 0) return { ok: true, reason: "no_hashes", candidates: [] };

  const skuClass = {
    brand: item.brand ?? undefined,
    garment_type: item.garment_type ?? undefined,
    category: item.item_category ?? item.garment_category ?? undefined,
  };

  // Candidate fingerprints among the owner's garments (tenant-scoped via the
  // joined garment's created_by). Bounded for cost.
  const { data: fpRows } = await supabaseAdmin
    .from("garment_fingerprints")
    .select("garment_id, payload, garments!inner(created_by, sku_class, public_passport_slug)")
    .eq("garments.created_by", ownerId)
    .limit(MAX_CANDIDATES);

  // Collapse to one candidate per garment, unioning hashes across its grades.
  const byGarment = new Map<string, RelistCandidate>();
  for (
    const r of (fpRows ?? []) as Array<{
      garment_id: string;
      payload: unknown;
      garments:
        | { sku_class: Record<string, unknown>; public_passport_slug: string }
        | { sku_class: Record<string, unknown>; public_passport_slug: string }[];
    }>
  ) {
    if (r.garment_id === linkedGarmentId) continue; // skip the already-linked passport
    const g = Array.isArray(r.garments) ? r.garments[0] : r.garments;
    const existing = byGarment.get(r.garment_id);
    const hashes = candidatePhashes(r.payload);
    if (existing) {
      existing.phashes = normalizePhashes([...existing.phashes, ...hashes]);
    } else {
      byGarment.set(r.garment_id, {
        garmentId: r.garment_id,
        slug: g?.public_passport_slug ?? null,
        phashes: hashes,
        skuClass: g?.sku_class ?? {},
      });
    }
  }
  const candidates = [...byGarment.values()];
  if (candidates.length === 0) return { ok: true, reason: "no_candidates", candidates: [] };

  const ranked = rankRelistCandidates(
    { phashes: queryHashes, skuClass },
    candidates,
    opts ? { ...DEFAULT_RELIST_OPTS, ...opts } : undefined,
  ).slice(0, MAX_SUGGESTIONS);

  return { ok: true, candidates: ranked };
}
