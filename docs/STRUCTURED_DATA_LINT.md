# Structured-data (JSON-LD) lint — runbook (US-1681)

pSEO templates emit JSON-LD at scale (glossary DefinedTerms, garment guides,
certificates). One broken template = broken markup on hundreds of pages. This
guard validates the schema.org JSON-LD our builders emit and **fails CI** on any
violation.

## What runs

- **`src/lib/seo/jsonld-lint.ts`** — the linter. `lintJsonLdNode(node)` returns
  human-readable violations; `lintJsonLd(nodes)` lints an array (one route's
  structured data). It checks: a valid `@context`/`@type`, no `undefined` or
  non-finite numbers leaking through, and per-`@type` required properties —
  including the Product `itemCondition` (a real `OfferItemCondition`) +
  `additionalProperty` PropertyValue + bounded Rating shape the certificates use.
- **`src/lib/seo/__tests__/jsonld-schema-lint.test.ts`** — runs the linter over
  **every registered route's** JSON-LD (via `jsonLdForRoute`) plus the dynamic
  certificate + passport Product nodes, asserts zero violations, asserts the AC's
  required types are actually covered, and includes negative controls so the
  linter can't silently become a no-op.

CI runs the vitest suite before the build/deploy gate, so a broken node blocks
the release.

## When it fails

The message is `[<@type>] <what's wrong>`, e.g.
`[Product] itemCondition "https://schema.org/BananaCondition" is not a schema.org
OfferItemCondition` or `[Article] missing required property "datePublished"`.
Fix the emitting builder in `src/lib/seo/json-ld.ts` or the page's builder in
`src/pages/marketing/marketing-jsonld.ts` — don't loosen the linter to make a
real gap pass.

## Adding a new @type

1. Add a checker to `TYPE_CHECKERS` in `jsonld-lint.ts` (use `requireKeys(...)`
   for required props; add value-shape checks like `checkProduct` does when a
   property has structure that matters).
2. If the new type is emitted on a route, the route iteration in the test already
   covers it. If it's a dynamic node (like cert/passport), add a fixture case to
   the test.
3. If it's one of the AC's headline types, add it to the "covers the AC's
   required schema types" assertion so coverage is enforced.

## Scope

This is a **targeted** guardrail for the node types GradeThread actually emits,
not a full schema.org validator. It catches the failure modes that bite at pSEO
scale: missing required props, empty/undefined values, wrong enum URLs, and
malformed Product/Rating markup. For a one-off external audit, paste a rendered
page into Google's Rich Results Test.
