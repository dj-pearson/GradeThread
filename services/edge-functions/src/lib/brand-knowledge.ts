// US-1711: Brand & Style Knowledge Base — DB-first resolver + compact pack
// assembler.
//
// The knowledge lives in the 00389 tables (brand_knowledge / brand_styles /
// brand_style_codes / brand_colorways / brand_size_charts). This module reads
// them DB-FIRST and falls back to the in-code seeds (brand-normalize.ts
// BRAND_ALIASES, sizing-charts.ts SIZING_CHARTS) on an empty/errored read —
// the same DB-override-with-code-fallback shape as resolveActivePrompt in
// ai-grading.ts. Keeping brand-normalize.ts / sizing-charts.ts PURE and SYNC
// (their many callers stay sync; they remain unit-testable) is deliberate: the
// DB-first behaviour is added HERE, with those modules as the fallback data.
//
// The public entry point resolveBrandKnowledgePack() returns a COMPACT,
// token-budgeted pack scoped to ONE brand — never the whole KB — so US-1713 can
// inject only the relevant brand's knowledge into the extraction prompt.
//
// These are GLOBAL REFERENCE tables (no user_id / tenant data), so reads are
// not tenant-scoped — there is nothing to scope by. The pure assembly + budget
// logic is factored out (assembleBrandKnowledgePack) so it unit-tests without a
// live DB; the thin DB fetch degrades to the fallback when the DB is
// unreachable (e.g. before 00389 is applied, or a transient error).

import { supabaseAdmin } from "./supabase.ts";
import {
  brandKey,
  canonicalizeBrand,
  isKnownBrand,
} from "./brand-normalize.ts";
import { findSizingCharts, type SizingChart } from "./sizing-charts.ts";
import type {
  DecodeResult,
  DecoderSpec,
  TransformId,
} from "./brand-decoders.ts";

// ── Budget caps — keep the injected pack small ──────────────────────────────
const MAX_STYLES = 8;
const MAX_COLORWAYS = 8;
const MAX_CHARTS = 3; // matches formatSizingChartsForPrompt's slice(0, 3)
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min, like the grading prompt cache

// ── Public pack shape ───────────────────────────────────────────────────────
export interface BrandStyleKnowledge {
  styleName: string;
  aliases: string[];
  productLine: string | null;
  department: string | null;
  category: string | null;
  visualFingerprint: string | null;
  fabricTech: string[];
  era: string | null;
  msrpBand: string | null;
  keywords: string[];
}

export interface BrandDecoder {
  decoderKind: string;
  description: string | null;
  pattern: string | null;
  extractionRules: unknown;
  examples: unknown;
}

export interface BrandColorway {
  colorName: string;
  aliases: string[];
  hex: string | null;
  years: string | null;
}

export interface BrandKnowledgePack {
  /** Canonical brand (e.g. "Levi's"). */
  brand: string;
  /** Normalized match key (e.g. "levis"). */
  key: string;
  /** True when the brand is a curated/known brand (vs. free-text passthrough). */
  known: boolean;
  aliases: string[];
  categoryFocus: string[];
  /** [{tell, detail}] — informational, never auto-authenticate. */
  authenticationTells: unknown[];
  /** [{era, years, description}] for tag/label dating. */
  tagEras: unknown[];
  styles: BrandStyleKnowledge[];
  decoders: BrandDecoder[];
  colorways: BrandColorway[];
  sizingCharts: SizingChart[];
  /** Where the knowledge came from — for logging / diagnostics. */
  source: "db" | "fallback" | "mixed";
}

export interface ResolvePackOptions {
  /** Garment category/type hint (e.g. "legging", "jacket") to narrow styles + charts. */
  category?: string | null;
  /** Bypass the in-process cache (tests / forced refresh). */
  noCache?: boolean;
}

// ── DB row shapes (snake_case) ──────────────────────────────────────────────
interface BrandKnowledgeRow {
  aliases: string[] | null;
  category_focus: string[] | null;
  tag_eras: unknown[] | null;
  authentication_tells: unknown[] | null;
}
interface BrandStyleRow {
  style_name: string;
  aliases: string[] | null;
  product_line: string | null;
  department: string | null;
  category: string | null;
  visual_fingerprint: string | null;
  fabric_tech: string[] | null;
  era: string | null;
  msrp_band: string | null;
  keywords: string[] | null;
}
interface BrandStyleCodeRow {
  decoder_kind: string;
  description: string | null;
  pattern: string | null;
  extraction_rules: unknown;
  examples: unknown;
}
interface BrandColorwayRow {
  color_name: string;
  aliases: string[] | null;
  hex: string | null;
  years: string | null;
}
interface BrandSizeChartRow {
  brand_label: string;
  brand_match: string[] | null;
  department: string;
  garment: string;
  category_match: string[] | null;
  rows: unknown;
  note: string | null;
  // US-2917 provenance. These decide the TIER the composer shows, so they are
  // read from the DB row rather than inferred: a chart is only "verified" when
  // a human said so against the brand's own guide.
  source_url: string | null;
  verified: boolean | null;
  measurement_basis: string | null;
}

// ── Pure assembly + budget (unit-tested without a DB) ───────────────────────

/** Lowercased needle test used by the category narrowers. */
function catIncludes(haystack: string | null, needle: string): boolean {
  return !!haystack && needle.includes(haystack.toLowerCase());
}

/** Rank styles by relevance to the category hint, then take the top MAX_STYLES. */
function rankStyles(
  rows: BrandStyleRow[],
  category: string | null,
): BrandStyleKnowledge[] {
  const cat = (category ?? "").toLowerCase();
  const scored = rows.map((r, i) => {
    let score = 0;
    if (cat) {
      if (catIncludes(r.category, cat)) score += 3;
      for (const kw of r.keywords ?? []) {
        if (cat.includes(kw.toLowerCase())) score += 1;
      }
    }
    return { r, score, i };
  });
  // Higher score first; stable on original order (which the query sorts by
  // confidence desc) for ties.
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  return scored.slice(0, MAX_STYLES).map(({ r }) => ({
    styleName: r.style_name,
    aliases: r.aliases ?? [],
    productLine: r.product_line,
    department: r.department,
    category: r.category,
    visualFingerprint: r.visual_fingerprint,
    fabricTech: r.fabric_tech ?? [],
    era: r.era,
    msrpBand: r.msrp_band,
    keywords: r.keywords ?? [],
  }));
}

function chartFromRow(r: BrandSizeChartRow): SizingChart {
  return {
    brand: r.brand_label,
    brandMatch: r.brand_match ?? [],
    department: r.department,
    garment: r.garment,
    categoryMatch: r.category_match ?? [],
    // rows is jsonb; the shape mirrors SizingRow[] as seeded from SIZING_CHARTS.
    rows: (r.rows as SizingChart["rows"]) ?? [],
    note: r.note ?? undefined,
    sourceUrl: r.source_url ?? null,
    verified: r.verified === true,
    // A row written before 00674 has no basis. NULL reads as "body", the same
    // default the column carries, because every chart seeded before that
    // migration held body measurements.
    measurementBasis: r.measurement_basis === "flat" ? "flat" : "body",
  };
}

/** Narrow DB charts by category the same way findSizingCharts does its category
 *  step: keep category matches if any, else return the whole pool. */
function narrowChartsByCategory(
  charts: SizingChart[],
  category: string | null,
): SizingChart[] {
  const cat = (category ?? "").toLowerCase();
  if (!cat) return charts;
  const byCat = charts.filter((c) =>
    c.categoryMatch.some((m) => cat.includes(m))
  );
  return byCat.length > 0 ? byCat : charts;
}

export interface AssembleInput {
  canonical: string;
  key: string;
  known: boolean;
  category: string | null;
  brandRow: BrandKnowledgeRow | null;
  styleRows: BrandStyleRow[];
  decoderRows: BrandStyleCodeRow[];
  colorwayRows: BrandColorwayRow[];
  dbCharts: SizingChart[];
  fallbackCharts: SizingChart[];
}

/** Pure: fold DB rows + fallback charts into a compact, budgeted pack. */
export function assembleBrandKnowledgePack(
  input: AssembleInput,
): BrandKnowledgePack {
  const {
    canonical,
    key,
    known,
    category,
    brandRow,
    styleRows,
    decoderRows,
    colorwayRows,
    dbCharts,
    fallbackCharts,
  } = input;

  const usedDbCharts = dbCharts.length > 0;
  const charts = narrowChartsByCategory(
    usedDbCharts ? dbCharts : fallbackCharts,
    category,
  ).slice(0, MAX_CHARTS);

  // US-2214: the chart fallback is SILENT by construction — it always returns
  // something, so a brand missing from brand_size_charts looks exactly like a
  // brand that has one. That is how the DB drifted to a couple of dozen charts
  // against 292 in code without anyone noticing. 00498 backfilled them, so a
  // fallback now means either the migration has not been applied or a chart was
  // added to code without regenerating it. Say so once, where it is greppable.
  if (!usedDbCharts && fallbackCharts.length > 0) {
    console.warn(
      `[BrandKnowledge] size charts for "${canonical}" came from the IN-CODE ` +
        `fallback, not brand_size_charts — 00498 may be unapplied, or the chart ` +
        `was added to sizing-charts.ts without regenerating the seed ` +
        `(scripts/gen-sizing-chart-seed.mjs).`,
    );
  }

  const hasDbRows = !!brandRow || styleRows.length > 0 ||
    decoderRows.length > 0 || colorwayRows.length > 0 || usedDbCharts;
  // "db" = knowledge (incl. charts) came from the DB; "mixed" = DB rows present
  // but charts fell back to the in-code seeds; "fallback" = no DB rows at all.
  const source: BrandKnowledgePack["source"] = hasDbRows
    ? (usedDbCharts ? "db" : "mixed")
    : "fallback";

  return {
    brand: canonical,
    key,
    known,
    aliases: brandRow?.aliases ?? [],
    categoryFocus: brandRow?.category_focus ?? [],
    authenticationTells: brandRow?.authentication_tells ?? [],
    tagEras: brandRow?.tag_eras ?? [],
    styles: rankStyles(styleRows, category),
    decoders: decoderRows.map((r) => ({
      decoderKind: r.decoder_kind,
      description: r.description,
      pattern: r.pattern,
      extractionRules: r.extraction_rules,
      examples: r.examples,
    })),
    colorways: colorwayRows.slice(0, MAX_COLORWAYS).map((r) => ({
      colorName: r.color_name,
      aliases: r.aliases ?? [],
      hex: r.hex,
      years: r.years,
    })),
    sizingCharts: charts,
    source,
  };
}

// ── In-process cache ────────────────────────────────────────────────────────
const cache = new Map<string, { pack: BrandKnowledgePack; expires: number }>();

/** Clear the resolver cache (tests / forced refresh). */
export function clearBrandKnowledgeCache(): void {
  cache.clear();
}

// ── DB-first resolution ─────────────────────────────────────────────────────

/**
 * Resolve a compact, brand-scoped knowledge pack for a free-text brand. Returns
 * null when the input is blank (no brand). DB-first; on any read failure the
 * pack degrades to the in-code fallback (canonical brand + sizing charts) so
 * behaviour never regresses vs. pre-KB — even before 00389 is applied.
 */
export async function resolveBrandKnowledgePack(
  rawBrand: string | null | undefined,
  opts: ResolvePackOptions = {},
): Promise<BrandKnowledgePack | null> {
  const canonical = canonicalizeBrand(rawBrand);
  if (!canonical) return null;
  const key = brandKey(canonical);
  const category = opts.category ?? null;
  const cacheKey = `${key}::${category ?? ""}`;

  if (!opts.noCache) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.pack;
  }

  const fallbackCharts = findSizingCharts(canonical, category);

  let brandRow: BrandKnowledgeRow | null = null;
  let styleRows: BrandStyleRow[] = [];
  let decoderRows: BrandStyleCodeRow[] = [];
  let colorwayRows: BrandColorwayRow[] = [];
  let dbCharts: SizingChart[] = [];

  try {
    const [bk, st, dc, cw, sizeCharts] = await Promise.all([
      supabaseAdmin
        .from("brand_knowledge")
        .select("aliases, category_focus, tag_eras, authentication_tells")
        .eq("brand_key", key)
        .maybeSingle(),
      supabaseAdmin
        .from("brand_styles")
        .select(
          "style_name, aliases, product_line, department, category, visual_fingerprint, fabric_tech, era, msrp_band, keywords",
        )
        .eq("brand_key", key)
        .order("confidence", { ascending: false, nullsFirst: false }),
      supabaseAdmin
        .from("brand_style_codes")
        .select(
          "decoder_kind, description, pattern, extraction_rules, examples",
        )
        .eq("brand_key", key),
      supabaseAdmin
        .from("brand_colorways")
        .select("color_name, aliases, hex, years")
        .eq("brand_key", key)
        .order("confidence", { ascending: false, nullsFirst: false }),
      supabaseAdmin
        .from("brand_size_charts")
        .select(
          "brand_label, brand_match, department, garment, category_match, rows, note, source_url, verified, measurement_basis",
        )
        .eq("brand_key", key),
    ]);

    if (!bk.error) brandRow = (bk.data as BrandKnowledgeRow | null) ?? null;
    if (!st.error && st.data) styleRows = st.data as BrandStyleRow[];
    if (!dc.error && dc.data) decoderRows = dc.data as BrandStyleCodeRow[];
    if (!cw.error && cw.data) colorwayRows = cw.data as BrandColorwayRow[];
    if (!sizeCharts.error && sizeCharts.data) {
      dbCharts = (sizeCharts.data as BrandSizeChartRow[]).map(chartFromRow);
    }
  } catch (err) {
    // DB unreachable (e.g. pre-migration, transient) → fall back to code seeds.
    console.warn(
      `[brand-knowledge] DB read failed for "${key}"; using in-code fallback:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  const pack = assembleBrandKnowledgePack({
    canonical,
    key,
    known: isKnownBrand(rawBrand),
    category,
    brandRow,
    styleRows,
    decoderRows,
    colorwayRows,
    dbCharts,
    fallbackCharts,
  });

  cache.set(cacheKey, { pack, expires: Date.now() + CACHE_TTL_MS });
  return pack;
}

// ── Bridge to the US-1712 decoder engine ────────────────────────────────────

/**
 * Convert a pack's DB decoder rows into runnable DecoderSpecs. A brand_style_codes
 * row's extraction_rules jsonb holds { fieldMap, transforms?, confidence? }. Rows
 * without a pattern or fieldMap are skipped (unusable). When the pack has no
 * usable DB decoders, decodeTagCode() falls back to the in-code DEFAULT specs.
 */
export function decoderSpecsFromPack(pack: BrandKnowledgePack): DecoderSpec[] {
  const specs: DecoderSpec[] = [];
  for (const d of pack.decoders) {
    if (!d.pattern) continue;
    const rules = (d.extractionRules ?? {}) as {
      fieldMap?: Record<string, string>;
      transforms?: Record<string, string>;
      canonicalFrom?: string[];
      confidence?: number;
    };
    if (!rules.fieldMap || Object.keys(rules.fieldMap).length === 0) continue;
    specs.push({
      brandKey: pack.key,
      decoderKind: d.decoderKind,
      pattern: d.pattern,
      fieldMap: rules.fieldMap as Record<string, keyof DecodeResult>,
      transforms: rules.transforms as
        | Partial<Record<string, TransformId>>
        | undefined,
      // US-2714: without this the DB path yields no canonicalCode, and the DB
      // path is the one production uses — decodeTagCode ignores the in-code
      // defaults entirely once a brand has seeded specs.
      canonicalFrom: Array.isArray(rules.canonicalFrom)
        ? rules.canonicalFrom.filter((g): g is string => typeof g === "string")
        : undefined,
      confidence: typeof rules.confidence === "number" ? rules.confidence : 0.8,
    });
  }
  return specs;
}

// ── Compact prompt block (injected into the extract prompt, US-1713) ────────

/**
 * Render a brand pack as a compact, prompt-injectable block that GROUNDS the
 * AI's identification in real reference knowledge. Returns "" when the pack has
 * nothing useful to add (no styles / decoders / colorways / tells) so the
 * extract prompt stays byte-identical to today when there is no knowledge for a
 * brand — the regression guarantee.
 */
export function brandPackPromptBlock(pack: BrandKnowledgePack | null): string {
  if (!pack) return "";
  const lines: string[] = [];

  if (pack.styles.length > 0) {
    lines.push(
      `KNOWN ${pack.brand} STYLES — use the visual fingerprint to disambiguate ` +
        `lookalikes; identify the named style ONLY when the evidence fits, never invent:`,
    );
    for (const s of pack.styles) {
      const bits = [s.styleName];
      if (s.productLine) bits.push(`(line: ${s.productLine})`);
      if (s.visualFingerprint) bits.push(`— ${s.visualFingerprint}`);
      if (s.fabricTech.length) {
        bits.push(`[fabric: ${s.fabricTech.join(", ")}]`);
      }
      lines.push(`- ${bits.join(" ")}`);
    }
  }

  if (pack.decoders.length > 0) {
    const kinds = pack.decoders
      .map((d) => d.description || d.decoderKind)
      .join("; ");
    lines.push(
      `${pack.brand} encodes identity on the tag (${kinds}). If a style/size ` +
        `code is legible, transcribe it VERBATIM into style_code so it can be decoded.`,
    );
  }

  if (pack.colorways.length > 0) {
    lines.push(
      `${pack.brand} named colorways (map the observed color to the closest when ` +
        `it clearly matches): ${
          pack.colorways.map((c) => c.colorName).join(", ")
        }`,
    );
  }

  if (pack.authenticationTells.length > 0) {
    lines.push(
      `Authentication note (informational only — NEVER assert authenticity): ` +
        `${pack.brand} has known tells; flag anything inconsistent in condition_notes.`,
    );
  }

  if (lines.length === 0) return "";
  return `BRAND KNOWLEDGE for ${pack.brand} (grounded reference — prefer it over ` +
    `guessing, but the photos/tag still win on what is actually present):\n` +
    lines.join("\n");
}
