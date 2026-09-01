// US-828: aspect reconciliation against the category spec — at GENERATION time
// (AutoLister) and at PUBLISH time (eBay push).
//
// The pipeline already constrains item-specifics NAMES to the category and runs
// a second AI pass (extractEbayAspects) to constrain VALUES. But two holes
// remained:
//   1. When the second pass fails, the fallback filtered first-pass aspects BY
//      NAME only — a SELECTION_ONLY aspect could still carry a value eBay won't
//      accept ("Poly" instead of "Polyester"), surfacing only as a silent
//      publish-time omission.
//   2. Invented aspect names (not in the category spec) were either silently
//      dropped or pushed to eBay and ignored, with nothing telling the seller.
//   3. eBay's NUMBER-typed aspects (aspectConstraint.aspectDataType) were
//      treated as free text, because mode is FREE_TEXT for them. A descriptive
//      value in one ("Fabric Weight: Midweight") fails the ENTIRE publish with
//      25002 "must be greater than 0. Enter up to 1 number after the decimal."
//
// This module closes both. It validates every generated aspect NAME and VALUE
// against the cached category spec, routes near-miss SELECTION_ONLY values
// through the US-823 normalizer, and reports what couldn't be matched so it's
// kept VISIBLY as needs-review on the draft (generation) or logged + surfaced
// in the publish diagnostics (publish) — never silently lost.
//
// Two entry points, one philosophy, different last-mile behavior:
//   • reconcileGeneratedAspects — KEEPS unmatched values (flags them) so the
//     seller can fix them in the composer before publishing.
//   • reconcilePublishAspects — OMITS unmatched SELECTION_ONLY values (eBay
//     would reject them) and returns diagnostics so the client can say
//     "X was not sent".

import { normalizeAspectValue } from "./aspect-normalize.ts";
import type { EbayAspectSpec } from "./ai-extract.ts";

/** Minimal aspect-spec shape the reconciler needs (a subset of EbayAspectSpec). */
export interface ReconcileSpec {
  name: string;
  mode: string; // "SELECTION_ONLY" | "SUGGESTED" | "FREE_TEXT"
  allowedValues?: string[];
  /**
   * eBay's `aspectConstraint.aspectDataType` — "STRING" (default) | "NUMBER" |
   * "DATE". A NUMBER aspect is FREE_TEXT as far as mode goes, but eBay parses
   * the value as a number and rejects the whole publish when it can't
   * ("Fabric weight must be greater than 0. Enter up to 1 number after the
   * decimal." — errorId 25002).
   */
  dataType?: string;
}

export type AspectReviewReason = "unknown_aspect" | "unmatched_value";

/** One aspect (or one set of values) that couldn't be matched to the spec. */
export interface AspectReviewEntry {
  /** The (generated) aspect name. */
  aspect: string;
  /** The original value(s) that couldn't be matched. */
  values: string[];
  reason: AspectReviewReason;
}

export interface GeneratedReconcileResult {
  /**
   * The reconciled aspect map: SELECTION_ONLY near-misses normalized to eBay's
   * allowed value, valid values kept, and unmatched values/aspects KEPT (not
   * dropped) so nothing disappears silently before the seller can review it.
   */
  aspects: Record<string, string[]>;
  /** Aspects/values needing a human look (drives the draft needs-review UI). */
  review: AspectReviewEntry[];
}

/** Adapt an EbayAspectSpec[] (the generation-side shape) to ReconcileSpec[]. */
export function specsFromEbayAspectSpecs(specs: EbayAspectSpec[]): ReconcileSpec[] {
  return specs.map((s) => ({
    name: s.name,
    mode: s.mode,
    allowedValues: s.allowedValues,
    dataType: s.dataType,
  }));
}

// Case/punctuation-insensitive key so "Size Type" / "size-type" collapse and a
// generated name matches the spec's canonical display name.
function looseName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildSpecIndex(specs: ReconcileSpec[]): Map<string, ReconcileSpec> {
  const idx = new Map<string, ReconcileSpec>();
  for (const s of specs) {
    const key = looseName(s.name ?? "");
    if (key) idx.set(key, s);
  }
  return idx;
}

/**
 * eBay's standardized size enforcement (developer notice, rollout by site from
 * 2026-08-31 through 2026-10-20; US 2026-09-22): Apparel and Footwear listings
 * must carry eBay's own values for the size aspects, and a custom value is
 * rejected at publish with "The product aspects for this category no longer
 * support custom values for Size Type." The Taxonomy payload we cache for a
 * category can be up to a month old, so its aspectMode for Size / Size Type
 * may still read SUGGESTED or FREE_TEXT after eBay closed the list. The name
 * is the durable signal: any aspect whose name carries "size" is treated as a
 * closed list whenever eBay shipped values for it, whatever the cached mode.
 */
export function isSizeAspect(name: string | null | undefined): boolean {
  return looseName(name ?? "").includes("size");
}

function hasAllowedValues(spec: ReconcileSpec): boolean {
  return (
    Array.isArray(spec.allowedValues) &&
    spec.allowedValues.filter((v) => v && v.trim().length > 0).length > 0
  );
}

// A SELECTION_ONLY aspect WITH a non-empty allowed list is where a value can be
// "invalid" — everything else (FREE_TEXT / SUGGESTED / a SELECTION_ONLY aspect
// eBay returned no values for) accepts free text. The one exception is the
// size family above, which eBay now enforces regardless of the mode it reports.
function isClosedList(spec: ReconcileSpec): boolean {
  if (!hasAllowedValues(spec)) return false;
  return spec.mode === "SELECTION_ONLY" || isSizeAspect(spec.name);
}

/** eBay parses this aspect's value as a number, not a string. */
function isNumericSpec(spec: ReconcileSpec): boolean {
  return (spec.dataType ?? "").toUpperCase() === "NUMBER";
}

// ONE numeric token, optionally wrapped in unit/label text: "16", "16.5",
// "5,5", "16 oz", "oz 16", "8.5 oz/yd²". A second number ("16-18", "5 to 7")
// is deliberately NOT matched — a range has no single value eBay can take, and
// silently sending half of it would misdescribe the garment.
// The sign is captured (not swallowed by the prefix) so "-2" stays negative and
// is rejected below rather than publishing as "2".
const SINGLE_NUMBER_RE = /^[^\d+-]*([+-]?\d+(?:[.,]\d+)?)[^\d]*$/;

/**
 * Coerce a stored aspect value into the plain positive number eBay's NUMBER
 * aspects require, or null when it isn't one.
 *
 * eBay rejects the ENTIRE publish (25002) when a NUMBER aspect carries text it
 * can't parse, so this runs at both chokepoints. What it accepts:
 *   • "16", "16.5"          → unchanged
 *   • "16 oz", "8.5 oz/yd²" → the unit is stripped (eBay wants the bare number;
 *                             the unit rides its own aspect when the category
 *                             has one)
 *   • "5,5"                 → decimal comma normalized
 *   • "16.75"               → rounded to "16.8" (eBay: "up to 1 number after
 *                             the decimal")
 * What it rejects (→ caller omits/flags the value rather than eating a 400):
 *   • descriptive weights: "Midweight", "Heavy"
 *   • ranges: "16-18"
 *   • zero/negative: "0", "-2" (eBay: "must be greater than 0")
 */
export function coerceNumericAspectValue(raw: string): string | null {
  const m = (raw ?? "").trim().match(SINGLE_NUMBER_RE);
  if (!m?.[1]) return null;
  const n = Number.parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(n)) return null;
  // One decimal place max — anything finer is rounded, not dropped, so a
  // legitimate measurement still publishes.
  const rounded = Math.round(n * 10) / 10;
  if (!(rounded > 0)) return null;
  return String(rounded);
}

/**
 * GENERATION-time reconciliation. Validates the AI-generated aspect map against
 * the resolved category spec:
 *   • aspect not in the spec        → kept, flagged `unknown_aspect`
 *   • SELECTION_ONLY closed-list    → each value normalized (US-823); matched
 *                                     values replaced with eBay's canonical
 *                                     spelling, unmatched values KEPT + the
 *                                     aspect flagged `unmatched_value`
 *   • free-text / suggested aspects → passed through untouched
 *
 * Nothing is dropped — the goal is to surface problems on the draft, not to
 * quietly discard the seller's data.
 */
export function reconcileGeneratedAspects(
  generated: Record<string, string[]>,
  specs: ReconcileSpec[],
): GeneratedReconcileResult {
  const idx = buildSpecIndex(specs);
  const aspects: Record<string, string[]> = {};
  const review: AspectReviewEntry[] = [];

  for (const [name, rawValues] of Object.entries(generated)) {
    const values = (rawValues ?? []).filter((v) => v && v.trim().length > 0);
    if (values.length === 0) continue;

    const spec = idx.get(looseName(name));
    if (!spec) {
      // Not a valid aspect for this category. Keep it visible + flag it rather
      // than silently dropping the model's work.
      aspects[name] = values;
      review.push({ aspect: name, values: [...values], reason: "unknown_aspect" });
      continue;
    }

    if (isNumericSpec(spec)) {
      // Numeric aspect: repair what we can ("16 oz" → "16"), KEEP what we
      // can't ("Midweight") and flag it, same contract as a SELECTION_ONLY
      // near-miss — the seller fixes it in the composer before publish.
      const resolved: string[] = [];
      const unmatched: string[] = [];
      for (const v of values) {
        const num = coerceNumericAspectValue(v);
        const keep = num ?? v;
        if (num == null) unmatched.push(v);
        if (!resolved.includes(keep)) resolved.push(keep);
      }
      aspects[spec.name] = resolved;
      if (unmatched.length > 0) {
        review.push({ aspect: spec.name, values: unmatched, reason: "unmatched_value" });
      }
      continue;
    }

    if (!isClosedList(spec)) {
      // Free text — eBay accepts whatever the model wrote.
      aspects[name] = values;
      continue;
    }

    const resolved: string[] = [];
    const unmatched: string[] = [];
    for (const v of values) {
      const norm = normalizeAspectValue(v, {
        name: spec.name,
        mode: spec.mode,
        allowedValues: spec.allowedValues,
      });
      if (norm != null) {
        if (!resolved.includes(norm)) resolved.push(norm);
      } else {
        unmatched.push(v);
        if (!resolved.includes(v)) resolved.push(v); // keep — don't drop
      }
    }
    aspects[spec.name] = resolved;
    if (unmatched.length > 0) {
      review.push({ aspect: spec.name, values: unmatched, reason: "unmatched_value" });
    }
  }

  return { aspects, review };
}

/** One aspect/value the publish path declined to send to eBay. */
export interface PublishAspectDiagnostic {
  aspect: string;
  /** The value(s) omitted from the eBay payload (value-validation failures). */
  omittedValues: string[];
  reason: AspectReviewReason;
}

export interface PublishReconcileResult {
  /** The sanitized aspect map safe to send to eBay. */
  aspects: Record<string, string[]>;
  /** What was omitted, so the client can surface "X was not sent". */
  omitted: PublishAspectDiagnostic[];
}

/**
 * US-1505: `item_specifics_override` / `ebay_aspects` have historically been
 * persisted BOTH string-valued (`{Fit:"Slim"}` — iOS `saveDraft` + the
 * server template overlay) AND array-valued (`{Fit:["Slim"]}` — the AutoLister
 * / column-projection paths). Every edge consumer types them
 * `Record<string, string[]>` and calls array methods (`.filter`, spreads). A
 * string value reaching `reconcilePublishAspects`' `(rawValues ?? []).filter`
 * threw a `TypeError` the publish path masked as "Could not load eBay specifics
 * for this category" — a retry-forever dead end. Coerce any persisted map to
 * `string[]` values at the read boundary so legacy string-valued rows publish
 * and revise correctly. Drops empty/blank values so it never introduces an
 * aspect eBay would reject.
 */
export function normalizeAspectMap(
  map: Record<string, unknown> | null | undefined,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!map || typeof map !== "object") return out;
  for (const [name, raw] of Object.entries(map)) {
    if (raw == null) continue;
    const arr = Array.isArray(raw) ? raw : [raw];
    const values: string[] = [];
    for (const v of arr) {
      if (v == null) continue;
      const s = String(v).trim();
      if (s.length > 0 && !values.includes(s)) values.push(s);
    }
    if (values.length > 0) out[name] = values;
  }
  return out;
}

/**
 * PUBLISH-time reconciliation. Unlike the generation path, an invalid
 * SELECTION_ONLY value is OMITTED here — eBay would reject it — but near-misses
 * are first normalized through US-823, so a value the seller never fixed still
 * publishes when it's an unambiguous synonym. Every omission is returned as a
 * diagnostic (and logged by the caller).
 *
 * Conservative on names: aspects with no matching spec are passed through
 * unchanged (eBay ignores unknown aspects without failing the publish), so this
 * only ever omits for VALUE-validation reasons — matching AC3 precisely.
 */
export function reconcilePublishAspects(
  aspectMap: Record<string, string[]>,
  specs: ReconcileSpec[],
): PublishReconcileResult {
  const idx = buildSpecIndex(specs);
  const aspects: Record<string, string[]> = {};
  const omitted: PublishAspectDiagnostic[] = [];

  for (const [name, rawValues] of Object.entries(aspectMap)) {
    // Defensive: DB rows may carry a bare string (US-1505) rather than string[].
    // Coerce before filtering so a legacy `{Fit:"Slim"}` never throws here.
    const rawArr = Array.isArray(rawValues)
      ? rawValues
      : rawValues == null
        ? []
        : [rawValues as string];
    const values = rawArr
      .map((v) => (v == null ? "" : String(v)))
      .filter((v) => v.trim().length > 0);
    if (values.length === 0) continue;

    const spec = idx.get(looseName(name));
    if (spec && isNumericSpec(spec)) {
      // eBay parses this one as a number and fails the WHOLE publish (25002:
      // "… must be greater than 0. Enter up to 1 number after the decimal.")
      // when it can't. Send the coerced number; omit + diagnose anything that
      // isn't one, so one unparseable specific costs the seller that specific
      // instead of the listing.
      const kept: string[] = [];
      const drop: string[] = [];
      for (const v of values) {
        const num = coerceNumericAspectValue(v);
        if (num == null) drop.push(v);
        else if (!kept.includes(num)) kept.push(num);
      }
      if (kept.length > 0) aspects[spec.name] = kept;
      if (drop.length > 0) {
        omitted.push({ aspect: spec.name, omittedValues: drop, reason: "unmatched_value" });
      }
      continue;
    }
    if (!spec || !isClosedList(spec)) {
      // Unknown name or free-text aspect — pass through as today.
      aspects[name] = values;
      continue;
    }

    const kept: string[] = [];
    const drop: string[] = [];
    for (const v of values) {
      // The list is closed here (mode, or the size family): the normalizer
      // must refuse a miss rather than hand the raw value back.
      const norm = normalizeAspectValue(v, {
        name: spec.name,
        mode: "SELECTION_ONLY",
        allowedValues: spec.allowedValues,
      });
      if (norm != null) {
        if (!kept.includes(norm)) kept.push(norm);
      } else {
        drop.push(v);
      }
    }
    if (kept.length > 0) aspects[spec.name] = kept;
    if (drop.length > 0) {
      omitted.push({ aspect: spec.name, omittedValues: drop, reason: "unmatched_value" });
    }
  }

  return { aspects, omitted };
}
