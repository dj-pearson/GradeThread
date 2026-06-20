// US-916: Product "What's New" changelog — IMPURE DB wrappers (the assembler +
// auto-capture side). Pure policy/types live in changelog.ts; admin CRUD lives
// in routes/admin-changelog.ts; the public feed in routes/changelog.ts.

import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";
import {
  audienceForProductFocus,
  type ChangelogAudience,
  audiencesForProduct,
  type ChangelogRow,
  selectUnsentChangelog,
} from "./changelog.ts";
import type { ContentProduct } from "./content-history.ts";

// Full column projection (string concat → Supabase can't infer the row type, so
// results are cast to ChangelogRow).
export const CHANGELOG_COLS =
  "id, title, summary, body, category, audience, image_url, status, " +
  "published_at, source, source_ref, featured_at, featured_issue_id, " +
  "created_at, updated_at";

/**
 * The unsent, audience-appropriate published changelog entries to feature in the
 * next issue, newest first, capped at `max`. Best-effort: a DB error yields an
 * empty list so the issue degrades to evergreen content (never invents news).
 */
export async function fetchUnsentChangelogForProduct(
  product: ContentProduct,
  max: number,
): Promise<ChangelogRow[]> {
  if (max <= 0) return [];
  const audiences = audiencesForProduct(product);
  const { data, error } = await supabaseAdmin
    .from("changelog_entries")
    .select(CHANGELOG_COLS)
    .eq("status", "published")
    .is("featured_at", null)
    .in("audience", audiences)
    .order("published_at", { ascending: false })
    .limit(50);
  if (error || !data) return [];
  // Re-run the pure selector (defensive: also enforces the cap + ordering).
  return selectUnsentChangelog(data as unknown as ChangelogRow[], audiences, max);
}

/**
 * Mark the given entries as featured by an issue so they aren't re-sent next week
 * (AC4). Best-effort: a failure must not block the issue. Only stamps rows that
 * are still unfeatured (so a resume doesn't reassign an entry to a new issue).
 */
export async function markChangelogFeatured(
  ids: string[],
  issueId: string,
  nowMs: number,
): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabaseAdmin
    .from("changelog_entries")
    .update({
      featured_at: new Date(nowMs).toISOString(),
      featured_issue_id: issueId,
    })
    .in("id", ids)
    .is("featured_at", null);
  if (error) {
    console.error(`[changelog] markChangelogFeatured failed: ${error.message}`);
  }
}

/**
 * AC2 auto-capture: draft changelog entries (status='draft', source='auto') from
 * recently published blog posts for human-light curation. Idempotent per source
 * signal via the unique source_ref index — a re-run never duplicates an entry,
 * and an operator's edit/publish/delete is never clobbered. Best-effort.
 *
 * Drafts are NOT auto-published: an operator reviews and publishes them, after
 * which the assembler features them. Returns the number of new drafts created.
 */
export async function autoCaptureChangelogDrafts(nowMs: number): Promise<number> {
  const enabled = await getSetting<boolean>("changelog_autocapture_enabled", true);
  if (!enabled) return 0;
  const lookbackDays = await getSetting<number>("changelog_autocapture_lookback_days", 30);
  const cutoff = new Date(nowMs - Math.max(1, lookbackDays) * 86_400_000).toISOString();

  // Recently published blog content (the "newly shipped work" signal).
  const { data: signals, error } = await supabaseAdmin
    .from("content_history_index")
    .select("id, title, summary_one_line, product_focus, published_at")
    .eq("surface", "blog")
    .gte("published_at", cutoff)
    .order("published_at", { ascending: false })
    .limit(50);
  if (error || !signals || signals.length === 0) return 0;

  const rows = signals as Array<{
    id: string;
    title: string;
    summary_one_line: string | null;
    product_focus: string;
    published_at: string;
  }>;
  const refs = rows.map((r) => `blog:${r.id}`);

  // Which signals already have a changelog entry — skip those (idempotent).
  const { data: existing } = await supabaseAdmin
    .from("changelog_entries")
    .select("source_ref")
    .in("source_ref", refs);
  const seen = new Set(
    ((existing ?? []) as Array<{ source_ref: string | null }>)
      .map((e) => e.source_ref)
      .filter((r): r is string => !!r),
  );

  const toInsert = rows
    .filter((r) => !seen.has(`blog:${r.id}`))
    .map((r) => ({
      title: r.title,
      summary: r.summary_one_line,
      body: null as string | null,
      // Newly published content reads as an announcement; the operator can
      // reclassify before publishing.
      category: "announcement" as const,
      audience: audienceForProductFocus(
        (r.product_focus as ContentProduct) ?? "both",
      ) as ChangelogAudience,
      status: "draft" as const,
      source: "auto" as const,
      source_ref: `blog:${r.id}`,
    }));
  if (toInsert.length === 0) return 0;

  // Ignore-duplicates on the source_ref unique index in case of a concurrent run.
  const { error: insErr } = await supabaseAdmin
    .from("changelog_entries")
    .upsert(toInsert, { onConflict: "source_ref", ignoreDuplicates: true });
  if (insErr) {
    console.error(`[changelog] autoCaptureChangelogDrafts failed: ${insErr.message}`);
    return 0;
  }
  return toInsert.length;
}
