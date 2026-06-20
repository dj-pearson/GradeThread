// US-916: Product "What's New" changelog — PURE helpers (no supabase/env import,
// so these unit-test with no env dance). The impure DB wrappers live in
// changelog-job.ts; the admin/public routes own their own CRUD.

import type { ContentProduct } from "./content-history.ts";
import type { ChangelogEntry } from "./newsletter-changelog.ts";

export const CHANGELOG_CATEGORIES = ["feature", "improvement", "fix", "announcement"] as const;
export type ChangelogCategory = (typeof CHANGELOG_CATEGORIES)[number];

export const CHANGELOG_AUDIENCES = ["all", "grading", "flipdesk", "verified"] as const;
export type ChangelogAudience = (typeof CHANGELOG_AUDIENCES)[number];

export const CHANGELOG_STATUSES = ["draft", "published"] as const;
export type ChangelogStatus = (typeof CHANGELOG_STATUSES)[number];

export const CHANGELOG_SOURCES = ["manual", "auto"] as const;
export type ChangelogSource = (typeof CHANGELOG_SOURCES)[number];

/** The full DB row shape (changelog_entries). */
export interface ChangelogRow {
  id: string;
  title: string;
  summary: string | null;
  body: string | null;
  category: ChangelogCategory;
  audience: ChangelogAudience;
  image_url: string | null;
  status: ChangelogStatus;
  published_at: string | null;
  source: ChangelogSource;
  source_ref: string | null;
  featured_at: string | null;
  featured_issue_id: string | null;
  created_at: string;
  updated_at: string;
}

/** The public projection (no operator bookkeeping leaks). */
export interface PublicChangelogEntry {
  id: string;
  title: string;
  summary: string | null;
  body: string | null;
  category: ChangelogCategory;
  audience: ChangelogAudience;
  image_url: string | null;
  published_at: string | null;
}

export function isChangelogCategory(v: unknown): v is ChangelogCategory {
  return typeof v === "string" && (CHANGELOG_CATEGORIES as readonly string[]).includes(v);
}
export function isChangelogAudience(v: unknown): v is ChangelogAudience {
  return typeof v === "string" && (CHANGELOG_AUDIENCES as readonly string[]).includes(v);
}
export function isChangelogStatus(v: unknown): v is ChangelogStatus {
  return typeof v === "string" && (CHANGELOG_STATUSES as readonly string[]).includes(v);
}

/**
 * The changelog audiences an issue for `product` may feature. 'all' is always
 * included so universal news reaches everyone; product-specific news is gated so
 * a grading-only reader never gets FlipDesk-only feature news (AC5). 'verified'
 * (GradeThread Verified seller profiles) is a grading-side surface, so it rides
 * along with the grading audience. Pure.
 */
export function audiencesForProduct(product: ContentProduct): ChangelogAudience[] {
  switch (product) {
    case "flipdesk":
      return ["all", "flipdesk"];
    case "gradethread":
      return ["all", "grading", "verified"];
    default: // "both"
      return ["all", "grading", "flipdesk", "verified"];
  }
}

/**
 * The default audience tag for an auto-captured entry, derived from the source
 * content's product focus. Pure.
 */
export function audienceForProductFocus(product: ContentProduct): ChangelogAudience {
  switch (product) {
    case "flipdesk":
      return "flipdesk";
    case "gradethread":
      return "grading";
    default:
      return "all";
  }
}

/** Public projection of a full row (drops operator bookkeeping). Pure. */
export function toPublicEntry(row: ChangelogRow): PublicChangelogEntry {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    body: row.body,
    category: row.category,
    audience: row.audience,
    image_url: row.image_url,
    published_at: row.published_at,
  };
}

/**
 * Map a changelog row into the newsletter's ChangelogEntry shape so it flows
 * through the assembler's existing buildWhatsNewSection. productFocus is left
 * 'both' (audience already gated the selection upstream). Pure.
 */
export function toWhatsNewEntry(row: ChangelogRow): ChangelogEntry {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    productFocus: "both",
    publishedAt: row.published_at ?? row.created_at,
  };
}

/**
 * Select the unsent, audience-appropriate published entries to feature, newest
 * first, capped at `max`. "Unsent" = featured_at is null. Pure (the DB query
 * pre-filters too, but keeping the policy here makes it unit-testable).
 */
export function selectUnsentChangelog(
  rows: ChangelogRow[],
  audiences: ChangelogAudience[],
  max: number,
): ChangelogRow[] {
  if (max <= 0) return [];
  const allowed = new Set(audiences);
  return rows
    .filter((r) => r.status === "published" && !r.featured_at && allowed.has(r.audience))
    .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""))
    .slice(0, max);
}
