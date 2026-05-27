// One-off script: append the content module user stories (US-226 → US-260)
// from the Blog & Social Content Super-Module plan to prd.json.
// Idempotent — skips any ID already present.

import fs from "node:fs";
import path from "node:path";

const PRD_PATH = path.resolve(
  process.argv[2] ?? "C:/Users/dpearson/Documents/GradeThread/prd.json",
);

const stories = [
  // ── Phase A: Foundation ─────────────────────────────────
  {
    id: "US-226",
    title: "Content module schema + RLS + seed knowledge docs",
    description:
      "As an admin, I need a Postgres schema for blog posts, social posts, a self-refilling topic bank, a per-publish history index, knowledge docs, a webhook log, and singleton content settings, all admin-only via RLS, with a public read carve-out for published blog posts so the Cloudflare Pages SSR worker can read them with the anon key.",
    acceptanceCriteria: [
      "Migration 00041_content_module.sql creates enums (content_surface, content_product, content_status, topic_status, content_generated_by, content_topic_source) and 8 tables (content_topics, blog_posts, blog_post_tags, social_posts, content_knowledge, content_history_index, content_webhook_log, content_settings)",
      "All tables admin-only via public.is_admin() helper from 00003",
      "blog_posts and blog_post_tags also have an anon SELECT policy filtered to status='published'",
      "content-images storage bucket created (public read, admin write) with 20MB / image MIME allowlist",
      "Six baseline knowledge docs seeded (brand.voice, blog.gradethread.style, blog.flipdesk.style, social.long.style, social.short.style, seo.pillars) on conflict-do-nothing",
      "Singleton content_settings row pre-inserted with default model IDs (Sonnet 4.6 for generation, Haiku 4.5 for research) and cadence (1 blog/day, 2 social/day)",
    ],
    priority: 226,
    passes: false,
    notes: "",
  },
  {
    id: "US-227",
    title: "Edge route /api/content/blog (CRUD + lifecycle)",
    description:
      "As an admin, I need a Hono route module for blog posts that supports list/read/create/update (autosave)/delete plus publish/schedule/archive lifecycle transitions, so the dashboard can drive the full editorial flow.",
    acceptanceCriteria: [
      "services/edge-functions/src/routes/content-blog.ts exports contentBlogRoutes with GET / · GET /:id · POST / · PATCH /:id · DELETE /:id · POST /:id/publish · POST /:id/schedule · POST /:id/archive",
      "Create generates a unique slug from title; PATCH supports tags array replacement",
      "Publish stamps published_at, marks the originating topic row 'used', appends a row to content_history_index",
      "POST /:id/generate and /:id/regenerate-section return 501 (lands in Phase B)",
      "Mounted at /api/content/blog in main.ts behind authMiddleware + adminAuthMiddleware",
    ],
    priority: 227,
    passes: false,
    notes: "",
  },
  {
    id: "US-228",
    title: "Edge route /api/content/social (CRUD + lifecycle)",
    description:
      "As an admin, I need a Hono route module for social posts that supports the same CRUD/publish surface as blog, with one row carrying both long and short variants so editorial pairing stays atomic.",
    acceptanceCriteria: [
      "services/edge-functions/src/routes/content-social.ts exports contentSocialRoutes with list/read/create/update/delete plus POST /:id/publish and POST /:id/schedule",
      "Publish marks the originating topic 'used' and appends a 140-char condensed summary to content_history_index",
      "POST /:id/generate returns 501 (lands in Phase D)",
      "Mounted at /api/content/social in main.ts",
    ],
    priority: 228,
    passes: false,
    notes: "",
  },
  {
    id: "US-229",
    title: "Edge route /api/content/topics (bank ops + dedup)",
    description:
      "As an admin, I need a Hono route module for the topic bank that supports list/counts/bulk-add/reject/promote-to-draft plus a check-keyword utility, with primary-keyword dedup against both the bank and the history index.",
    acceptanceCriteria: [
      "services/edge-functions/src/routes/content-topics.ts exports contentTopicsRoutes with GET / · GET /counts · POST /bulk · POST /:id/reject · POST /:id/promote · POST /check-keyword",
      "POST /bulk dedup-filters candidates against content_history_index AND content_topics(status IN queued/assigned/used) for the same (surface, product_focus) slice before insert",
      "POST /:id/promote creates a draft blog or social post depending on topic.surface, marks topic 'assigned', and returns the new draft",
      "POST /research returns 501 (lands in Phase B/D — needs AI generator)",
      "Mounted at /api/content/topics in main.ts",
    ],
    priority: 229,
    passes: false,
    notes: "",
  },
  {
    id: "US-230",
    title: "Edge route /api/content/knowledge (CRUD)",
    description:
      "As an admin, I need a Hono route module for knowledge docs (CLAUDE.md-style references) supporting list/read/upsert-by-key/delete, with an estimated token count stored on each doc for the dashboard UI.",
    acceptanceCriteria: [
      "services/edge-functions/src/routes/content-knowledge.ts exports contentKnowledgeRoutes with GET / · GET /:key · PUT /:key (upsert) · DELETE /:key",
      "PUT /:key sets token_count_est via chars/4 heuristic on save",
      "Mounted at /api/content/knowledge in main.ts",
    ],
    priority: 230,
    passes: false,
    notes: "",
  },
  {
    id: "US-231",
    title: "Lib content-history helpers (memory + dedup)",
    description:
      "As an engineer, I need shared helpers for appending to the history index, building token-budgeted context for AI prompts, and bulk-checking primary keywords against history+bank for the dedup gate.",
    acceptanceCriteria: [
      "services/edge-functions/src/lib/content-history.ts exports appendToHistoryIndex, buildHistoryContext({ surface, productFocus, maxTokens }), isKeywordDuplicate(surface, productFocus, keyword), findDuplicateKeywords(surface, productFocus, keywords[])",
      "buildHistoryContext returns newest-first bulleted lines (date · product · title [primary_keyword] (also: secondaries) — summary) trimmed to a chars/4 token budget (default 4000)",
      "Product slice queries include rows with product_focus='both' on both sides of the GT/FD split",
      "appendToHistoryIndex is best-effort: failures log but never throw, so a webhook hiccup can't roll back a successful publish",
    ],
    priority: 231,
    passes: false,
    notes: "",
  },

  // ── Phase B: Blog AI loop ───────────────────────────────
  {
    id: "US-232",
    title: "AI blog article generator (Sonnet) with Tiptap output shape",
    description:
      "As an admin, I need an edge-side generator that takes a topic + knowledge docs + history context and returns a fully shaped blog draft (title, slug, excerpt, Tiptap body_json + sanitized body_html, SEO meta, primary/secondary keywords, JSON-LD article schema, reading_time_min, hero prompt) so /api/content/blog/:id/generate can fill an empty draft.",
    acceptanceCriteria: [
      "services/edge-functions/src/lib/content-ai-blog.ts exports generateBlogArticle({ topic, productFocus, knowledge, historyIndex, model? }) returning the full draft shape",
      "Uses getAnthropicClient() with model = content_settings.default_blog_model (claude-sonnet-4-6)",
      "System prompt assembles brand.voice + blog.<productFocus>.style + seo.pillars + buildHistoryContext output",
      "Output passes server-side DOMPurify before body_html is stored (US-245)",
      "POST /api/content/blog/:id/generate wires the generator end-to-end, streams chunks via SSE for in-editor regeneration",
    ],
    priority: 232,
    passes: false,
    notes: "",
  },
  {
    id: "US-233",
    title: "AI social post generator (long + short in one call)",
    description:
      "As an admin, I need an edge-side generator that produces a paired long-format (LI/FB, 800–1500 chars) and short-format (X/Threads, ≤280 chars) post for one topic with one CTA URL, returning hashtags as a typed array.",
    acceptanceCriteria: [
      "services/edge-functions/src/lib/content-ai-social.ts exports generateSocialPost({ topic, productFocus, knowledge, historyIndex }) returning { longBody, shortBody, hashtags[], ctaUrl }",
      "CTA URL builder appends utm_source=<platform>&utm_medium=social&utm_campaign=<topic-slug> to https://gradethread.com/ (GT) or https://gradethread.com/flipdesk (FD)",
      "Short body is hard-truncated to 280 chars including link length",
      "POST /api/content/social/:id/generate wires the generator end-to-end",
    ],
    priority: 233,
    passes: false,
    notes: "",
  },
  {
    id: "US-234",
    title: "AI hero image generation via OpenAI gpt-image-1",
    description:
      "As an admin, I need an edge endpoint that generates a hero image for a blog post using OpenAI gpt-image-1 from a hero_prompt and uploads it to the content-images Supabase storage bucket, returning a public URL.",
    acceptanceCriteria: [
      "services/edge-functions/src/lib/openai-images.ts wraps the OpenAI client, reads OPENAI_API_KEY",
      "POST /api/content/images/hero { prompt, post_id } generates a 1792×1024 image, uploads to content-images/blog/<post_id>/hero_<ts>.png via service-role storage client, returns { url, path }",
      "Updates blog_posts.hero_image_url + hero_image_path on success",
      "Failure does not block publish — caller catches and proceeds with default OG image",
      "POST /api/content/images/inline returns a signed upload URL the editor can use for manual uploads",
    ],
    priority: 234,
    passes: false,
    notes: "",
  },
  {
    id: "US-235",
    title: "Outbound webhook dispatcher for Make.com",
    description:
      "As an admin, I need a webhook delivery helper that POSTs publish events to configured Make.com URLs with HMAC signature, retries 3× with exponential backoff, and logs every attempt to content_webhook_log for auditability.",
    acceptanceCriteria: [
      "services/edge-functions/src/lib/content-webhook.ts exports dispatchContentWebhook(event, payload, { format? })",
      "Reads target URL from content_settings.make_webhook_blog | _social_long | _social_short by event+format",
      "POSTs JSON with X-Content-Signature: hmac-sha256(CONTENT_WEBHOOK_SIGNING_SECRET, body)",
      "Retries on non-2xx: 5s, 30s, 120s; 10s timeout per attempt (mirrors webhook-delivery.ts)",
      "Inserts a content_webhook_log row per attempt with attempt_no, http_status, response_body, succeeded",
      "blog_posts.publish and social_posts.publish call this helper; failures don't roll back the publish",
    ],
    priority: 235,
    passes: false,
    notes: "",
  },
  {
    id: "US-236",
    title: "Autonomous scheduler tick endpoint",
    description:
      "As an admin, I need a /api/content/scheduler/tick endpoint Make.com can hit on a cron that decides which (surface, product_focus) is due, pulls the oldest queued topic (refilling via research if the bank is under threshold), generates a draft, and optionally auto-publishes per content_settings.",
    acceptanceCriteria: [
      "services/edge-functions/src/routes/content-scheduler.ts exports contentSchedulerRoutes mounted at /api/content/scheduler",
      "Gated by X-Internal-Job-Secret: $CONTENT_INTERNAL_JOB_SECRET header (no user JWT required) AND also accepts admin JWT for the dashboard 'Generate next' button",
      "Tick decides surface by today's published count vs post_cadence_per_day_*; picks product_focus that is least represented in last 14d",
      "If queued bank for (surface, product_focus) < min_topics_in_bank, calls researchTopics(...) to backfill",
      "Generates, drafts, marks topic 'assigned'; if auto_publish_<surface>=true, also publishes (hero gen + webhook dispatch) and marks topic 'used'",
      "Returns { skipped, surface, product_focus, post_id?, status }",
    ],
    priority: 236,
    passes: false,
    notes: "",
  },
  {
    id: "US-237",
    title: "Tiptap WYSIWYG editor shell + autosave",
    description:
      "As an admin, I need a React Tiptap shell component with the right extensions (StarterKit, Link, Image, Table, Placeholder, Typography, CodeBlock) and a debounced autosave hook so the blog editor and knowledge-doc editor can both reuse it.",
    acceptanceCriteria: [
      "src/components/content/tiptap-editor.tsx renders an Editor with the listed extensions",
      "src/components/content/tiptap-toolbar.tsx provides bold/italic/h2/h3/lists/link/image/table + an AI submenu (regenerate/expand/rewrite-for-keyword)",
      "onUpdate is debounced 1.5s and calls a passed-in onSave(jsonDoc, html) callback",
      "Exposes editor.commands.insertContent so SSE chunks can stream into the document",
      "Tiptap deps added to package.json (@tiptap/react, @tiptap/starter-kit, @tiptap/extension-{link,image,table,placeholder,typography})",
    ],
    priority: 237,
    passes: false,
    notes: "",
  },
  {
    id: "US-238",
    title: "Blog list + editor pages",
    description:
      "As an admin, I need a blog list page (table with status/focus/keyword/published_at filters and a 'Generate next' button) and a two-column editor page (Tiptap left, SEO sidebar right) so I can browse, create, and edit posts.",
    acceptanceCriteria: [
      "src/pages/content/blog-list.tsx with status + product filters, sortable columns, Generate next button (calls scheduler tick), New post button (opens empty editor)",
      "src/pages/content/blog-editor.tsx mounted at /dashboard/content/blog/editor/:id?",
      "SEO sidebar component (src/components/content/seo-sidebar.tsx): title, slug, primary keyword, secondary keywords chip input, hero preview + regenerate, JSON-LD live preview, scheduling controls",
      "Routes registered in src/routes/index.tsx under <AdminRoute>",
      "use-content-posts.ts hook backs both pages with TanStack Query (queryKey: ['blog_posts', filters])",
    ],
    priority: 238,
    passes: false,
    notes: "",
  },
  {
    id: "US-239",
    title: "Social list + editor pages",
    description:
      "As an admin, I need a social list page and a side-by-side composer (long + short) with live character counts, hashtag chip input, a CTA URL builder, and a Generate button so I can produce paired social posts efficiently.",
    acceptanceCriteria: [
      "src/pages/content/social-list.tsx shows long/short previews side-by-side per row",
      "src/pages/content/social-editor.tsx with two textareas, live char counts (3000 / 280), hashtag chip input, CTA URL with UTM builder, Generate button",
      "Routes registered under <AdminRoute>",
      "use-content-posts.ts handles both blog and social via TanStack Query",
    ],
    priority: 239,
    passes: false,
    notes: "",
  },
  {
    id: "US-240",
    title: "Topic bank page (4 tabs)",
    description:
      "As an admin, I need a topic bank page with four tabs (Blog·GT, Blog·FD, Social·GT, Social·FD) showing queued topics with title/keyword/angle and buttons to research more, add manually, reject, or promote to a draft.",
    acceptanceCriteria: [
      "src/pages/content/topic-bank.tsx with 4 tabs and per-tab counters",
      "Research 10 more button calls POST /api/content/topics/research with the active tab's (surface, productFocus)",
      "Add manually opens a small form (title, primary keyword, secondary keywords chip input, angle)",
      "Reject and Promote-to-draft actions wired to existing endpoints",
      "Optimistic updates on reject/promote via TanStack Query setQueryData",
    ],
    priority: 240,
    passes: false,
    notes: "",
  },
  {
    id: "US-241",
    title: "Knowledge docs page",
    description:
      "As an admin, I need a knowledge docs page listing all docs (key, title, token estimate) where clicking a doc opens it in a Tiptap-flavored markdown editor so I can update voice/style references that feed every AI prompt.",
    acceptanceCriteria: [
      "src/pages/content/knowledge.tsx lists docs from GET /api/content/knowledge",
      "Click opens an inline editor (reuses Tiptap shell, output stored as body_md)",
      "Token estimate updates on save (chars/4 heuristic)",
      "Cannot delete the six seeded keys (UI disables delete for those)",
    ],
    priority: 241,
    passes: false,
    notes: "",
  },
  {
    id: "US-242",
    title: "Content settings page",
    description:
      "As an admin, I need a settings page where I can configure the three Make.com webhook URLs, auto-publish toggles per surface, daily cadence per surface, default model IDs, and fire a test webhook to verify the wiring.",
    acceptanceCriteria: [
      "src/pages/content/content-settings.tsx wires all content_settings fields",
      "Webhook tester component (src/components/content/webhook-tester.tsx) sends a synthetic payload and shows the last content_webhook_log row's HTTP status",
      "Form persists via PATCH on a new GET/PATCH /api/content/settings route (singleton row id=1)",
    ],
    priority: 242,
    passes: false,
    notes: "",
  },
  {
    id: "US-243",
    title: "Sidebar group + lazy routes + admin gating",
    description:
      "As an admin, I need a 'Content' nav group in the dashboard sidebar (visible only to admins) and all content pages registered as lazy-loaded routes under <AdminRoute>.",
    acceptanceCriteria: [
      "src/components/dashboard/sidebar.tsx renders the Content group only when profile.role IN ('admin','super_admin')",
      "src/routes/index.tsx adds 7 lazy-loaded content pages nested under an <AdminRoute> + <DashboardLayout>",
      "Constants in src/lib/constants.ts: CONTENT_SURFACES, CONTENT_PRODUCTS, CONTENT_STATUSES, TOPIC_STATUSES, SOCIAL_LONG_LIMIT, SOCIAL_SHORT_LIMIT, PRODUCT_LABELS",
      "Database types appended to src/types/database.ts for blog_posts / social_posts / content_topics / content_knowledge / content_settings",
    ],
    priority: 243,
    passes: false,
    notes: "",
  },

  // ── Phase C: Public SSR ─────────────────────────────────
  {
    id: "US-244",
    title: "Cloudflare Pages Functions for /blog/* SSR",
    description:
      "As a search engine, I need fully-server-rendered HTML for /blog, /blog/[slug], /blog/tag/[tag], /sitemap.xml, /rss.xml, /robots.txt so my crawler can index content without executing JS.",
    acceptanceCriteria: [
      "functions/blog/[[path]].ts fetches /api/content/public/posts(:slug) and returns an inline-templated HTML page with full <head>, OG tags, JSON-LD article schema, canonical link",
      "functions/sitemap.xml.ts returns a valid sitemap with all status=published posts (lastmod = updated_at)",
      "functions/rss.xml.ts returns an RSS 2.0 feed of the last 50 posts",
      "functions/robots.txt.ts allows /blog/, points to /sitemap.xml; replaces public/robots.txt + public/sitemap.xml (deleted)",
      "Edge service exposes GET /api/content/public/posts, /:slug, /tags/:tag, /sitemap.json with anon auth (no admin middleware)",
      "All responses include Cache-Control: public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
    ],
    priority: 244,
    passes: false,
    notes: "",
  },
  {
    id: "US-245",
    title: "Server-side HTML sanitization at publish",
    description:
      "As a security-conscious admin, I need Tiptap-output HTML to be sanitized server-side at publish time so the SSR worker can serve body_html directly without any client-side sanitization.",
    acceptanceCriteria: [
      "Edge service adds isomorphic-dompurify via npm: import (services/edge-functions/deno.json)",
      "Publish path runs body_html through DOMPurify with a whitelist allowing <iframe> only from youtube.com/youtube-nocookie.com",
      "All inline event handlers (onclick, etc.) and <script> tags stripped",
      "Sanitized HTML is what gets stored in blog_posts.body_html",
    ],
    priority: 245,
    passes: false,
    notes: "",
  },
  {
    id: "US-246",
    title: "Cloudflare cache purge on publish/edit",
    description:
      "As an admin publishing content, I need the Cloudflare edge cache to be purged for the affected URLs so changes appear immediately without waiting for the 1h s-maxage.",
    acceptanceCriteria: [
      "On POST /api/content/blog/:id/publish (and post-publish edits), the edge service calls Cloudflare's purge_files API for /blog/<slug>, /blog, /sitemap.xml, /rss.xml",
      "Requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID env vars",
      "Failures log but don't block the publish",
    ],
    priority: 246,
    passes: false,
    notes: "",
  },
  {
    id: "US-247",
    title: "Make.com scenarios for blog + social fan-out",
    description:
      "As an admin, I need three Make.com scenarios (blog, social-long, social-short) that consume the publish webhooks and post to the right platforms with the right framing.",
    acceptanceCriteria: [
      "Blog scenario: webhook → fork to LinkedIn (share article URL + hero), X (title + URL), Threads (excerpt + URL)",
      "Social-long scenario: webhook → LinkedIn + Facebook posts with long_body + hashtags + cta_url",
      "Social-short scenario: webhook → X + Threads posts with short_body + cta_url",
      "Each scenario verifies the X-Content-Signature HMAC before posting",
      "Webhook URLs configured in content_settings via the dashboard settings page",
    ],
    priority: 247,
    passes: false,
    notes: "",
  },
  {
    id: "US-248",
    title: "Autonomous Make.com cron firing scheduler tick",
    description:
      "As an admin, I need a Make.com cron that fires every hour and calls /api/content/scheduler/tick with the internal job secret so the system produces posts at the configured daily cadence with no human intervention.",
    acceptanceCriteria: [
      "Make.com scenario: schedule (1h) → HTTP POST to https://functions.gradethread.com/api/content/scheduler/tick with X-Internal-Job-Secret",
      "Logs into content_webhook_log if the tick produces a publish",
      "Manual 'Generate next' button on dashboard hits the same endpoint with admin JWT",
    ],
    priority: 248,
    passes: false,
    notes: "",
  },
  {
    id: "US-249",
    title: "JSON-LD Article + Organization schema on /blog/*",
    description:
      "As a search engine, I need structured data (JSON-LD Article + Organization) injected into every /blog/[slug] page so rich snippets (article cards, author/publisher info) can render in SERPs.",
    acceptanceCriteria: [
      "functions/blog/[[path]].ts injects <script type='application/ld+json'> with schema.org Article: headline, image, datePublished, dateModified, author (Pearson Media LLC), publisher (GradeThread + logo)",
      "Same template injects an Organization schema on /blog index",
      "Validates clean in Google's Rich Results Test",
    ],
    priority: 249,
    passes: false,
    notes: "",
  },
  {
    id: "US-250",
    title: "UTM builder + CTA URL helper on social composer",
    description:
      "As an admin, I need the social editor's CTA URL field to auto-build UTM-tagged links per platform so traffic from each post is attributable in analytics.",
    acceptanceCriteria: [
      "Helper in src/lib/utm.ts: buildCtaUrl({ baseUrl, platform, campaign }) returns baseUrl?utm_source=<platform>&utm_medium=social&utm_campaign=<slug>",
      "Social editor exposes platform selector + campaign field that auto-derives from topic title slug",
      "AI social generator (US-233) uses the same helper",
    ],
    priority: 250,
    passes: false,
    notes: "",
  },

  // ── Phase F: Polish ─────────────────────────────────────
  {
    id: "US-251",
    title: "SSE streaming AI generation into Tiptap editor",
    description:
      "As an admin, I want to watch AI-generated content stream into the editor in real time instead of waiting for a single response, so I can stop or redirect early if the direction is wrong.",
    acceptanceCriteria: [
      "Generate endpoints support text/event-stream with incremental Tiptap insert payloads",
      "src/components/content/ai-stream-button.tsx wires SSE to editor.commands.insertContent",
      "Stop button cancels the fetch and discards remaining stream",
    ],
    priority: 251,
    passes: false,
    notes: "",
  },
  {
    id: "US-252",
    title: "Regenerate-selection + rewrite-for-keyword toolbar actions",
    description:
      "As an admin editing a blog post, I want toolbar buttons to regenerate a selected paragraph, expand a thin section, or rewrite a passage to better target a chosen keyword.",
    acceptanceCriteria: [
      "Tiptap toolbar AI submenu: Regenerate selection · Expand selection · Rewrite for keyword (input prompts for keyword)",
      "Backed by POST /api/content/blog/:id/regenerate-section { mode, selectionHtml, keyword? }",
      "Stream replacement HTML back via SSE",
    ],
    priority: 252,
    passes: false,
    notes: "",
  },
  {
    id: "US-253",
    title: "Hashtag suggestion endpoint for social posts",
    description:
      "As an admin, I want a 'Suggest hashtags' button on the social editor that asks Claude Haiku for 5–8 relevant tags so I don't have to brainstorm them.",
    acceptanceCriteria: [
      "POST /api/content/social/:id/suggest-hashtags returns string[] of 5–8 hashtags ranked by relevance",
      "Uses content_settings.default_research_model",
      "Editor appends suggestions to the chip input (deduped)",
    ],
    priority: 253,
    passes: false,
    notes: "",
  },
  {
    id: "US-254",
    title: "A/B title testing for blog posts",
    description:
      "As an admin, I want the AI generator to propose 3 candidate titles per post and remember which one I picked so future generations bias toward similar shapes.",
    acceptanceCriteria: [
      "generateBlogArticle returns titleSuggestions[3] (one per slot: question, listicle, contrarian)",
      "blog-editor shows them as radio options before commit",
      "content_history_index.title reflects the chosen one",
    ],
    priority: 254,
    passes: false,
    notes: "",
  },
  {
    id: "US-255",
    title: "GA4 + PostHog events for content",
    description:
      "As an analyst, I need GA4 page_view events on /blog/[slug] and PostHog events for editor + publish actions so I can measure content performance and content-team velocity.",
    acceptanceCriteria: [
      "Pages Function injects GA4 gtag with config",
      "Dashboard fires posthog events: content.draft.created, content.generated, content.published, topic.researched, webhook.dispatched",
      "Each event includes surface + product_focus",
    ],
    priority: 255,
    passes: false,
    notes: "",
  },
  {
    id: "US-256",
    title: "RSS extensions (Atom + media:thumbnail)",
    description:
      "As a podcast/feed reader, I need an RSS feed with proper namespacing, atom:link self-reference, and media:thumbnail for hero images so the feed shows previews in feed readers.",
    acceptanceCriteria: [
      "functions/rss.xml.ts emits the rss namespace + atom + media:thumbnail + content:encoded",
      "Validates clean against W3C feed validator",
    ],
    priority: 256,
    passes: false,
    notes: "",
  },
  {
    id: "US-257",
    title: "Draft preview links (signed, time-limited)",
    description:
      "As an admin, I want a signed preview URL on draft posts so I can review the rendered SSR output before publishing without exposing drafts to the public.",
    acceptanceCriteria: [
      "POST /api/content/blog/:id/preview-link returns a signed URL valid 30 minutes",
      "Pages Function honors a preview= query param with the signature → serves the draft",
      "Preview pages get noindex,nofollow",
    ],
    priority: 257,
    passes: false,
    notes: "",
  },
  {
    id: "US-258",
    title: "Content analytics dashboard",
    description:
      "As an admin, I want a small analytics surface inside the content module showing posts published per week, topic-bank levels, webhook success rate, and top-performing posts by GA4 traffic.",
    acceptanceCriteria: [
      "src/pages/content/analytics.tsx with 4 cards + a chart per surface",
      "Pulls from content_webhook_log, content_history_index, content_topics/counts, and the GA4 reporting API",
    ],
    priority: 258,
    passes: false,
    notes: "",
  },
  {
    id: "US-259",
    title: "Dead-letter queue for failed webhooks",
    description:
      "As an admin, I want a way to inspect and retry webhooks that failed all 3 attempts so a transient Make.com outage doesn't silently drop a publish.",
    acceptanceCriteria: [
      "content_webhook_log shows failed deliveries in the dashboard with a Retry button",
      "POST /api/content/webhooks/:log_id/retry replays the original payload",
      "Optional: daily admin email summarizing failed deliveries from the last 24h",
    ],
    priority: 259,
    passes: false,
    notes: "",
  },
  {
    id: "US-260",
    title: "Weekly content summary email",
    description:
      "As an admin, I want a weekly digest email summarizing what published, top-performing posts, and current topic-bank levels so I can adjust knowledge docs or cadence without opening the dashboard.",
    acceptanceCriteria: [
      "Cron (Make.com) hits GET /api/content/scheduler/summary every Monday morning",
      "Returns a JSON summary that Make.com formats into an email and sends",
      "Includes: posts published last 7d (per surface/focus), topics added/used, webhook success rate, bank levels, suggested doc edits if voice drift detected",
    ],
    priority: 260,
    passes: false,
    notes: "",
  },
];

const prd = JSON.parse(fs.readFileSync(PRD_PATH, "utf8"));
const existing = new Set(prd.userStories.map((s) => s.id));
let added = 0;
let skipped = 0;
for (const s of stories) {
  if (existing.has(s.id)) {
    skipped++;
    continue;
  }
  prd.userStories.push(s);
  added++;
}

fs.writeFileSync(PRD_PATH, JSON.stringify(prd, null, 2) + "\n");
console.log(`Appended ${added} stories (skipped ${skipped} duplicates).`);
console.log(`Total stories: ${prd.userStories.length}`);
