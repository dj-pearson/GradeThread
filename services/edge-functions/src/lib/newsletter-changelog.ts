// US-922: "What's new" changelog source for the autonomous assembler.
//
// The newsletter has no dedicated changelog table — recently PUBLISHED content
// (content_history_index, the blog/social ledger from the content engine) IS the
// "what's new" the issue features. The PURE helpers here pick the unsent,
// audience-appropriate entries + run the product-focus balancing; the impure
// fetch/track helpers wrap the DB. Keeping the selection pure means the
// dedup/balancing logic unit-tests with no Supabase.

import { supabaseAdmin } from "./supabase.ts";
import type { ContentProduct } from "./content-history.ts";

export interface ChangelogEntry {
  id: string;
  title: string;
  summary: string | null;
  productFocus: ContentProduct;
  publishedAt: string;
}

// ── Pure selection / balancing ───────────────────────────────────────────────

/**
 * The product the next issue should lean toward, balancing so grading-only vs
 * FlipDesk audiences both get relevant content over time. Mirrors the
 * content-scheduler approach: pick whichever product has been featured LEAST in
 * the recent issue history (ties → 'gradethread', the default surface). 'both'
 * issues count toward neither, so a run of generic issues re-opens both. Pure.
 */
export function pickProductFocus(recentFocuses: string[]): ContentProduct {
  let gt = 0;
  let fd = 0;
  for (const f of recentFocuses) {
    if (f === "gradethread") gt++;
    else if (f === "flipdesk") fd++;
  }
  return fd < gt ? "flipdesk" : "gradethread";
}

/** The product_focus values an issue for `focus` may feature (always includes 'both'). */
export function focusFilter(focus: ContentProduct): ContentProduct[] {
  return focus === "both" ? ["gradethread", "flipdesk", "both"] : [focus, "both"];
}

/**
 * Select the unsent, product-appropriate changelog entries to feature, newest
 * first, capped at `max`. "Unsent" = id not in `featuredIds` (already featured in
 * a prior issue). Pure.
 */
export function selectChangelogEntries(
  entries: ChangelogEntry[],
  featuredIds: Set<string>,
  focus: ContentProduct,
  max: number,
): ChangelogEntry[] {
  if (max <= 0) return [];
  const allowed = new Set(focusFilter(focus));
  return entries
    .filter((e) => !featuredIds.has(e.id) && allowed.has(e.productFocus))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, max);
}

/** Render selected entries as compact prompt lines for the copywriter. Pure. */
export function changelogToLines(entries: ChangelogEntry[]): string[] {
  return entries.map((e) => {
    const date = e.publishedAt.slice(0, 10);
    const summary = e.summary ? ` — ${e.summary}` : "";
    return `- ${date} · "${e.title}"${summary}`;
  });
}

// ── Impure DB wrappers ───────────────────────────────────────────────────────

/**
 * Recent published content within the lookback window, newest first. The pool the
 * pure selector picks from. Best-effort: a DB error yields an empty pool so the
 * issue gracefully degrades to evergreen educational content (AC3).
 */
export async function fetchChangelogPool(
  lookbackDays: number,
  nowMs: number,
): Promise<ChangelogEntry[]> {
  const cutoff = new Date(nowMs - lookbackDays * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("content_history_index")
    .select("id, title, summary_one_line, product_focus, published_at")
    .gte("published_at", cutoff)
    .order("published_at", { ascending: false })
    .limit(100);
  if (error || !data) return [];
  return (data as Array<{
    id: string;
    title: string;
    summary_one_line: string | null;
    product_focus: string;
    published_at: string;
  }>).map((r) => ({
    id: r.id,
    title: r.title,
    summary: r.summary_one_line,
    productFocus: (r.product_focus as ContentProduct) ?? "both",
    publishedAt: r.published_at,
  }));
}

/**
 * Every content id already featured in a prior issue's `featured_content_ids`, so
 * the same "what's new" is never re-sent. Best-effort (empty set on error).
 */
export async function loadFeaturedContentIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const { data, error } = await supabaseAdmin
    .from("newsletter_issues")
    .select("featured_content_ids")
    .not("featured_content_ids", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error || !data) return ids;
  for (const row of data as Array<{ featured_content_ids: unknown }>) {
    const arr = Array.isArray(row.featured_content_ids) ? row.featured_content_ids : [];
    for (const v of arr) if (typeof v === "string") ids.add(v);
  }
  return ids;
}

/** Recent issues' product_focus (newest first) for the balancing decision. */
export async function loadRecentProductFocus(limit = 8): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("newsletter_issues")
    .select("product_focus")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return (data as Array<{ product_focus: string | null }>)
    .map((r) => r.product_focus ?? "both")
    .filter((f): f is string => typeof f === "string");
}
