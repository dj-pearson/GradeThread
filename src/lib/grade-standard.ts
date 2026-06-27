// The GradeThread Standard — the published, versioned open grade-field spec
// (US-1284). This is the frontend mirror of the edge embedding helper
// (services/edge-functions/src/lib/gt-grade-standard.ts): the two define the
// SAME canonical field (version, name, propertyID), one for emitting it onto
// listings (edge) and one for publishing + documenting it (here). Keep the
// version + field name in sync across both.
//
// The spec is published on the public /grading-standard page and as a stable
// JSON Schema at /grade-standard.schema.json, and is linked from the page's
// JSON-LD so partners can discover + cite the field. It describes an OPEN
// specification only — it makes no claim that any third party has adopted it.

import { SITE_URL } from "@/lib/seo/public-routes";
import type { JsonLd } from "@/lib/seo/json-ld";

/** Bumped only on a breaking change to the field shape. Mirrors the edge const. */
export const GRADE_STANDARD_VERSION = "1.0";

/** Fixed dates (never a build timestamp) so prerender + SPA stay byte-identical. */
export const GRADE_STANDARD_PUBLISHED = "2026-06-26";
export const GRADE_STANDARD_MODIFIED = "2026-06-26";

/** The canonical machine-readable field name partners ingest. */
export const GRADE_FIELD_NAME = "GradeThread Grade";

/** eBay item-specific (aspect) key carrying the grade in the spec table. */
export const GRADE_ITEM_SPECIFIC = "Condition Grade";

/** The public, versioned open-spec page. */
export const GRADE_STANDARD_SPEC_URL = `${SITE_URL}/grading-standard`;

/** The stable, citable JSON Schema for the grade field (static asset). */
export const GRADE_STANDARD_SCHEMA_URL = `${SITE_URL}/grade-standard.schema.json`;

/** Stable propertyID a partner keys on (matches the schema.org PropertyValue). */
export const GRADE_FIELD_PROPERTY_ID = `${GRADE_STANDARD_SPEC_URL}#grade`;

const ORG_ID = `${SITE_URL}/#organization`;

/**
 * A worked example of the canonical GT Grade field as a schema.org
 * PropertyValue (additionalProperty) — exactly what a partner would attach to a
 * Product/Offer to carry a GradeThread grade. Deterministic example values.
 */
export function gradeFieldExample(): Record<string, unknown> {
  return {
    "@type": "PropertyValue",
    propertyID: GRADE_FIELD_PROPERTY_ID,
    name: GRADE_FIELD_NAME,
    value: 8,
    minValue: 1,
    maxValue: 10,
    alternateName: "Excellent",
    url: `${SITE_URL}/cert/EXAMPLE`,
    valueReference: {
      "@type": "DefinedTerm",
      inDefinedTermSet: GRADE_STANDARD_SPEC_URL,
    },
  };
}

/**
 * The open grade-field specification, modelled as a schema.org TechArticle that
 * documents the field + links to its JSON Schema and a worked PropertyValue
 * example. This is the node that makes the GT Grade a discoverable, citable,
 * machine-ingestible field — emitted on /grading-standard alongside the FAQ.
 * Deterministic (fixed dates, static example) so prerender + SPA structured data
 * stay byte-identical (US-423 parity test).
 */
export function gradeStandardSpecJsonLd(): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    "@id": `${GRADE_STANDARD_SPEC_URL}#grade-field-spec`,
    name: "The GradeThread Standard — Open Grade-Field Specification",
    headline: "The GradeThread Standard — Open Grade-Field Specification",
    description:
      "An open, versioned specification for embedding a GradeThread condition grade in any listing as a machine-readable field: the 1.0–10.0 grade on the published rubric, its tier, and its verifiable certificate, expressed as a schema.org PropertyValue (additionalProperty). Free to implement; describes the open standard only.",
    url: GRADE_STANDARD_SPEC_URL,
    version: GRADE_STANDARD_VERSION,
    schemaVersion: GRADE_STANDARD_VERSION,
    datePublished: GRADE_STANDARD_PUBLISHED,
    dateModified: GRADE_STANDARD_MODIFIED,
    author: { "@id": ORG_ID },
    publisher: { "@id": ORG_ID },
    isAccessibleForFree: true,
    license: "https://creativecommons.org/licenses/by/4.0/",
    keywords: [
      "GradeThread Grade",
      "clothing condition grade field",
      "open grading standard",
      "schema.org additionalProperty",
      "machine-readable condition grade",
    ],
    about: {
      "@type": "DefinedTerm",
      name: GRADE_FIELD_NAME,
      description:
        "A pre-owned garment's standardized condition grade on the GradeThread 1.0–10.0 scale, mapped to a named tier and backed by a verifiable certificate.",
      url: GRADE_FIELD_PROPERTY_ID,
      inDefinedTermSet: GRADE_STANDARD_SPEC_URL,
    },
    // The machine-readable artifacts: the JSON Schema + a worked example.
    associatedMedia: {
      "@type": "MediaObject",
      name: "GradeThread Grade field JSON Schema",
      encodingFormat: "application/schema+json",
      contentUrl: GRADE_STANDARD_SCHEMA_URL,
    },
    hasPart: gradeFieldExample(),
    mainEntityOfPage: { "@type": "WebPage", "@id": GRADE_STANDARD_SPEC_URL },
  };
}
