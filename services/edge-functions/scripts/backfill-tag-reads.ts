// 2026-09-02: read the tag on every item that has one and no style code yet.
//
// WHY. 1001 items on prod were generated before the listing path could land a
// Style Code aspect. 150 have a tag-typed photo. Regenerating them would cost
// about $120 and rewrite titles the seller may have edited; reading the tag
// costs about $0.03 an item and writes four attributes and two aspects.
//
// WHAT IT WRITES, and nothing else: attributes.mpn / .model / .rn /
// .rn_registrant, plus the Style Code (or MPN) and Model aspects when the
// leaf exposes them, with inventory_derived provenance. No title, no
// description, no size, no brand, no listings row. A live eBay listing changes
// only when the seller republishes.
//
// It READS the style-code index for a resolved name and never writes it; our
// own listings are excluded evidence (vault/20-domain/style-code-index-evidence.md).
// It DOES record an RN sighting on no_reference, because a sighting is OCR
// evidence off a real tag, which is what this is.
//
// Metered under tag_ocr like generation (extractTagGroundTruth tags its own
// calls). Does not consume the seller's monthly AI-action quota: operator-run.
//
//   deno run --allow-net --allow-env scripts/backfill-tag-reads.ts               # dry run
//   deno run --allow-net --allow-env scripts/backfill-tag-reads.ts --limit 10
//   deno run --allow-net --allow-env scripts/backfill-tag-reads.ts --owner <uuid>
//   deno run --allow-net --allow-env scripts/backfill-tag-reads.ts --apply
//
// --dry-run is the default. A dry run still pays for the OCR (that is the
// point of --limit); it writes nothing, sightings included.

import { supabaseAdmin } from "../src/lib/supabase.ts";
import {
  extractTagGroundTruth,
  selectTagOcrPhotos,
  TAG_GROUND_TRUTH_MIN_CONFIDENCE,
  tagAttributeFill,
} from "../src/lib/ai-tag-ocr.ts";
import {
  filterListablePhotos,
  itemPhotoAiUrls,
  type ItemPhotoUrlRow,
} from "../src/lib/item-photo-storage.ts";
import { resolveBrandKnowledgePack } from "../src/lib/brand-knowledge.ts";
import { brandKey, canonicalizeBrand } from "../src/lib/brand-normalize.ts";
import { lookupLearnedStyle } from "../src/lib/style-code-observations.ts";
import {
  applyLearnedStyleToListing,
  learnedStyleForListing,
  resolveListingStyleCode,
} from "../src/lib/listing-style-code.ts";
import {
  assessRegisteredNumber,
  getRegisteredNumberContext,
  recordRegisteredNumberSighting,
} from "../src/lib/registered-numbers.ts";
import { planListingRegisteredNumber } from "../src/lib/listing-registered-number.ts";
import { getCategoryAspects } from "../src/lib/ebay-client.ts";
import { buildAspectSpecsForCategory } from "../src/lib/ai-listing.ts";
import type { EbayAspectSpec } from "../src/lib/ai-extract.ts";
import {
  type BackfillItem,
  backfillEligible,
  planBackfillPatch,
} from "../src/lib/tag-read-backfill.ts";

const apply = Deno.args.includes("--apply");
const limitIdx = Deno.args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(Deno.args[limitIdx + 1]) : Infinity;
const ownerIdx = Deno.args.indexOf("--owner");
const owner = ownerIdx >= 0 ? Deno.args[ownerIdx + 1] ?? null : null;

const ITEM_COLUMNS =
  "id, user_id, brand, style, size, color, material, title, item_category, garment_type, garment_category, ebay_category_id, ebay_aspects, ebay_aspect_sources, attributes";

const stats = {
  scanned: 0,
  skipped: 0,
  read: 0,
  code: 0,
  decoded: 0,
  named: 0,
  rnParsed: 0,
  rnCorroborates: 0,
  rnContradicts: 0,
  rnNoReference: 0,
  attributesWritten: 0,
  aspectsWritten: 0,
  failed: 0,
};

const specCache = new Map<string, EbayAspectSpec[]>();
async function specsFor(categoryId: string | null): Promise<EbayAspectSpec[]> {
  if (!categoryId) return [];
  const hit = specCache.get(categoryId);
  if (hit) return hit;
  try {
    const specs = buildAspectSpecsForCategory(await getCategoryAspects(categoryId));
    specCache.set(categoryId, specs);
    return specs;
  } catch (err) {
    console.warn(
      `  aspects for ${categoryId} unavailable: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }
}

function confidentValue(
  field: { value: string; confidence: number } | undefined,
): string | null {
  if (!field || field.confidence < TAG_GROUND_TRUTH_MIN_CONFIDENCE) return null;
  const v = field.value.trim();
  return v === "" ? null : v;
}

async function main() {
  console.log(
    `backfill-tag-reads: ${apply ? "APPLY" : "dry run"}${owner ? ` owner=${owner}` : ""}`,
  );

  // Items with at least one tag-typed photo. Ids only here; each item is then
  // loaded by id and every write is scoped to its own user_id (US-268).
  const { data: tagRows, error: tagErr } = await supabaseAdmin
    .from("item_photos")
    .select("inventory_item_id")
    .in("photo_type", ["tag", "tag_2"]);
  if (tagErr) throw tagErr;
  const itemIds = [
    ...new Set((tagRows ?? []).map((r) => r.inventory_item_id as string)),
  ];
  console.log(`${itemIds.length} item(s) carry a tag-typed photo`);

  const rnCtx = await getRegisteredNumberContext();

  for (const id of itemIds) {
    if (stats.scanned >= limit) break;
    const { data: row, error } = await supabaseAdmin
      .from("inventory_items")
      .select(ITEM_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error || !row) {
      stats.failed++;
      continue;
    }
    const item = row as unknown as BackfillItem;
    if (owner && item.user_id !== owner) continue;
    stats.scanned++;
    if (!backfillEligible(item)) {
      stats.skipped++;
      continue;
    }

    try {
      const { data: photoRows } = await supabaseAdmin
        .from("item_photos")
        .select("id, photo_type, photo_role, storage_path, sort_order, photo_url")
        .eq("inventory_item_id", item.id)
        .order("sort_order", { ascending: true });
      const listable = filterListablePhotos((photoRows ?? []) as ItemPhotoUrlRow[]);
      const resolved = await itemPhotoAiUrls(listable);
      const photos = resolved.map(({ row, url }) => ({
        url,
        type: row.photo_type ?? "",
      }));
      // A photo row can outlive its storage object (the first dry run hit one
      // whose path belonged to a merged item). The vision API fails the whole
      // call on one bad URL, so check each tag photo first and drop the dead.
      const tagPhotos: typeof photos = [];
      for (const p of selectTagOcrPhotos(photos)) {
        const ok = await fetch(p.url, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
        if (ok) tagPhotos.push(p);
        else console.log(`  ${item.id}: tag photo unreachable, skipped: ${p.url}`);
      }
      if (tagPhotos.length === 0) {
        stats.skipped++;
        continue;
      }

      const ocr = await extractTagGroundTruth(
        tagPhotos.map((p) => ({ url: p.url, type: p.type })),
      );
      if (Object.keys(ocr.fields).length > 0) stats.read++;
      // What the label said, with confidences, so a dry run shows WHY a code
      // did or did not come through (the threshold is 0.4).
      const readSummary = Object.entries(ocr.fields)
        .map(([k, f]) => `${k}=${JSON.stringify(f.value)}@${f.confidence.toFixed(2)}`)
        .join(" ");
      console.log(`  read: ${readSummary || "(nothing legible)"}`);

      const brand = canonicalizeBrand(confidentValue(ocr.fields.brand) ?? item.brand);
      const pack = brand ? await resolveBrandKnowledgePack(brand) : null;
      let tagAttributes = tagAttributeFill(ocr.fields, item.attributes);

      const code = resolveListingStyleCode({
        ocr: ocr.fields,
        itemAttributes: item.attributes,
        sneakerStyleCode: null,
        brand,
        pack,
      });
      if (code.styleCodeRaw) {
        stats.code++;
        if (code.decoded) stats.decoded++;
        tagAttributes = { ...tagAttributes, mpn: code.styleCodeNorm || code.styleCodeRaw };
        const key = pack?.key ?? (brand ? brandKey(brand) : "");
        if (key) {
          const learned = learnedStyleForListing(
            await lookupLearnedStyle(key, code.styleCodeRaw),
            brand,
            code.styleCodeRaw,
          );
          if (learned.resolvedName) {
            stats.named++;
            tagAttributes = applyLearnedStyleToListing({
              learned,
              knownFields: {},
              tagGroundTruth: undefined,
              tagAttributes,
              sellerTypedStyle: item.style,
            }).tagAttributes;
          }
        }
      }

      const rn = confidentValue(ocr.fields.rn_number);
      let sighting: (() => Promise<void>) | null = null;
      if (rn) {
        const assessment = assessRegisteredNumber(rn, brand, rnCtx.index, rnCtx.registrants);
        const plan = planListingRegisteredNumber({
          rn,
          declaredBrand: brand,
          existingAttributes: item.attributes,
          assessment,
        });
        if (plan.outcome !== "unparsed") stats.rnParsed++;
        if (plan.outcome === "corroborates" || plan.outcome === "ambiguous") {
          stats.rnCorroborates++;
        }
        if (plan.outcome === "contradicts") stats.rnContradicts++;
        if (plan.outcome === "no_reference") stats.rnNoReference++;
        tagAttributes = { ...tagAttributes, ...plan.attributes };
        if (plan.recordSighting) {
          sighting = () => recordRegisteredNumberSighting(assessment, brand);
        }
      }

      const patch = planBackfillPatch({
        item,
        tagAttributes,
        aspectSpecs: await specsFor(item.ebay_category_id),
      });
      console.log(
        `${item.id} ${brand ?? "?"}: code=${code.styleCodeRaw ?? "-"} ` +
          `name=${tagAttributes.model ?? "-"} rn=${rn ?? "-"} ` +
          `attrs=[${patch.addedAttributes.join(",")}] aspects=[${patch.addedAspects.join(",")}]`,
      );
      if (!apply || !patch.attributes) continue;

      const update: Record<string, unknown> = { attributes: patch.attributes };
      if (patch.ebay_aspects) update.ebay_aspects = patch.ebay_aspects;
      if (patch.ebay_aspect_sources) {
        update.ebay_aspect_sources = patch.ebay_aspect_sources;
      }
      const { error: upErr } = await supabaseAdmin
        .from("inventory_items")
        .update(update)
        .eq("id", item.id)
        .eq("user_id", item.user_id);
      if (upErr) {
        stats.failed++;
        console.error(`  write failed: ${upErr.message}`);
        continue;
      }
      stats.attributesWritten += patch.addedAttributes.length;
      stats.aspectsWritten += patch.addedAspects.length;
      if (sighting) await sighting();
    } catch (err) {
      stats.failed++;
      console.error(`  ${item.id} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(JSON.stringify(stats));
}

await main();
