import type { ItemFullRow } from "@/types/database";
import { measurementGroupFor, type MeasurementGroup } from "./measurement-templates";

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
): string {
  if (!measurements || Object.keys(measurements).length === 0) {
    return "(measurements available on request)";
  }
  return Object.entries(measurements)
    .map(([k, v]) => `  ${k.replace(/_/g, " ")}: ${v}`)
    .join("\n");
}

function gradeBlock(item: ItemFullRow): string {
  if (item.grade_value == null) return "";
  const label = item.grade_label ? ` (${item.grade_label})` : "";
  let block = `Independently graded by GradeThread: ${item.grade_value.toFixed(
    1,
  )}/10${label}.`;
  if (item.certificate_url) {
    block += `\nView the full condition certificate: ${item.certificate_url}`;
  }
  return block;
}

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
    measurements: measurementsBlock(item.measurements),
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
