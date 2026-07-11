import { getConsent, track } from "./analytics";

// US-1908: AutoLister grouping-quality telemetry. Measures how well
// auto-grouping performs on real sessions — how much sellers correct it — so
// DEFAULT_GAP_SECONDS, VISUAL_MERGE_MAX_DISTANCE, and MAX_AUTO_GROUP_PHOTOS get
// tuned from evidence instead of anecdotes. NO image data, NO filenames, NO
// PII — counts and coarse buckets only.
//
// Events (documented here so the PostHog dashboards are reproducible):
//   autolister_autogroup_run    { photo_count, group_count, singleton_count,
//                                 pct_with_exif, seq_seeded_count }
//       once per Auto-group run, before the seller's manual edits.
//   autolister_group_edit       { kind: move|merge|split|ungroup_all|reorder|group_every }
//       once per manual grouping mutation.
//   autolister_ai_suggestion    { source: verify|propose, action: applied|dismissed,
//                                 confidence_bucket: low|medium|high }
//       when a seller applies or dismisses an AI grouping suggestion.
//   autolister_grouping_outcome { photo_count, corrected_count, correction_pct,
//                                 manual_groups_created }
//       once at generate (session end) — the correction score.
//
// Every event fires ONLY after analytics consent (US-291 geo-consent gating)
// and goes through the shared track()/getConsent() utils — no direct
// posthog.capture calls.

/** Analytics telemetry fires only after the seller granted analytics consent. */
function analyticsAllowed(): boolean {
  return getConsent()?.analytics === true;
}

export type GroupEditKind =
  | "move"
  | "merge"
  | "split"
  | "ungroup_all"
  | "reorder"
  | "group_every";

export type SuggestionSource = "verify" | "propose";
export type SuggestionAction = "applied" | "dismissed";

/** Coarse confidence bucket — never the raw score (keeps the event low-entropy). */
export function confidenceBucket(confidence: number): "low" | "medium" | "high" {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

/**
 * Correction score: the fraction of AUTO-assigned photos whose FINAL group
 * differs from the group auto-grouping placed them in. Only photos present in
 * the auto-assignment snapshot count toward the denominator — photos the seller
 * grouped entirely by hand aren't "corrections" of the auto-grouper. A photo
 * that was auto-grouped and then left ungrouped (final null) counts as
 * corrected. Pure + unit-tested.
 */
export function groupingCorrectionScore(
  autoAssigned: Readonly<Record<string, string>>,
  finalAssigned: Readonly<Record<string, string | null>>,
): { corrected: number; total: number; pct: number } {
  let corrected = 0;
  let total = 0;
  for (const [photoId, autoGroup] of Object.entries(autoAssigned)) {
    total++;
    if ((finalAssigned[photoId] ?? null) !== autoGroup) corrected++;
  }
  const pct = total === 0 ? 0 : corrected / total;
  return { corrected, total, pct };
}

/** Count of final groups that auto-grouping didn't create (seller-made). */
export function manualGroupsCreated(
  autoGroupIds: Iterable<string>,
  finalGroupIds: Iterable<string>,
): number {
  const auto = new Set(autoGroupIds);
  let n = 0;
  for (const id of finalGroupIds) if (!auto.has(id)) n++;
  return n;
}

export function trackAutogroupRun(p: {
  photo_count: number;
  group_count: number;
  singleton_count: number;
  pct_with_exif: number;
  seq_seeded_count: number;
}): void {
  if (!analyticsAllowed()) return;
  track("autolister_autogroup_run", p);
}

export function trackGroupEdit(kind: GroupEditKind): void {
  if (!analyticsAllowed()) return;
  track("autolister_group_edit", { kind });
}

export function trackAiSuggestion(p: {
  source: SuggestionSource;
  action: SuggestionAction;
  confidence: number;
}): void {
  if (!analyticsAllowed()) return;
  track("autolister_ai_suggestion", {
    source: p.source,
    action: p.action,
    confidence_bucket: confidenceBucket(p.confidence),
  });
}

export function trackGroupingOutcome(p: {
  photo_count: number;
  corrected_count: number;
  correction_pct: number;
  manual_groups_created: number;
}): void {
  if (!analyticsAllowed()) return;
  track("autolister_grouping_outcome", p);
}
