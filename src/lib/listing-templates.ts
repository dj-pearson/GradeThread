import type { ItemFullRow } from "@/types/database";
import {
  measurementGroupFor,
  measurementGroupForItem,
  type MeasurementGroup,
} from "./measurement-templates";
import { buildMeasurementLines, type LengthUnit } from "./measurements";

// Per-group description templates. Placeholders are filled by interpolate().
export const DESCRIPTION_TEMPLATES: Record<MeasurementGroup, string> = {
  top: `{{brand}} {{title}}

Size: {{size}}
Color: {{color}}
Material: {{material}}

Condition: {{condition}}

Measurements (garment laid flat):
{{measurements}}

{{grade}}
Smoke-free home. Ships fast. Questions welcome.`,
  bottom: `{{brand}} {{title}}

Size: {{size}}
Color: {{color}}
Material: {{material}}

Condition: {{condition}}

Measurements (laid flat):
{{measurements}}

{{grade}}
Smoke-free home. Ships fast. Questions welcome.`,
  dress: `{{brand}} {{title}}

Size: {{size}}
Color: {{color}}
Material: {{material}}

Condition: {{condition}}

Measurements (laid flat):
{{measurements}}

{{grade}}
Smoke-free home. Ships fast. Questions welcome.`,
  outerwear: `{{brand}} {{title}}

Size: {{size}}
Color: {{color}}
Material: {{material}}

Condition: {{condition}}

Measurements (laid flat):
{{measurements}}

{{grade}}
Smoke-free home. Ships fast. Questions welcome.`,
  // US-2464. The one template that says "two pieces" out loud. A suit buyer's
  // first question is whether the jacket and trousers are the same suit, so the
  // sold-as-a-set line is the body copy, not a nicety.
  suit: `{{brand}} {{title}}

Size: {{size}}
Color: {{color}}
Material: {{material}}

Condition: {{condition}}

Sold as a two-piece set — jacket and trousers together.

Measurements (each piece laid flat):
{{measurements}}

{{grade}}
Smoke-free home. Ships fast. Questions welcome.`,
  shoes: `{{brand}} {{title}}

Size: {{size}}
Color: {{color}}

Condition: {{condition}}

{{measurements}}

{{grade}}
Smoke-free home. Ships fast. Questions welcome.`,
  watch: `{{brand}} {{title}}

Condition: {{condition}}

Specs:
{{measurements}}

{{grade}}
Ships insured. Questions welcome.`,
  headwear: `{{brand}} {{title}}

Size: {{size}}
Color: {{color}}
Material: {{material}}

Condition: {{condition}}

Measurements:
{{measurements}}

{{grade}}
Smoke-free home. Ships fast. Questions welcome.`,
  accessory: `{{brand}} {{title}}

Color: {{color}}
Material: {{material}}

Condition: {{condition}}

Measurements:
{{measurements}}

{{grade}}
Smoke-free home. Ships fast. Questions welcome.`,
  bag: `{{brand}} {{title}}

Color: {{color}}
Material: {{material}}

Condition: {{condition}}

Measurements:
{{measurements}}

{{grade}}
Comes from a smoke-free home. Ships boxed. Questions welcome.`,
  generic: `{{brand}} {{title}}

Size: {{size}}
Color: {{color}}
Material: {{material}}

Condition: {{condition}}

{{measurements}}

{{grade}}
Smoke-free home. Ships fast. Questions welcome.`,
};

function measurementsBlock(
  measurements: Record<string, number | string> | null,
  unit: LengthUnit,
): string {
  // US-827: render via the shared formatter so values carry units and honor the
  // seller's in/cm preference (US-648), consistent with the edge draft build.
  const lines = buildMeasurementLines(measurements, unit);
  if (lines.length === 0) return "(measurements available on request)";
  return lines.map((l) => `  ${l.replace(/^- /, "")}`).join("\n");
}

function gradeBlock(item: ItemFullRow): string {
  if (item.grade_value == null) return "";
  // Plain text, NO URL — eBay bans off-eBay links in listings. The PSA-style
  // certificate NUMBER ("Cert #GT-…") is appended server-side at publish
  // (flipdesk-ebay.ts applyGradeListingPromotion), because the unique number
  // lives on the grade report, not on the item row available here. Buyers verify
  // the number on GradeThread's /verify page, which we never link from eBay.
  return `Graded by GradeThread — Condition Grade ${item.grade_value.toFixed(1)}`;
}

// Idempotently ensure the grade line is present in a description. Mirrors the
// server's appendCertNumber idempotency (flipdesk-ebay.ts applyGradeListingPromotion,
// which keys on the "Condition Grade" phrase) so the composer draft stays truthful:
// an AI rewrite — especially "regenerate" — writes a fresh description that drops
// the "Graded by GradeThread — Condition Grade X" line, and the seller's preview
// would then show no grade even though publish re-asserts it. Re-append the block
// as a trailing paragraph when it's missing. No-op when the item has no grade or a
// grade line is already present (the server appends the cert # to it at publish).
export function ensureGradeLine(description: string, item: ItemFullRow): string {
  const block = gradeBlock(item);
  if (!block) return description; // no grade on this item
  if (/Condition Grade/i.test(description)) return description; // already present
  const trimmed = description.replace(/\s+$/, "");
  return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
}

// The GradeThread "Verified Seller" credentials block is appended to a listing
// description server-side (edge ai-listing.ts) behind this HTML comment marker,
// which anchors the block so we can find, preserve, and render it. Keep this
// literal in lockstep with the edge injection.
export const SELLER_CREDENTIALS_MARKER = "<!--gradethread-seller-credentials-->";

// Split a description into its plain body and the trailing seller-credentials
// block (marker + HTML). Everything from the marker to the end is the block —
// it is always appended last. Returns an empty `credentials` when absent.
export function splitSellerCredentials(
  description: string,
): { body: string; credentials: string } {
  const idx = description.indexOf(SELLER_CREDENTIALS_MARKER);
  if (idx < 0) return { body: description, credentials: "" };
  return {
    body: description.slice(0, idx).replace(/\s+$/, ""),
    credentials: description.slice(idx),
  };
}

// Idempotently preserve the seller-credentials block across an AI rewrite.
// A rewrite (esp. "regenerate") writes a fresh description that drops — or
// half-mangles — the appended GradeThread block; strip any marker the model
// echoed out of the new copy, then re-append the ORIGINAL block verbatim so the
// draft/preview keeps showing the seller's verified-grade card. No-op when the
// original had no block. Mirrors `ensureGradeLine`.
export function ensureSellerCredentials(next: string, original: string): string {
  const { credentials } = splitSellerCredentials(original);
  const cleaned = splitSellerCredentials(next).body;
  if (!credentials) return cleaned;
  const trimmed = cleaned.replace(/\s+$/, "");
  return trimmed.length > 0 ? `${trimmed}\n${credentials}` : credentials;
}

export function interpolateDescription(
  template: string,
  item: ItemFullRow,
  unit: LengthUnit = "in",
): string {
  const vars: Record<string, string> = {
    brand: item.brand ?? "",
    title: item.item_title ?? "",
    size: item.size ?? "—",
    color: "—", // items_full doesn't expose color; user can edit
    material: "—",
    condition:
      item.notes?.trim() ||
      (item.grade_label ? item.grade_label : "Pre-owned, good condition"),
    measurements: measurementsBlock(item.measurements, unit),
    grade: gradeBlock(item),
  };
  return template
    .replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? "")
    .replace(/\n{3,}/g, "\n\n") // collapse gaps left by empty vars
    .trim();
}

// Brand-first eBay title suggestion, capped at 80 chars.
export function suggestTitle(item: ItemFullRow): string {
  const parts = [
    item.brand,
    item.style || item.item_title,
    item.size ? `Size ${item.size}` : null,
    item.category,
  ].filter((p): p is string => !!p && p.trim() !== "");
  return parts.join(" ").slice(0, 80);
}

// Keyword chips the user can append to the title.
export function titleKeywords(item: ItemFullRow): string[] {
  const out = new Set<string>();
  if (item.brand) out.add(item.brand);
  if (item.category) out.add(item.category);
  if (item.size) out.add(item.size);
  if (item.style) {
    for (const w of item.style.split(/\s+/)) if (w.length > 2) out.add(w);
  }
  if (item.grade_value != null) out.add("Graded");
  return Array.from(out);
}

// US-2595: `items_full.category` is COALESCE(item_category, garment_category),
// so on any item whose vertical is set it reads "clothing" — and
// measurementGroupFor("clothing") is `generic`. Every blazer and every pair of
// shorts got the length-and-width template. `garment` is the specific word when
// the caller has it (the composer holds it on the side, since the view doesn't
// expose it); the title is the last resort.
export function templateGroupFor(
  item: ItemFullRow,
  garment?: string | null,
): MeasurementGroup {
  // `garment` IS THE ANSWER when the caller has one, and it is used directly
  // rather than fed back through garmentDescriptorFor.
  //
  // It arrives already resolved — the composer runs the full most-specific-first
  // pass, including the eBay leaf, and hands the winner in. Passing it back as
  // `garment_category` put it through the coarse demotion a second time, and a
  // leaf named like a vertical ("Tops", "Dresses") lost to whatever the row
  // still said. On an item whose title had not caught up, templateGroupFor(row,
  // "Tops") returned `bottom`.
  //
  // A garment that resolves to `generic` is not an answer, so it falls through
  // to the row — that is the case this signature was added for (US-2595), where
  // `items_full.category` reads "clothing" and resolves to nothing.
  const supplied = (garment ?? "").trim();
  if (supplied) {
    const group = measurementGroupFor(supplied);
    if (group !== "generic") return group;
  }
  return measurementGroupForItem({
    category: item.category,
    title: item.item_title,
  });
}
