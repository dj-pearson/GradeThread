---
title: Ralph brand-KB working log
type: learning
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [agent, ralph, brands]
summary: Per-story record of applying the brand-KB rules; the rules themselves live in 20-domain/brands.
---

> [!info] This is the LOG. The RULES live in `20-domain/brands`.
> Reconciled 2026-07-19 (US-2061) against the rules extracted from the migration
> headers in US-2058. The two knowledge bases **agree** — the decoder bar, the
> Textile Act RN exclusion and the Reebok/adidas refusal appear in both.
>
> The split going forward:
>
> - **[[brand-kb-decoder-bar]] / [[brand-kb-alias-refusals]] /
>   [[brand-kb-negative-findings]]** — the rules, stated once.
> - **This file** — the per-story record of applying them (US-1717 onward).
>
> The reconciliation was not one-way. This log carried a rule the extracted
> notes had MISSED: a **parent-wide identifier can never attribute a sibling**
> (URBN's `OB######` clears all three tests and is still refused, because a hit
> would spell "Urban Outfitters" onto Anthropologie or Free People *with decoder
> authority, which outranks the AI on conflict*). That has been folded into
> [[brand-kb-decoder-bar]] as its fourth question.
>
> Do not restate a rule here. Link it.
# Ralph Learnings — Brand Knowledge Base

Read this IN ADDITION to LEARNINGS.md when your story is a Brand KB group story (US-1717…US-1733+) or touches brand_knowledge / brand_styles / brand_size_charts / brand_colorways.

## Brand KB group stories (US-1717…US-1733+)
- The next migration number is NOT "last brand-KB seed + 1", and the drift is
  SILENT: a merged/co-running non-KB branch can take the slot AND bump
  `EXPECTED_SCHEMA_VERSION` ahead of the KB run, so schema-version.ts already
  reads the number you were about to claim and looks "already done" — US-1984
  found 00463 held by `00463_social_video.sql` (renumbered by its own merge) and
  had to ship as 00464. ALWAYS `ls supabase/migrations` + read
  EXPECTED_SCHEMA_VERSION before naming the file; the comment above that constant
  names the migration it belongs to, which is the tell. Same merge also CLOBBERED
  the previous story's `PENDING_MIGRATIONS.md` section — check the held-migration
  list still documents every unapplied migration, not just yours.
- `PENDING_MIGRATIONS.md` DOES exist at the repo root and every brand-KB commit
  updates it — but the Bash tool's cwd PERSISTS across calls, so an `ls`/`find`
  for it run after a `cd services/edge-functions` reports "No such file" and reads
  as "the doc was removed / that bullet is stale". US-1987 nearly skipped the
  held-migration section on exactly that. Re-check from the repo root before
  concluding a root-level file is gone.
- A brand-group story ships FOUR things, not just the migration: the
  `NNNNN_*_brand_knowledge.sql` seed, any missing `BRAND_ALIASES` in
  `brand-normalize.ts` (a brand absent there PASSES THROUGH the seller's casing
  into the prompt + the eBay Brand aspect), the `sizing-charts.ts` in-code
  fallback charts, AND **two** test files — cases in
  `brand-knowledge-golden_test.ts` (resolver: recovery/never-guess/no-false-
  positive) plus a per-group `<group>-content_test.ts` (prompt block renders the
  disambiguation + `findSizingCharts` reachability). The content test is easy to
  miss; every prior group has one (`alo-yoga-`, `athleta-`, `free-people-`,
  `madewell-jcrew-`, `athleisure-content_test.ts`).
- A seeded `brand_style_codes` decoder must capture into **`styleCode`** or it
  recovers NOTHING: `enrichExtractionWithBrandKnowledge` keys brand recovery off
  `decoderHits.find((h) => h.styleCode)`, then spells the brand from `pack.brand`
  (so no `KEY_TO_CANONICAL` entry in brand-decoders.ts is needed). And every
  `fieldMap` target must be a REAL `DecodeResult` field (gender/styleCode/size/
  colorInitial/colorway/season/year) — `decoderSpecsFromPack` CASTS the jsonb, so
  a bogus target silently writes a phantom property nothing reads instead of
  failing. Put un-modellable extras (e.g. a HEATTECH warmth level) in a
  NON-capturing group. US-1739.
- The three pack RENDERERS carry DIFFERENT content, and seeding a fact into the
  wrong one makes it invisible: `brandPackPromptBlock` (extract) renders styles'
  `visualFingerprint` VERBATIM + decoders + colorways, but collapses every
  authentication tell to ONE GENERIC LINE — tell PROSE never reaches the extract
  prompt. Tells render only via `buildTrustedBrandFactsBlock` (garment-baselines,
  grading), which takes the FIRST FOUR only and hard-caps the block at 900 chars
  (so lead each row's tells with the important ones). `formatSizingChartsForPrompt`
  renders size LABELS + the note IN FULL, uncapped — it is the only uncapped
  channel. So a fact that must reach identification belongs in a fingerprint or a
  chart note, NOT a tell. US-1740.
- Tell PROSE has a FOURTH renderer, and it — not the grading block — is where
  authentication tells actually land: `normalizeTells`/`getEffectiveTells`
  (brand-authenticity.ts, US-1768) feeding the confidence-capped, human-review-gated
  ai-authenticity add-on. `coerceTell` maps the group-convention `{tell, detail}`
  shape onto the structured `{category, claim, check, redFlag}` one on READ, so keep
  seeding `{tell, detail}` (every migration 00443..00460 does). Corollary: do NOT
  "fix" `buildTrustedBrandFactsBlock` to hoist tells above fingerprints to make a
  never-auto-authenticate tell survive its 900-char cap — that block is for GRADING,
  it spends its budget on construction fingerprints ON PURPOSE, and tell truncation
  there is not the liability it looks like. Assert the guard via normalizeTells
  instead. US-1981.
- Inside the seed migrations' DOLLAR-quoted JSON (`$j$…$j$`, `$json$…$json$`),
  `''` is NOT an escape — it stays two literal apostrophes, so `men''s` ships as
  "men''s" in the seeded prose. Postgres applies no escaping in a dollar-quoted
  body; only the surrounding ordinary `'…'` SQL strings (the chart `note`, the
  identity blob) need `''`. Both conventions sit inches apart in the same row, so
  it's easy to over-escape by reflex — and NOTHING catches it: the SQL is valid,
  the JSON is valid, `verify:db` applies it clean, and the content tests match on
  substrings that miss it. Grep new seed migrations for `''` inside `$j$` blocks
  before committing. US-1981 (fixed 12 in 00460; 00455/00457/00459 were clean).
- `brandFromStyleFormat`'s formats are NOT brand-exclusive (Converse's classic
  codes are M+4 digits, same shape as New Balance model numbers) and
  `ai-listing.ts` takes `styleResolution?.brand ?? canonicalBrand` — so a format
  GUESS overrides the tag's own brand. US-1740 fixed the precedence (curated table
  > explicit sneaker brandHint > format inference). Adding a format here without
  checking which other brands share the shape re-opens a silent mis-branding.
- The US-1738 leading-boundary `brandTextMatches` has a standing bill: a CONCATENATED
  sub-label does NOT match its parent's short token ("babygap".indexOf("gap") is
  preceded by "y", a word char), so babyGap/GapKids/GapFit must be listed in
  `brandMatch` explicitly or they silently miss the parent's charts. Spaced forms
  ("Baby Gap") are fine. Check this for every short-token brand you seed. US-1739.
- Some brands are ALREADY covered by a SHARED multi-brand chart — the 00389
  `thenorthfacepatagoniaouterwear` row / its `sizing-charts.ts` twin matched
  north face+patagonia+columbia+arcteryx. Giving such a brand its OWN chart makes
  `findSizingCharts` return BOTH (same numbers twice, competing for the 3-chart
  prompt budget), so narrow the shared `brandMatch` in the SAME commit — in-code
  AND via an UPDATE of the DB row (US-1734 did this for columbia+arcteryx). Check
  for a shared chart before adding a per-brand one.
- `verified=false` is CORRECT and intentional on every seeded fact even though
  the AC says "marked verified before the story passes" — verification is the
  US-1715 human admin queue's job. Every prior group shipped verified=false; do
  not flip it to true to satisfy the AC (that fabricates a human review).
- ACCESSORY/BAG brands are NOT garment brands with different nouns, and two
  "missing" facts are STATUTORY/STRUCTURAL absences that must be seeded as
  REFUSALS, not logged as research gaps (US-1988, the first accessory group):
  (a) **an RN legitimately does not exist** — the Textile Act excludes handbags &
  luggage unless a fiber claim is made, so only a brand that ALSO sells RTW has one
  (Marc Jacobs did; the other eight don't). Absence must never read as a red flag,
  and the prior packs' "the FTC site is a JS shell" note is an ACCESS excuse that
  hides this. (b) **the style code left with the hangtag** — apparel prints it on
  the sewn care label (hence 00460/00467's cut-tag decoders), but a bag has no care
  label, so seed a decoder only where the mark is ON THE BODY (Coach's sewn creed
  patch, 00398; Fossil's metal case back, 00468). Beware the sourced-but-wrong RN:
  the FTC register's only "longchamp" hit is LONGCHAMP FABRICS CORP, an unrelated
  NYC fabric wholesaler — right string, real record, wrong company.
- Seed only what a source supports: `tag_eras` is populated for heritage brands
  (Levi's/Carhartt/Lululemon) but left EMPTY for modern athleisure (Alo/Athleta/
  Free People/US-1733's six) — no authoritative era documentation exists. Same
  rule for decoders: seed `brand_style_codes` ONLY for a code that is both
  tag-printed and regular (of US-1733's six, only Under Armour qualifies); a
  web/catalog SKU is an informational tell, never a decoder.
- `brandKey()` STRIPS ACCENTS (it keeps `[a-z0-9]` only), and `brand_key` =
  `brandKey(canonical_brand)` — so an accented canonical keys WEIRDLY and a row
  seeded under the spelling you'd expect is NEVER FOUND: "Hermès"→`herms`,
  "Céline"→`cline`, "Stüssy"→`stssy` (the 00389 precedent). Seed the row under the
  stripped key and alias BOTH spellings, or pick an unaccented canonical when the
  brand itself is unaccented (US-1982 made Celine unaccented — the house dropped
  the accent in 2018 — and kept `Hermès`/`herms`). Check with
  `deno eval` on `brandKey(canonicalizeBrand(x))` before writing the seed.
- The accent trap has a SECOND half that bites in BRAND_ALIASES, not just the
  seed: `brandKey()` DELETES the accented char rather than folding it to ASCII, so
  the accented and unaccented spellings are DIFFERENT keys — "Aimé Leon Dore" →
  `aimleondore` (no e!) but "Aime Leon Dore" → `aimeleondore`. Sellers type both,
  so BOTH keys must be in the alias map or the one who bothers with the accent gets
  a passthrough. It looks like a duplicate line and is not. (Hermès dodged this:
  `herms` vs `hermes` are visibly different, so 00461 noticed. US-1983.)
- A canonical VALUE that is an ordinary word has NO protection, even though an
  ordinary-word alias KEY is safe: `CANONICAL_BRANDS` is built from BRAND_ALIASES'
  VALUES and `detectBrandInText` regex-scans those over prose, while the KEY side is
  an exact whole-field lookup (the "ag"/"spider"/"ch" play). The word-boundary guard
  can't save a value like "Off-White" — an off-white garment's title contains the
  brand name EXACTLY — and longest-first ordering makes the false positive BEAT the
  real brand in the same string. Fix (US-1983): `DETECT_EXCLUDED_FROM_TEXT` in
  brand-normalize.ts, filtered out of CANONICAL_BRANDS — the brand stays reachable
  by TAG (canonicalizeBrand, which is what the eBay aspect/comp filter read) but is
  never guessed from prose. Opt-in and additive; it does NOT fix the Gucci GG
  Supreme→Supreme case (we WANT Supreme detected — that needs a positional rule).
- Reuse an EXISTING decoder transform by choosing the capture BOUNDARY, not by
  adding code: `genderCode` only maps `W`/`M`, so Off-White's `OM`/`OW` prefix
  captures the SECOND character (`^(?<code>O(?<gender>[MW])…`) and maps to Men/Women
  for free. Capturing "OM" whole would fall through the transform's table and emit
  the raw "OM" as a gender. Check TRANSFORMS' actual lookup tables before assuming a
  new one is needed. Also note `decodeTagCode(brandKey, raw, specs)` takes THREE args
  (brandKey first) — calling it (raw, specs) silently returns null for everything.
- `python3` does not exist on this host but `python` does (3.13 + pglast v8.2) — so
  when Docker is down and `verify:db` can't run, the 00461-style static validation
  (real PostgreSQL parser: parses / column-count vs every tuple / names + conflict
  targets resolve against the DDL / no duplicate conflict key in one VALUES list)
  IS available; just don't invoke it as `python3`. Related: the Bash tool eats one
  level of backslashes, so a `new RegExp("\\$j\\$")` built in a `node -e '…'`
  one-liner silently becomes `/$j$/` and matches NOTHING — write the script to a
  file instead of debugging a phantom zero-match. CORRECTION (US-1985): a quoted
  `<<'EOF'` HEREDOC eats them too — "write it to a file" only works via the Write
  TOOL. And the failure is SILENT-SUCCESS, not an error: a vacuous scan finds 0
  blocks and prints "no problems", so it reads as a clean bill of health. Any
  throwaway validator must be SELF-TESTED against a planted bug (`--selftest` that
  breaks one block and asserts the scanner goes red) before you trust a green run
  — US-1985 shipped two vacuous scans in a row before catching it.
  **STOP REBUILDING IT (US-1988): the validator is now COMMITTED** as
  `scripts/ralph/validate-seed-sql.py` (pglast parse + tuple-arity vs column list
  + duplicate on-conflict key + `''`-inside-`$j$` + JSON validity; prints what it
  scanned). Run `python scripts/ralph/validate-seed-sql.py --selftest <seed.sql>`
  (plants all 3 bug classes, asserts each is caught) then the bare form. A FOURTH
  way to fake a green: the Bash tool rewrites `/tmp/x` in ARGV but NOT inside a
  heredoc's string literals, so a `python - <<EOF` that writes `/tmp/bug.sql`
  dies FileNotFound while the validator invoked on `/tmp/bug.sql` happily reads
  the CLEAN copy — three "planted" bugs all printed OK. Plant via the Write tool
  or a repo-relative path, and never accept a self-test that prints no PLANT step.
- A brand that sells BOTH shoes and clothes under one name (US-1985's Fila/PUMA/
  Reebok — the first in the epic) owns TWO charts on one `brand_key`, and
  `category_match` is the ONLY thing choosing between them: a stamped US/UK/EU
  shoe number vs an alpha chest letter, read in OPPOSITE directions (a shoe chart
  TRANSLATES, a garment chart ESTIMATES). A miss silently hands a hoodie a shoe
  chart. Keep the two brands' category lists tight + non-overlapping, name the
  system in `garment` so the model sees which it got, and remember `category_match`
  is a plain SUBSTRING test (deliberately) — so a `boot` token fires on `bootcut`.
- A sub-label an ORDER OF MAGNITUDE below its parent gets its OWN canonical and
  must NOT fold onto the parent (the AGOLDE/Miu Miu rule) — folding it silently
  retitles the cheap piece as the parent and prices it against mainline via the
  eBay Brand aspect. Fold only same-price-band labels (Fire+Ice→Bogner, the MK
  play). US-1982: Versace Jeans Couture / Versus / Collection each got their own
  canonical. Safe even though they contain the parent's name — CANONICAL_BRANDS is
  sorted LONGEST-FIRST, so `detectBrandInText` tests the sub-label first.
- Tag-printed + regular is NOT sufficient for a decoder — the FORMAT must also be
  brand-unique, and the older luxury rows mislead on this. 00399 seeds an
  informational LV `date_code`, which reads as a licence to decode any serial;
  it survives only because `SD1160` (2 letters + 4 digits) is distinctive. A bare
  digit run is an ordinary number, so Chanel's 7-8 digit serial is deliberately
  decoder-less (US-1736) — a pattern over it mints the KB's costliest false
  positive from any tag with 8 digits. Same rule as Lee's "101"; put the era fact
  in `tag_eras`/`authentication_tells` instead, which is where it belongs anyway.
- A PARENT-WIDE identifier can never attribute a SIBLING, and this kills decoders
  that clear every other bar. URBN's `OB######` style number is primary-sourced
  (its own vendor manual) AND tag-printed AND regular — and US-1986 still seeded no
  decoder for it, because the code is URBN-wide and Anthropologie (00457) + Free
  People (00449) already own packs, so a hit would spell "Urban Outfitters" onto a
  sibling with DECODER authority (which outranks the AI on conflict). Same for the
  shared RN 66170. It is US-1985's Reebok refusal (the format was adidas's) in a new
  costume: before seeding a decoder/RN, ask WHICH ENTITY the identifier names, not
  just whether it's regular. Record it in `registered_numbers`/`tag_eras` with the
  can't-disambiguate caveat instead.
- For fast-fashion/mall brands the brand's OWN size guide is usually 403 to
  automated fetches (zara.com, hm.com, express.com, pacsun.com all were in
  US-1986) — and the SEO/aggregator pages that fill the gap are where FABRICATED
  charts live. Every "Brandy Melville size chart" on the open web traces to
  scraper spam; the brand publishes none. This is the KB's worst failure mode
  because a model RECALLS exactly those numbers, so a seeded fabrication reads as
  confirmation. Use the `confidence` column honestly (US-1986 ships 0.85 for a
  brand-published chart down to 0.5 where none exists) and say IN THE NOTE that the
  numbers are not the brand's own. Corollary: widely-repeated brand "facts" are
  often UNCITED-Wikipedia laundered into prose — US-1986 found Talbots' real ranges
  (2-18 / 0P-16P / 14W-26W) contradict the universally-repeated ones, and Lucky's
  "two four-leaf clovers on the fly shield" has no source at all. Fetch the primary
  document or seed the refusal; never seed recall.
- `canonicalizeBrand` returns `string | null` (NOT an object) — assert
  `canonicalizeBrand("x") === "Brand"`; `isKnownBrand` is what separates a
  curated entry from a passthrough.
- A SHORT brand token is a live hazard, and the two matchers differ:
  `sizing-charts.ts` `findSizingCharts` matches `brandMatch` by SUBSTRING
  (`brand.includes(m)`) and `detectBrandInText` regex-scans CANONICAL_BRANDS over
  free text — so a 2-3 letter entry false-fires (`"patagonia".includes("ag")` is
  TRUE, so a bare `"ag"` hands every Patagonia garment AG's denim charts).
  `BRAND_ALIASES` is an EXACT-key lookup, so the short form is safe THERE. Fix
  (US-1735): make the canonical the long form ("AG Jeans"), keep the short form as
  an alias key only, and never put it in `brandMatch` — the chart is then reached
  via the canonical, which is what brand-knowledge.ts passes anyway.
- The substring rule bites a SECOND way (US-1737): a diffusion label whose name
  CONTAINS its mainline's ("Fear of God Essentials" ⊃ "Fear of God") inherits the
  mainline's charts, and no narrowing can fix it — there is no token unique to the
  shorter name. DB charts are safe (fetched by exact `brand_key`); only the
  in-code fallback collides. Give the chart to the brand that actually has sourced
  sizing and leave the other chartless (it falls through to the generics, as
  Coach/LV/Gucci do) — and assert it, so a later chart addition fails loudly.
- `sizing-charts.ts` `norm()` only LOWERCASES — it does NOT strip accents, while
  `brandKey()` strips everything non-`[a-z0-9]`. So Stüssy's KB key is `stssy`
  (00389 seeded it that way — do not "correct" it, the resolver re-derives the
  same key at read time) but its `brandMatch` needs the ACCENTED `"stüssy"` to
  match the canonical brand-knowledge.ts passes in; include the plain spelling too
  for raw seller text. Only non-ASCII canonical in the KB.
- `detectBrandInText` sorts CANONICAL_BRANDS LONGEST-FIRST, which is what makes a
  contained-name pair safe (it tests "Fear of God Essentials" before "Fear of
  God"). But length is a proxy for specificity, not specificity: "Gucci GG
  Supreme" (Gucci's canvas, 00400) mis-detects as **Supreme**, because "Supreme"
  is longer than "Gucci". Pre-existing, barcode-title path only, NOT fixed by
  US-1737 — a positional (earliest-match) rule would fix it but changes a shared
  matcher for every brand. Corollary you CAN use: listing a containing brand in
  BRAND_ALIASES is PROTECTIVE — US-1738 added `vincecamuto: "Vince Camuto"` so
  detectBrandInText tests it before the "Vince" it contains.
- `findSizingCharts` no longer matches `brandMatch` by bare substring (US-1738):
  it requires the token to START a word (`brandTextMatches`, `\p{L}`-based). The
  bug that forced it: `"eileen fisher".includes("lee")` is TRUE ("ei-LEE-n"), so
  Lee's DENIM charts fired on every Eileen Fisher garment. UNFIXABLE in data — any
  brandMatch still matching its own canonical "lee" is also a substring of
  "eileen". The boundary is LEADING-ONLY on purpose: a trailing letter is
  load-bearing ("Burberrys" = "Burberry"+s must still reach Burberry's charts;
  a both-sides boundary broke `luxury-content_test.ts`). This does NOT rescue a
  genuine leading-word collision — "vince camuto" still matches "vince" — so the
  omit-the-shorter-brand's-chart remedy below still applies. Category matching
  stays a plain substring test on purpose.
- The DB and in-code chart lookups DIFFER, and US-1738 is the first story to
  exploit it: `brand_size_charts` is fetched by EXACT `brand_key` (safe), while
  `findSizingCharts` matches `brand_match` as a leading-word substring (leaks onto
  a longer brand name). So a brand whose name PREFIXES an unrelated brand's can be
  given a DB chart and deliberately NO in-code mirror — Vince gets its chart while
  "Vince Camuto" (a DIFFERENT COMPANY, not a diffusion line) correctly falls to
  the generics. Prefer this over dropping the chart entirely.
- A retailer's HOUSE LABELS (Aritzia's Wilfred/Babaton/TNA, Anthropologie's
  Maeve/Pilcro/Moth) print their OWN name and never the parent's — the tag does
  not say the brand. Fold them onto the parent canonical with the label in `style`
  (the MK precedent) when they share a PRICE BAND; split into separate canonicals
  (the Fear of God/AGOLDE precedent) only when they are an order of magnitude
  apart. Folding also keeps short tokens ("tna") out of CANONICAL_BRANDS. Watch
  for ordinary-word labels: "moth" is a garment-DAMAGE term the product's own
  condition text emits constantly, so it must never be an alias.
- HERITAGE/WORKWEAR (US-1989, 00469): for this tier the TAG IS THE ASSET — the
  interior label ERA is the price driver, so the pack's weight goes to `tag_eras`,
  and empty `tag_eras` is CORRECT for a modern catalogue brand (Duluth Trading
  1989 / Orvis) — the athleisure call, do not invent a chronology. The ONE decoder
  is Barbour's interior-label `[ML](WX|QU|CA|KN|TN|…)\d{4}` (MWX0018 = Bedale) —
  the Canada Goose department-letter case: a bare "0018" is refused, the M/L
  prefix makes it brand-unique; capture styleCode, don't map M/L to gender. The
  boot brands' household-name model numbers (Dickies 874, Red Wing 875, Timberland
  10061) are REFUSED as bare digit runs. NEW COLLISION seeded as a refusal: a bare
  "duluth" is DULUTH PACK (est. 1882), NOT Duluth Trading — alias only the
  two-word forms (the Longchamp-Fabrics trap). And "Red Wing" went into
  DETECT_EXCLUDED_FROM_TEXT ("Detroit Red Wings"/the blackbird). RN refused (not
  faked) even though these ARE textiles — no registrant sourced.


## Related

- [[brand-kb-decoder-bar]] — the rules this log records applying
- [[brand-taxonomy-overview]] — the value/rule split
- [[ralph-learnings]] — the always-read playbook
