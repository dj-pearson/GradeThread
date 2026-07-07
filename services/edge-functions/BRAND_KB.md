# Brand & Style Knowledge Base — contributor guide

The KB grounds garment **brand / style / size** identification (AutoLister
extraction today; grading baselines next) in curated reference data instead of
the model's memory. This is how to add or correct a brand's knowledge.

## Architecture (where things live)

| Piece | File | Role |
|---|---|---|
| Schema | `supabase/migrations/00389_brand_knowledge_base.sql` | 5 tables: `brand_knowledge`, `brand_styles`, `brand_style_codes`, `brand_colorways`, `brand_size_charts` (global reference, deny-all RLS) |
| Resolver | `src/lib/brand-knowledge.ts` | `resolveBrandKnowledgePack(brand, {category})` — DB-first, falls back to the in-code seeds; returns a **compact, budgeted** pack for ONE brand |
| Decoders | `src/lib/brand-decoders.ts` | `decodeTagCode(brandKey, raw, specs)` — data-driven regex engine; `DEFAULT_DECODER_SPECS` are the in-code fallback |
| Enrichment | `src/lib/ai-extract.ts` | `enrichExtractionWithBrandKnowledge` — decoder-wins-on-conflict, confidence composition, conflict surfacing |
| Seeding gate | `src/lib/brand-seed.ts` | `validateBrandFact` / `partitionSeedFacts` — provenance enforcement |
| Golden gate | `src/tests/brand-knowledge-golden_test.ts` | fixture-driven recovery regression gate |

## Adding a brand (the US-1718+ flow: draft → verify → seed)

1. **Research** the brand from authoritative sources — official size charts,
   reseller authentication guides, style catalogs. Capture: canonical name +
   aliases, top resale styles with a *disambiguating visual fingerprint*, any
   regular tag-code format (→ a `brand_style_codes` decoder spec), named
   colorways, size charts (inches), and authentication tells.

2. **Provenance is mandatory.** Every seeded row carries `source_url` +
   `confidence` (0–1). Run facts through `partitionSeedFacts` — **unsourced or
   mis-scored facts are rejected, never stored.** A fact without a citation is a
   guess; the KB exists to beat guessing.

3. **Seed via a migration** (follow the `migrations` skill — idempotent /
   `EXPECTED_SCHEMA_VERSION` bump / self-record footer). Insert with
   `ON CONFLICT DO NOTHING`. Mark `verified=true` only for human-checked facts.

4. **Add golden fixtures** to `brand-knowledge-golden_test.ts` — at minimum a
   **cut-tag case** (no brand in the AI output, only a style code) asserting the
   brand is recovered. New brands *append* cases; they must not regress existing
   ones.

5. **Verify recovery:**
   ```
   deno test --allow-env --allow-net --allow-read \
     src/tests/brand-knowledge-golden_test.ts
   ```
   It prints `[brand-golden] recovery — <Brand>: n/m (x%) | mean confidence Δ`.

## Decoder specs (data-driven)

A `brand_style_codes` row is `{ decoder_kind, pattern (named-group regex),
extraction_rules: { fieldMap, transforms?, confidence } }`. Reuse existing
transforms (`genderCode`, `seasonCode`, `year2to4`, `upper`) where the format is
regular — that makes a new decoder a **data change**. Only a genuinely novel
encoding needs new transform code in `brand-decoders.ts`.

Anchor patterns strictly (`^…$`) so a malformed code returns **no match, never a
false positive**.

## Hard rules

- **Never auto-authenticate.** Luxury/streetwear packs surface authentication
  *tells* as informational flags only — a date code / serial proves nothing on
  its own. The pack must never assert a bag is genuine.
- **Never run `deno fmt` on an existing edge file.** This project does not run
  `deno fmt` in CI (verify:edge = lint / check / test) and existing files use a
  non-default style; formatting one reflows the whole file. Match local style by
  hand. New files may use any consistent style.
- Grading stays **label-as-reference**: the KB improves grading *accuracy* via
  baselines/tells (US-1717); it does not turn grading into a brand identifier.
