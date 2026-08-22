// Help Center types (US-2574). Mirrors services/edge-functions/src/lib/help-center.ts.
//
// Deliberately its own file rather than an addition to database.ts: the Help
// Center is one table with one API, and the editor, the reader and the public
// pages all want the same shapes. Keeping them here means the two-copies-must-
// agree problem has exactly one place to look.

export const HELP_VISIBILITIES = ["public", "members", "internal"] as const;
export type HelpVisibility = (typeof HELP_VISIBILITIES)[number];

export const HELP_STATUSES = ["draft", "published", "archived"] as const;
export type HelpArticleStatus = (typeof HELP_STATUSES)[number];

export const HELP_AUDIENCES = ["all", "seller", "buyer", "developer", "operator"] as const;
export type HelpAudience = (typeof HELP_AUDIENCES)[number];

/**
 * What each visibility means, in the words the editor shows the author.
 * The consequence is stated, not the mechanism: an author picking a level
 * needs to know who ends up reading it, not which RLS policy runs.
 */
export const HELP_VISIBILITY_LABELS: Record<HelpVisibility, string> = {
  public: "Public",
  members: "Members only",
  internal: "Internal",
};

export const HELP_VISIBILITY_HINTS: Record<HelpVisibility, string> = {
  public: "Anyone can read it, and Google will index it.",
  members: "Only signed-in accounts. Never indexed, never in a sitemap.",
  internal: "Only admins. Operator runbooks, abuse thresholds, unreleased work.",
};

export const HELP_STATUS_LABELS: Record<HelpArticleStatus, string> = {
  draft: "Draft",
  published: "Published",
  archived: "Archived",
};

export const HELP_AUDIENCE_LABELS: Record<HelpAudience, string> = {
  all: "Everyone",
  seller: "Sellers",
  buyer: "Buyers",
  developer: "Developers",
  operator: "Operators",
};

export interface HelpFaqPair {
  question: string;
  answer: string;
}

export interface HelpCategory {
  key: string;
  title: string;
  slug: string;
  summary: string;
  sort_order: number;
  icon: string | null;
  /** Only present on index payloads. */
  article_count?: number;
}

export interface HelpArticle {
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
  faq: HelpFaqPair[] | null;
  related_slugs: string[] | null;
  video_url: string | null;
  pillar_path: string | null;
  published_at: string | null;
  reviewed_at: string | null;
  review_interval_days: number;
  created_at: string;
  updated_at: string;
}

/** What a create/update accepts. Every field optional except on create. */
export type HelpArticleInput = Partial<
  Pick<
    HelpArticle,
    | "slug"
    | "title"
    | "summary"
    | "body_html"
    | "body_json"
    | "body_markdown"
    | "category_key"
    | "audience"
    | "visibility"
    | "status"
    | "sort_order"
    | "hero_image_url"
    | "faq"
    | "related_slugs"
    | "video_url"
    | "pillar_path"
    | "reviewed_at"
    | "review_interval_days"
  >
>;

/** Mirrors slugifyHelp() on the edge, so the editor previews the real URL. */
export function slugifyHelp(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Mirrors RESERVED_HELP_SLUGS on the edge. */
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

export function isReservedHelpSlug(slug: string): boolean {
  return RESERVED_HELP_SLUGS.has(slug.toLowerCase());
}

// The hub's own copy. Kept identical to functions/_shared/help-render.ts, which
// serves the same words to crawlers — src/test/help-ssr.test.ts asserts the two
// match, because a title that differs between the SSR page and the SPA page is
// a title Google sees change on every hydration.
export const HELP_HUB_TITLE = "Help Center";
export const HELP_HUB_DESCRIPTION =
  "How to grade a garment, run the FlipDesk pipeline, connect a marketplace, " +
  "use the browser extension, and fix it when something goes wrong.";

export function helpHubPath(): string {
  return "/help";
}

/**
 * The seeded category shelf (US-2582).
 *
 * Mirrors the seed in supabase/migrations/00602_help_center_articles.sql, and
 * src/test/help-link-graph.test.ts fails if the two ever disagree. It exists so
 * PRERENDERED surfaces — the human HTML sitemap in particular — can link every
 * shelf in crawlable markup, which a client-side fetch cannot do.
 *
 * The titles here are for internal link text only. What a visitor reads on the
 * page itself comes from the database row, so renaming a shelf is still a
 * one-place change; this list going stale costs a slightly-off link label and a
 * failing test, not a broken URL.
 */
export const HELP_CATEGORIES: ReadonlyArray<{ key: string; slug: string; title: string }> = [
  { key: "getting-started", slug: "getting-started", title: "Getting started" },
  { key: "grading", slug: "grading", title: "Grading" },
  { key: "certificates", slug: "certificates", title: "Certificates and passports" },
  { key: "flipdesk", slug: "flipdesk", title: "FlipDesk" },
  { key: "marketplaces", slug: "marketplaces", title: "Marketplaces" },
  { key: "autolister", slug: "autolister", title: "AutoLister and bulk work" },
  { key: "extension", slug: "extension", title: "Browser extension" },
  { key: "mobile", slug: "mobile", title: "iPhone and Android apps" },
  { key: "buyers", slug: "buyers", title: "For buyers" },
  { key: "billing", slug: "billing", title: "Billing" },
  { key: "team", slug: "team", title: "Team and workspaces" },
  { key: "integrations", slug: "integrations", title: "API and integrations" },
  { key: "troubleshooting", slug: "troubleshooting", title: "Troubleshooting" },
  { key: "account", slug: "account", title: "Account and privacy" },
];

export function helpCategoryPath(categorySlug: string): string {
  return `/help/${categorySlug}`;
}

/** The public URL an article will live at, once published as 'public'. */
export function helpArticlePath(categorySlug: string, slug: string): string {
  return `/help/${categorySlug}/${slug}`;
}
