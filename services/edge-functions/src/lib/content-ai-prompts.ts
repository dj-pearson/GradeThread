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
    | "regenerate-section"
    | "refresh-article";
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
      "refresh-article":
        "Your task is to refresh and improve an existing, already-published blog article so it stays accurate, current, and competitive — without rewriting it from scratch.",
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

export const BLOG_ARTICLE_PROMPT_VERSION = "blog_article_v3";

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
    "Open ANSWER-FIRST: the opening paragraph must directly answer the core question / state the takeaway in 1–2 sentences before any context, so AI assistants can quote it (no 'in this article we will explore').",
    "If this is a how-to / step-by-step topic, include the procedure as an explicit ordered list (<ol><li>…</li></ol>) where each <li> is one concrete action step in order — this is the source for HowTo structured data.",
    "Use the CANONICAL GradeThread grading vocabulary verbatim where relevant so it matches our glossary: the tiers NWT, NWOT, Excellent, Very Good, Good, Fair, Poor, and the five factors Fabric Condition, Structural Integrity, Cosmetic Appearance, Functional Elements, Odor & Cleanliness. Do not invent synonyms for these terms.",
    "Close with a clear, low-pressure CTA.",
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
    '  "hero_image_alt": "<concise descriptive alt text for that hero image, ≤125 chars, naturally includes the primary keyword, describes what is depicted — no \\"image of\\"/\\"photo of\\" prefix>",',
    '  "hero_image_caption": "<optional ≤120 char human caption for the hero (empty string if none)>",',
    '  "summary_one_line": "<single sentence, ≤140 chars, for the history index>"',
    "}",
  ]
    .filter(Boolean)
    .join("\n");
}

// ──────────────────────────────────────────────────────────
// BLOG ARTICLE REFRESH (US-875)
// ──────────────────────────────────────────────────────────
// The freshness loop re-runs an EXISTING published post through the model to
// expand thin sections, correct anything stale, and tighten the answer-first
// blocks (key takeaways + FAQs). Unlike generation, the title and slug are
// FIXED — we never break the canonical URL — and the model is told to preserve
// what already works rather than start over. The job decides whether the result
// is materially different before it writes anything (see content-freshness.ts).
export const BLOG_REFRESH_PROMPT_VERSION = "blog_refresh_v1";

export interface BlogRefreshInput {
  title: string; // fixed — do not change
  primary_keyword: string;
  secondary_keywords: string[];
  product_focus: ContentProduct;
  current_html: string;
  current_excerpt: string | null;
  current_key_takeaways: string[];
  current_faqs: Array<{ q: string; a: string }>;
  published_at: string | null;
}

export function buildBlogRefreshUserPrompt(input: BlogRefreshInput): string {
  const faqLines = input.current_faqs.length > 0
    ? input.current_faqs.map((f) => `- Q: ${f.q}\n  A: ${f.a}`).join("\n")
    : "(none)";
  return [
    "Refresh and improve this already-published blog article. Keep everything that works; do NOT rewrite from scratch and do NOT change the title.",
    "",
    `Title (FIXED — keep exactly): ${input.title}`,
    `Primary keyword: ${input.primary_keyword}`,
    input.secondary_keywords.length > 0
      ? `Secondary keywords: ${input.secondary_keywords.join(", ")}`
      : "",
    `Product focus: ${input.product_focus}`,
    input.published_at ? `Originally published: ${input.published_at.slice(0, 10)}` : "",
    "",
    "Current key takeaways:",
    input.current_key_takeaways.length > 0
      ? input.current_key_takeaways.map((k) => `- ${k}`).join("\n")
      : "(none)",
    "",
    "Current FAQs:",
    faqLines,
    "",
    "Current article body (HTML):",
    input.current_html,
    "",
    "How to refresh:",
    "- Expand thin or shallow sections with concrete specifics; add a new H2 section only if it genuinely adds value.",
    "- Correct anything dated, and add current best-practice detail where the topic has moved on.",
    "- Keep the strongest existing sentences; this is an edit, not a teardown.",
    "- Do NOT add an H1 (the page renders the title separately). Start body at <h2>.",
    "- For how-to / step-by-step topics, ensure the procedure is an explicit ordered list (<ol><li>…</li></ol>), one action per step, so HowTo structured data has real source content.",
    "- Use the canonical grading vocabulary verbatim (tiers NWT/NWOT/Excellent/Very Good/Good/Fair/Poor; factors Fabric Condition, Structural Integrity, Cosmetic Appearance, Functional Elements, Odor & Cleanliness) so terms stay consistent with the glossary.",
    "- Refresh the answer-first key takeaways and the FAQ Q&A so they reflect the updated body.",
    "- No <script>, no inline style, no on* handlers.",
    "",
    "Return JSON matching exactly this schema:",
    "{",
    '  "body_html": "<the refreshed article body as semantic HTML, starting at <h2>>",',
    '  "excerpt": "<140–180 char hook; keep close to the current one unless it should change>",',
    '  "seo_description": "<≤155 chars, includes primary keyword>",',
    '  "key_takeaways": ["<3–5 answer-first bullets>"],',
    '  "faqs": [ { "q": "<question>", "a": "<concise answer>" } ],',
    '  "summary_one_line": "<single sentence, ≤140 chars>",',
    '  "change_summary": "<one sentence: what you changed and why it is a genuine improvement>"',
    "}",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface BlogRefreshOutput {
  body_html: string;
  excerpt: string;
  seo_description: string;
  key_takeaways: string[];
  faqs: Array<{ q: string; a: string }>;
  summary_one_line: string;
  change_summary: string;
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
  // US-876: AI-authored hero image SEO metadata (stored, not per-render).
  hero_image_alt: string;
  hero_image_caption: string;
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

// ──────────────────────────────────────────────────────────
// EMAIL NEWSLETTER ISSUE GENERATION (US-918)
// ──────────────────────────────────────────────────────────
// The autonomous weekly-newsletter copywriter. Mirrors the blog generator's
// architecture (curated knowledge docs + distilled history context in the
// system prompt; a per-issue JSON schema in the user prompt) but produces a
// complete EMAIL ISSUE: subject + 2–3 subject variants, preheader, intro, the
// teach/tip/CTA sections, and a footer note — grounded strictly in the inputs.
//
// The prompt builders + the validate/normalize + the grounding guard below are
// PURE (this module imports only types), so the grounding negative test runs
// with no env. The impure generation/persistence lives in content-ai-email.ts.

export const EMAIL_ISSUE_PROMPT_VERSION = "email_issue_v1";

const EMAIL_SUBJECT_MAX = 60;
const EMAIL_PREHEADER_MAX = 110;
const EMAIL_SUMMARY_MAX = 200;

// Evergreen gradethread.com paths the copy may always link to (homepage +
// stable product/marketing surfaces). Any OTHER link must appear verbatim in
// the provided inputs (a changelog line), or it is treated as fabricated and
// stripped — the model cannot invent a feature/landing page that doesn't exist.
export const EMAIL_LINK_ALLOWLIST = [
  "/",
  "/dashboard",
  "/pricing",
  "/blog",
  "/how-it-works",
  "/about",
  "/contact",
  "/login",
  "/signup",
  "/flipdesk",
  "/certificate",
];

export interface EmailIssueTopic {
  /** Human label for the educational focus (becomes the issue's working title). */
  label: string;
  /** Content pillar (topic family) — stamped on the issue for tuning attribution. */
  pillar: string;
  /** Topic angle within the pillar. */
  angle: string;
}

export interface EmailIssueInput {
  topic: EmailIssueTopic;
  /** Compact "what's new" grounding lines (may be empty → lean evergreen). */
  changelogLines: string[];
  /** Optional knowledge-base tip to weave into the issue. */
  kbTip?: string;
  productFocus: ContentProduct;
  /** Max teach/tip/CTA sections to request (the intro is separate). */
  maxSections: number;
}

export interface EmailIssueSection {
  heading?: string;
  /** Pre-sanitized AI-authored HTML for the block body. */
  body: string;
  /** Optional 1–2 sentence image prompt for a per-section illustration. */
  imagePrompt?: string;
  ctaLabel?: string;
  ctaUrl?: string;
}

export interface EmailIssueOutput {
  subject: string;
  /** 2–3 alternative subject lines for the A/B test (deduped, excludes subject). */
  subjectVariants: string[];
  preheader: string;
  /** Short HTML lede paragraph. */
  intro: string;
  sections: EmailIssueSection[];
  /** A short sign-off / footer note (above the CAN-SPAM footer). */
  footerNote: string;
  /** One-line distillation appended to content_history_index on send (dedup). */
  summaryOneLine: string;
}

const PRODUCT_AUDIENCE_EMAIL: Record<string, string> = {
  gradethread: "sellers grading pre-owned clothing condition",
  flipdesk: "resellers running the full eBay listing lifecycle",
  both: "pre-owned clothing sellers and resellers",
};

// Assembles the system message from the curated email knowledge docs + the
// distilled history context + the issue's grounding inputs (changelog, topic,
// KB tip). Mirrors buildSystemPrompt for the blog. Pure.
export function buildEmailIssueSystemPrompt(input: {
  emailVoice: string;
  emailStructure: string;
  valueProps: string;
  historyContext: string;
  topic: EmailIssueTopic;
  changelogLines: string[];
  kbTip?: string;
  productFocus: ContentProduct;
}): string {
  const audience = PRODUCT_AUDIENCE_EMAIL[input.productFocus] ?? PRODUCT_AUDIENCE_EMAIL.both;
  const whatsNew = input.changelogLines.length > 0
    ? input.changelogLines.map((l) => `- ${l.replace(/^[-•]\s*/, "")}`).join("\n")
    : "(no fresh product updates this week — lean fully on evergreen educational value)";
  return [
    "# Role",
    `You are the email copywriter for GradeThread (AI-powered clothing condition grading) and its FlipDesk reseller surface. You write a weekly educational newsletter for ${audience}. Your task is to write ONE complete issue.`,
    "",
    "# Brand voice",
    input.emailVoice || "(use plain, concrete, non-hypey English; teach first, sell second)",
    "",
    "# Newsletter structure",
    input.emailStructure || "(intro → what's new → teach something → quick tip → low-pressure CTA)",
    "",
    "# Value props (what we may credibly claim)",
    input.valueProps || "(standardized 1.0–10.0 condition grades, shareable certificates, fewer not-as-described disputes)",
    "",
    "# What we have already covered (do not repeat these topics)",
    input.historyContext || "(no prior issues)",
    "",
    "# This issue's inputs (your ONLY source of facts)",
    `Educational focus: ${input.topic.label} (pillar: ${input.topic.pillar}, angle: ${input.topic.angle})`,
    "Recent product updates ('what's new') — the ONLY product changes you may mention:",
    whatsNew,
    input.kbTip?.trim() ? `Knowledge-base tip to weave in: ${input.kbTip.trim()}` : "",
    "",
    "# Grounding rules (strict)",
    "- Ground every claim in the inputs above. Do NOT invent product features, prices, statistics, customer counts, or results that are not stated in the inputs.",
    "- If there are no fresh product updates, skip the 'what's new' angle entirely and lean on evergreen education — do NOT fabricate news.",
    "- Only include a cta_url you are certain is a real gradethread.com page (homepage or a stable surface), or a URL that appears verbatim in the inputs. Never invent a landing page or feature URL.",
    "",
    "# Output rules",
    "- Respond with ONLY valid JSON matching the schema in the user message — no markdown fences, no preamble, no commentary.",
    "- body_html is a short run of <p>/<ul>/<li>/<strong>/<em>/<a> only. No <script>, no inline style, no on* handlers.",
    "- If an optional field has nothing to say, return an empty string or empty array — never omit the key.",
  ].filter(Boolean).join("\n");
}

export function buildEmailIssueUserPrompt(input: EmailIssueInput): string {
  const sections = Math.max(1, Math.min(10, Math.floor(input.maxSections)));
  return [
    "Write this week's newsletter issue now.",
    "",
    `Produce up to ${sections} focused section(s) (teach-something + a quick actionable tip + a closing CTA section). Keep it skimmable and genuinely useful.`,
    `Subject MUST be ≤ ${EMAIL_SUBJECT_MAX} characters. Preheader MUST be ≤ ${EMAIL_PREHEADER_MAX} characters.`,
    "Provide 2–3 distinct alternative subject lines (for an A/B test) in subject_variants — each also ≤ 60 characters and meaningfully different from the main subject.",
    "",
    "Return JSON matching exactly this schema:",
    "{",
    `  "subject": "<the email subject line, ≤${EMAIL_SUBJECT_MAX} chars>",`,
    '  "subject_variants": ["<alt subject 1>", "<alt subject 2>", "<alt subject 3 (optional)>"],',
    `  "preheader": "<inbox preview text, ≤${EMAIL_PREHEADER_MAX} chars>",`,
    '  "intro": "<a short <p> lede that sets up the issue>",',
    '  "sections": [',
    '    {',
    '      "heading": "<short section heading>",',
    '      "body_html": "<short HTML body: <p>/<ul>/<li>/<strong>/<em> only>",',
    '      "image_prompt": "<optional 1–2 sentence prompt for a section image, or empty string>",',
    '      "cta_label": "<optional CTA label, or empty string>",',
    '      "cta_url": "<optional REAL gradethread.com URL — omit/empty if unsure>"',
    '    }',
    '  ],',
    '  "footer_note": "<a brief sign-off line above the legal footer>",',
    `  "summary_one_line": "<single sentence, ≤140 chars, summarizing this issue for the history index>"`,
    "}",
  ].join("\n");
}

function stripEmailCodeFence(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
}

function sanitizeEmailHtml(s: string): string {
  return s
    .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, "")
    .replace(/<\s*style[\s\S]*?<\s*\/\s*style\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "")
    .trim();
}

/**
 * Grounding guard for an email link (pure). A link is grounded only when it is an
 * https gradethread.com URL whose path is on the evergreen allowlist, OR whose
 * exact URL appears in one of the provided changelog/input lines. Anything else
 * (an invented feature/landing page) is rejected. This is the enforceable half of
 * "copy is grounded strictly in the provided inputs — no fabricated links".
 */
export function isGroundedEmailLink(url: string, changelogLines: string[]): boolean {
  const u = url.trim();
  if (!u) return false;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (host !== "gradethread.com" && host !== "www.gradethread.com") return false;
  const path = (parsed.pathname.replace(/\/+$/, "") || "/");
  if (path === "/") return true;
  for (const p of EMAIL_LINK_ALLOWLIST) {
    if (p === "/") continue;
    if (path === p || path.startsWith(p + "/")) return true;
  }
  // Otherwise it's only grounded if the exact URL was provided as an input.
  return changelogLines.some((l) => l.includes(u));
}

/**
 * Validate + normalize the model's JSON into a clean, length-capped, sanitized,
 * grounded EmailIssueOutput (pure). Throws on unusable output (no subject / no
 * section with a body) so the caller can fall back. Caps lengths (subject ≤ 60,
 * preheader ≤ 110), dedups subject variants, strips unsafe HTML, and removes any
 * fabricated CTA link not grounded in the inputs.
 */
export function normalizeEmailIssue(
  parsed: unknown,
  opts: { changelogLines: string[]; maxSections: number },
): EmailIssueOutput {
  if (!parsed || typeof parsed !== "object") throw new Error("email issue not an object");
  const p = parsed as Record<string, unknown>;

  const subject = String(p.subject ?? "").trim().slice(0, EMAIL_SUBJECT_MAX);
  if (!subject) throw new Error("email issue missing subject");
  const preheader = String(p.preheader ?? "").trim().slice(0, EMAIL_PREHEADER_MAX);
  const intro = sanitizeEmailHtml(String(p.intro ?? "").trim());
  const footerNote = sanitizeEmailHtml(String(p.footer_note ?? "").trim());
  const summaryOneLine = String(p.summary_one_line ?? "").trim().slice(0, EMAIL_SUMMARY_MAX);

  // Subject variants: deduped (case-insensitive), exclude the main subject, ≤3.
  const subjectVariants: string[] = [];
  const seen = new Set<string>([subject.toLowerCase()]);
  if (Array.isArray(p.subject_variants)) {
    for (const v of p.subject_variants) {
      const s = String(v ?? "").trim().slice(0, EMAIL_SUBJECT_MAX);
      if (!s || seen.has(s.toLowerCase())) continue;
      seen.add(s.toLowerCase());
      subjectVariants.push(s);
      if (subjectVariants.length >= 3) break;
    }
  }

  const maxSections = Math.max(1, Math.min(10, Math.floor(opts.maxSections)));
  const rawSections = Array.isArray(p.sections) ? p.sections : [];
  const sections: EmailIssueSection[] = [];
  for (const s of rawSections) {
    if (!s || typeof s !== "object") continue;
    const sec = s as Record<string, unknown>;
    const body = sanitizeEmailHtml(String(sec.body_html ?? sec.body ?? "").trim());
    if (!body) continue;
    const out: EmailIssueSection = { body };
    const heading = String(sec.heading ?? "").trim();
    if (heading) out.heading = heading;
    const imagePrompt = String(sec.image_prompt ?? "").trim();
    if (imagePrompt) out.imagePrompt = imagePrompt;
    const ctaLabel = String(sec.cta_label ?? "").trim();
    const ctaUrl = String(sec.cta_url ?? "").trim();
    if (ctaLabel && ctaUrl && isGroundedEmailLink(ctaUrl, opts.changelogLines)) {
      out.ctaLabel = ctaLabel;
      out.ctaUrl = ctaUrl;
    }
    sections.push(out);
    if (sections.length >= maxSections) break;
  }
  if (sections.length === 0) throw new Error("email issue produced no usable sections");

  return { subject, subjectVariants, preheader, intro, sections, footerNote, summaryOneLine };
}

// Exposed for the generator (content-ai-email.ts) so the fence-strip lives with
// the parser it feeds.
export function parseEmailIssue(
  raw: string,
  opts: { changelogLines: string[]; maxSections: number },
): EmailIssueOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripEmailCodeFence(raw));
  } catch {
    throw new Error("email issue JSON parse failed");
  }
  return normalizeEmailIssue(parsed, opts);
}
