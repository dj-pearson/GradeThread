// Structured-data (JSON-LD) linter (US-1681).
//
// A build/CI guard so pSEO templates can't ship broken schema.org markup at
// scale. It validates the JSON-LD objects our builders emit (src/lib/seo/
// json-ld.ts + the page builders) against a small set of per-@type invariants:
// required properties, a valid schema.org @context, no undefined/NaN leaking
// through, and the Product/itemCondition/PropertyValue + Rating shape the
// certificate pages depend on.
//
// It is NOT a full schema.org validator — it's a targeted guardrail for the
// node types GradeThread actually emits, and it runs on EVERY registered route's
// JSON-LD plus representative dynamic (cert/passport/blog) nodes in
// src/lib/seo/__tests__/jsonld-schema-lint.test.ts. A violation fails CI.
//
// Adding a new @type? See vault/40-growth/seo-technical-guards.md — add a checker to
// TYPE_CHECKERS below and a case to the test's node fixtures.

export type JsonLdNode = Record<string, unknown>;

const VALID_ITEM_CONDITIONS = new Set([
  "https://schema.org/NewCondition",
  "https://schema.org/UsedCondition",
  "https://schema.org/RefurbishedCondition",
  "https://schema.org/DamagedCondition",
]);

/** Require that each key is present and non-empty (string) / non-null. */
function requireKeys(node: JsonLdNode, keys: string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const v = node[k];
    if (v === undefined || v === null) {
      out.push(`missing required property "${k}"`);
    } else if (typeof v === "string" && v.trim() === "") {
      out.push(`property "${k}" is an empty string`);
    } else if (Array.isArray(v) && v.length === 0) {
      out.push(`property "${k}" is an empty array`);
    }
  }
  return out;
}

/** Deep-scan for values that must never appear in emitted JSON-LD. */
function scanBadValues(value: unknown, path: string): string[] {
  const out: string[] = [];
  if (value === undefined) {
    out.push(`undefined value at ${path}`);
  } else if (typeof value === "number" && !Number.isFinite(value)) {
    out.push(`non-finite number at ${path}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...scanBadValues(v, `${path}[${i}]`)));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(...scanBadValues(v, `${path}.${k}`));
    }
  }
  return out;
}

function checkProduct(n: JsonLdNode): string[] {
  const out = requireKeys(n, ["name", "itemCondition"]);
  if (
    typeof n.itemCondition === "string" &&
    !VALID_ITEM_CONDITIONS.has(n.itemCondition)
  ) {
    out.push(`itemCondition "${n.itemCondition}" is not a schema.org OfferItemCondition`);
  }
  // additionalProperty (the GradeThread grade) — if present, a valid PropertyValue.
  const ap = n.additionalProperty as JsonLdNode | undefined;
  if (ap) {
    if (ap["@type"] !== "PropertyValue") {
      out.push("additionalProperty must be a PropertyValue");
    }
    out.push(...requireKeys(ap, ["name", "value"]));
    if (typeof ap.value !== "number" || !Number.isFinite(ap.value)) {
      out.push("additionalProperty.value must be a finite number");
    }
  }
  // review Rating (if present) must be bounded + numeric.
  const review = n.review as JsonLdNode | undefined;
  if (review) {
    const rr = review.reviewRating as JsonLdNode | undefined;
    if (!rr) {
      out.push("review is missing reviewRating");
    } else {
      const rv = rr.ratingValue;
      if (typeof rv !== "number" || !Number.isFinite(rv)) {
        out.push("reviewRating.ratingValue must be a finite number");
      }
    }
  }
  return out;
}

function checkHasDefinedTerms(n: JsonLdNode): string[] {
  const out = requireKeys(n, ["name", "hasDefinedTerm"]);
  const terms = n.hasDefinedTerm;
  if (Array.isArray(terms)) {
    terms.forEach((t, i) => {
      const term = t as JsonLdNode;
      if (term["@type"] !== "DefinedTerm") {
        out.push(`hasDefinedTerm[${i}] must be a DefinedTerm`);
      }
      if (!term.name) out.push(`hasDefinedTerm[${i}] missing name`);
      if (!term.inDefinedTermSet) {
        out.push(`hasDefinedTerm[${i}] missing inDefinedTermSet`);
      }
    });
  }
  return out;
}

// Per-@type required-property checkers. Only the types GradeThread emits.
const TYPE_CHECKERS: Record<string, (n: JsonLdNode) => string[]> = {
  Organization: (n) => requireKeys(n, ["name", "url"]),
  WebSite: (n) => requireKeys(n, ["name", "url"]),
  // offers is recommended, not required (the FlipDesk overview omits it; the
  // conversion landing pages include it). Validate it only when present.
  SoftwareApplication: (n) => {
    const out = requireKeys(n, ["name", "applicationCategory"]);
    if ("offers" in n && (n.offers === null || typeof n.offers !== "object")) {
      out.push("offers, when present, must be an Offer/AggregateOffer object");
    }
    return out;
  },
  Article: (n) => requireKeys(n, ["headline", "author", "publisher", "datePublished"]),
  TechArticle: (n) => requireKeys(n, ["headline"]),
  HowTo: (n) => requireKeys(n, ["name", "step"]),
  FAQPage: (n) => requireKeys(n, ["mainEntity"]),
  BreadcrumbList: (n) => requireKeys(n, ["itemListElement"]),
  Dataset: (n) => requireKeys(n, ["name", "description"]),
  AboutPage: (n) => requireKeys(n, ["name"]),
  ProfilePage: (n) => requireKeys(n, ["url"]),
  Person: (n) => requireKeys(n, ["name"]),
  DefinedTerm: (n) => requireKeys(n, ["name", "inDefinedTermSet"]),
  DefinedTermSet: checkHasDefinedTerms,
  Product: checkProduct,
};

/** Lint a single top-level JSON-LD node. Returns human-readable violations. */
export function lintJsonLdNode(node: JsonLdNode): string[] {
  const out: string[] = [];
  const type = node["@type"];
  const label = typeof type === "string" ? type : JSON.stringify(type);

  if (node["@context"] !== "https://schema.org") {
    out.push(`@context must be "https://schema.org" (got ${JSON.stringify(node["@context"])})`);
  }
  if (typeof type !== "string" || type.trim() === "") {
    out.push("missing or invalid @type");
  }
  out.push(...scanBadValues(node, label));

  const checker = typeof type === "string" ? TYPE_CHECKERS[type] : undefined;
  if (checker) out.push(...checker(node));

  return out.map((v) => `[${label}] ${v}`);
}

/** Lint an array of top-level JSON-LD nodes (one route's structured data). */
export function lintJsonLd(nodes: JsonLdNode[]): string[] {
  return nodes.flatMap((n) => lintJsonLdNode(n));
}

/** The @types this linter knows how to check (for coverage assertions). */
export const LINTED_TYPES = Object.keys(TYPE_CHECKERS);
