// Pure builders for robots.txt and llms.txt (PRD: tasks/prd-seo-hardening.md,
// US-295). Kept dependency-free (no Cloudflare types) so they're unit-testable
// from the src/ test suite and reusable by the Pages Function handlers.

// AI + search crawlers we explicitly welcome — we WANT these answering with
// (and citing) GradeThread content. Each gets an Allow on the public site.
export const ALLOWED_AI_AGENTS: readonly string[] = [
  // Traditional search
  "Googlebot",
  "Bingbot",
  // OpenAI
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  // Anthropic
  "ClaudeBot",
  "Claude-User",
  // Perplexity
  "PerplexityBot",
  "Perplexity-User",
  // Google Gemini / Vertex training opt-in
  "Google-Extended",
  // Apple Intelligence
  "Applebot",
  "Applebot-Extended",
];

// Aggressive / non-attributing scrapers to disallow site-wide. Empty by
// default — flip entries in here to block without touching handler code.
export const BLOCKED_AI_AGENTS: readonly string[] = [
  // "Bytespider",
  // "CCBot",
];

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
  allowed?: readonly string[];
  blocked?: readonly string[];
}): string {
  const allowed = opts.allowed ?? ALLOWED_AI_AGENTS;
  const blocked = opts.blocked ?? BLOCKED_AI_AGENTS;
  const disallowLines = DISALLOWED_PATHS.map((p) => `Disallow: ${p}`).join("\n");

  const blocks: string[] = [];

  // Default policy for everything else: index the public site.
  blocks.push(`User-agent: *
Allow: /
Allow: /blog/
${disallowLines}`);

  // Explicit per-agent allow blocks. Redundant with "*" today, but documents
  // intent and survives future tightening of the default policy.
  for (const ua of allowed) {
    blocks.push(`User-agent: ${ua}
Allow: /
${disallowLines}`);
  }

  // Hard blocks for unwanted scrapers.
  for (const ua of blocked) {
    blocks.push(`User-agent: ${ua}
Disallow: /`);
  }

  return `${blocks.join("\n\n")}

Sitemap: ${opts.siteUrl}/sitemap.xml
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
}): string {
  const lines: string[] = [];
  lines.push(`# GradeThread`);
  lines.push("");
  lines.push(`> ${opts.summary}`);
  lines.push("");
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
      { title: "RSS feed", url: "/rss.xml", note: "Latest published articles." },
    ],
  });
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
