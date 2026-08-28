import type { ItemFullRow } from "@/types/database";
import {
  measurementGroupFor,
  measurementGroupForItem,
  type MeasurementGroup,
} from "./measurement-templates";

// Per-group description templates. Placeholders are filled by interpolate().
//
// US-2965: no `{{measurements}}` and no `{{grade}}`. Both are their own
// description blocks now (migration 00678), rendered by the edge service on
// every save, and a template that restated them printed each fact twice — once
// in the intro block this string becomes, once in the block that owns it. Only
// one of the two copies followed the seller's next edit, which is the exact
// failure the block epic exists to remove. The Swift mirror dropped them in
// US-2964, and src/test/listing-template-native-parity.test.ts pins the two
// together.
export const DESCRIPTION_TEMPLATES: Record<MeasurementGroup, string> = {
  top: `{{brand}} {{title}}

Size: {{size}}
Color: {{color}}
Material: {{material}}

Condition: {{condition}}

Smoke-free home. Ships fast. Questions welcome.`,
  bottom: `{{brand}} {{title}}

Size: {{size}}
Color: {{color}}
Material: {{material}}

Condition: {{condition}}

Smoke-free home. Ships fast. Questions welcome.`,
  dress: `{{brand}} {{title}}

Size: {{size}}
Color: {{color}}
Material: {{material}}

Condition: {{condition}}

Smoke-free home. Ships fast. Questions welcome.`,
  outerwear: `{{brand}} {{title}}

Size: {{size}}
Color: {{color}}
Material: {{material}}

Condition: {{condition}}

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

Smoke-free home. Ships fast. Questions welcome.`,
  shoes: `{{brand}} {{title}}

Size: {{size}}
Color: {{color}}

Condition: {{condition}}

Smoke-free home. Ships fast. Questions welcome.`,
  watch: `{{brand}} {{title}}

Condition: {{condition}}

Ships insured. Questions welcome.`,
  headwear: `{{brand}} {{title}}

Size: {{size}}
Color: {{color}}
Material: {{material}}

Condition: {{condition}}

Smoke-free home. Ships fast. Questions welcome.`,
  accessory: `{{brand}} {{title}}

Color: {{color}}
Material: {{material}}

Condition: {{condition}}

Smoke-free home. Ships fast. Questions welcome.`,
  bag: `{{brand}} {{title}}

Color: {{color}}
Material: {{material}}

Condition: {{condition}}

Comes from a smoke-free home. Ships boxed. Questions welcome.`,
  generic: `{{brand}} {{title}}

Size: {{size}}
Color: {{color}}
Material: {{material}}

Condition: {{condition}}

Smoke-free home. Ships fast. Questions welcome.`,
};

// US-2965 removed three writers from this file: `measurementsBlock`,
// `gradeBlock` and `ensureGradeLine`.
//
// Each of them wrote a fact that is now its own description block — the
// measurement table, the grade line, the defect disclosure — and the edge
// renderer emits all three on every save. Keeping a client-side copy printed
// each fact twice, and only the block half followed the seller's next edit,
// which is the failure the block split exists to remove. The server still
// appends the cert number to the rendered grade line at publish
// (`applyGradeListingPromotion`), unchanged.
//
// `buildMeasurementLines` (src/lib/measurements.ts) is untouched and is still
// the one formatter both sides share, so nothing about the LINE FORMAT moved.
// See vault/30-platform/grade-authority-on-listings.md for what a grade may
// become on a listing.

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

// US-2965 removed `ensureSellerCredentials` for the same reason as the three
// above: the badge is the `credentials` block, so re-appending the pre-rewrite
// copy printed it twice. `splitSellerCredentials` stays — the eBay view-item
// preview READS it to draw the card apart from the body, which is not a second
// writer.

// US-2965: no `unit` parameter, because nothing here renders a measurement any
// more. An unknown placeholder still resolves to the empty string, which is what
// a template saved before the split — one still carrying `{{measurements}}` —
// now renders to; the measurements block prints it instead, exactly once.
export function interpolateDescription(
  template: string,
  item: ItemFullRow,
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
