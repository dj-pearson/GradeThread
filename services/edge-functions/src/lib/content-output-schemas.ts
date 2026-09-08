// US-3151: the shapes the content generators are GUARANTEED to get back.
//
// WHY THIS FILE EXISTS. Until now every content call asked for JSON in prose
// and then hand-parsed the reply. Measured on production, content_scheduler_runs
// 2026-08-09..09-08: 886 runs, 402 errors, of which ~349 were the model
// returning something the parser could not read. The replies were not truncated
// - they closed cleanly with the final property - they simply got the escaping
// wrong somewhere inside a long HTML string nested in a JSON string. Prose
// cannot make that reliable, and no amount of "respond with ONLY valid JSON"
// was going to.
//
// output_config.format makes it impossible instead of asking for it. ai-grading
// has used the same mechanism since US-1032, where the note reads "output_config
// .format guarantees valid, schema-conformant JSON on supporting models, so this
// can no longer fail on malformed JSON".
//
// ⚠ THE PROSE SCHEMA IN THE USER PROMPT STAYS, and deleting it would be the
// obvious wrong move. A JSON Schema can say `excerpt` is a string; it cannot say
// "140-180 char hook for OG description and feed snippets", or that seo_title
// must contain the primary keyword. Those are INSTRUCTIONS and they carry the
// quality. What comes out is the "- Respond with ONLY valid JSON / no markdown
// fences" rules, which are the part the API now enforces.
//
// ⚠ additionalProperties:false ON EVERY OBJECT, and every property in `required`.
// That is what the API's structured-output mode expects; a schema missing either
// is rejected. It also means adding a field here without adding it to `required`
// silently changes nothing.

const STR = { type: "string" } as const;
const INT = { type: "integer" } as const;
const STR_ARRAY = { type: "array", items: { type: "string" } } as const;

/** buildBlogArticleUserPrompt's schema block, as an enforceable schema. */
export const BLOG_ARTICLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: STR,
    title_suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          style: { type: "string", enum: ["question", "listicle", "contrarian"] },
          title: STR,
        },
        required: ["style", "title"],
      },
    },
    slug: STR,
    excerpt: STR,
    body_html: STR,
    seo_title: STR,
    seo_description: STR,
    primary_keyword: STR,
    secondary_keywords: STR_ARRAY,
    tags: STR_ARRAY,
    reading_time_min: INT,
    hero_prompt: STR,
    hero_image_alt: STR,
    hero_image_caption: STR,
    summary_one_line: STR,
  },
  required: [
    "title",
    "title_suggestions",
    "slug",
    "excerpt",
    "body_html",
    "seo_title",
    "seo_description",
    "primary_keyword",
    "secondary_keywords",
    "tags",
    "reading_time_min",
    "hero_prompt",
    "hero_image_alt",
    "hero_image_caption",
    "summary_one_line",
  ],
} as const;

/** BlogRefreshOutput. Title and slug are fixed by the caller, never returned. */
export const BLOG_REFRESH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    body_html: STR,
    excerpt: STR,
    seo_description: STR,
    key_takeaways: STR_ARRAY,
    faqs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { q: STR, a: STR },
        required: ["q", "a"],
      },
    },
    summary_one_line: STR,
    change_summary: STR,
  },
  required: [
    "body_html",
    "excerpt",
    "seo_description",
    "key_takeaways",
    "faqs",
    "summary_one_line",
    "change_summary",
  ],
} as const;

/**
 * SocialPostOutput. `variants` is required but may be empty - the caller asks
 * for zero platforms when none are enabled, and an empty array is the correct
 * answer rather than a missing key.
 */
export const SOCIAL_POST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    long_body: STR,
    short_body: STR,
    hashtags: STR_ARRAY,
    variants: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          platform: STR,
          body: STR,
          hashtags: STR_ARRAY,
          char_limit: INT,
          image_field: STR,
        },
        required: ["platform", "body", "hashtags", "char_limit", "image_field"],
      },
    },
  },
  required: ["long_body", "short_body", "hashtags", "variants"],
} as const;

/** TopicResearchOutput. */
export const TOPIC_RESEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: STR,
          angle: STR,
          primary_keyword: STR,
          secondary_keywords: STR_ARRAY,
          search_intent: STR,
        },
        required: [
          "title",
          "angle",
          "primary_keyword",
          "secondary_keywords",
          "search_intent",
        ],
      },
    },
  },
  required: ["candidates"],
} as const;
