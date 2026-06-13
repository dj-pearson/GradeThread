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

// A SELECTION_ONLY aspect WITH a non-empty allowed list is the only case where
// a value can be "invalid" — everything else (FREE_TEXT / SUGGESTED / a
// SELECTION_ONLY aspect eBay returned no values for) accepts free text.
function isClosedList(spec: ReconcileSpec): boolean {
  return (
    spec.mode === "SELECTION_ONLY" &&
    Array.isArray(spec.allowedValues) &&
    spec.allowedValues.filter((v) => v && v.trim().length > 0).length > 0
  );
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
    const values = (rawValues ?? []).filter((v) => v && v.trim().length > 0);
    if (values.length === 0) continue;

    const spec = idx.get(looseName(name));
    if (!spec || !isClosedList(spec)) {
      // Unknown name or free-text aspect — pass through as today.
      aspects[name] = values;
      continue;
    }

    const kept: string[] = [];
    const drop: string[] = [];
    for (const v of values) {
      const norm = normalizeAspectValue(v, {
        name: spec.name,
        mode: spec.mode,
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
