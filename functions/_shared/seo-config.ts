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
