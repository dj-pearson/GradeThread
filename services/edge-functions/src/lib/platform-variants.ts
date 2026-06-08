// US-721: pure per-marketplace variant assembly.
//
// Split out from ai-listing.ts so it has NO I/O dependency (no Anthropic /
// Supabase) and can be unit-tested directly. ai-listing.ts re-exports these
// and layers the AI text pass + persistence on top.
//
// Depends only on the marketplace registry (pure data + functions).

import {
  getMarketplaceSpec,
  mapCondition,
  type ConditionOption,
  type DraftFields,
  type MarketplacePlatform,
  type ValidationResult,
  validateListingForPlatform,
} from "./marketplace-specs.ts";

function clampConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// The source facts a variant is adapted from (the base eBay draft + item).
export interface PlatformVariantBase {
  title: string;
  description: string;
  brand: string | null;
  size: string | null;
  color: string | null;
  material: string | null;
  itemSpecifics: Record<string, string[]>;
  gradeValue: number | null;
  gradeLabel: string | null;
  priceCents: number;
  /** Natural-language category (US-722 later resolves it to each taxonomy). */
  categoryQuery: string;
  confidence: number;
}

// Per-platform AI text output (tone/length/tags only — facts come from base).
export interface PlatformText {
  title: string;
  description: string;
  tags: string[];
}

// The fully assembled, persistable variant for one platform.
export interface PlatformVariant {
  platform: MarketplacePlatform;
  title: string;
  description: string;
  condition: ConditionOption | null;
  category: string;
  brand: string | null;
  color: string | null;
  size: string | null;
  price: number; // dollars
  tags: string[];
  confidence: number;
  validation: ValidationResult;
}

// Word-boundary trim so a hard char limit never cuts mid-word. Falls back to a
// hard slice when the first word alone already exceeds the cap.
export function trimToLimit(text: string, max: number | null | undefined): string {
  const t = (text ?? "").trim();
  if (max == null || t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

// Builds the field map the registry validator expects from a finished variant.
function variantToDraftFields(platform: MarketplacePlatform, v: PlatformVariant): DraftFields {
  const base: DraftFields = {
    title: v.title,
    description: v.description,
    category: v.category,
    condition: v.condition?.value ?? "",
    brand: v.brand ?? "",
    color: v.color ?? "",
    size: v.size ?? "",
    price: String(v.price),
    tags: v.tags,
  };
  // Grailed names brand "designer" and splits the category into department.
  if (platform === "grailed") {
    base.designer = v.brand ?? "";
    base.department = v.category;
  }
  return base;
}

/**
 * Pure assembly of one platform's variant from the base + the AI text output.
 * Deterministic: condition via mapCondition (US-720), category passthrough,
 * brand/size/color/price from the base; AI text supplies tone-adapted title /
 * description / tags, clamped to the platform's limits. Then validated.
 * No I/O — unit-testable.
 */
export function assemblePlatformVariant(
  platform: MarketplacePlatform,
  base: PlatformVariantBase,
  text: PlatformText,
  ctx: { photoCount?: number; brandAllowed?: boolean } = {},
  // US-722: the platform-mapped category (seeded). Falls back to the base's
  // natural-language category query when not mapped.
  categoryOverride?: string | null,
): PlatformVariant {
  const spec = getMarketplaceSpec(platform);
  if (!spec) throw new Error(`No marketplace spec for ${platform}`);

  // Title: AI title trimmed to the platform's cap; blank when the platform has
  // no title field (Depop).
  const title = spec.titleMaxLength == null
    ? ""
    : trimToLimit(text.title || base.title, spec.titleMaxLength);

  const description = trimToLimit(
    text.description || base.description,
    spec.descriptionMaxLength,
  );

  const tags = spec.tags
    ? (text.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, spec.tags.max)
    : [];

  const variant: PlatformVariant = {
    platform,
    title,
    description,
    condition: mapCondition(platform, base.gradeValue, base.gradeLabel),
    category: categoryOverride?.trim() || base.categoryQuery,
    brand: base.brand,
    color: base.color,
    size: base.size,
    price: Math.round(base.priceCents) / 100,
    tags,
    confidence: clampConfidence(base.confidence),
    // placeholder; replaced below once the field map exists
    validation: { platform, ok: true, issues: [] },
  };
  variant.validation = validateListingForPlatform(
    platform,
    variantToDraftFields(platform, variant),
    ctx,
  );
  return variant;
}
