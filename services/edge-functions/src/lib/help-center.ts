// Help Center domain rules (US-2573), kept OUT of the route file so the wall
// itself is unit-testable without a database, a JWT or a running service.
//
// The single property everything here exists to protect: a viewer never sees a
// visibility above their own. The database enforces it too (00602's anon and
// authenticated SELECT policies), but the edge reaches Supabase with the
// SERVICE-ROLE client, which BYPASSES RLS — so in this process the filter in
// `visibilitiesFor` is the only thing standing between an anonymous crawler and
// an operator runbook. Every query against help_articles must pass its result
// through `visibilitiesFor(viewer)`; none may be written with a hand-rolled
// `.eq("visibility", ...)`.

export const HELP_VISIBILITIES = ["public", "members", "internal"] as const;
export type HelpVisibility = typeof HELP_VISIBILITIES[number];

export const HELP_STATUSES = ["draft", "published", "archived"] as const;
export type HelpArticleStatus = typeof HELP_STATUSES[number];

export const HELP_AUDIENCES = ["all", "seller", "buyer", "developer", "operator"] as const;
export type HelpAudience = typeof HELP_AUDIENCES[number];

/** Who is asking. Derived from the mount + an admin lookup, never from a body. */
export type HelpViewer = "anon" | "member" | "admin";

export interface HelpFaqPair {
  question: string;
  answer: string;
}

export interface HelpCategoryRow {
  key: string;
  title: string;
  slug: string;
  summary: string;
  sort_order: number;
  icon: string | null;
}

export interface HelpArticleRow {
  id: string;
  slug: string;
  title: string;
  summary: string;
  body_html: string;
  body_json: unknown;
  body_markdown: string;
  category_key: string;
  audience: HelpAudience;
  visibility: HelpVisibility;
  status: HelpArticleStatus;
  sort_order: number;
  hero_image_url: string | null;
  faq: unknown;
  related_slugs: string[] | null;
  video_url: string | null;
  pillar_path: string | null;
  published_at: string | null;
  reviewed_at: string | null;
  review_interval_days: number;
  created_at: string;
  updated_at: string;
}

/**
 * The visibilities a viewer may read. Ordered least- to most-privileged.
 *
 * 'member' deliberately stops short of 'internal'. An authenticated session
 * belongs to a CUSTOMER; operator runbooks, abuse thresholds and unreleased
 * feature notes are not customer-readable just because someone signed up.
 */
export function visibilitiesFor(viewer: HelpViewer): HelpVisibility[] {
  switch (viewer) {
    case "anon":
      return ["public"];
    case "member":
      return ["public", "members"];
    case "admin":
      return ["public", "members", "internal"];
  }
}

/**
 * The statuses a viewer may read through a READER endpoint.
 *
 * Published only, for everyone including admins. Admins reach drafts through
 * the authoring endpoints, which is where a draft is meant to be seen; letting
 * the reader serve them would mean an admin's own "does this page look right?"
 * check silently tests a URL no visitor can load.
 */
export function readableStatusesFor(_viewer: HelpViewer): HelpArticleStatus[] {
  return ["published"];
}

/** True when this viewer may read this row. The last line of defence. */
export function canView(
  viewer: HelpViewer,
  row: Pick<HelpArticleRow, "visibility" | "status">,
): boolean {
  return (
    visibilitiesFor(viewer).includes(row.visibility) &&
    readableStatusesFor(viewer).includes(row.status)
  );
}

// Slugs the URL space needs for itself. An article that took one of these would
// shadow a real route (/help/search) or produce a nonsense URL.
export const RESERVED_HELP_SLUGS = new Set([
  "search",
  "index",
  "sitemap",
  "feed",
  "rss",
  "new",
  "edit",
  "categories",
  "category",
  "feedback",
  "freshness",
  "admin",
  "api",
]);

export function slugifyHelp(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function isReservedHelpSlug(slug: string): boolean {
  return RESERVED_HELP_SLUGS.has(slug.toLowerCase());
}

export function isHelpVisibility(v: unknown): v is HelpVisibility {
  return typeof v === "string" && (HELP_VISIBILITIES as readonly string[]).includes(v);
}

export function isHelpStatus(v: unknown): v is HelpArticleStatus {
  return typeof v === "string" && (HELP_STATUSES as readonly string[]).includes(v);
}

export function isHelpAudience(v: unknown): v is HelpAudience {
  return typeof v === "string" && (HELP_AUDIENCES as readonly string[]).includes(v);
}

/** Coerce a `faq` jsonb blob into well-formed pairs, dropping anything else. */
export function normalizeFaq(raw: unknown): HelpFaqPair[] {
  if (!Array.isArray(raw)) return [];
  const out: HelpFaqPair[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const q = (entry as Record<string, unknown>).question;
    const a = (entry as Record<string, unknown>).answer;
    if (typeof q !== "string" || typeof a !== "string") continue;
    const question = q.trim();
    const answer = a.trim();
    if (!question || !answer) continue;
    out.push({ question, answer });
  }
  return out;
}

export function cleanSlugArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    const s = slugifyHelp(String(v ?? ""));
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** The shape a list surface renders. Deliberately without the body. */
export interface HelpListItem {
  slug: string;
  title: string;
  summary: string;
  category_key: string;
  audience: HelpAudience;
  visibility: HelpVisibility;
  sort_order: number;
  updated_at: string;
  reviewed_at: string | null;
}

export function projectListItem(row: HelpArticleRow): HelpListItem {
  return {
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    category_key: row.category_key,
    audience: row.audience,
    visibility: row.visibility,
    sort_order: row.sort_order,
    updated_at: row.updated_at,
    reviewed_at: row.reviewed_at,
  };
}

/** The shape an article page renders. */
export interface HelpArticleView extends HelpListItem {
  body_html: string;
  body_markdown: string;
  hero_image_url: string | null;
  faq: HelpFaqPair[];
  related_slugs: string[];
  video_url: string | null;
  pillar_path: string | null;
  published_at: string | null;
}

export function projectArticle(row: HelpArticleRow): HelpArticleView {
  return {
    ...projectListItem(row),
    body_html: row.body_html,
    body_markdown: row.body_markdown,
    hero_image_url: row.hero_image_url,
    faq: normalizeFaq(row.faq),
    related_slugs: cleanSlugArray(row.related_slugs),
    video_url: row.video_url,
    pillar_path: row.pillar_path,
    published_at: row.published_at,
  };
}

// ── search (US-2577) ──────────────────────────────────────

export interface HelpSearchHit {
  slug: string;
  title: string;
  summary: string;
  category_key: string;
  visibility: HelpVisibility;
  rank: number;
}

/** Longest query we will send to Postgres. Anything past this is not a question. */
export const HELP_QUERY_MAX_LENGTH = 200;

/**
 * Lowercase and collapse whitespace, so "eBay  Fees" and "ebay fees" rank
 * together in the zero-result backlog instead of as two separate misses.
 */
export function normalizeHelpQuery(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ").slice(0, HELP_QUERY_MAX_LENGTH);
}

/**
 * Is this worth sending to Postgres at all?
 *
 * A single character matches most of the corpus and costs a full index scan to
 * say so. Two is the shortest query that means anything ("id", "ai").
 */
export function isSearchableHelpQuery(raw: string): boolean {
  return normalizeHelpQuery(raw).length >= 2;
}

/**
 * US-2591: is this article past its review interval?
 * An article never reviewed falls back to when it was published.
 */
export function isStale(
  row: Pick<HelpArticleRow, "reviewed_at" | "published_at" | "review_interval_days">,
  now: number,
): boolean {
  const basis = row.reviewed_at ?? row.published_at;
  if (!basis) return false;
  const ms = Date.parse(basis);
  if (Number.isNaN(ms)) return false;
  return now - ms > row.review_interval_days * 86_400_000;
}
