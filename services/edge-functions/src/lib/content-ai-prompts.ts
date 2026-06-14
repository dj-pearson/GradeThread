// Prompt templates for the content module's AI calls. Keep them in one
// place so a voice change is a single edit. Each export is a pure
// function: in → string. The generator libs assemble system prompts
// from knowledge docs + history context and then call these.
//
// Versioning: the `_v1` suffix is recorded with each generation in
// case we want to A/B prompts later. Bump the suffix on material changes.

import type { ContentProduct, ContentSurface } from "./content-history.ts";

interface ResearchCandidate {
  title: string;
  angle: string;
  primary_keyword: string;
  secondary_keywords: string[];
  search_intent: string;
}

// ──────────────────────────────────────────────────────────
// SYSTEM PROMPT BUILDER (shared)
// ──────────────────────────────────────────────────────────
// Assembles a system message from the curated knowledge docs +
// the distilled history context. Keeps the per-call user prompts
// small (just the topic) and keeps voice rules in one durable place.

export function buildSystemPrompt(input: {
  brandVoice: string;
  surfaceStyle: string;
  pillarMap: string;
  historyContext: string;
  task:
    | "write-blog-article"
    | "write-social-post"
    | "research-topics"
    | "regenerate-section";
}): string {
  const taskHeader =
    {
      "write-blog-article":
        "Your task is to write a single, SEO-targeted blog article.",
      "write-social-post":
        "Your task is to write a paired long-format and short-format social post for one topic.",
      "research-topics":
        "Your task is to propose a batch of fresh topic candidates that do NOT overlap with anything in the history index.",
      "regenerate-section":
        "Your task is to regenerate or rewrite a specific passage of an existing article.",
    }[input.task];

  return [
    "# Role",
    "You write content for GradeThread (AI clothing condition grading) and FlipDesk (reseller management for thrifters/eBay sellers). " +
      taskHeader,
    "",
    "# Brand voice",
    input.brandVoice,
    "",
    "# Surface style",
    input.surfaceStyle,
    "",
    "# SEO pillar map (territory we cover)",
    input.pillarMap,
    "",
    "# What we have already covered (do not duplicate)",
    input.historyContext || "(no prior posts)",
    "",
    "# Output rules",
    "- Respond with ONLY valid JSON matching the schema in the user message.",
    "- No markdown fences, no preamble, no explanation outside the JSON.",
    "- If a field is optional and you have nothing to say, return an empty string or empty array — never omit the key.",
  ].join("\n");
}

// ──────────────────────────────────────────────────────────
// STREAMING SYSTEM PROMPT (US-251 / US-252)
// ──────────────────────────────────────────────────────────
// The batch generator asks for a JSON envelope; that can't be inserted into
// the editor mid-stream. For the live-streaming features we want the model to
// emit clean HTML directly, so the deltas are insertable as they arrive.

export function buildStreamSystemPrompt(input: {
  brandVoice: string;
  surfaceStyle: string;
  pillarMap: string;
  task: "compose-article" | "regenerate-section";
}): string {
  const taskHeader =
    input.task === "compose-article"
      ? "Your task is to write a single SEO-targeted blog article, streamed as HTML."
      : "Your task is to rewrite a specific passage of an existing article, streamed as HTML.";

  return [
    "# Role",
    "You write content for GradeThread (AI clothing condition grading) and FlipDesk (reseller management for thrifters/eBay sellers). " +
      taskHeader,
    "",
    "# Brand voice",
    input.brandVoice,
    "",
    "# Surface style",
    input.surfaceStyle,
    "",
    "# SEO pillar map (territory we cover)",
    input.pillarMap,
    "",
    "# Output rules",
    "- Respond with ONLY the HTML content — no JSON, no markdown code fences, no preamble or commentary.",
    "- Use semantic tags: <h2>, <h3>, <p>, <ul><li>, <ol><li>, <blockquote>, <table>. Do NOT emit <html>, <head>, <body>, <script>, inline style, or on* handlers.",
    "- Begin output immediately with the first content tag.",
  ].join("\n");
}

// US-251: stream a full article body (HTML) for the given topic. No title/SEO
// envelope — those stay on the batch generator; this just fills the editor.
export function buildBlogComposeStreamUserPrompt(input: {
  title: string;
  angle: string | null;
  primary_keyword: string;
  secondary_keywords: string[];
  search_intent: string | null;
  product_focus: ContentProduct;
  instruction?: string;
}): string {
  return [
    "Write the body of a single blog article as streamed HTML.",
    "",
    `Working title: ${input.title}`,
    input.angle ? `Angle: ${input.angle}` : "",
    `Primary keyword: ${input.primary_keyword}`,
    input.secondary_keywords.length > 0
      ? `Secondary keywords: ${input.secondary_keywords.join(", ")}`
      : "",
    input.search_intent ? `Search intent: ${input.search_intent}` : "",
    `Product focus: ${input.product_focus}`,
    input.instruction ? `Extra direction: ${input.instruction}` : "",
    "",
    "Length: 1200–2000 words. Start at <h2> (the page already renders the title as <h1>). 4–7 H2 sections, H3 sparingly. Include at least one list or comparison table. Open with a concrete scenario; close with a low-pressure CTA. Output HTML only.",
  ]
    .filter(Boolean)
    .join("\n");
}

// US-252: stream a replacement passage (HTML) for a selected section.
export function buildSectionRegenStreamUserPrompt(input: {
  mode: "regenerate" | "expand" | "rewrite-for-keyword";
  selection_html: string;
  primary_keyword?: string;
  surrounding_context?: string;
}): string {
  const modeHint = {
    regenerate:
      "Regenerate the selection. Same intent, fresher phrasing, same approximate length.",
    expand:
      "Expand the selection. Add concrete examples or a short list. ~2× length.",
    "rewrite-for-keyword":
      `Rewrite the selection to naturally target the keyword "${
        input.primary_keyword ?? ""
      }" without keyword stuffing.`,
  }[input.mode];

  return [
    modeHint,
    "",
    input.surrounding_context
      ? `Surrounding context (do not return this — for awareness only):\n${input.surrounding_context}\n`
      : "",
    "Selection HTML:",
    input.selection_html,
    "",
    "Return ONLY the replacement HTML for the selection. No JSON, no fences, no commentary.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ──────────────────────────────────────────────────────────
// BLOG ARTICLE GENERATION (v1)
// ──────────────────────────────────────────────────────────

export const BLOG_ARTICLE_PROMPT_VERSION = "blog_article_v2";

export interface BlogTopicInput {
  title: string;
  angle: string | null;
  primary_keyword: string;
  secondary_keywords: string[];
  search_intent: string | null;
  product_focus: ContentProduct;
}

export function buildBlogArticleUserPrompt(topic: BlogTopicInput): string {
  return [
    "Write a single blog article for the following topic.",
    "",
    `Title (working): ${topic.title}`,
    topic.angle ? `Angle: ${topic.angle}` : "",
    `Primary keyword: ${topic.primary_keyword}`,
    topic.secondary_keywords.length > 0
      ? `Secondary keywords: ${topic.secondary_keywords.join(", ")}`
      : "",
    topic.search_intent ? `Search intent: ${topic.search_intent}` : "",
    `Product focus: ${topic.product_focus}`,
    "",
    "Length: 1500–2200 words. One H1 (= final title). 4–7 H2 sections, use H3 sparingly.",
    "Include at least one numbered list OR comparison table.",
    "Open with a specific scenario (no 'in this article we will explore'). Close with a clear, low-pressure CTA.",
    "",
    "Return JSON matching exactly this schema:",
    "{",
    '  "title": "<final title — may differ from working title; use the strongest of your title_suggestions>",',
    '  "title_suggestions": [',
    '    { "style": "question",  "title": "<a question-framed headline>" },',
    '    { "style": "listicle",  "title": "<a numbered/list-framed headline>" },',
    '    { "style": "contrarian","title": "<a myth-busting / against-the-grain headline>" }',
    "  ],",
    '  "slug": "<lowercase-kebab-slug, ≤80 chars>",',
    '  "excerpt": "<140–180 char hook for OG description and feed snippets>",',
    '  "body_html": "<the article as semantic HTML: <h1>…</h1><p>…</p><h2>…</h2><ul><li>…</li></ul><table>…</table>. No <script>, no inline style, no onclick handlers.>",',
    '  "seo_title": "<≤60 chars, includes primary keyword>",',
    '  "seo_description": "<≤155 chars, includes primary keyword, ends with a clear value prop>",',
    '  "primary_keyword": "<echo the input primary_keyword, lowercase>",',
    '  "secondary_keywords": ["<3–5 long-tail keywords actually used in the body>"],',
    '  "tags": ["<3–6 high-level topic tags suitable for /blog/tag/[tag] pages>"],',
    '  "reading_time_min": <integer>,',
    '  "hero_prompt": "<a 1–2 sentence image prompt for a hero photo that matches this article — no text in the image, photographic realism preferred>",',
    '  "summary_one_line": "<single sentence, ≤140 chars, for the history index>"',
    "}",
  ]
    .filter(Boolean)
    .join("\n");
}

// ──────────────────────────────────────────────────────────
// SOCIAL POST GENERATION (v1)
// ──────────────────────────────────────────────────────────

// v2 (US-870): the model now also returns a tailored variant per enabled
// platform (X/LinkedIn/Facebook/Threads/Pinterest/Instagram) in the same call,
// alongside the legacy long_body/short_body the rest of the system still reads.
export const SOCIAL_POST_PROMPT_VERSION = "social_post_v2";

export interface SocialTopicInput {
  title: string;
  angle: string | null;
  primary_keyword: string;
  product_focus: ContentProduct;
  cta_url: string; // already includes utm_*
}

// A platform + its hard rules, passed in by the caller (content-ai-social.ts)
// from social-platforms.ts so the prompt and the spec never drift.
export interface SocialPlatformPromptSpec {
  platform: string;
  rules: string;
}

export function buildSocialPostUserPrompt(
  topic: SocialTopicInput,
  platforms: SocialPlatformPromptSpec[] = [],
): string {
  const variantBlock = platforms.length > 0
    ? [
      "",
      "Also write a tailored variant for EACH of these platforms — same idea,",
      "but matched to that network's length, tone, hashtag, and link conventions:",
      ...platforms.map((p) => `- ${p.platform}: ${p.rules}`),
      "",
      'Add a "variants" object keyed by platform. For each platform include',
      '"body" (the post text, honoring its character limit) and "hashtags"',
      "(lowercase, no spaces, no '#' prefix). Only include the platforms listed above.",
    ]
    : [];

  const variantSchema = platforms.length > 0
    ? [
      "  ,",
      '  "variants": {',
      ...platforms.map(
        (p, i) =>
          `    "${p.platform}": { "body": "<see rules>", "hashtags": ["reselling"] }${
            i < platforms.length - 1 ? "," : ""
          }`,
      ),
      "  }",
    ]
    : [];

  return [
    "Write a paired long-format and short-format social post for this topic.",
    "",
    `Topic: ${topic.title}`,
    topic.angle ? `Angle: ${topic.angle}` : "",
    `Primary keyword (for tone, not stuffing): ${topic.primary_keyword}`,
    `Product focus: ${topic.product_focus}`,
    `CTA URL (include in long_body and short_body): ${topic.cta_url}`,
    "",
    "Long body: 800–1500 characters. Hook line on its own. One blank line between paragraphs. End with the CTA URL on its own line.",
    "Short body: ≤280 characters TOTAL including the URL. One thought, sharp insight, link.",
    "Hashtags: 3–5 lowercase, no spaces, no '#' prefix in the array values.",
    ...variantBlock,
    "",
    "Return JSON matching exactly this schema:",
    "{",
    '  "long_body": "<see rules above>",',
    '  "short_body": "<see rules above, ≤280 chars>",',
    '  "hashtags": ["reselling","thrifting"]',
    ...variantSchema,
    "}",
  ]
    .filter(Boolean)
    .join("\n");
}

// ──────────────────────────────────────────────────────────
// TOPIC RESEARCH (v1)
// ──────────────────────────────────────────────────────────

export const TOPIC_RESEARCH_PROMPT_VERSION = "topic_research_v1";

export function buildResearchUserPrompt(input: {
  surface: ContentSurface;
  productFocus: ContentProduct;
  count: number;
}): string {
  const surfaceHint =
    input.surface === "blog"
      ? "long-form blog articles (1500–2200 words, evergreen, search-traffic targets)"
      : "social posts (short opinionated takes that link back to the site)";

  return [
    `Propose ${input.count} fresh topic candidates for ${surfaceHint} on the ${input.productFocus} side.`,
    "",
    "Constraints:",
    "- Each topic must ladder up to a pillar from the SEO pillar map in the system prompt.",
    "- Each primary_keyword MUST be a long-tail buyer-intent phrase (4+ words), not a head term.",
    "- Do NOT propose any topic whose primary_keyword overlaps semantically with anything in the history index.",
    "- Spread across pillars — don't return 10 variants of the same idea.",
    "",
    "Return JSON: { \"candidates\": [ { \"title\": \"...\", \"angle\": \"...\", \"primary_keyword\": \"...\", \"secondary_keywords\": [\"...\"], \"search_intent\": \"informational|commercial|transactional\" } ] }",
  ].join("\n");
}

// ──────────────────────────────────────────────────────────
// SECTION REGENERATION (v1)
// ──────────────────────────────────────────────────────────

export const SECTION_REGEN_PROMPT_VERSION = "section_regen_v1";

export function buildSectionRegenUserPrompt(input: {
  mode: "regenerate" | "expand" | "rewrite-for-keyword";
  selection_html: string;
  primary_keyword?: string;
  surrounding_context?: string;
}): string {
  const modeHint = {
    regenerate:
      "Regenerate the selection. Same intent, fresher phrasing, same approximate length.",
    expand:
      "Expand the selection. Add concrete examples or a short list. ~2× length.",
    "rewrite-for-keyword":
      `Rewrite the selection to naturally target the keyword "${
        input.primary_keyword ?? ""
      }" without keyword stuffing.`,
  }[input.mode];

  return [
    modeHint,
    "",
    input.surrounding_context
      ? `Surrounding context (do not return this — for awareness only):\n${input.surrounding_context}\n`
      : "",
    "Selection HTML:",
    input.selection_html,
    "",
    'Return JSON: { "replacement_html": "<the new HTML, no <script>, no inline event handlers>" }',
  ]
    .filter(Boolean)
    .join("\n");
}

// ──────────────────────────────────────────────────────────
// TYPED OUTPUT SHAPES (what the generator libs validate against)
// ──────────────────────────────────────────────────────────

export type TitleSuggestionStyle = "question" | "listicle" | "contrarian";

export interface TitleSuggestion {
  style: TitleSuggestionStyle;
  title: string;
}

// US-254: normalize the model's title_suggestions into 1–3 typed slots,
// deduping and capping. Always returns at least one entry so the editor's
// title picker has something to show even when the model omits the field.
export function normalizeTitleSuggestions(
  input: unknown,
  fallbackTitle: string,
): TitleSuggestion[] {
  const allowed: TitleSuggestionStyle[] = ["question", "listicle", "contrarian"];
  const out: TitleSuggestion[] = [];
  const seen = new Set<string>();
  if (Array.isArray(input)) {
    for (const raw of input) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const title = String(r.title ?? "").trim();
      if (!title || seen.has(title.toLowerCase())) continue;
      const styleRaw = String(r.style ?? "").trim().toLowerCase();
      const style = (allowed as string[]).includes(styleRaw)
        ? (styleRaw as TitleSuggestionStyle)
        : "question";
      seen.add(title.toLowerCase());
      out.push({ style, title });
      if (out.length >= 3) break;
    }
  }
  if (out.length === 0) out.push({ style: "question", title: fallbackTitle });
  return out;
}

export interface BlogArticleOutput {
  title: string;
  // US-254: A/B title candidates (one per slot). Always ≥1 (falls back to
  // [{ style:'question', title }] when the model omits them).
  titleSuggestions: TitleSuggestion[];
  slug: string;
  excerpt: string;
  body_html: string;
  seo_title: string;
  seo_description: string;
  primary_keyword: string;
  secondary_keywords: string[];
  tags: string[];
  reading_time_min: number;
  hero_prompt: string;
  summary_one_line: string;
}

// US-870: one tailored, normalized variant per platform.
export interface SocialVariantOutput {
  platform: string;
  body: string;
  hashtags: string[];
  char_limit: number;
  image_field: string;
}

export interface SocialPostOutput {
  long_body: string;
  short_body: string;
  hashtags: string[];
  // Platform-tailored variants (US-870). Empty when no platforms requested.
  variants: SocialVariantOutput[];
}

export interface TopicResearchOutput {
  candidates: ResearchCandidate[];
}

export interface SectionRegenOutput {
  replacement_html: string;
}
