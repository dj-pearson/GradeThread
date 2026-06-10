// Client-side mirrors of the publish-time auto-fill logic in
// services/edge-functions/src/routes/flipdesk-ebay.ts (inferDepartment,
// deriveAspectsFromItem, mapEbayCondition). The server applies these at
// publish; mirroring them in the composer means the user SEES the same values
// prefilled instead of facing empty dropdowns for data they already entered.
// Keep both sides in sync when changing the mapping rules.

import type { EbayAspect } from "@/hooks/use-ebay";

// The structured item columns aspect prefill can draw from.
export interface ItemAspectSource {
  title: string | null;
  brand: string | null;
  size: string | null;
  color: string | null;
  material: string | null;
  style: string | null;
  description: string | null;
  condition_notes: string | null;
  item_category: string | null;
}

// Department (Men/Women/Boys/…) inferred from free-text fields — mirrors the
// server's inferDepartment. Order matters: most specific first; \b avoids
// "men" matching inside "women".
export function inferDepartment(item: ItemAspectSource): string | null {
  const text = [
    item.title,
    item.style,
    item.description,
    item.condition_notes,
    item.size,
  ]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ")
    .toLowerCase();
  if (!text) return null;
  const has = (re: RegExp) => re.test(text);
  if (has(/\bmaternity\b/)) return "Maternity";
  if (has(/\b(baby|infant|newborn|toddler|onesie)\b/)) return "Baby";
  if (has(/\bboys?\b/)) return "Boys";
  if (has(/\bgirls?\b/)) return "Girls";
  if (has(/\b(kids?|youth|juniors?|children'?s?|child)\b/)) return "Unisex Kids";
  if (has(/\bunisex\b/)) return "Unisex Adult";
  if (
    has(/\b(women'?s?|womens|woman'?s?|womenswear|ladies'?|lady'?s?|female|misses)\b/)
  ) {
    return "Women";
  }
  if (has(/\b(men'?s?|mens|man'?s?|menswear|male)\b/)) return "Men";
  return null;
}

// Map structured item columns onto a category's aspects. Returns only aspects
// NOT already set in `existing`. SELECTION_ONLY aspects fill only when the
// value matches an eBay-allowed value (case- and plural-insensitive);
// FREE_TEXT/SUGGESTED aspects take the raw value.
export function deriveAspectsFromItem(
  item: ItemAspectSource,
  aspectList: EbayAspect[],
  existing: Record<string, string[]>,
): Record<string, string[]> {
  const isClothing = item.item_category === "clothing";
  const concepts: Array<{ names: string[]; value: string | null }> = [
    { names: ["brand"], value: item.brand },
    { names: ["size"], value: item.size },
    { names: ["color", "colour"], value: item.color },
    {
      names: ["material", "fabric type", "outer shell material"],
      value: item.material,
    },
    { names: ["style", "type"], value: item.style },
    // Most clothing is "Regular"; a safe default the seller can change.
    { names: ["size type"], value: isClothing ? "Regular" : null },
    { names: ["department"], value: inferDepartment(item) },
  ];

  const out: Record<string, string[]> = {};
  for (const aspect of aspectList) {
    const name = (aspect.localizedAspectName ?? "").trim();
    if (!name) continue;
    if ((existing[name]?.length ?? 0) > 0) continue;
    const lname = name.toLowerCase();
    const match = concepts.find(
      (cpt) => cpt.value && cpt.value.trim() && cpt.names.includes(lname),
    );
    const candidate = match?.value?.trim();
    if (!candidate) continue;

    if (aspect.aspectConstraint?.aspectMode === "SELECTION_ONLY") {
      const allowed = (aspect.aspectValues ?? [])
        .map((v) => v.localizedValue ?? "")
        .filter((v) => v.length > 0);
      // Plural-tolerant: eBay sometimes pluralizes values ("Unisex Adults").
      const norm = (s: string) => s.toLowerCase().trim().replace(/s$/, "");
      const cand = norm(candidate);
      const hit = allowed.find((v) => norm(v) === cand);
      if (!hit) continue;
      out[name] = [hit];
    } else {
      out[name] = [candidate];
    }
  }
  return out;
}

// Grade → eBay condition mapping — mirrors the server's mapEbayCondition,
// which is what publish falls back to when no condition was chosen. Surfacing
// it in the composer makes the eventual publish value visible and editable.
export function mapEbayCondition(
  grade: number | null,
  label: string | null,
): string {
  const isNwt = (label ?? "").toUpperCase().includes("NWT");
  if (grade != null) {
    if (grade >= 9.75 || isNwt) return "NEW";
    if (grade >= 9.0) return "LIKE_NEW";
    if (grade >= 7.5) return "USED_EXCELLENT";
    if (grade >= 6.0) return "USED_VERY_GOOD";
    if (grade >= 4.5) return "USED_GOOD";
    return "USED_ACCEPTABLE";
  }
  return isNwt ? "NEW" : "USED_EXCELLENT";
}
