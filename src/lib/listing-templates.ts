import type { ItemFullRow } from "@/types/database";
import { measurementGroupFor, type MeasurementGroup } from "./measurement-templates";
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

export function templateGroupFor(item: ItemFullRow): MeasurementGroup {
  return measurementGroupFor(item.category);
}
