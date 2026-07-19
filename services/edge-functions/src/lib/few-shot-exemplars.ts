import { supabaseAdmin } from "./supabase.ts";
import { createVersionedCache } from "./coherent-cache.ts";

// ─── US-1067: few-shot exemplar cache from human-corrected grades ────────────
//
// The self-improvement loop already MEASURES where the AI is wrong (accuracy-
// tracking.ts) and grows the golden eval set from corrections (grading-eval.ts).
// This module closes the remaining gap: it MINES the highest-value corrected
// grades — flagged intentional-design misreads and large score corrections — into
// a curated, versioned, prompt-cached few-shot block the composite grading prompt
// can lean on, so the model gets distressed-denim / misread cases right WITHOUT a
// larger reasoning budget (cheaper + more accurate over time).
//
// PRIVACY (AC3): an exemplar carries ONLY non-identifying grading facts —
// garment category/type, the AI score, the human-corrected score, the misread
// flag, and a short generated rationale. NEVER reviewer free-text notes, owner
// identity, titles/descriptions (seller PII), or images. Nothing here can leave
// the tenant boundary because nothing tenant-identifying is ever selected.
//
// A set is INERT until it passes the grading-eval gate (evalExemplarSet) and is
// explicitly activated (activateExemplarSet). With no active set, getActive-
// ExemplarBlock returns "" and grading behaviour is unchanged.

// ─── Types ───────────────────────────────────────────────────────────────────

/** A correction worth mining, assembled from a review + its grade report +
 *  submission. Carries no PII (no notes, no owner, no free text). */
export interface CorrectionSignal {
  garment_category: string;
  garment_type: string;
  ai_overall_score: number;
  corrected_overall_score: number;
  intentional_misread: boolean;
  reviewed_at: string;
}

/** A curated, PII-free few-shot exemplar — exactly what is persisted + rendered. */
export interface GradingExemplar {
  garment_category: string;
  garment_type: string;
  ai_overall_score: number;
  corrected_overall_score: number;
  intentional_misread: boolean;
  // Generated, non-identifying one-liner describing the lesson (e.g. "AI graded
  // 4.0 but the correct grade was 8.0 — intentional distressing was misread as
  // damage; grade against the as-manufactured state").
  rationale: string;
}

export interface SelectExemplarsOptions {
  /** Minimum |corrected − ai| points for a non-misread correction to qualify. */
  minDelta?: number;
  /** Max exemplars retained per garment_category. */
  perCategoryCap?: number;
  /** Hard cap on total exemplars in the set (bounds the recurring token cost). */
  totalCap?: number;
}

export const DEFAULT_MIN_DELTA = 1.0;
export const DEFAULT_PER_CATEGORY_CAP = 4;
export const DEFAULT_TOTAL_CAP = 24;
/** US-1535: hard cap on the rendered block's token cost (AC4). */
export const MAX_EXEMPLAR_BLOCK_TOKENS = 1500;

/**
 * US-1535 (AC4): dedupe key for a correction — two corrections teaching the
 * SAME lesson (same category/type, same misread flag, same direction and
 * rounded magnitude) add tokens without adding signal; only the most recent
 * survives selection.
 */
export function correctionSignature(s: CorrectionSignal): string {
  const delta = s.corrected_overall_score - s.ai_overall_score;
  const dir = delta > 0 ? "+" : delta < 0 ? "-" : "0";
  return [
    s.garment_category,
    s.garment_type,
    s.intentional_misread ? "misread" : "delta",
    `${dir}${Math.abs(Math.round(delta))}`,
  ].join("|");
}

// ─── Pure selection + rendering (unit-tested, no DB) ─────────────────────────

/** A correction is high-signal if the reviewer flagged an intentional-design
 *  misread, or moved the overall score by at least minDelta points. Mirrors
 *  grading-eval.isHighSignalCorrection but operates on the assembled signal and
 *  is duplicated here deliberately to keep this module free of a static import
 *  cycle through ai-grading.ts. */
export function isHighSignalSignal(s: CorrectionSignal, minDelta: number): boolean {
  if (s.intentional_misread) return true;
  return Math.abs(s.corrected_overall_score - s.ai_overall_score) >= minDelta;
}

// Rank within a category: misreads first (the costliest failure mode), then by
// the magnitude of the correction (the biggest mistakes teach the most), then
// newest. Pure comparator so selection is deterministic + testable.
function correctionRank(a: CorrectionSignal, b: CorrectionSignal): number {
  if (a.intentional_misread !== b.intentional_misread) {
    return a.intentional_misread ? -1 : 1;
  }
  const da = Math.abs(a.corrected_overall_score - a.ai_overall_score);
  const db = Math.abs(b.corrected_overall_score - b.ai_overall_score);
  if (db !== da) return db - da;
  return b.reviewed_at.localeCompare(a.reviewed_at);
}

function buildRationale(s: CorrectionSignal): string {
  const delta = s.corrected_overall_score - s.ai_overall_score;
  if (s.intentional_misread) {
    return `AI graded ${s.ai_overall_score.toFixed(1)} but the correct grade was ` +
      `${s.corrected_overall_score.toFixed(1)} — intentional design (e.g. factory ` +
      `distressing, raw hem, acid wash) was misread as damage. Grade against the ` +
      `as-manufactured state.`;
  }
  const dir = delta > 0 ? "too harsh (under-graded)" : "too lenient (over-graded)";
  return `AI graded ${s.ai_overall_score.toFixed(1)} but the correct grade was ` +
    `${s.corrected_overall_score.toFixed(1)} — the AI was ${dir} by ` +
    `${Math.abs(delta).toFixed(1)} points for this ${s.garment_category}.`;
}

/**
 * Curate high-signal corrections into a capped, per-category-balanced exemplar
 * set. Pure: filters to high-signal, ranks within each category, keeps at most
 * perCategoryCap per category, then round-robins across categories up to
 * totalCap so no single noisy category dominates the block.
 */
export function selectExemplars(
  signals: CorrectionSignal[],
  options: SelectExemplarsOptions = {},
): GradingExemplar[] {
  const minDelta =
    Number.isFinite(options.minDelta) && (options.minDelta as number) > 0
      ? (options.minDelta as number)
      : DEFAULT_MIN_DELTA;
  const perCategoryCap =
    Number.isFinite(options.perCategoryCap) && (options.perCategoryCap as number) > 0
      ? Math.floor(options.perCategoryCap as number)
      : DEFAULT_PER_CATEGORY_CAP;
  const totalCap =
    Number.isFinite(options.totalCap) && (options.totalCap as number) > 0
      ? Math.floor(options.totalCap as number)
      : DEFAULT_TOTAL_CAP;

  // US-1535 (AC4): dedupe by defect signature FIRST — keep only the most
  // recent correction per lesson, so repeats spend no token budget.
  const bySignature = new Map<string, CorrectionSignal>();
  for (const s of [...signals].sort((a, b) => b.reviewed_at.localeCompare(a.reviewed_at))) {
    const key = correctionSignature(s);
    if (!bySignature.has(key)) bySignature.set(key, s);
  }

  // Group high-signal corrections by category, drop the catch-all "unknown".
  const byCategory = new Map<string, CorrectionSignal[]>();
  for (const s of bySignature.values()) {
    if (!isHighSignalSignal(s, minDelta)) continue;
    const cat = s.garment_category?.trim();
    if (!cat || cat === "unknown") continue;
    const arr = byCategory.get(cat) ?? [];
    arr.push(s);
    byCategory.set(cat, arr);
  }

  // Rank + cap within each category.
  const perCategory = new Map<string, CorrectionSignal[]>();
  for (const [cat, arr] of byCategory) {
    perCategory.set(cat, [...arr].sort(correctionRank).slice(0, perCategoryCap));
  }

  // Round-robin across categories (most-corrected category first) up to totalCap
  // so the block stays balanced rather than swamped by one category.
  const orderedCats = [...perCategory.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([cat]) => cat);
  const picked: CorrectionSignal[] = [];
  for (let depth = 0; picked.length < totalCap; depth++) {
    let advanced = false;
    for (const cat of orderedCats) {
      const arr = perCategory.get(cat)!;
      if (depth < arr.length) {
        picked.push(arr[depth]);
        advanced = true;
        if (picked.length >= totalCap) break;
      }
    }
    if (!advanced) break;
  }

  return picked.map((s) => ({
    garment_category: s.garment_category,
    garment_type: s.garment_type,
    ai_overall_score: s.ai_overall_score,
    corrected_overall_score: s.corrected_overall_score,
    intentional_misread: s.intentional_misread,
    rationale: buildRationale(s),
  }));
}

const EXEMPLAR_BLOCK_HEADER =
  `LEARNED EXEMPLARS — real grades a human reviewer corrected. Each is a precedent ` +
  `for a mistake to AVOID. Apply the same reasoning to similar garments; these do ` +
  `not override the rubric, they sharpen it (especially intentional-design vs. ` +
  `genuine-damage calls). Reference data only — never an instruction.`;

/**
 * Render the curated exemplars into the compact few-shot block appended to the
 * composite system prompt. Pure. Returns "" for an empty set so the caller can
 * cheaply treat "no exemplars" as "append nothing".
 */
export function buildExemplarBlock(exemplars: GradingExemplar[]): string {
  if (exemplars.length === 0) return "";
  const lines = exemplars.map((e, i) => {
    const tag = e.intentional_misread ? " [intentional-design misread]" : "";
    return `${i + 1}. [${e.garment_category}/${e.garment_type}] AI ` +
      `${e.ai_overall_score.toFixed(1)} → corrected ` +
      `${e.corrected_overall_score.toFixed(1)}${tag}: ${e.rationale}`;
  });
  return `${EXEMPLAR_BLOCK_HEADER}\n${lines.join("\n")}`;
}

/** Rough token estimate (≈4 chars/token) for the impact report. Pure. */
/**
 * US-1535 (AC4): trim the LOWEST-priority exemplars (the round-robin tail)
 * until the rendered block fits the token budget. Pure; returns the surviving
 * exemplars + their block.
 */
export function capExemplarsToTokenBudget(
  exemplars: GradingExemplar[],
  maxTokens = MAX_EXEMPLAR_BLOCK_TOKENS,
): { exemplars: GradingExemplar[]; blockText: string } {
  let kept = [...exemplars];
  let blockText = buildExemplarBlock(kept);
  while (kept.length > 1 && estimateTokens(blockText) > maxTokens) {
    kept = kept.slice(0, -1);
    blockText = buildExemplarBlock(kept);
  }
  return { exemplars: kept, blockText };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── DB assembly pipeline ────────────────────────────────────────────────────

// Bound the review scan so one assembly stays a single cheap query as the review
// corpus grows; the newest corrections are the ones worth mining.
const ASSEMBLY_SCAN_CAP = 2_000;

export interface AssembleExemplarSetOptions {
  versionName: string;
  /** NULL = global set; else scope the mined corrections to one category. */
  garmentCategory?: string | null;
  minDelta?: number;
  perCategoryCap?: number;
  totalCap?: number;
  /** Only mine reviews from the last N days (default 180). */
  sinceDays?: number;
  notes?: string | null;
  createdBy?: string | null;
}

export interface ExemplarSetRow {
  id: string;
  version_name: string;
  garment_category: string | null;
  exemplars: GradingExemplar[];
  block_text: string;
  exemplar_count: number;
  approx_tokens: number;
  source_review_count: number;
  status: string;
  eval_passed: boolean | null;
  eval_run_id: string | null;
  eval_mae: number | null;
  eval_agreement_rate: number | null;
  is_active: boolean;
}

/**
 * Mine recent human-corrected grades into a CANDIDATE exemplar set (inactive,
 * un-evaluated). Joins human_reviews → grade_reports → submissions to assemble
 * PII-free CorrectionSignals, curates them, renders the block, and persists it.
 * The set must pass evalExemplarSet + activateExemplarSet before it can affect
 * live grading.
 */
export async function assembleExemplarSet(
  opts: AssembleExemplarSetOptions,
): Promise<ExemplarSetRow> {
  const versionName = opts.versionName.trim();
  if (!versionName) throw new Error("versionName is required");
  const scope = opts.garmentCategory?.trim() || null;
  const sinceDays =
    Number.isFinite(opts.sinceDays) && (opts.sinceDays as number) > 0
      ? (opts.sinceDays as number)
      : 180;
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();

  // Pull corrected reviews. We deliberately select ONLY the corrected scores +
  // the misread flag — NOT review_notes (free text / PII).
  const { data: reviews, error: reviewsError } = await supabaseAdmin
    .from("human_reviews")
    .select("grade_report_id, original_score, adjusted_score, intentional_misread, reviewed_at")
    .gte("reviewed_at", since)
    .order("reviewed_at", { ascending: false })
    .limit(ASSEMBLY_SCAN_CAP);
  if (reviewsError) throw new Error(`Failed to scan reviews: ${reviewsError.message}`);

  const reviewRows = (reviews ?? []) as Array<{
    grade_report_id: string;
    original_score: number;
    adjusted_score: number | null;
    intentional_misread: boolean | null;
    reviewed_at: string;
  }>;

  // One report can have several reviews; newest-first query means the first time
  // we see a report id carries its latest correction.
  const seen = new Set<string>();
  const latestByReport = reviewRows.filter((r) => {
    if (seen.has(r.grade_report_id)) return false;
    seen.add(r.grade_report_id);
    return true;
  });

  // US-2034: EXCLUDE the golden set. TRAIN/TEST CONTAMINATION.
  //
  // Golden eval cases are grown from the same corrected reviews this function
  // mines (grading-eval.ts promoteGradeReportToEvalCase stores the origin in
  // grading_eval_cases.source_grade_report_id). Nothing prevented the SAME
  // corrected report from becoming both a golden case and a few-shot exemplar.
  //
  // That is not a cosmetic overlap: evalExemplarSet() gates a candidate exemplar
  // set against the golden set — so the model was shown the answers to the very
  // cases it was then scored on. The gate reports inflated agreement and
  // deflated MAE, an exemplar set that does not generalize gets activated, and
  // real customer garments are graded by a prompt whose measured quality was
  // fictitious. It also corrupts any published accuracy figure citing the same
  // thresholds.
  //
  // Exclude ALL golden sources, not just active cases: an inactive case may be
  // reactivated, and a set that was contaminated at assembly time cannot be
  // decontaminated later. For the same reason this deliberately does NOT filter
  // deleted_at (US-2037) — a soft-deleted case can be restored, and this is the
  // one read path where over-excluding is the safe direction.
  const { data: goldenSources, error: goldenError } = await supabaseAdmin
    .from("grading_eval_cases")
    .select("source_grade_report_id")
    .not("source_grade_report_id", "is", null);
  if (goldenError) {
    // Fail CLOSED. Assembling an exemplar set while unable to prove it is
    // uncontaminated would produce a number nobody can trust — and the whole
    // point of the gate is that its number can be trusted.
    throw new Error(
      `Failed to load golden-set sources for exemplar exclusion: ${goldenError.message}`,
    );
  }
  const goldenReportIds = new Set(
    ((goldenSources ?? []) as Array<{ source_grade_report_id: string | null }>)
      .map((g) => g.source_grade_report_id)
      .filter((id): id is string => !!id),
  );
  const uncontaminated = latestByReport.filter(
    (r) => !goldenReportIds.has(r.grade_report_id),
  );
  const excludedCount = latestByReport.length - uncontaminated.length;
  if (excludedCount > 0) {
    console.log(
      `[few-shot-exemplars] excluded ${excludedCount} golden-set report(s) from ` +
        `the exemplar pool (train/test separation)`,
    );
  }

  const signals: CorrectionSignal[] = [];
  if (uncontaminated.length > 0) {
    const reportIds = uncontaminated.map((r) => r.grade_report_id);
    const { data: reports, error: reportsError } = await supabaseAdmin
      .from("grade_reports")
      .select("id, overall_score, submission_id")
      .in("id", reportIds);
    if (reportsError) throw new Error(`Failed to fetch grade reports: ${reportsError.message}`);
    const reportById = new Map(
      ((reports ?? []) as Array<{ id: string; overall_score: number; submission_id: string }>)
        .map((r) => [r.id, r]),
    );

    const submissionIds = [...new Set([...reportById.values()].map((r) => r.submission_id))];
    // Only the non-identifying garment attributes — never title/description.
    const { data: subs, error: subsError } = await supabaseAdmin
      .from("submissions")
      .select("id, garment_type, garment_category")
      .in("id", submissionIds);
    if (subsError) throw new Error(`Failed to fetch submissions: ${subsError.message}`);
    const subById = new Map(
      ((subs ?? []) as Array<{ id: string; garment_type: string; garment_category: string }>)
        .map((s) => [s.id, s]),
    );

    for (const r of uncontaminated) {
      const report = reportById.get(r.grade_report_id);
      if (!report) continue;
      const sub = subById.get(report.submission_id);
      const category = sub?.garment_category ?? "unknown";
      if (scope && category !== scope) continue;
      signals.push({
        garment_category: category,
        garment_type: sub?.garment_type ?? "unknown",
        ai_overall_score: report.overall_score,
        corrected_overall_score: r.adjusted_score ?? r.original_score,
        intentional_misread: r.intentional_misread === true,
        reviewed_at: r.reviewed_at,
      });
    }
  }

  // US-1535: approved buyer-guarantee claims are confirmed "the grade was
  // wrong" signals (US-1113) — mine active claim signals in the same window as
  // additional corrections. corrected = ai + the claim's overall delta.
  const reviewSignalCount = signals.length;
  let claimSignalCount = 0;
  try {
    const { data: claimRows } = await supabaseAdmin
      .from("claim_accuracy_signals")
      .select("grade_report_id, garment_category, overall_delta, updated_at")
      .eq("active", true)
      .gte("updated_at", since)
      .limit(500);
    const claims = (claimRows ?? []) as Array<{
      grade_report_id: string;
      garment_category: string | null;
      overall_delta: number;
      updated_at: string;
    }>;
    const claimReportIds = claims
      .map((cl) => cl.grade_report_id)
      .filter((id) => !!id);
    if (claimReportIds.length > 0) {
      const { data: claimReports } = await supabaseAdmin
        .from("grade_reports")
        .select("id, overall_score")
        .in("id", claimReportIds);
      const scoreByReport = new Map(
        ((claimReports ?? []) as Array<{ id: string; overall_score: number }>)
          .map((r) => [r.id, r.overall_score]),
      );
      for (const cl of claims) {
        const ai = scoreByReport.get(cl.grade_report_id);
        const category = cl.garment_category?.trim() || "unknown";
        if (ai === undefined || cl.overall_delta === 0) continue;
        if (scope && category !== scope) continue;
        signals.push({
          garment_category: category,
          garment_type: "unknown",
          ai_overall_score: ai,
          corrected_overall_score: Math.max(1, Math.min(10, ai + cl.overall_delta)),
          intentional_misread: false,
          reviewed_at: cl.updated_at,
        });
        claimSignalCount++;
      }
    }
  } catch (err) {
    // Claim mining is additive — a failure just means a review-only set.
    console.error(
      "[few-shot-exemplars] claim-signal mining failed (continuing with reviews only):",
      err instanceof Error ? err.message : String(err),
    );
  }

  const selected = selectExemplars(signals, {
    minDelta: opts.minDelta,
    perCategoryCap: opts.perCategoryCap,
    totalCap: opts.totalCap,
  });
  // US-1535 (AC4): hard token budget on the rendered block.
  const { exemplars, blockText } = capExemplarsToTokenBudget(selected);

  // US-1535 (AC5): lineage — what fed this set. Prepended to the operator notes.
  const lineage =
    `sources: ${reviewSignalCount} review correction(s) + ${claimSignalCount} approved-claim signal(s), window ${sinceDays}d`;
  const notes = [lineage, opts.notes?.trim() || ""].filter(Boolean).join(" | ");

  const { data: inserted, error } = await supabaseAdmin
    .from("grading_exemplar_sets")
    .insert({
      version_name: versionName,
      garment_category: scope,
      exemplars,
      block_text: blockText,
      exemplar_count: exemplars.length,
      approx_tokens: estimateTokens(blockText),
      source_review_count: signals.length,
      status: "candidate",
      is_active: false,
      notes,
      created_by: opts.createdBy ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to persist exemplar set: ${error.message}`);
  return inserted as ExemplarSetRow;
}

// ─── Active-block resolution (the grade-time read path) ──────────────────────

// Version-stamped, cluster-coherent cache (mirrors the grading-prompt cache):
// activate/retire bumps the signal so every replica drops its entry within the
// micro-TTL instead of serving a stale block for a local TTL.
const EXEMPLAR_CACHE_SIGNAL = "grading-exemplars";
const exemplarCache = createVersionedCache<string>({
  signalKey: EXEMPLAR_CACHE_SIGNAL,
});

/** Invalidate the active-exemplar cache cluster-wide (called on activate/retire). */
export async function invalidateExemplarCache(): Promise<void> {
  await exemplarCache.invalidate();
}

/**
 * Resolve the active exemplar block for a garment category (the grade-time read).
 * Prefers a category-scoped active set, then the global (null-scope) set, then
 * "" (no active set → append nothing → grading unchanged). Cached + fail-safe: a
 * DB hiccup returns "" rather than failing the grade.
 */
export async function getActiveExemplarBlock(
  garmentCategory: string | null,
): Promise<string> {
  const cacheKey = garmentCategory?.trim() || "";
  return await exemplarCache.get(cacheKey, async () => {
    try {
      const { data, error } = await supabaseAdmin
        .from("grading_exemplar_sets")
        .select("garment_category, block_text")
        .eq("is_active", true);
      if (error || !Array.isArray(data)) return "";
      const rows = data as Array<{ garment_category: string | null; block_text: string }>;
      const scoped = cacheKey
        ? rows.find((r) => r.garment_category === cacheKey)
        : undefined;
      const global = rows.find((r) => !r.garment_category);
      const picked = scoped ?? global;
      return picked?.block_text ?? "";
    } catch {
      return "";
    }
  });
}

// ─── Eval gate + activation ──────────────────────────────────────────────────

export interface ExemplarEvalResult {
  set_id: string;
  version_name: string;
  garment_category: string | null;
  exemplar_count: number;
  // Impact report (AC2): the gate metrics WITH the block injected + the recurring
  // token cost of the block (amortized per grade by prompt caching).
  mean_absolute_error: number;
  agreement_rate: number;
  cases_total: number;
  cases_passed: number;
  passed: boolean;
  thresholds: { max_mae: number; min_agreement: number };
  block_tokens: number;
  per_tag: Record<string, unknown>;
}

/**
 * Gate an exemplar set through the SAME golden-set eval the prompt gate uses,
 * with the candidate block injected into the composite prompt, and record the
 * impact (MAE + agreement + token cost) on the set. Reuses grading-eval +
 * ai-grading via DYNAMIC import to avoid a static import cycle (ai-grading.ts
 * statically imports getActiveExemplarBlock from this module).
 *
 * An empty exemplar set can't help the model, so it's rejected before spending
 * any vision-API budget.
 */
export async function evalExemplarSet(
  setId: string,
  triggeredBy: string | null,
): Promise<ExemplarEvalResult> {
  const { data: setRow, error } = await supabaseAdmin
    .from("grading_exemplar_sets")
    .select("*")
    .eq("id", setId)
    .single();
  if (error || !setRow) throw new Error(`Exemplar set not found: ${setId}`);
  const set = setRow as ExemplarSetRow & { block_text: string };
  if (!set.block_text || set.exemplar_count === 0) {
    throw new Error("Exemplar set is empty — assemble exemplars before running the eval gate.");
  }

  // Dynamic imports break the static cycle (see header note).
  const { downloadCaseImage, evalThresholds } = await import("./grading-eval.ts");
  const {
    analyzeImage,
    compositeGrade,
    composeExemplarPrompt,
    resolveActiveCompositePrompt,
  } = await import("./ai-grading.ts");

  // Scope the golden set to the set's category when it's a scoped set, mirroring
  // runEval's garment_scope handling.
  let casesQuery = supabaseAdmin
    .from("grading_eval_cases")
    .select(
      "id, label, garment_type, garment_category, brand, description, style_attributes, images, expected_score, expected_tier, tags",
    )
    .eq("is_active", true)
    .is("deleted_at", null); // US-2037: retired cases never re-enter the gate.
  if (set.garment_category) {
    casesQuery = casesQuery.eq("garment_category", set.garment_category);
  }
  const { data: cases, error: casesError } = await casesQuery;
  if (casesError) throw new Error(`Failed to load eval cases: ${casesError.message}`);
  const caseRows = (cases ?? []) as Array<{
    id: string;
    label: string;
    garment_type: string;
    garment_category: string;
    brand: string | null;
    description: string | null;
    style_attributes: string[] | null;
    images: Array<{ image_type: string; storage_path: string }>;
    expected_score: number;
    tags: string[] | null;
  }>;
  if (caseRows.length === 0) {
    throw new Error(
      "No active eval cases" +
        (set.garment_category ? ` for category "${set.garment_category}"` : "") +
        ". Add golden cases before gating an exemplar set.",
    );
  }

  // US-1922: the candidate composite prompt = the ACTIVE composite prompt (DB
  // override → code default, resolved PER CASE category exactly as the live grade
  // path does) + the exemplar block. Composing onto the hard-coded default here
  // (the old bug) meant a set was gated against a different base than it runs
  // under whenever a DB composite override is active, defeating the eval gate.
  let errSum = 0;
  let scored = 0;
  let agreed = 0;
  const tagBuckets = new Map<string, { errSum: number; scored: number; agreed: number; count: number }>();

  for (const row of caseRows) {
    const styleHint = Array.isArray(row.style_attributes) ? row.style_attributes : [];
    let error: number | null = null;
    try {
      const images = Array.isArray(row.images) ? row.images : [];
      if (images.length === 0) throw new Error("case has no images");
      const perImage = [];
      for (const img of images) {
        const dl = await downloadCaseImage(img.storage_path);
        if ("error" in dl) throw new Error(`${img.storage_path}: ${dl.error}`);
        perImage.push(
          await analyzeImage(
            dl.dataUri,
            img.image_type,
            row.garment_type,
            row.garment_category,
            styleHint,
          ),
        );
      }
      // Resolve the active composite base for THIS case's category (same as the
      // live path) and compose the candidate block onto it via the shared helper.
      const activeBase = await resolveActiveCompositePrompt(row.garment_category || null);
      const compositeOverride = {
        text: composeExemplarPrompt(activeBase.text, set.block_text),
        versionName: `${activeBase.versionName}+${set.version_name}`,
      };
      const result = await compositeGrade(
        perImage,
        {
          garment_type: row.garment_type,
          garment_category: row.garment_category,
          brand: row.brand,
          title: row.label,
          description: row.description,
          style_attributes: styleHint,
        },
        compositeOverride,
      );
      error = Math.abs(result.overall_score - row.expected_score);
    } catch {
      error = null;
    }

    const caseAgreed = error !== null && error <= 0.5;
    if (error !== null) {
      errSum += error;
      scored++;
    }
    if (caseAgreed) agreed++;
    for (const tag of row.tags ?? []) {
      const b = tagBuckets.get(tag) ?? { errSum: 0, scored: 0, agreed: 0, count: 0 };
      b.count++;
      if (error !== null) {
        b.errSum += error;
        b.scored++;
      }
      if (caseAgreed) b.agreed++;
      tagBuckets.set(tag, b);
    }
  }

  const mae = scored > 0 ? errSum / scored : Number.POSITIVE_INFINITY;
  const agreementRate = caseRows.length > 0 ? agreed / caseRows.length : 0;
  const thresholds = evalThresholds();
  const passed =
    Number.isFinite(mae) &&
    mae <= thresholds.max_mae &&
    agreementRate >= thresholds.min_agreement;

  const perTag: Record<string, unknown> = {};
  for (const [tag, b] of tagBuckets) {
    perTag[tag] = {
      tag,
      mean_absolute_error: b.scored > 0 ? Number((b.errSum / b.scored).toFixed(2)) : 0,
      agreement_rate: b.count > 0 ? Number((b.agreed / b.count).toFixed(4)) : 0,
      count: b.count,
    };
  }

  // Record the gate outcome + impact on the set.
  await supabaseAdmin
    .from("grading_exemplar_sets")
    .update({
      eval_passed: passed,
      eval_mae: Number.isFinite(mae) ? Number(mae.toFixed(2)) : null,
      eval_agreement_rate: Number(agreementRate.toFixed(4)),
    })
    .eq("id", setId);

  // triggeredBy is recorded by the route audit log; kept in the signature so the
  // call site reads consistently with runEval.
  void triggeredBy;

  return {
    set_id: setId,
    version_name: set.version_name,
    garment_category: set.garment_category,
    exemplar_count: set.exemplar_count,
    mean_absolute_error: Number.isFinite(mae) ? Number(mae.toFixed(2)) : Number.POSITIVE_INFINITY,
    agreement_rate: Number(agreementRate.toFixed(4)),
    cases_total: caseRows.length,
    cases_passed: agreed,
    passed,
    thresholds,
    block_tokens: estimateTokens(set.block_text),
    per_tag: perTag,
  };
}

/**
 * Activation gate (AC2). An exemplar set may go active ONLY if its most recent
 * eval run passed. Deactivates the prior active set in the same scope first, then
 * flips this one active and invalidates the cluster-wide cache so it takes effect
 * on every replica immediately.
 */
export async function activateExemplarSet(
  setId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { data: setRow, error } = await supabaseAdmin
    .from("grading_exemplar_sets")
    .select("id, garment_category, eval_passed")
    .eq("id", setId)
    .single();
  if (error || !setRow) return { ok: false, reason: "Exemplar set not found" };
  const set = setRow as { id: string; garment_category: string | null; eval_passed: boolean | null };

  if (set.eval_passed !== true) {
    return {
      ok: false,
      reason:
        "Exemplar set has not passed the eval gate. Run the eval and clear the MAE/agreement thresholds before activating.",
    };
  }

  // Deactivate the current active set for the same scope (the unique partial
  // index would otherwise reject the activation).
  let deactivate = supabaseAdmin
    .from("grading_exemplar_sets")
    .update({ is_active: false, status: "retired" })
    .eq("is_active", true)
    .neq("id", setId);
  deactivate = set.garment_category
    ? deactivate.eq("garment_category", set.garment_category)
    : deactivate.is("garment_category", null);
  await deactivate;

  const { error: activateError } = await supabaseAdmin
    .from("grading_exemplar_sets")
    .update({ is_active: true, status: "active" })
    .eq("id", setId);
  if (activateError) return { ok: false, reason: activateError.message };

  await invalidateExemplarCache();
  return { ok: true };
}

/** Deactivate the active set in a scope (reverts grading to no exemplar block). */
export async function deactivateExemplarSet(setId: string): Promise<void> {
  await supabaseAdmin
    .from("grading_exemplar_sets")
    .update({ is_active: false, status: "retired" })
    .eq("id", setId);
  await invalidateExemplarCache();
}
