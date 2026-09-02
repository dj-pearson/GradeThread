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
//   deno run --allow-net --allow-env scripts/backfill-tag-reads.ts --redo-undecoded
//
// --dry-run is the default. A dry run still pays for the OCR (that is the
// point of --limit); it writes nothing, sightings included.
//
// --redo-undecoded (US-3086) is the SECOND pass and costs nothing at all. It
// re-plans the items whose attributes.mpn does not decode under their brand
// pack, FROM THE STORED STRING: no photo is fetched, no vision call is made,
// no ANTHROPIC_API_KEY is needed. The first run filed five Lululemon rims raw
// because the OCR started mid-circle; the rotation search now recovers the
// style number from the same characters. It rewrites attributes.mpn and, only
// where the aspect still carries that same raw value with inventory_derived
// provenance, the MPN / Style Code aspect. Nothing else, ever.
//
// It rewrites on the same rule the read path files under: whatever decodes,
// spelled canonically (US-2714). So an item that already decoded but was
// stored in another spelling is canonicalised too, which is the point of one
// spelling per garment. An item that still decodes to nothing is left alone.

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
  planRedoUndecodedPatch,
} from "../src/lib/tag-read-backfill.ts";

const apply = Deno.args.includes("--apply");
const redoUndecoded = Deno.args.includes("--redo-undecoded");
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

/**
 * US-3086: re-file the codes that were stored before the rim rotation search
 * existed. Reads the stored attributes.mpn and nothing else: no photo, no
 * vision call, no spend. It writes only where the decoders now recover a
 * different, canonical spelling.
 */
async function redoUndecodedMain() {
  console.log(
    `backfill-tag-reads --redo-undecoded: ${apply ? "APPLY" : "dry run"}` +
      `${owner ? ` owner=${owner}` : ""} (no OCR, no spend)`,
  );
  const redo = {
    scanned: 0,
    skipped: 0,
    stillUndecoded: 0,
    alreadyCanonical: 0,
    recovered: 0,
    attributesWritten: 0,
    aspectsWritten: 0,
    failed: 0,
  };

  // Items that already carry a code. Ids only; each row is then loaded by id
  // and every write is scoped to its own user_id (US-268).
  const { data: idRows, error: idErr } = await supabaseAdmin
    .from("inventory_items")
    .select("id")
    .not("attributes->>mpn", "is", null);
  if (idErr) throw idErr;
  const itemIds = [...new Set((idRows ?? []).map((r) => r.id as string))];
  console.log(`${itemIds.length} item(s) carry a stored style code`);

  const packCache = new Map<string, Awaited<ReturnType<typeof resolveBrandKnowledgePack>>>();
  for (const id of itemIds) {
    if (redo.scanned >= limit) break;
    const { data: row, error } = await supabaseAdmin
      .from("inventory_items")
      .select(ITEM_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error || !row) {
      redo.failed++;
      continue;
    }
    const item = row as unknown as BackfillItem;
    if (owner && item.user_id !== owner) continue;
    redo.scanned++;

    const brand = canonicalizeBrand(item.brand);
    if (!brand) {
      redo.skipped++;
      continue;
    }
    try {
      const key = brandKey(brand);
      if (!packCache.has(key)) {
        packCache.set(key, await resolveBrandKnowledgePack(brand));
      }
      const pack = packCache.get(key) ?? null;
      // The stored string is the ONLY input. ocr is null: nothing is read.
      const code = resolveListingStyleCode({
        ocr: null,
        itemAttributes: item.attributes,
        sneakerStyleCode: null,
        brand,
        pack,
      });
      if (!code.decoded) {
        redo.stillUndecoded++;
        continue;
      }
      const patch = planRedoUndecodedPatch({
        item,
        canonicalCode: code.styleCodeNorm,
      });
      if (!patch.attributes) {
        redo.alreadyCanonical++;
        continue;
      }
      redo.recovered++;
      console.log(
        `${item.id} ${brand}: mpn ${patch.storedCode} -> ${code.styleCodeNorm} ` +
          `(${code.decoded.decoderKind}, via ${code.styleCodeRaw}) ` +
          `aspects=[${patch.changedAspects.join(",")}]`,
      );
      if (!apply) continue;

      const update: Record<string, unknown> = { attributes: patch.attributes };
      if (patch.ebay_aspects) update.ebay_aspects = patch.ebay_aspects;
      const { error: upErr } = await supabaseAdmin
        .from("inventory_items")
        .update(update)
        .eq("id", item.id)
        .eq("user_id", item.user_id);
      if (upErr) {
        redo.failed++;
        console.error(`  write failed: ${upErr.message}`);
        continue;
      }
      redo.attributesWritten += patch.changedAttributes.length;
      redo.aspectsWritten += patch.changedAspects.length;
    } catch (err) {
      redo.failed++;
      console.error(`  ${item.id} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(JSON.stringify(redo));
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

// Say what WE need before anything touches the service-role client. Without
// this, the first supabaseAdmin property access throws "SUPABASE_URL is not
// set" from inside lib/supabase.ts, which tells an operator nothing about which
// script wanted it (scripts/operator-scripts-start.test.mjs, US-2661).
if (import.meta.main) {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    console.error(
      "backfill-tag-reads: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and ANTHROPIC_API_KEY are required\n" +
        "(--redo-undecoded needs no ANTHROPIC_API_KEY: it makes no AI call). Usage:\n" +
        "  deno run --allow-net --allow-env --env-file=.env scripts/backfill-tag-reads.ts [--apply] [--limit N] [--owner <uuid>]\n" +
        "  deno run --allow-net --allow-env --env-file=.env scripts/backfill-tag-reads.ts --redo-undecoded [--apply] [--limit N] [--owner <uuid>]",
    );
    Deno.exit(1);
  }
  await (redoUndecoded ? redoUndecodedMain() : main());
}
