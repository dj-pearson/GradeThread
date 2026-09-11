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
 * signal via the source_ref READ below: a re-run never duplicates an entry, and
 * an operator's edit/publish/delete is never clobbered. The partial unique index
 * is the race guard only; see the write site for why it cannot be an ON CONFLICT
 * target through PostgREST (US-3365). Best-effort.
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

  // US-3365: a plain INSERT, deliberately not an upsert.
  //
  // This used to be `.upsert(toInsert, { onConflict: "source_ref",
  // ignoreDuplicates: true })`, and it never once wrote a row.
  // `changelog_entries_source_ref_key` (00291) is a PARTIAL index --
  // `ON public.changelog_entries (source_ref) WHERE source_ref IS NOT NULL` --
  // and Postgres refuses a partial index as an ON CONFLICT target unless the
  // statement repeats the predicate, which PostgREST has no way to send.
  // Measured against a real PostgREST on the local stack:
  //
  //   POST /rest/v1/changelog_entries?on_conflict=source_ref
  //   Prefer: resolution=ignore-duplicates
  //   HTTP 400
  //   {"code":"42P10","message":"there is no unique or exclusion constraint
  //     matching the ON CONFLICT specification"}
  //
  // A control upsert on the same table naming the NON-partial
  // changelog_entries_pkey returned 201 in the same session, so it is the
  // predicate and not the table. Dropping the `resolution=ignore-duplicates`
  // header's conflict target is not an escape hatch either: with no
  // on_conflict param PostgREST falls back to the primary key, and the partial
  // index then answers 23505 / 409 (also measured).
  //
  // The dedupe the upsert was asking for is already done: the source_ref read
  // above removes every signal that has an entry. So the index stays purely as
  // the race guard between two concurrent runs, and a 23505 here means the
  // other run won -- not a failure. Retried one row at a time because a batch
  // insert is all-or-nothing and one duplicate would otherwise drop the
  // innocent drafts with it.
  let inserted = 0;
  let raced = 0;
  const { error: insErr } = await supabaseAdmin.from("changelog_entries").insert(toInsert);
  if (!insErr) {
    inserted = toInsert.length;
  } else if (insErr.code === "23505") {
    for (const row of toInsert) {
      const { error: one } = await supabaseAdmin.from("changelog_entries").insert(row);
      if (!one) inserted++;
      else if (one.code === "23505") raced++;
      else console.error(`[changelog] autoCaptureChangelogDrafts failed: ${one.message}`);
    }
    // Said out loud: `raced` on every run is also what a BROKEN dedupe read
    // looks like, and the entry count stays correct either way because the
    // index catches it. A quiet counter would make the two indistinguishable.
    console.warn(
      `[changelog] ${raced} auto-capture draft(s) lost a race on ` +
        `changelog_entries_source_ref_key; if this is every run, the source_ref ` +
        `read above is broken`,
    );
  } else {
    console.error(`[changelog] autoCaptureChangelogDrafts failed: ${insErr.message}`);
    return 0;
  }
  return inserted;
}
