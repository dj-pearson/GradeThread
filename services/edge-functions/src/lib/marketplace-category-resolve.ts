// US-722: per-platform category resolution — I/O layer (Supabase cache + AI).
//
// Resolution order for the no-API marketplaces (Poshmark/Mercari/Depop/Grailed):
//   1. Shared cache/override row in marketplace_category_map (seed | ai | admin)
//      — keyed by (platform, gradethread_garment) like ebay_category_aspects
//      (00030); a single warm row serves every seller so repeats cost ~0 AI.
//   2. Deterministic seed map (resolveSeededCategory) — write-through to the
//      cache so it becomes admin-extensible going forward.
//   3. AI suggestion constrained to the platform's candidate categories — cached
//      with needs_confirmation=true (the seller confirms once in the kit).
//   4. Unmapped → caller falls back to the NL query and prompts a category pick.
//
// eBay (Taxonomy API) and Shopify (free-form) never enter this path.

import { supabaseAdmin } from "./supabase.ts";
import { getAnthropicClient, getLightweightModel } from "./ai-config.ts";
import { withRetry } from "./retry.ts";
import type { MarketplacePlatform } from "./marketplace-specs.ts";
import {
  type CategoryResolution,
  MAPPED_PLATFORMS,
  PLATFORM_CATEGORY_HINTS,
  resolveSeededCategory,
  toGarmentKey,
  UNMAPPED_CATEGORY,
} from "./marketplace-category.ts";

interface CacheRow {
  platform_category: string;
  department: string | null;
  source: "seed" | "ai" | "admin";
  needs_confirmation: boolean;
}

interface AiSuggestion {
  path: string;
  department: string | null;
  confidence: number;
}

// Injectable I/O so the resolution logic is unit-testable without Supabase/AI.
export interface ResolveDeps {
  loadCache: (
    platform: MarketplacePlatform,
    garmentKey: string,
  ) => Promise<CacheRow | null>;
  saveCache: (row: {
    platform: MarketplacePlatform;
    gradethread_garment: string;
    platform_category: string;
    department?: string | null;
    source: "seed" | "ai";
    confidence?: number | null;
    needs_confirmation: boolean;
  }) => Promise<void>;
  aiSuggest: (
    platform: MarketplacePlatform,
    garmentLabel: string,
  ) => Promise<AiSuggestion | null>;
}

async function loadCacheRow(
  platform: MarketplacePlatform,
  garmentKey: string,
): Promise<CacheRow | null> {
  const { data } = await supabaseAdmin
    .from("marketplace_category_map")
    .select("platform_category, department, source, needs_confirmation")
    .eq("platform", platform)
    .eq("gradethread_garment", garmentKey)
    .maybeSingle();
  return (data as CacheRow | null) ?? null;
}

async function saveCacheRow(row: {
  platform: MarketplacePlatform;
  gradethread_garment: string;
  platform_category: string;
  department?: string | null;
  source: "seed" | "ai";
  confidence?: number | null;
  needs_confirmation: boolean;
}): Promise<void> {
  // Upsert on the (platform, gradethread_garment) unique key. Never clobber an
  // existing admin override or already-confirmed AI row with a fresh suggestion.
  await supabaseAdmin
    .from("marketplace_category_map")
    .upsert(
      {
        platform: row.platform,
        gradethread_garment: row.gradethread_garment,
        platform_category: row.platform_category,
        department: row.department ?? null,
        source: row.source,
        confidence: row.confidence ?? null,
        needs_confirmation: row.needs_confirmation,
      },
      { onConflict: "platform,gradethread_garment", ignoreDuplicates: true },
    );
}

const SUGGEST_TOOL = {
  name: "suggest_category",
  description:
    "Pick the single best platform category for the garment from the allowed list.",
  input_schema: {
    type: "object" as const,
    properties: {
      category: {
        type: "string",
        description: "Exactly one value copied verbatim from the allowed list.",
      },
      department: {
        type: "string",
        description: "Best-guess department/gender, e.g. Women, Men, Kids, Unisex.",
      },
      confidence: { type: "number", description: "0..1 confidence in the pick." },
    },
    required: ["category"],
  },
};

async function defaultAiSuggest(
  platform: MarketplacePlatform,
  garmentLabel: string,
): Promise<AiSuggestion | null> {
  const allowed = PLATFORM_CATEGORY_HINTS[platform];
  if (!allowed || allowed.length === 0) return null;

  const client = getAnthropicClient();
  const model = getLightweightModel();
  const response = await withRetry(
    () =>
      client.messages.create({
        model,
        max_tokens: 256,
        system: [
          {
            type: "text",
            text:
              "You map a resale clothing item to a marketplace category. Choose " +
              "the SINGLE best category from the allowed list ONLY — copy it " +
              "verbatim. Never invent a category. Call suggest_category.",
          },
        ],
        tools: [SUGGEST_TOOL],
        tool_choice: { type: "tool", name: "suggest_category" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  `Platform: ${platform}`,
                  `Item garment/category: ${garmentLabel}`,
                  `Allowed categories: ${allowed.join(", ")}`,
                ].join("\n"),
              },
            ],
          },
        ],
      }),
    {
      onRetry: ({ attempt, delayMs }) =>
        console.warn(`[category-map] AI suggest retry #${attempt} after ${delayMs}ms`),
    },
  );

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return null;
  const input = toolUse.input as {
    category?: unknown;
    department?: unknown;
    confidence?: unknown;
  };
  const category = typeof input.category === "string" ? input.category.trim() : "";
  // Reject anything outside the allowed set — the model occasionally paraphrases.
  if (!category || !allowed.includes(category)) return null;
  const department =
    typeof input.department === "string" && input.department.trim()
      ? input.department.trim()
      : null;
  const confidence =
    typeof input.confidence === "number" && Number.isFinite(input.confidence)
      ? Math.max(0, Math.min(1, input.confidence))
      : 0.5;
  return { path: category, department, confidence };
}

/**
 * Resolves a platform-native category for a GradeThread item: cache → seed →
 * AI → unmapped. Pass `deps` to inject I/O in tests; defaults hit Supabase + AI.
 */
export async function resolveMarketplaceCategory(
  platform: MarketplacePlatform,
  garmentCategory: string | null,
  itemCategory: string | null,
  deps: Partial<ResolveDeps> = {},
): Promise<CategoryResolution> {
  if (!MAPPED_PLATFORMS.has(platform)) return UNMAPPED_CATEGORY;

  const loadCache = deps.loadCache ?? loadCacheRow;
  const saveCache = deps.saveCache ?? saveCacheRow;
  const aiSuggest = deps.aiSuggest ?? defaultAiSuggest;

  const key = toGarmentKey(garmentCategory, itemCategory);

  // 1. Shared cache / admin override.
  if (key) {
    const cached = await loadCache(platform, key).catch(() => null);
    if (cached) {
      return {
        status: "mapped",
        path: cached.platform_category,
        department: cached.department,
        source: cached.source,
        needsConfirmation: cached.needs_confirmation,
      };
    }
  }

  // 2. Deterministic seed (write-through so it's cached + extensible).
  const seed = resolveSeededCategory(platform, garmentCategory, itemCategory);
  if (seed && key) {
    await saveCache({
      platform,
      gradethread_garment: key,
      platform_category: seed.path,
      source: "seed",
      needs_confirmation: false,
    }).catch(() => {});
    return {
      status: "mapped",
      path: seed.path,
      department: null,
      source: "seed",
      needsConfirmation: false,
    };
  }

  // 3. AI suggestion (constrained to the platform's allowed categories), cached.
  const garmentLabel = (garmentCategory ?? itemCategory ?? "").trim();
  if (garmentLabel) {
    const suggestion = await aiSuggest(platform, garmentLabel).catch(() => null);
    if (suggestion) {
      // Key by the normalized garment when known, else by the raw label so the
      // same odd category resolves from cache next time (~0 AI on repeats).
      const cacheKey = key ?? garmentLabel.toLowerCase();
      await saveCache({
        platform,
        gradethread_garment: cacheKey,
        platform_category: suggestion.path,
        department: suggestion.department,
        source: "ai",
        confidence: suggestion.confidence,
        needs_confirmation: true,
      }).catch(() => {});
      return {
        status: "mapped",
        path: suggestion.path,
        department: suggestion.department,
        source: "ai",
        needsConfirmation: true,
      };
    }
  }

  // 4. Unmapped — caller falls back to the NL query and prompts a pick.
  return UNMAPPED_CATEGORY;
}
