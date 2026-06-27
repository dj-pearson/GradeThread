// The GradeThread Standard — canonical, machine-readable GT Grade field (US-1284).
//
// One published, versioned way to embed a GradeThread condition grade in any
// listing, on any marketplace, so other people's listings can cite "GradeThread
// 8.0" the way card listings cite PSA. This module is the single source of truth
// for the field FORMAT; every cross-listing adapter (eBay / Shopify / Depop …)
// embeds the grade through these helpers so the wire shape can't drift between
// platforms.
//
// The open spec that documents this field for partners is published at
// GT_GRADE_SPEC_URL (the public /grading-standard page) and as a JSON Schema at
// GT_GRADE_SCHEMA_URL. The frontend mirror of these constants lives in
// src/lib/grade-standard.ts — keep the version + field names in sync.
//
// Pure (no env / no supabase / no I/O) so it unit-tests directly and can be
// imported from any adapter without the env dance.

/** Bumped only on a breaking change to the field shape. */
export const GT_GRADE_STANDARD_VERSION = "1.0";

/** The canonical machine-readable field name partners ingest. */
export const GT_GRADE_FIELD_NAME = "GradeThread Grade";

/** eBay item-specific (aspect) key carrying the grade in the spec table. */
export const GT_GRADE_ITEM_SPECIFIC = "Condition Grade";

const SITE_ORIGIN = "https://gradethread.com";

/** Public, versioned open-spec page documenting this field. */
export const GT_GRADE_SPEC_URL = `${SITE_ORIGIN}/grading-standard`;

/** Stable JSON Schema for the grade field (served as a static asset). */
export const GT_GRADE_SCHEMA_URL = `${SITE_ORIGIN}/grade-standard.schema.json`;

/** Stable propertyID a partner can key on (matches the schema.org PropertyValue). */
export const GT_GRADE_PROPERTY_ID = `${GT_GRADE_SPEC_URL}#grade`;

export interface GtGradeFieldInput {
  /** The overall 1.0–10.0 grade. */
  grade: number;
  /** Named tier, e.g. "Excellent" (optional). */
  tier?: string | null;
  /** PSA-style certificate number, e.g. "GT-ABC123" (optional). */
  certNumber?: string | null;
  /** Public certificate URL, e.g. https://gradethread.com/cert/<id> (optional). */
  certUrl?: string | null;
}

/** The resolved, canonical GT Grade field. */
export interface GtGradeField {
  standard: "gradethread";
  version: string;
  /** Grade as a string, one decimal: "8.0". */
  grade: string;
  /** Numeric grade. */
  gradeValue: number;
  scaleMin: 1;
  scaleMax: 10;
  tier: string | null;
  certNumber: string | null;
  certUrl: string | null;
  specUrl: string;
}

/** One-decimal grade string ("8" -> "8.0"). */
export function formatGtGrade(grade: number): string {
  return grade.toFixed(1);
}

/** Resolve raw item data into the canonical field object. */
export function buildGtGradeField(input: GtGradeFieldInput): GtGradeField {
  return {
    standard: "gradethread",
    version: GT_GRADE_STANDARD_VERSION,
    grade: formatGtGrade(input.grade),
    gradeValue: input.grade,
    scaleMin: 1,
    scaleMax: 10,
    tier: input.tier?.trim() ? input.tier.trim() : null,
    certNumber: input.certNumber?.trim() ? input.certNumber.trim() : null,
    certUrl: input.certUrl?.trim() ? input.certUrl.trim() : null,
    specUrl: GT_GRADE_SPEC_URL,
  };
}

/**
 * Human-readable, documented one-liner used in listing copy. Stable enough to
 * be parsed back out by partners: "GradeThread Grade <n>/10 (<tier>) · Cert
 * #<num>". `includeCertUrl` adds the verify URL — pass false on eBay, which
 * bans off-site links (the listing would be hidden).
 */
export function gtGradeCitation(
  field: GtGradeField,
  opts?: { includeCertUrl?: boolean },
): string {
  const parts = [`${GT_GRADE_FIELD_NAME} ${field.grade}/10`];
  if (field.tier) parts[0] += ` (${field.tier})`;
  if (field.certNumber) parts.push(`Cert #${field.certNumber}`);
  if (opts?.includeCertUrl && field.certUrl) parts.push(`Verify: ${field.certUrl}`);
  parts.push(field.specUrl.replace(/^https?:\/\//, ""));
  return parts.join(" · ");
}

/**
 * The schema.org PropertyValue (additionalProperty) for the grade — the
 * machine-readable field a partner's structured data ingests. The same shape is
 * documented by the open spec + JSON Schema.
 */
export function gtGradePropertyValue(
  field: GtGradeField,
): Record<string, unknown> {
  const node: Record<string, unknown> = {
    "@type": "PropertyValue",
    propertyID: GT_GRADE_PROPERTY_ID,
    name: GT_GRADE_FIELD_NAME,
    value: field.gradeValue,
    minValue: field.scaleMin,
    maxValue: field.scaleMax,
    ...(field.tier ? { alternateName: field.tier } : {}),
    ...(field.certNumber ? { identifier: field.certNumber } : {}),
    ...(field.certUrl ? { url: field.certUrl } : {}),
    valueReference: { "@type": "DefinedTerm", inDefinedTermSet: field.specUrl },
  };
  return node;
}

/**
 * A stable, documented, parseable marker carrying the canonical field as JSON,
 * for partners that scrape listing text. Wrapped in fixed delimiters so it can
 * be extracted regardless of surrounding copy. Single-line (no newlines inside)
 * so it survives platforms that collapse whitespace.
 */
export function gtGradeMarker(field: GtGradeField): string {
  const payload = {
    standard: field.standard,
    version: field.version,
    grade: field.gradeValue,
    scaleMin: field.scaleMin,
    scaleMax: field.scaleMax,
    tier: field.tier,
    cert: field.certNumber,
    certUrl: field.certUrl,
    spec: field.specUrl,
  };
  return `[gradethread-grade]${JSON.stringify(payload)}[/gradethread-grade]`;
}

/**
 * Append the consistent GT Grade block (human line + machine-readable marker)
 * to a listing description, idempotently. If the description already carries the
 * marker it's left untouched. `includeCertUrl` controls whether the verify URL
 * is shown (false for eBay).
 */
export function embedGtGradeBlock(
  description: string,
  field: GtGradeField,
  opts?: { includeCertUrl?: boolean },
): string {
  const base = (description ?? "").trim();
  if (base.includes("[gradethread-grade]")) return base;
  const line = gtGradeCitation(field, opts);
  const marker = gtGradeMarker(field);
  const block = `${line}\n${marker}`;
  return base ? `${base}\n\n${block}` : block;
}
