// US-3335: the eval that decides whether reference anchors may serve live
// grades. The golden set is graded twice with the SAME prompts and the same
// per-image reads, once without anchors and once with them; the only
// difference between the two composite calls is the anchors. Its verdict is
// persisted to system_settings.reference_anchor_eval, which
// referenceAnchorsActive() reads: no pass, no anchors, whatever the flag says.
//
// A case whose category has no eligible awards (after dropping its own
// submission's photos) cannot say anything about anchors and is left out of
// the comparison. Fewer than REFERENCE_ANCHOR_EVAL_MIN_CASES comparable cases
// is a fail, not a pass on thin evidence.
//
// Both legs suppress the live exemplar block (US-1643) so exemplars cannot
// confound the comparison.

import { supabaseAdmin } from "./supabase.ts";
import { bustSettingCache } from "./system-settings.ts";
import { analyzeImage, compositeGrade, type GarmentInfo, type PerImageAnalysis } from "./ai-grading.ts";
import { downloadCaseImage } from "./grading-eval.ts";
import {
  type AnchorEvalRecord,
  loadReferenceAnchors,
  REFERENCE_ANCHOR_EVAL_MIN_CASES,
  REFERENCE_ANCHOR_EVAL_SETTING,
} from "./reference-anchors.ts";

/** One case scored both ways. `on` is null when the case had no anchors. */
export interface AnchorEvalCase {
  case_id: string;
  garment_category: string;
  expected: number;
  off: number | null;
  on: number | null;
  anchors: number;
  failed_reason?: string;
}

const AGREE_WITHIN = 0.5;

/** Pure: the verdict from scored cases. */
export function summarizeAnchorEval(
  cases: readonly AnchorEvalCase[],
  minCases: number = REFERENCE_ANCHOR_EVAL_MIN_CASES,
): AnchorEvalRecord & { reason: string } {
  const both = cases.filter((c) => c.off !== null && c.on !== null && c.anchors > 0);
  const n = both.length;
  const mae = (k: "off" | "on") =>
    n === 0 ? null : both.reduce((s, c) => s + Math.abs((c[k] as number) - c.expected), 0) / n;
  const agree = (k: "off" | "on") =>
    n === 0 ? null : both.filter((c) => Math.abs((c[k] as number) - c.expected) <= AGREE_WITHIN).length / n;
  const r = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);
  const maeOff = r(mae("off"));
  const maeOn = r(mae("on"));
  const agreeOff = r(agree("off"));
  const agreeOn = r(agree("on"));

  let passed = false;
  let reason: string;
  if (n < minCases) {
    reason = `Only ${n} golden case(s) had reference photos for their category; ${minCases} are needed.`;
  } else if ((maeOn as number) > (maeOff as number)) {
    reason = `Anchors made the average error worse (${maeOn} vs ${maeOff}).`;
  } else if ((agreeOn as number) < (agreeOff as number)) {
    reason = `Anchors lowered agreement (${agreeOn} vs ${agreeOff}).`;
  } else {
    passed = true;
    reason = `Anchors did no worse on ${n} cases (error ${maeOn} vs ${maeOff}, agreement ${agreeOn} vs ${agreeOff}).`;
  }
  return {
    passed,
    reason,
    cases_with_anchors: n,
    mae_off: maeOff,
    mae_on: maeOn,
    agreement_off: agreeOff,
    agreement_on: agreeOn,
  };
}

interface CaseRow {
  id: string;
  label: string;
  garment_type: string;
  garment_category: string;
  brand: string | null;
  description: string | null;
  style_attributes: string[] | null;
  images: Array<{ image_type: string; storage_path: string }> | null;
  expected_score: number;
}

/**
 * Run the golden set with and without anchors, persist the verdict, and
 * return it. Costs real vision calls: one per-image pass per case plus two
 * composite calls per comparable case.
 */
export async function runReferenceAnchorEval(
  triggeredBy: string | null,
): Promise<AnchorEvalRecord & { reason: string; cases: AnchorEvalCase[] }> {
  const { data, error } = await supabaseAdmin
    .from("grading_eval_cases")
    .select("id, label, garment_type, garment_category, brand, description, style_attributes, images, expected_score")
    .eq("is_active", true)
    .is("deleted_at", null);
  if (error) throw new Error(`Failed to load eval cases: ${error.message}`);
  const rows = (data ?? []) as CaseRow[];
  if (rows.length === 0) throw new Error("No active eval cases. Add golden cases before running the anchor eval.");

  const cases: AnchorEvalCase[] = [];
  for (const row of rows) {
    const images = Array.isArray(row.images) ? row.images : [];
    const base: AnchorEvalCase = {
      case_id: row.id,
      garment_category: row.garment_category,
      expected: Number(row.expected_score),
      off: null,
      on: null,
      anchors: 0,
    };
    try {
      const anchors = await loadReferenceAnchors(
        row.garment_category,
        images.map((i) => i.storage_path),
      );
      if (anchors.length === 0) {
        cases.push({ ...base, failed_reason: "no reference photos for this category" });
        continue;
      }
      const styleHint = Array.isArray(row.style_attributes) ? row.style_attributes : [];
      const perImage: PerImageAnalysis[] = [];
      for (const img of images) {
        const dl = await downloadCaseImage(img.storage_path);
        if ("error" in dl) throw new Error(`${img.storage_path}: ${dl.error}`);
        perImage.push(
          await analyzeImage(dl.dataUri, img.image_type, row.garment_type, row.garment_category, styleHint),
        );
      }
      const garmentInfo: GarmentInfo = {
        garment_type: row.garment_type,
        garment_category: row.garment_category,
        brand: row.brand,
        title: row.label,
        description: row.description,
        style_attributes: styleHint,
      };
      // Same prompts, same per-image reads; the ONLY difference is the anchors.
      const off = await compositeGrade(perImage, garmentInfo, undefined, undefined, undefined, "", [], true);
      const on = await compositeGrade(
        perImage, garmentInfo, undefined, undefined, undefined, "", [], true,
        "", false, false, anchors,
      );
      cases.push({ ...base, off: off.overall_score, on: on.overall_score, anchors: anchors.length });
    } catch (err) {
      cases.push({ ...base, failed_reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const verdict = summarizeAnchorEval(cases);
  const record = { ...verdict, ran_at: new Date().toISOString(), triggered_by: triggeredBy };
  const { error: saveErr } = await supabaseAdmin
    .from("system_settings")
    .upsert(
      { key: REFERENCE_ANCHOR_EVAL_SETTING, value: record, value_type: "json", updated_by: triggeredBy },
      { onConflict: "key" },
    );
  if (saveErr) throw new Error(`Eval ran but its verdict could not be saved: ${saveErr.message}`);
  bustSettingCache(REFERENCE_ANCHOR_EVAL_SETTING);
  return { ...record, cases };
}
