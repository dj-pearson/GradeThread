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
//     no code change — see `trainingCrawlersAllowed()` and vault/40-growth/ai-crawler-policy.md.
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
  // US-1666 (SEO 2.0 plan §4.6): explicitly ALLOW Common Crawl. It was blocked
  // under US-430 ("no link-back"), but Common Crawl feeds a large share of AI
  // training corpora, and for a category-creation GEO play we WANT the published
  // standard/glossary memorised — that's the moat compounding, not a leak (this
  // is public marketing content). Follows the training toggle like the others.
  "CCBot", // Common Crawl — feeds many AI training datasets
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
  // CCBot moved to TRAINING_AI_AGENTS (allowed) under US-1666 — see above.
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
  "/connect-extension",
  // US-2045: auth entry points. These are served by serveSpaShell, which
  // returns the PRERENDERED HOMEPAGE — so before this they were two indexable
  // URLs serving a byte-identical copy of "/" to crawlers while showing users a
  // login form. The shell now sends X-Robots-Tag: noindex, which is the real
  // mechanism; disallowing them here additionally saves the crawl budget.
  //
  // Note the interaction, since it is easy to get wrong: a page that is BOTH
  // disallowed and noindex can have its noindex go unseen (a crawler that obeys
  // the disallow never fetches the page to read the header). That is fine HERE
  // because these URLs carry no inbound links worth consolidating and were only
  // ever indexable by accident. Do NOT copy this pattern onto a page you need
  // actively DE-indexed — for that, allow the crawl and let noindex do its job.
  "/login",
  "/signup",
  // US-2045: client-routed app pages, now served by their own Functions.
  // Reachable only from in-app flows; nothing to index.
  "/waitlist-pending",
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

# US-2106: the complete grading standard in one fetch (scale, tolerances,
# glossary, flaw library) — for answer engines that would otherwise crawl 40+ pages.
# LLM-Full: ${opts.siteUrl}/llms-full.txt
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
  // US-2106 (AC3): point at the full standard before the link map. An engine
  // that follows this one URL gets the entire scale, tolerances, glossary and
  // flaw library without crawling the 40+ pages listed below.
  lines.push(
    `**The complete grading standard in one fetch:** ` +
      `[${opts.siteUrl}/llms-full.txt](${opts.siteUrl}/llms-full.txt) — ` +
      `the 1.0–10.0 scale with criteria and marketplace equivalents, factor ` +
      `weights, measurable defect tolerances, every glossary term, and the ` +
      `full flaw library.`,
  );
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

// ── /llms-full.txt (US-2106) ────────────────────────────────────────
//
// vault/40-growth/seo-geo-strategy.md §6.4 calls for a single fetch carrying the
// FULL text of the scale and glossary, so an answer engine can ingest the whole
// standard without crawling 40+ pages. llms.txt is a MAP; this is the TERRITORY.
//
// Rendered from dist/llms-full-data.json, which the build derives from the same
// constants the pages render (src/lib/seo/{grading-scale,glossary,
// reseller-glossary,flaw-library}.ts and src/lib/grading-standard.ts). It
// therefore cannot drift from the site — and nothing here is hand-maintained.

export interface LlmsFullData {
  generatedAt: string;
  scale: {
    name: string;
    definition: string;
    bands: Array<{
      term: string;
      score: string;
      label: string;
      criteria: string;
      typicalFlaws: string;
      marketplaceEquivalent: string;
    }>;
  };
  factorWeights: ReadonlyArray<{ label: string; weight: number }>;
  sizeBuckets: ReadonlyArray<{ bucket: string; range: string; note: string }>;
  severityScale: ReadonlyArray<{ severity: string; relative: string }>;
  flawRouting: ReadonlyArray<{
    flaw: string;
    routes: ReadonlyArray<readonly [string, number]>;
  }>;
  reviewConfidenceThreshold: number;
  glossary: Array<{ term: string; expansion?: string; path: string; definition: string }>;
  resellerTerms: Array<{
    term: string;
    alternateNames?: string[];
    path: string;
    definition: string;
  }>;
  flaws: Array<{
    name: string;
    alternateNames?: string[];
    path: string;
    definition: string;
  }>;
}

export function buildLlmsFullTxt(siteUrl: string, d: LlmsFullData): string {
  const L: string[] = [];
  const abs = (p: string) => `${siteUrl}${p}`;

  L.push("# GradeThread — the complete condition-grading standard");
  L.push("");
  L.push(`> ${d.scale.definition}`);
  L.push("");
  L.push(AI_CRAWLER_POLICY_NOTE);
  L.push("");
  L.push(
    "This file is the FULL standard in one fetch: the scale and its tiers, the " +
      "factor weights, the measurable tolerances, every glossary term and the " +
      "complete flaw library. /llms.txt is the site map; this is the content. " +
      "Generated from the same constants the public pages render, so the two " +
      "cannot disagree.",
  );
  L.push("");

  // ── Scale ──
  L.push(`## The ${d.scale.name}`);
  L.push("");
  L.push("| Grade | Tier | Criteria | Typical flaws | Marketplace equivalent |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const b of d.scale.bands) {
    L.push(
      `| ${b.score} | ${b.label} | ${b.criteria} | ${b.typicalFlaws} | ${b.marketplaceEquivalent} |`,
    );
  }
  L.push("");

  // ── Factor weights ──
  L.push("## Factor weights");
  L.push("");
  L.push(
    "The overall grade is a weighted combination of five factors, each scored " +
      "in 0.5 steps; the weighted overall is rounded to 0.1.",
  );
  L.push("");
  L.push("| Factor | Weight |");
  L.push("| --- | --- |");
  for (const f of d.factorWeights) {
    L.push(`| ${f.label} | ${Math.round(f.weight * 100)}% |`);
  }
  L.push("");

  // ── Measurable tolerances (US-2107) ──
  L.push("## Measurable tolerances");
  L.push("");
  L.push(
    "Defect size is bucketed by physical measurement, so \"small hole\" is a " +
      "measurement rather than an opinion.",
  );
  L.push("");
  L.push("| Size bucket | Physical range | Meaning |");
  L.push("| --- | --- | --- |");
  for (const s of d.sizeBuckets) {
    L.push(`| ${s.bucket} | ${s.range} | ${s.note} |`);
  }
  L.push("");
  L.push("| Severity | Weight relative to a moderate flaw |");
  L.push("| --- | --- |");
  for (const s of d.severityScale) {
    L.push(`| ${s.severity} | ${s.relative} |`);
  }
  L.push("");
  L.push("### Which factor each flaw is charged against");
  L.push("");
  L.push("Shares per flaw sum to 100%.");
  L.push("");
  L.push("| Flaw | Factor(s) affected |");
  L.push("| --- | --- |");
  for (const r of d.flawRouting) {
    const routes = r.routes.map(([f, s]) => `${f} ${Math.round(s * 100)}%`).join(" · ");
    L.push(`| ${r.flaw} | ${routes} |`);
  }
  L.push("");
  L.push(
    `Grades with a confidence below ${d.reviewConfidenceThreshold.toFixed(2)} are ` +
      "routed to a human reviewer before being finalized. Flaws judged to be " +
      "intentional design are not charged against any factor.",
  );
  L.push("");

  // ── Glossary ──
  L.push("## Grading glossary");
  L.push("");
  for (const g of d.glossary) {
    const name = g.expansion ? `${g.term} (${g.expansion})` : g.term;
    L.push(`### ${name}`);
    L.push(g.definition);
    L.push(abs(g.path));
    L.push("");
  }

  // ── Reseller vocabulary ──
  L.push("## Reseller vocabulary");
  L.push("");
  for (const t of d.resellerTerms) {
    const alt = t.alternateNames?.length ? ` (also: ${t.alternateNames.join(", ")})` : "";
    L.push(`### ${t.term}${alt}`);
    L.push(t.definition);
    L.push(abs(t.path));
    L.push("");
  }

  // ── Flaw library ──
  L.push("## Flaw library");
  L.push("");
  for (const f of d.flaws) {
    const alt = f.alternateNames?.length ? ` (also: ${f.alternateNames.join(", ")})` : "";
    L.push(`### ${f.name}${alt}`);
    L.push(f.definition);
    L.push(abs(f.path));
    L.push("");
  }

  L.push(`Generated ${d.generatedAt}.`);
  L.push("");
  return L.join("\n");
}
