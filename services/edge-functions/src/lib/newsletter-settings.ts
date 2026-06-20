// US-922: Newsletter assembler settings singleton.
//
// Mirrors the content_settings pattern (registry-backed config) so the
// autonomous assembler's cadence / audiences / imagery budget / section budget
// are operator-retunable at /admin/ops/settings WITHOUT a deploy. All keys are
// seeded in migration 00286; this is the single typed reader the assembler uses
// so callers never sprinkle getSetting() calls with drifting defaults.

import { getSetting } from "./system-settings.ts";

export interface NewsletterAssemblerSettings {
  /** Master toggle — when false the autonomous build is a no-op. */
  enabled: boolean;
  /** Cadence period (days); at most one issue per period. Reuses the schedule key. */
  cadencePeriodDays: number;
  /** Max AI-generated hero images per issue (0 disables imagery). */
  maxImages: number;
  /** Max content sections the copywriter produces (excluding the what's-new block). */
  maxSections: number;
  /** Audience keys the assembler rotates across (newsletter_issues.audience). */
  audiences: string[];
  /** How far back (days) to scan content_history_index for unsent "what's new". */
  changelogLookbackDays: number;
  /** US-917: how recently (days) an evergreen topic may have been used before it's
   * excluded from selection (bank last_used_at / sent issue / history index). */
  topicDedupWindowDays: number;
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeAudiences(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of arr) {
    if (typeof a !== "string") continue;
    const key = a.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  // Never resolve to an empty rotation — the default audience always survives.
  return out.length > 0 ? out : ["all_confirmed"];
}

export async function loadNewsletterSettings(): Promise<NewsletterAssemblerSettings> {
  const [enabled, cadence, maxImages, maxSections, audiences, lookback, dedupWindow] = await Promise.all([
    getSetting<boolean>("newsletter_assembler_enabled", true),
    getSetting<number>("newsletter_cadence_period_days", 7),
    getSetting<number>("newsletter_assembler_max_images", 1),
    getSetting<number>("newsletter_assembler_max_sections", 5),
    getSetting<string[]>("newsletter_assembler_audiences", ["all_confirmed"]),
    getSetting<number>("newsletter_assembler_changelog_lookback_days", 45),
    getSetting<number>("newsletter_topic_dedup_window_days", 60),
  ]);
  return {
    enabled: Boolean(enabled),
    cadencePeriodDays: clampInt(cadence, 7, 1, 365),
    maxImages: clampInt(maxImages, 1, 0, 4),
    maxSections: clampInt(maxSections, 5, 1, 10),
    audiences: normalizeAudiences(audiences),
    changelogLookbackDays: clampInt(lookback, 45, 1, 365),
    topicDedupWindowDays: clampInt(dedupWindow, 60, 1, 365),
  };
}
