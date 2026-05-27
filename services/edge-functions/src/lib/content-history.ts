import { supabaseAdmin } from "./supabase.ts";

// Compact "what have we already covered" memory for the content module.
//
// The full body of every published post is in blog_posts/social_posts —
// far too much to stuff into a prompt as the catalogue grows. Instead,
// on every publish we append one row to content_history_index with the
// distilled essentials (title, primary keyword, secondaries, one-line
// summary). Prompts get a truncated slice of that index, not bodies.
//
// Dedup also reads this index: a primary keyword that already exists
// here (or in content_topics) is rejected before it ever reaches the
// generator.

export type ContentSurface = "blog" | "social";
export type ContentProduct = "gradethread" | "flipdesk" | "both";

export interface HistoryEntry {
  surface: ContentSurface;
  product_focus: ContentProduct;
  post_id: string | null;
  title: string;
  primary_keyword: string | null;
  secondary_keywords: string[];
  summary_one_line: string | null;
  published_at: string;
}

// Append after a successful publish. Best-effort: a failure here must not
// abort the publish flow, so callers should `.catch(log)`.
export async function appendToHistoryIndex(entry: HistoryEntry): Promise<void> {
  const { error } = await supabaseAdmin.from("content_history_index").insert({
    surface: entry.surface,
    product_focus: entry.product_focus,
    post_id: entry.post_id,
    title: entry.title,
    primary_keyword: entry.primary_keyword,
    secondary_keywords: entry.secondary_keywords ?? [],
    summary_one_line: entry.summary_one_line,
    published_at: entry.published_at,
  });
  if (error) {
    console.error("[content-history] appendToHistoryIndex failed:", error);
  }
}

interface BuildHistoryContextInput {
  surface: ContentSurface;
  productFocus: ContentProduct;
  // ~4 chars per token is a fine rough proxy for these short lines.
  maxTokens?: number;
}

// Returns a compact bulleted list ready to drop into a prompt.
// Newest first, truncated to fit the token budget. We pull the most
// recent 300 rows then trim by character count — cheap and good enough.
export async function buildHistoryContext({
  surface,
  productFocus,
  maxTokens = 4000,
}: BuildHistoryContextInput): Promise<string> {
  // We include `both`-focused posts in both product slices so a generic
  // "what we've covered" prompt reflects everything topically relevant.
  const focusFilter =
    productFocus === "both"
      ? ["gradethread", "flipdesk", "both"]
      : [productFocus, "both"];

  const { data, error } = await supabaseAdmin
    .from("content_history_index")
    .select("title, primary_keyword, secondary_keywords, summary_one_line, published_at, product_focus")
    .eq("surface", surface)
    .in("product_focus", focusFilter)
    .order("published_at", { ascending: false })
    .limit(300);

  if (error || !data || data.length === 0) return "";

  const charBudget = maxTokens * 4;
  const lines: string[] = [];
  let used = 0;
  for (const row of data) {
    const date = (row.published_at as string).slice(0, 10);
    const pk = row.primary_keyword ? ` [${row.primary_keyword}]` : "";
    const secs =
      Array.isArray(row.secondary_keywords) && row.secondary_keywords.length > 0
        ? ` (also: ${row.secondary_keywords.slice(0, 4).join(", ")})`
        : "";
    const summary = row.summary_one_line ? ` — ${row.summary_one_line}` : "";
    const line = `- ${date} · ${row.product_focus} · "${row.title}"${pk}${secs}${summary}`;
    if (used + line.length + 1 > charBudget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

// Authoritative dedup check used by the topic-research endpoint. Returns
// true if the keyword already appears (case-insensitive) in either the
// history index or any non-rejected topic in the bank for the same
// (surface, product_focus) slice.
export async function isKeywordDuplicate(
  surface: ContentSurface,
  productFocus: ContentProduct,
  primaryKeyword: string,
): Promise<boolean> {
  const needle = primaryKeyword.trim().toLowerCase();
  if (!needle) return false;

  const focusFilter =
    productFocus === "both"
      ? ["gradethread", "flipdesk", "both"]
      : [productFocus, "both"];

  const { data: history } = await supabaseAdmin
    .from("content_history_index")
    .select("id")
    .eq("surface", surface)
    .in("product_focus", focusFilter)
    .ilike("primary_keyword", needle)
    .limit(1);
  if (history && history.length > 0) return true;

  const { data: topics } = await supabaseAdmin
    .from("content_topics")
    .select("id")
    .eq("surface", surface)
    .in("product_focus", focusFilter)
    .in("status", ["queued", "assigned", "used"])
    .ilike("primary_keyword", needle)
    .limit(1);
  return !!(topics && topics.length > 0);
}

// Bulk version: returns the subset of input keywords that are duplicates.
// Used to filter a batch of research candidates in one DB round-trip per slice.
export async function findDuplicateKeywords(
  surface: ContentSurface,
  productFocus: ContentProduct,
  keywords: string[],
): Promise<Set<string>> {
  const dupes = new Set<string>();
  if (keywords.length === 0) return dupes;

  const focusFilter =
    productFocus === "both"
      ? ["gradethread", "flipdesk", "both"]
      : [productFocus, "both"];
  const normalized = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (normalized.length === 0) return dupes;

  const { data: history } = await supabaseAdmin
    .from("content_history_index")
    .select("primary_keyword")
    .eq("surface", surface)
    .in("product_focus", focusFilter)
    .not("primary_keyword", "is", null);
  for (const row of history ?? []) {
    const pk = (row.primary_keyword as string | null)?.toLowerCase();
    if (pk && normalized.includes(pk)) dupes.add(pk);
  }

  const { data: topics } = await supabaseAdmin
    .from("content_topics")
    .select("primary_keyword")
    .eq("surface", surface)
    .in("product_focus", focusFilter)
    .in("status", ["queued", "assigned", "used"]);
  for (const row of topics ?? []) {
    const pk = (row.primary_keyword as string | null)?.toLowerCase();
    if (pk && normalized.includes(pk)) dupes.add(pk);
  }

  return dupes;
}
