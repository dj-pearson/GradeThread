// US-547: Self-improving listing prompt from seller-acceptance data.
//
// Closes the AutoLister learning loop. Three pieces live here:
//
//  1. captureListingAcceptance — at publish, diff the AI's generated snapshot
//     (listings.ai_generated_snapshot, written by ai-listing.generateListing)
//     against the seller's final published values, record a per-field
//     keep/change signal attributed to the listing_gen prompt version.
//  2. markListingPromptSold — the eBay orders-sync flips the acceptance row's
//     sell-through flag when the listing sells.
//  3. summarizeListingPromptPerformance / autoPromoteListingPrompt — roll the
//     signal up per prompt version (field keep-rate + sell-through) and promote
//     an A/B challenger over the champion once it demonstrably wins.
//
// See migration 00155_listing_prompt_acceptance.sql for the schema.

import { supabaseAdmin } from "./supabase.ts";
import { activatePromptVersion } from "./grading-eval.ts";

// The listing fields whose keep/change we track. Each maps the AI snapshot key
// (ai_generated_snapshot.*) to the live listings column holding the seller's
// final value, plus how to compare them (price is numeric, specifics are maps).
type FieldKind = "text" | "price" | "map";
interface TrackedField {
  key: string;
  column: string;
  kind: FieldKind;
}

export const TRACKED_LISTING_FIELDS: readonly TrackedField[] = [
  { key: "title", column: "listing_title", kind: "text" },
  { key: "description", column: "listing_description", kind: "text" },
  { key: "price_cents", column: "listing_price", kind: "price" },
  { key: "ebay_condition", column: "ebay_condition", kind: "text" },
  { key: "condition_description", column: "ebay_condition_description", kind: "text" },
  { key: "category_id", column: "platform_category_id", kind: "text" },
  { key: "item_specifics", column: "item_specifics_override", kind: "map" },
];

function normText(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v);
}

// listing_price is stored in dollars; ai_generated_snapshot.price_cents in cents.
// Compare at cent granularity with a 1-cent tolerance for float round-trips.
function priceCentsFromDollars(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function canonicalMap(v: unknown): string {
  if (!v || typeof v !== "object") return "{}";
  const obj = v as Record<string, unknown>;
  const norm: Record<string, string[]> = {};
  for (const k of Object.keys(obj).sort()) {
    const val = obj[k];
    const arr = Array.isArray(val) ? val : val == null ? [] : [val];
    const vals = arr.map((x) => String(x).trim()).filter((x) => x.length > 0).sort();
    if (vals.length > 0) norm[k] = vals;
  }
  return JSON.stringify(norm);
}

export interface FieldDiff {
  fieldOutcomes: Record<string, "kept" | "changed">;
  keptCount: number;
  changedCount: number;
  totalFields: number;
}

/**
 * Diff the AI snapshot against the seller's final listing row. Only fields the
 * AI actually produced (present in the snapshot) are scored — a field the model
 * left empty can't be "kept" or "changed".
 */
export function diffListingFields(
  snapshot: Record<string, unknown>,
  finalRow: Record<string, unknown>,
): FieldDiff {
  const fieldOutcomes: Record<string, "kept" | "changed"> = {};
  let keptCount = 0;
  let changedCount = 0;

  for (const f of TRACKED_LISTING_FIELDS) {
    const aiVal = snapshot[f.key];
    // Skip fields the AI didn't generate (no signal to learn from).
    if (aiVal == null || (f.kind === "text" && normText(aiVal) === "")) continue;

    let kept: boolean;
    if (f.kind === "price") {
      kept = Math.abs(Number(aiVal) - priceCentsFromDollars(finalRow[f.column])) <= 1;
    } else if (f.kind === "map") {
      kept = canonicalMap(aiVal) === canonicalMap(finalRow[f.column]);
    } else {
      kept = normText(aiVal) === normText(finalRow[f.column]);
    }

    fieldOutcomes[f.key] = kept ? "kept" : "changed";
    if (kept) keptCount++;
    else changedCount++;
  }

  return {
    fieldOutcomes,
    keptCount,
    changedCount,
    totalFields: keptCount + changedCount,
  };
}

/**
 * Capture the acceptance signal for a published listing. No-op (logged, never
 * thrown) when the listing wasn't AI-generated or has no snapshot — only drafts
 * produced by generateListing carry ai_generated_snapshot/ai_prompt_version.
 * Idempotent: a re-publish upserts the same row (unique on listing_id).
 */
export async function captureListingAcceptance(listingId: string): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin
      .from("listings")
      .select(
        "id, ai_prompt_version, ai_generated_snapshot, listing_title, listing_description, " +
          "listing_price, ebay_condition, ebay_condition_description, platform_category_id, " +
          "item_specifics_override, inventory_item_id, inventory_items!inner(user_id)",
      )
      .eq("id", listingId)
      .maybeSingle();
    if (error || !data) return;

    const row = data as unknown as {
      ai_prompt_version: string | null;
      ai_generated_snapshot: Record<string, unknown> | null;
      inventory_item_id: string | null;
      inventory_items: { user_id: string } | { user_id: string }[];
    } & Record<string, unknown>;

    if (!row.ai_prompt_version || !row.ai_generated_snapshot) return;

    const owner = Array.isArray(row.inventory_items)
      ? row.inventory_items[0]?.user_id
      : row.inventory_items?.user_id;
    if (!owner) return;

    const snapshot = row.ai_generated_snapshot;
    const diff = diffListingFields(snapshot, row);

    const acceptedFields: Record<string, unknown> = {};
    for (const f of TRACKED_LISTING_FIELDS) {
      if (snapshot[f.key] == null) continue;
      acceptedFields[f.key] =
        f.kind === "price" ? priceCentsFromDollars(row[f.column]) : row[f.column] ?? null;
    }

    const { error: upErr } = await supabaseAdmin
      .from("listing_prompt_acceptance")
      .upsert(
        {
          user_id: owner,
          listing_id: listingId,
          inventory_item_id: row.inventory_item_id,
          prompt_version: row.ai_prompt_version,
          ai_fields: snapshot,
          accepted_fields: acceptedFields,
          field_outcomes: diff.fieldOutcomes,
          kept_count: diff.keptCount,
          changed_count: diff.changedCount,
          total_fields: diff.totalFields,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "listing_id" },
      );
    if (upErr) {
      console.error("[listing-acceptance] upsert failed:", upErr.message);
    }
  } catch (err) {
    console.error(
      "[listing-acceptance] captureListingAcceptance error:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Flip the sell-through flag when the orders-sync marks the listing sold. */
export async function markListingPromptSold(listingId: string): Promise<void> {
  try {
    await supabaseAdmin
      .from("listing_prompt_acceptance")
      .update({ sold: true, sold_at: new Date().toISOString() })
      .eq("listing_id", listingId)
      .eq("sold", false);
  } catch (err) {
    console.error(
      "[listing-acceptance] markListingPromptSold error:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ── Performance rollup + auto-promotion ───────────────────────────────────

export interface ListingPromptStats {
  promptVersion: string;
  isActive: boolean;
  inTrial: boolean;
  evalPassed: boolean | null;
  listings: number;
  sold: number;
  sellThrough: number; // sold / listings
  keptFields: number;
  totalFields: number;
  keepRate: number; // keptFields / totalFields
  // Combined acceptance + sell-through score used for promotion decisions.
  score: number;
  perField: Record<string, { kept: number; total: number; keepRate: number }>;
}

const PROMOTE_WEIGHT_KEEP = 0.5;
const PROMOTE_WEIGHT_SELL = 0.5;

function combinedScore(keepRate: number, sellThrough: number): number {
  return PROMOTE_WEIGHT_KEEP * keepRate + PROMOTE_WEIGHT_SELL * sellThrough;
}

interface AcceptanceRow {
  prompt_version: string;
  kept_count: number;
  total_fields: number;
  sold: boolean;
  field_outcomes: Record<string, string> | null;
}

/**
 * Roll the acceptance signal up per listing_gen prompt version: how many
 * listings it produced, the per-field keep-rate sellers gave it, and its
 * sell-through. Labels each version active / in-trial / eval status from
 * ai_prompt_versions so the dashboard can show champion vs challenger.
 */
export async function summarizeListingPromptPerformance(): Promise<ListingPromptStats[]> {
  const { data: rowsRaw, error } = await supabaseAdmin
    .from("listing_prompt_acceptance")
    .select("prompt_version, kept_count, total_fields, sold, field_outcomes");
  if (error) throw new Error(`Failed to load acceptance rows: ${error.message}`);
  const rows = (rowsRaw ?? []) as AcceptanceRow[];

  const { data: versionsRaw } = await supabaseAdmin
    .from("ai_prompt_versions")
    .select("version_name, is_active, in_trial, eval_passed")
    .eq("stage", "listing_gen");
  const versions = (versionsRaw ?? []) as Array<{
    version_name: string;
    is_active: boolean;
    in_trial: boolean;
    eval_passed: boolean | null;
  }>;
  const versionMeta = new Map(versions.map((v) => [v.version_name, v]));

  interface Agg {
    listings: number;
    sold: number;
    keptFields: number;
    totalFields: number;
    perField: Record<string, { kept: number; total: number }>;
  }
  const byVersion = new Map<string, Agg>();

  for (const r of rows) {
    const agg = byVersion.get(r.prompt_version) ?? {
      listings: 0,
      sold: 0,
      keptFields: 0,
      totalFields: 0,
      perField: {},
    };
    agg.listings += 1;
    if (r.sold) agg.sold += 1;
    agg.keptFields += r.kept_count ?? 0;
    agg.totalFields += r.total_fields ?? 0;
    if (r.field_outcomes && typeof r.field_outcomes === "object") {
      for (const [field, outcome] of Object.entries(r.field_outcomes)) {
        const pf = agg.perField[field] ?? { kept: 0, total: 0 };
        pf.total += 1;
        if (outcome === "kept") pf.kept += 1;
        agg.perField[field] = pf;
      }
    }
    byVersion.set(r.prompt_version, agg);
  }

  // Include eval-passed versions that exist but have no acceptance data yet, so
  // a freshly-started challenger shows up in the dashboard at zero.
  for (const v of versions) {
    if (!byVersion.has(v.version_name)) {
      byVersion.set(v.version_name, {
        listings: 0,
        sold: 0,
        keptFields: 0,
        totalFields: 0,
        perField: {},
      });
    }
  }

  const out: ListingPromptStats[] = [];
  for (const [promptVersion, agg] of byVersion) {
    const meta = versionMeta.get(promptVersion);
    const sellThrough = agg.listings > 0 ? agg.sold / agg.listings : 0;
    const keepRate = agg.totalFields > 0 ? agg.keptFields / agg.totalFields : 0;
    const perField: Record<string, { kept: number; total: number; keepRate: number }> = {};
    for (const [field, pf] of Object.entries(agg.perField)) {
      perField[field] = {
        kept: pf.kept,
        total: pf.total,
        keepRate: pf.total > 0 ? pf.kept / pf.total : 0,
      };
    }
    out.push({
      promptVersion,
      isActive: meta?.is_active ?? false,
      inTrial: meta?.in_trial ?? false,
      evalPassed: meta?.eval_passed ?? null,
      listings: agg.listings,
      sold: agg.sold,
      sellThrough,
      keptFields: agg.keptFields,
      totalFields: agg.totalFields,
      keepRate,
      score: combinedScore(keepRate, sellThrough),
      perField,
    });
  }

  // Champion first, then challenger, then by score.
  out.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    if (a.inTrial !== b.inTrial) return a.inTrial ? -1 : 1;
    return b.score - a.score;
  });
  return out;
}

export interface AutoPromoteDecision {
  action: "promoted" | "trial_ended" | "insufficient_data" | "no_challenger";
  reason: string;
  challenger?: string;
  champion?: string;
  challengerScore?: number;
  championScore?: number;
  sample?: number;
}

function minTrialSample(): number {
  const raw = Number(Deno.env.get("LISTING_AB_MIN_SAMPLE"));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20;
}

function promoteMargin(): number {
  const raw = Number(Deno.env.get("LISTING_AB_PROMOTE_MARGIN"));
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.02;
}

/**
 * Compare the in-trial challenger against the active champion and act:
 *  - promote the challenger (and end its trial) when it has enough sample and
 *    beats the champion's combined keep-rate + sell-through score by the margin;
 *  - end the trial (clear in_trial, leave champion) when it has enough sample
 *    but does NOT beat the champion;
 *  - otherwise hold for more data.
 * Promotion still goes through the eval gate (activatePromptVersion requires
 * eval_passed=true), so a regressed challenger can never go live.
 */
export async function autoPromoteListingPrompt(): Promise<AutoPromoteDecision> {
  const { data: challengerRaw } = await supabaseAdmin
    .from("ai_prompt_versions")
    .select("id, version_name, eval_passed")
    .eq("stage", "listing_gen")
    .eq("in_trial", true)
    .eq("is_active", false)
    .limit(1)
    .maybeSingle();
  const challenger = challengerRaw as
    | { id: string; version_name: string; eval_passed: boolean | null }
    | null;
  if (!challenger) {
    return { action: "no_challenger", reason: "No listing_gen prompt is in trial." };
  }

  const stats = await summarizeListingPromptPerformance();
  const challengerStat = stats.find((s) => s.promptVersion === challenger.version_name);
  const championStat = stats.find((s) => s.isActive);

  const sample = challengerStat?.listings ?? 0;
  const minSample = minTrialSample();
  if (sample < minSample) {
    return {
      action: "insufficient_data",
      reason: `Challenger has ${sample}/${minSample} listings; holding trial.`,
      challenger: challenger.version_name,
      champion: championStat?.promptVersion,
      sample,
    };
  }

  const challengerScore = challengerStat?.score ?? 0;
  // No active champion row → the code default is the incumbent; treat its score
  // as 0 so an eval-passed challenger that cleared the sample bar can win.
  const championScore = championStat?.score ?? 0;

  if (challenger.eval_passed === true && challengerScore >= championScore + promoteMargin()) {
    const result = await activatePromptVersion(challenger.id);
    if (!result.ok) {
      return {
        action: "insufficient_data",
        reason: `Challenger won but activation was blocked: ${result.reason}`,
        challenger: challenger.version_name,
        champion: championStat?.promptVersion,
        challengerScore,
        championScore,
        sample,
      };
    }
    await supabaseAdmin
      .from("ai_prompt_versions")
      .update({ in_trial: false })
      .eq("id", challenger.id);
    return {
      action: "promoted",
      reason: `Challenger ${challenger.version_name} beat the champion (${challengerScore.toFixed(3)} vs ${championScore.toFixed(3)}) over ${sample} listings.`,
      challenger: challenger.version_name,
      champion: championStat?.promptVersion,
      challengerScore,
      championScore,
      sample,
    };
  }

  // Enough sample, didn't win → end the trial so it stops taking traffic.
  await supabaseAdmin
    .from("ai_prompt_versions")
    .update({ in_trial: false })
    .eq("id", challenger.id);
  return {
    action: "trial_ended",
    reason: `Challenger ${challenger.version_name} did not beat the champion (${challengerScore.toFixed(3)} vs ${championScore.toFixed(3)}) over ${sample} listings; trial ended.`,
    challenger: challenger.version_name,
    champion: championStat?.promptVersion,
    challengerScore,
    championScore,
    sample,
  };
}
