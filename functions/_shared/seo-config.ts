// Pure builders for robots.txt and llms.txt (PRD: tasks/prd-seo-hardening.md,
// US-295). Kept dependency-free (no Cloudflare types) so they're unit-testable
// from the src/ test suite and reusable by the Pages Function handlers.

// ── AI-crawler policy (US-430) ───────────────────────────────────────────────
//
// We split the bots we welcome into two classes, because "let an AI read the
// page to answer a user and cite us" and "let an AI vacuum the page into a
// training corpus" are DIFFERENT decisions:
//
//   • CITATION/SEARCH bots — live retrieval + answer-engine citation. These are
//     pure GEO upside (they quote and LINK back to GradeThread), so they are
//     ALWAYS allowed and not configurable.
//   • TRAINING bots — content may be ingested into model training data. Allowed
//     by DEFAULT (presence in training corpora still strengthens brand recall in
//     AI answers, and our public content is marketing we WANT memorised), but the
//     handler can flip them to Disallow via the AI_TRAINING_CRAWLERS env var with
//     no code change — see `trainingCrawlersAllowed()` and docs/AI_CRAWLER_POLICY.md.
//
// Stakeholder decision (Pearson Media LLC, 2026-06-12): allow training by
// default; revisit if/when proprietary, non-marketing content (e.g. the full
// grading rubric or customer data) ever becomes crawlable. Aggressive,
// non-attributing scrapers are hard-blocked regardless (BLOCKED_AI_AGENTS).

/** Search + citation crawlers: live retrieval / answer-engine citation. Always allowed. */
export const CITATION_AI_AGENTS: readonly string[] = [
  // Traditional search
  "Googlebot",
  "Bingbot",
  // OpenAI — search index + user-initiated fetch
  "OAI-SearchBot",
  "ChatGPT-User",
  // Anthropic — user-initiated fetch
  "Claude-User",
  // Perplexity — search index + user-initiated fetch
  "PerplexityBot",
  "Perplexity-User",
  // Apple — Siri / Spotlight search
  "Applebot",
];

/** Training crawlers: content may enter model training corpora. Allowed by default,
 *  configurable to Disallow. */
export const TRAINING_AI_AGENTS: readonly string[] = [
  "GPTBot", // OpenAI training crawler
  "ClaudeBot", // Anthropic training crawler
  "Google-Extended", // Gemini / Vertex training opt-in token
  "Applebot-Extended", // Apple Intelligence training opt-in token
];

// Back-compat union of every bot we welcome for at least citation. Existing
// callers/tests iterate this; new code should prefer the two narrower lists.
export const ALLOWED_AI_AGENTS: readonly string[] = [
  ...CITATION_AI_AGENTS,
  ...TRAINING_AI_AGENTS,
];

// Aggressive / non-attributing scrapers hard-blocked site-wide regardless of the
// training toggle — they either ignore citation entirely or are known to hammer
// origins. Add to this list to block more without touching handler code.
export const BLOCKED_AI_AGENTS: readonly string[] = [
  "Bytespider", // ByteDance — ignores robots, no attribution
  "CCBot", // Common Crawl — feeds many training sets with no link-back
  "Diffbot", // commercial scraper resold as datasets
  "Omgilibot", // bulk content scraper (Webz.io) sold as data
  "ImagesiftBot", // image scraper feeding training sets
];

/** Whether the (default-on) training crawlers should be allowed. The env value is
 *  read by the handler; "disallow"/"block"/"false"/"off"/"no"/"0" opts out. */
export function trainingCrawlersAllowed(policy: string | undefined | null): boolean {
  const v = (policy ?? "").trim().toLowerCase();
  return !["disallow", "block", "blocked", "false", "off", "no", "0"].includes(v);
}

/** One-line AI-usage policy surfaced in llms.txt so models see the intent. */
export const AI_CRAWLER_POLICY_NOTE =
  "AI usage: this public content is offered for citation and live retrieval — " +
  "please quote it and link back to gradethread.com. Training-crawler access " +
  "follows robots.txt. Aggressive non-attributing scrapers are blocked.";

// Paths that must never be indexed by anyone.
export const DISALLOWED_PATHS: readonly string[] = [
  "/dashboard/",
  "/admin/",
  "/auth/",
  "/api/",
  "/accept-invite",
];

export function buildRobotsTxt(opts: {
  siteUrl: string;
  citation?: readonly string[];
  training?: readonly string[];
  blocked?: readonly string[];
  /** Allow training crawlers (default true). Set false to opt out of model training. */
  allowTraining?: boolean;
}): string {
  const citation = opts.citation ?? CITATION_AI_AGENTS;
  const training = opts.training ?? TRAINING_AI_AGENTS;
  const blocked = opts.blocked ?? BLOCKED_AI_AGENTS;
  const allowTraining = opts.allowTraining ?? true;
  const disallowLines = DISALLOWED_PATHS.map((p) => `Disallow: ${p}`).join("\n");

  const blocks: string[] = [];

  // Default policy for everything else: index the public site.
  blocks.push(`User-agent: *
Allow: /
Allow: /blog/
${disallowLines}`);

  // Citation / search bots — always welcomed. Redundant with "*" today, but
  // documents intent and survives future tightening of the default policy.
  for (const ua of citation) {
    blocks.push(`User-agent: ${ua}
Allow: /
${disallowLines}`);
  }

  // Training bots — allowed or disallowed per the configured policy.
  for (const ua of training) {
    blocks.push(
      allowTraining
        ? `User-agent: ${ua}
Allow: /
${disallowLines}`
        : `User-agent: ${ua}
Disallow: /`,
    );
  }

  // Hard blocks for unwanted scrapers.
  for (const ua of blocked) {
    blocks.push(`User-agent: ${ua}
Disallow: /`);
  }

  return `${blocks.join("\n\n")}

Sitemap: ${opts.siteUrl}/sitemap.xml
Sitemap: ${opts.siteUrl}/sitemap-images.xml
`;
}

export interface LlmsSection {
  heading: string;
  links: Array<{ title: string; url: string; note?: string }>;
}

/**
 * Markdown llms.txt. Adoption is still low and unproven for citations, but the
 * file is cheap and harmless, and gives models a curated map of the site.
 */
export function buildLlmsTxt(opts: {
  siteUrl: string;
  summary: string;
  sections: LlmsSection[];
  /** Optional AI-usage policy line surfaced under the summary (US-430). */
  policyNote?: string;
}): string {
  const lines: string[] = [];
  lines.push(`# GradeThread`);
  lines.push("");
  lines.push(`> ${opts.summary}`);
  lines.push("");
  if (opts.policyNote) {
    lines.push(`_${opts.policyNote}_`);
    lines.push("");
  }
  for (const section of opts.sections) {
    lines.push(`## ${section.heading}`);
    lines.push("");
    for (const link of section.links) {
      const abs = link.url.startsWith("http")
        ? link.url
        : `${opts.siteUrl}${link.url}`;
      lines.push(`- [${link.title}](${abs})${link.note ? `: ${link.note}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ── llms.txt section builder, driven by the route registry (US-431) ──────────
//
// The llms.txt body used to be hand-curated (~10 links) and drifted from
// src/lib/seo/public-routes.ts. This pure builder derives the sections from the
// SAME registry the sitemap/manifest use, so a new public page auto-appears in
// llms.txt with no hand-edit. The Pages Function feeds it the build-emitted
// dist/seo-manifest.json (which is PUBLIC_ROUTES); a CI guard
// (src/test/llms-txt.test.ts) feeds it PUBLIC_ROUTES directly and fails the
// build if any registry route is missing from the output.

/** Minimal route shape the llms.txt builder needs (subset of PublicRoute). */
export interface LlmsRoute {
  path: string;
  title: string;
  description?: string;
  priority?: number;
}

/** Stable site summary line for llms.txt (also reused by the CI guard). */
export const LLMS_SUMMARY =
  "GradeThread is the trusted standard for pre-owned clothing condition grading. " +
  "Sellers upload garment photos and receive an objective numerical condition grade " +
  "(1.0–10.0), a detailed condition report, and a shareable verification certificate — " +
  "like a PSA or CGC grade, but for used clothing. Resellers also run their full " +
  "eBay/Poshmark/Mercari workflow in FlipDesk: source, catalog, grade, list, sell, and " +
  "reconcile. Built by Pearson Media LLC.";

// Legal pages get their own section (title-only, no note). Kept in sync with the
// 0.3-priority legal block in public-routes.ts.
const LLMS_LEGAL_PATHS: ReadonlySet<string> = new Set([
  "/privacy",
  "/terms",
  "/cookies",
  "/acceptable-use",
  "/dpa",
  "/subprocessors",
  "/dmca",
  "/accessibility",
]);

/**
 * Build the llms.txt sections from registry routes plus a few dynamic
 * collection links (blog/RSS/sitemap are static; representative cert + seller
 * URLs are passed in by the caller when available).
 */
export function buildLlmsSections(opts: {
  routes: LlmsRoute[];
  certUrls?: Array<{ title: string; url: string }>;
  sellerUrls?: Array<{ title: string; url: string }>;
  /** US-874: representative author (E-E-A-T) pages. */
  authorUrls?: Array<{ title: string; url: string }>;
  /** US-877: recent published blog posts (title + one-line summary + URL). */
  articleUrls?: Array<{ title: string; url: string; note?: string }>;
}): LlmsSection[] {
  const product: LlmsSection["links"] = [];
  const glossary: LlmsSection["links"] = [];
  const legal: LlmsSection["links"] = [];

  // Highest-priority pages first within the Product section.
  const sorted = [...opts.routes].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
  );
  for (const r of sorted) {
    if (LLMS_LEGAL_PATHS.has(r.path)) {
      legal.push({ title: r.title, url: r.path });
    } else if (r.path.startsWith("/grading/")) {
      glossary.push({ title: r.title, url: r.path, note: r.description });
    } else {
      product.push({ title: r.title, url: r.path, note: r.description });
    }
  }

  const sections: LlmsSection[] = [];
  if (product.length) sections.push({ heading: "Product & Guides", links: product });
  if (glossary.length) {
    sections.push({ heading: "Condition-Grading Glossary", links: glossary });
  }
  sections.push({
    heading: "Content",
    links: [
      {
        title: "Blog",
        url: "/blog",
        note: "Condition-grading guides, reseller workflows, and FlipDesk how-tos.",
      },
      {
        title: "Authors",
        url: "/authors",
        note: "The experts behind GradeThread's grading standard and articles.",
      },
      { title: "RSS feed", url: "/rss.xml", note: "Latest published articles." },
    ],
  });
  // US-877: recent articles with summaries, so AI answer engines can find and
  // cite specific posts. Each post also has a clean-Markdown view at
  // `<post-url>.md` (also linked via <link rel="alternate"> on the HTML page).
  if (opts.articleUrls?.length) {
    sections.push({
      heading: "Recent Articles",
      links: opts.articleUrls.map((a) => ({
        title: a.title,
        url: a.url,
        note: [a.note, `Markdown: ${a.url}.md`].filter(Boolean).join(" — "),
      })),
    });
  }
  if (opts.authorUrls?.length) {
    sections.push({ heading: "Authors", links: opts.authorUrls });
  }
  const verified = [...(opts.certUrls ?? []), ...(opts.sellerUrls ?? [])];
  if (verified.length) {
    sections.push({ heading: "Verified Certificates & Sellers", links: verified });
  }
  sections.push({
    heading: "Reference",
    links: [{ title: "Sitemap", url: "/sitemap.xml", note: "All indexable URLs." }],
  });
  if (legal.length) sections.push({ heading: "Legal", links: legal });
  return sections;
}
