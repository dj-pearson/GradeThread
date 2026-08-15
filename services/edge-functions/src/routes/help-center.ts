import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { isAdminUserCached } from "../lib/maintenance.ts";
import { buildHelpPurgeFiles, purgeCloudflareCache } from "../lib/cloudflare-purge.ts";
import { submitUrls } from "../lib/indexnow.ts";
import {
  canView,
  cleanSlugArray,
  type HelpArticleRow,
  type HelpCategoryRow,
  type HelpViewer,
  isHelpAudience,
  isHelpStatus,
  isHelpVisibility,
  isReservedHelpSlug,
  isSearchableHelpQuery,
  type HelpArticleStatus,
  type HelpVisibility,
  normalizeFaq,
  normalizeHelpQuery,
  type HelpSearchHit,
  projectArticle,
  projectListItem,
  readableStatusesFor,
  slugifyHelp,
  visibilitiesFor,
} from "../lib/help-center.ts";
import {
  deflectionRate,
  type HelpArticleMeta,
  type HelpDeflectionRow,
  type HelpFeedbackRow,
  type HelpViewRow,
  rankArticles,
  reportWindowDays,
  splitTicketsByCategory,
  type TicketRow,
} from "../lib/help-analytics.ts";

// Help Center API (US-2573). Three mounts, three audiences, one table:
//
//   /api/content/public/help   anonymous. Powers the SSR Function for /help.
//   /api/help                  authMiddleware. Powers /dashboard/help.
//   /api/content/help          authMiddleware + adminAuthMiddleware. Authoring.
//
// The service-role client bypasses RLS, so every read here filters by
// visibilitiesFor(viewer) explicitly. That call is the wall in this process;
// 00602's policies are the wall for anything that reaches Postgres with the
// anon key instead. Two independent gates, deliberately.
//
// A row the viewer may not see returns 404, never 403: a 403 confirms the slug
// exists, which turns the members-only list into something an anonymous caller
// can enumerate one guess at a time.

type PublicEnv = { Variables: Record<string, never> };
type ReaderEnv = { Variables: { userId: string } };
type AdminEnv = { Variables: { userId: string; adminRole: "admin" | "super_admin" } };

const ARTICLE_COLUMNS =
  "id, slug, title, summary, body_html, body_json, body_markdown, category_key, audience, " +
  "visibility, status, sort_order, hero_image_url, faq, related_slugs, video_url, pillar_path, " +
  "published_at, reviewed_at, review_interval_days, created_at, updated_at";

const CATEGORY_COLUMNS = "key, title, slug, summary, sort_order, icon";

// ── shared reads ──────────────────────────────────────────
// One implementation for all three mounts. The ONLY thing that varies is the
// viewer, which is exactly the property that must not be re-derived per route.

async function loadCategories(): Promise<HelpCategoryRow[]> {
  const { data, error } = await supabaseAdmin
    .from("help_categories")
    .select(CATEGORY_COLUMNS)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return (data ?? []) as HelpCategoryRow[];
}

async function loadIndex(viewer: HelpViewer): Promise<HelpArticleRow[]> {
  const { data, error } = await supabaseAdmin
    .from("help_articles")
    .select(ARTICLE_COLUMNS)
    .in("visibility", visibilitiesFor(viewer))
    .in("status", readableStatusesFor(viewer))
    .order("category_key", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("title", { ascending: true });
  if (error) throw error;
  // Cast through unknown: ARTICLE_COLUMNS is a concatenated string rather than a
  // literal, so supabase-js's select() parser gives up and infers
  // GenericStringError instead of the row shape. Same workaround as the
  // submission_images reads elsewhere in this service.
  return (data ?? []) as unknown as HelpArticleRow[];
}

async function loadArticle(
  viewer: HelpViewer,
  slug: string,
): Promise<HelpArticleRow | null> {
  const normalized = slugifyHelp(slug);
  if (!normalized) return null;
  const { data, error } = await supabaseAdmin
    .from("help_articles")
    .select(ARTICLE_COLUMNS)
    .eq("slug", normalized)
    .in("visibility", visibilitiesFor(viewer))
    .in("status", readableStatusesFor(viewer))
    .maybeSingle();
  if (error) throw error;
  const row = data as HelpArticleRow | null;
  // Belt and braces: the query already filtered, but canView is the assertion
  // a future refactor of that query has to keep satisfying.
  if (!row || !canView(viewer, row)) return null;
  return row;
}

/**
 * An article always ships with its category row.
 *
 * The public URL is /help/<category-slug>/<article-slug>, and the renderer needs
 * the category's slug and title for the canonical URL and the breadcrumb. Making
 * it fetch the index as well would be a second upstream round trip on every
 * article page, on the hop that already fronts every visitor.
 */
async function categoryFor(key: string): Promise<HelpCategoryRow | null> {
  const { data, error } = await supabaseAdmin
    .from("help_categories")
    .select(CATEGORY_COLUMNS)
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;
  return (data as HelpCategoryRow | null) ?? null;
}

function indexPayload(categories: HelpCategoryRow[], rows: HelpArticleRow[]) {
  const articles = rows.map(projectListItem);
  const counts = new Map<string, number>();
  for (const a of articles) counts.set(a.category_key, (counts.get(a.category_key) ?? 0) + 1);
  return {
    categories: categories.map((c) => ({ ...c, article_count: counts.get(c.key) ?? 0 })),
    articles,
  };
}

// ── search (US-2577) ──────────────────────────────────────
// One implementation, three mounts, same rule as the reads: the viewer decides
// which visibilities the query may reach. Search is the most tempting way around
// a permission wall, because it looks like a read of "the index" rather than a
// read of the articles.

async function runSearch(
  viewer: HelpViewer,
  rawQuery: string,
): Promise<{ query: string; hits: HelpSearchHit[] }> {
  const query = normalizeHelpQuery(rawQuery);
  if (!isSearchableHelpQuery(query)) return { query, hits: [] };

  const { data, error } = await supabaseAdmin.rpc("help_search", {
    p_query: query,
    p_visibilities: visibilitiesFor(viewer),
    p_limit: 20,
  });
  if (error) throw error;
  const hits = ((data ?? []) as unknown as HelpSearchHit[]).filter((h) =>
    visibilitiesFor(viewer).includes(h.visibility)
  );

  // A query that found nothing is the best signal we get for what to write next:
  // somebody wanted an answer badly enough to type it. Best-effort — a failed
  // insert must never turn an empty result page into a 500.
  if (hits.length === 0) {
    await supabaseAdmin
      .from("help_search_misses")
      .insert({ query: rawQuery.slice(0, 200), normalized: query, viewer_tier: viewer, hits: 0 })
      .then(
        () => {},
        (e: unknown) => console.warn("[help.search] miss log failed", e),
      );
  }
  return { query, hits };
}

function searchQueryOf(c: { req: { query: (k: string) => string | undefined } }): string {
  return c.req.query("q") ?? "";
}

// ══════════════════════════════════════════════════════════
// PUBLIC — anonymous, mounted at /api/content/public/help
// ══════════════════════════════════════════════════════════

export const helpPublicRoutes = new Hono<PublicEnv>();

helpPublicRoutes.get("/", async (c) => {
  try {
    const [categories, rows] = await Promise.all([loadCategories(), loadIndex("anon")]);
    const payload = indexPayload(categories, rows);
    // US-2580: ?full=1 adds each article's Markdown body, so /help.md can be a
    // single-fetch document an answer engine ingests whole instead of crawling
    // one URL per article. Opt-in because the default index is the payload the
    // hub and every category page render, and it must stay small.
    if (c.req.query("full") === "1") {
      const bodyBySlug = new Map(rows.map((r) => [r.slug, r.body_markdown ?? ""]));
      return c.json({
        ...payload,
        articles: payload.articles.map((a) => ({
          ...a,
          body_markdown: bodyBySlug.get(a.slug) ?? "",
        })),
      });
    }
    return c.json(payload);
  } catch (err) {
    return failSafe(c, 500, "Couldn't load help articles.", err, "help.public.index");
  }
});

// Registered BEFORE /:slug so the literal path wins, and matching the reserved
// slug list in lib/help-center.ts, which forbids an article from taking it.
helpPublicRoutes.get("/search", async (c) => {
  try {
    return c.json(await runSearch("anon", searchQueryOf(c)));
  } catch (err) {
    return failSafe(c, 500, "Couldn't run that search.", err, "help.public.search");
  }
});

/**
 * US-2591: was this article any good?
 *
 * Anonymous on purpose. The articles are public, so requiring a signed-in
 * reader would collect feedback only from the minority who happened to be
 * logged in and then present that as a measurement.
 *
 * Accepts JSON or a form body, because the no-JS path is a same-origin HTML
 * form posted through functions/help/feedback.ts. That path is what makes the
 * widget work for a visitor with scripts off, which is a real share of the
 * people a public help page is for.
 */
async function handleFeedback(
  c: {
    req: {
      param: (k: string) => string;
      header: (k: string) => string | undefined;
      json: () => Promise<unknown>;
      formData: () => Promise<FormData>;
    };
    json: (body: unknown, status?: number) => Response;
  },
  viewer: HelpViewer,
): Promise<Response> {
  const slug = slugifyHelp(c.req.param("slug"));
  if (!slug) return c.json({ error: "Not found" }, 404);

  // Only an article THIS viewer may read can be voted on. Otherwise the table
  // becomes a write surface for arbitrary strings, and the 404 for an article
  // above the viewer's tier is the same 404 a made-up slug gets.
  const article = await loadArticle(viewer, slug);
  if (!article) return c.json({ error: "Not found" }, 404);

  const ct = c.req.header("content-type") ?? "";
  const body = ct.includes("application/json")
    ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>)
    : (Object.fromEntries(await c.req.formData()) as Record<string, unknown>);

  const raw = String(body.helpful ?? "");
  if (raw !== "yes" && raw !== "no" && raw !== "true" && raw !== "false") {
    return c.json({ error: "helpful must be yes or no" }, 400);
  }
  const helpful = raw === "yes" || raw === "true";

  const comment = typeof body.comment === "string"
    ? body.comment.trim().slice(0, 1000)
    : "";

  const { error } = await supabaseAdmin.from("help_feedback").insert({
    article_slug: slug,
    // Recorded against the wording they actually read, so a rewrite starts a
    // clean record rather than inheriting the previous version's score.
    content_version: (article as unknown as { content_version?: number }).content_version ?? 1,
    helpful,
    comment: comment || null,
    viewer_tier: viewer,
  });
  if (error) console.warn("[help.feedback] insert failed", error);
  return c.json({ ok: true, recorded: !error });
}

helpPublicRoutes.post("/:slug/feedback", async (c) => {
  try {
    return await handleFeedback(c, "anon");
  } catch (err) {
    return failSafe(c, 500, "Couldn't record that.", err, "help.public.feedback");
  }
});

/**
 * US-2592: count a read of a public article.
 *
 * This exists because PostHog cannot see these pages. Every public help URL is
 * server-rendered and the React app never mounts on it, which is what makes it
 * index well and also what makes posthog-js absent. A "top articles" list built
 * from PostHog alone would rank in-app reading and silently omit the organic
 * traffic this whole epic is for.
 *
 * Best-effort in exactly the way the deflection endpoint is: it is called from
 * the Pages Function inside waitUntil, after the HTML has already gone out. A
 * failure here must never affect what the reader saw.
 *
 * No identity is taken and none is available: the counter's grain is
 * (article, surface, day). The RPC validates the slug and requires the article
 * to exist, so this endpoint cannot be used to invent rows.
 */
helpPublicRoutes.post("/:slug/view", async (c) => {
  const slug = slugifyHelp(c.req.param("slug"));
  if (!slug) return c.json({ ok: true, recorded: false });
  const { error } = await supabaseAdmin.rpc("record_help_article_view", {
    p_slug: slug,
    p_surface: "public",
  });
  if (error) console.warn("[help.view] rpc failed", error);
  return c.json({ ok: true, recorded: !error });
});

helpPublicRoutes.get("/:slug", async (c) => {
  try {
    const row = await loadArticle("anon", c.req.param("slug"));
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json({ article: projectArticle(row), category: await categoryFor(row.category_key) });
  } catch (err) {
    return failSafe(c, 500, "Couldn't load that help article.", err, "help.public.article");
  }
});

// ══════════════════════════════════════════════════════════
// READER — authed customers, mounted at /api/help
// ══════════════════════════════════════════════════════════

export const helpReaderRoutes = new Hono<ReaderEnv>();

// A signed-in user is a 'member'; an admin additionally unlocks 'internal'.
// Resolved from the verified userId, never from a header or a query parameter.
async function viewerFor(userId: string | undefined): Promise<HelpViewer> {
  if (!userId) return "anon";
  return (await isAdminUserCached(userId)) ? "admin" : "member";
}

helpReaderRoutes.get("/", async (c) => {
  try {
    const viewer = await viewerFor(c.get("userId"));
    const [categories, rows] = await Promise.all([loadCategories(), loadIndex(viewer)]);
    return c.json({ ...indexPayload(categories, rows), viewer });
  } catch (err) {
    return failSafe(c, 500, "Couldn't load help articles.", err, "help.reader.index");
  }
});

helpReaderRoutes.get("/search", async (c) => {
  try {
    const viewer = await viewerFor(c.get("userId"));
    return c.json({ ...(await runSearch(viewer, searchQueryOf(c))), viewer });
  } catch (err) {
    return failSafe(c, 500, "Couldn't run that search.", err, "help.reader.search");
  }
});

/**
 * US-2585: the ticket that was NOT filed.
 *
 * Fired when somebody opened the support form, was shown articles, opened one,
 * and then left without submitting. There is no other row in the database this
 * event could hang on, which is exactly why deflection normally goes
 * unmeasured — and why the number that justifies the whole help centre is
 * usually a guess.
 *
 * Best-effort by design: it is sent with sendBeacon during page-hide, so it
 * must answer fast, must never block, and must never fail loudly. A lost
 * deflection under-reports the win; a 500 here would be a browser error on a
 * page the user has already left.
 */
helpReaderRoutes.post("/deflected", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    subject?: unknown;
    articles_shown?: unknown;
    article_opened?: unknown;
  };
  const slugs = Array.isArray(body.articles_shown)
    ? body.articles_shown
      .map((v) => String(v).trim().toLowerCase())
      .filter((v) => /^[a-z0-9-]{1,80}$/.test(v))
      .slice(0, 5)
    : [];
  const rawOpened = typeof body.article_opened === "string"
    ? body.article_opened.trim().toLowerCase()
    : "";
  const opened = /^[a-z0-9-]{1,80}$/.test(rawOpened) ? rawOpened : null;

  // Nothing was read, so nothing was deflected. Recording it would inflate the
  // one number this table exists to keep honest.
  if (!opened) return c.json({ ok: true, recorded: false });

  const { error } = await supabaseAdmin.from("help_deflections").insert({
    owner_user_id: c.get("userId") ?? null,
    subject: typeof body.subject === "string" ? body.subject.slice(0, 200) : "",
    articles_shown: slugs,
    article_opened: opened,
  });
  if (error) console.warn("[help.deflected] insert failed", error);
  return c.json({ ok: true, recorded: !error });
});

/**
 * US-2592: the in-app half of "was this any good?".
 *
 * The public form (US-2591) can only accept votes on PUBLIC articles, so until
 * now a members-only or internal article could not be rated at all — and those
 * are the ones with no other feedback channel, because nobody arrives at an
 * operator runbook from a search engine. The vote is recorded with the viewer's
 * tier, so an internal note's score is not mixed in with a public article's.
 */
helpReaderRoutes.post("/:slug/feedback", async (c) => {
  try {
    return await handleFeedback(c, await viewerFor(c.get("userId")));
  } catch (err) {
    return failSafe(c, 500, "Couldn't record that.", err, "help.reader.feedback");
  }
});

/**
 * The same counter for the in-app reader, recorded under surface 'app'.
 *
 * Kept apart from 'public' rather than summed. An article that everybody opens
 * from inside the product and nobody ever finds through search is a different
 * result from one that ranks, and adding the two together is how you conclude
 * the help centre is earning traffic it is not.
 */
helpReaderRoutes.post("/:slug/view", async (c) => {
  const slug = slugifyHelp(c.req.param("slug"));
  if (!slug) return c.json({ ok: true, recorded: false });
  const { error } = await supabaseAdmin.rpc("record_help_article_view", {
    p_slug: slug,
    p_surface: "app",
  });
  if (error) console.warn("[help.view] rpc failed", error);
  return c.json({ ok: true, recorded: !error });
});

helpReaderRoutes.get("/:slug", async (c) => {
  try {
    const viewer = await viewerFor(c.get("userId"));
    const row = await loadArticle(viewer, c.req.param("slug"));
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json({
      article: projectArticle(row),
      category: await categoryFor(row.category_key),
      viewer,
    });
  } catch (err) {
    return failSafe(c, 500, "Couldn't load that help article.", err, "help.reader.article");
  }
});

// ══════════════════════════════════════════════════════════
// AUTHORING — admin only, mounted at /api/content/help
// ══════════════════════════════════════════════════════════

export const helpAdminRoutes = new Hono<AdminEnv>();

/**
 * US-2578: after a write, tell the caches and the crawlers.
 *
 * Fire-and-forget on purpose. A purge or an IndexNow submit that fails must
 * never turn a successful save into an error the author has to interpret — the
 * article IS saved either way, and the worst case is that the public page lags
 * by the edge cache TTL.
 *
 * Only a PUBLIC article is submitted to IndexNow. Asking Bing to crawl a URL
 * that answers 404 to everyone but a signed-in member is both useless and a
 * quiet announcement that the URL exists.
 */
function afterHelpWrite(row: {
  slug: string;
  category_key: string;
  visibility: HelpVisibility;
  status: HelpArticleStatus;
}): void {
  void (async () => {
    try {
      const category = await categoryFor(row.category_key);
      const categorySlug = category?.slug ?? row.category_key;
      const files = await buildHelpPurgeFiles(categorySlug, row.slug);
      await purgeCloudflareCache({ files });

      if (row.visibility === "public" && row.status === "published") {
        const base = (Deno.env.get("PUBLIC_SITE_URL") ?? "https://gradethread.com")
          .trim()
          .replace(/\/$/, "");
        await submitUrls([`${base}/help/${categorySlug}/${row.slug}`]);
      }
    } catch (e) {
      console.warn("[help.admin] cache purge / IndexNow failed:", e);
    }
  })();
}

interface HelpArticleInput {
  slug?: string;
  title?: string;
  summary?: string;
  body_html?: string;
  body_json?: unknown;
  body_markdown?: string;
  category_key?: string;
  audience?: string;
  visibility?: string;
  status?: string;
  sort_order?: number;
  hero_image_url?: string | null;
  faq?: unknown;
  related_slugs?: unknown;
  video_url?: string | null;
  pillar_path?: string | null;
  reviewed_at?: string | null;
  review_interval_days?: number;
}

async function slugTaken(slug: string, exceptId?: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("help_articles")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  const row = data as { id: string } | null;
  if (!row) return false;
  return !exceptId || row.id !== exceptId;
}

/** Shared field coercion. Returns an error string, or the patch to apply. */
function buildPatch(
  body: HelpArticleInput,
): { error: string } | { patch: Record<string, unknown> } {
  const patch: Record<string, unknown> = {};

  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) return { error: "title cannot be empty" };
    patch.title = title;
  }
  if (body.summary !== undefined) patch.summary = String(body.summary).trim();
  if (body.body_html !== undefined) patch.body_html = String(body.body_html);
  if (body.body_markdown !== undefined) patch.body_markdown = String(body.body_markdown);
  if (body.body_json !== undefined) patch.body_json = body.body_json ?? {};
  if (body.category_key !== undefined) patch.category_key = String(body.category_key).trim();

  if (body.audience !== undefined) {
    if (!isHelpAudience(body.audience)) return { error: "invalid audience" };
    patch.audience = body.audience;
  }
  if (body.visibility !== undefined) {
    if (!isHelpVisibility(body.visibility)) return { error: "invalid visibility" };
    patch.visibility = body.visibility;
  }
  if (body.status !== undefined) {
    if (!isHelpStatus(body.status)) return { error: "invalid status" };
    patch.status = body.status;
    // published_at is NOT set here. It is stamped the first time a row goes
    // live and never moved after, so "Updated <date>" stays distinguishable
    // from "Published <date>" (US-2591) — the callers below own that.
  }
  if (body.sort_order !== undefined) patch.sort_order = Number(body.sort_order) || 0;
  if (body.hero_image_url !== undefined) {
    patch.hero_image_url = body.hero_image_url?.toString().trim() || null;
  }
  if (body.video_url !== undefined) patch.video_url = body.video_url?.toString().trim() || null;
  if (body.pillar_path !== undefined) {
    patch.pillar_path = body.pillar_path?.toString().trim() || null;
  }
  if (body.faq !== undefined) patch.faq = normalizeFaq(body.faq);
  if (body.related_slugs !== undefined) patch.related_slugs = cleanSlugArray(body.related_slugs);
  if (body.reviewed_at !== undefined) patch.reviewed_at = body.reviewed_at || null;
  if (body.review_interval_days !== undefined) {
    const n = Number(body.review_interval_days);
    if (!Number.isFinite(n) || n < 1) return { error: "review_interval_days must be >= 1" };
    patch.review_interval_days = Math.round(n);
  }
  return { patch };
}

// ── LIST (everything, drafts included) ────────────────────
helpAdminRoutes.get("/", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("help_articles")
    .select(ARTICLE_COLUMNS)
    .order("category_key", { ascending: true })
    .order("sort_order", { ascending: true });
  if (error) return failSafe(c, 500, "Couldn't load help articles.", error, "help.admin.list");
  return c.json({ articles: data ?? [] });
});

/**
 * US-2591: what needs re-reading, and what readers thought of it.
 *
 * Registered BEFORE /:id so the literal path wins the match.
 *
 * A stale article is FLAGGED and nothing else. It keeps its sitemap entry and
 * stays published, because a page that vanishes for want of a review is worse
 * for a reader than one that is slightly out of date, and quietly dropping URLs
 * is how a section loses its ranking without anybody deciding to.
 */
helpAdminRoutes.get("/freshness", async (c) => {
  const { data: stale, error: staleErr } = await supabaseAdmin
    .from("help_articles_stale")
    .select("slug, title, category_key, visibility, reviewed_at, published_at, review_interval_days, is_stale, days_since_basis")
    .order("days_since_basis", { ascending: false });
  if (staleErr) {
    return failSafe(c, 500, "Couldn't load freshness.", staleErr, "help.admin.freshness");
  }

  const { data: votes, error: voteErr } = await supabaseAdmin
    .from("help_feedback")
    .select("article_slug, content_version, helpful, comment, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  if (voteErr) {
    return failSafe(c, 500, "Couldn't load feedback.", voteErr, "help.admin.freshness");
  }

  // Tally per article. Deliberately NOT a stored score: a rewrite bumps
  // content_version, and a rolled-up average across versions would let an
  // article's old wording keep dragging its new wording down.
  const tally = new Map<string, { helpful: number; unhelpful: number; comments: string[] }>();
  for (const v of (votes ?? []) as Array<{
    article_slug: string;
    helpful: boolean;
    comment: string | null;
  }>) {
    const t = tally.get(v.article_slug) ?? { helpful: 0, unhelpful: 0, comments: [] };
    if (v.helpful) t.helpful += 1;
    else t.unhelpful += 1;
    if (v.comment) t.comments.push(v.comment);
    tally.set(v.article_slug, t);
  }

  return c.json({
    articles: ((stale ?? []) as Array<{ slug: string }>).map((row) => ({
      ...row,
      feedback: tally.get(row.slug) ?? { helpful: 0, unhelpful: 0, comments: [] },
    })),
  });
});

/**
 * US-2592: did any of this work?
 *
 * Registered BEFORE /:id so the literal path wins the match.
 *
 * Two numbers decide whether the epic paid for itself: how much organic traffic
 * the help centre earns, and how many tickets it prevents. This endpoint answers
 * both from Postgres, because the surface that earns the traffic is
 * server-rendered and PostHog is not on it. See lib/help-analytics.ts for why
 * the two measurement systems are reported side by side and never summed.
 */
helpAdminRoutes.get("/report", async (c) => {
  try {
    const days = reportWindowDays(c.req.query("days"));
    const now = new Date();
    const sinceIso = new Date(now.getTime() - days * 86_400_000).toISOString();
    const sinceDay = sinceIso.slice(0, 10);

    const [articlesRes, viewsRes, feedbackRes, deflectionsRes, missesRes, ticketsRes] =
      await Promise.all([
        supabaseAdmin
          .from("help_articles")
          .select("slug, title, category_key, visibility, published_at"),
        supabaseAdmin
          .from("help_article_views")
          .select("article_slug, surface, views")
          .gte("day", sinceDay),
        supabaseAdmin
          .from("help_feedback")
          .select("article_slug, helpful")
          .gte("created_at", sinceIso),
        supabaseAdmin
          .from("help_deflections")
          .select("article_opened")
          .gte("created_at", sinceIso),
        supabaseAdmin.rpc("help_zero_result_queries", { p_since: sinceIso, p_limit: 50 }),
        // Two windows either side of the split, so the query has to reach back
        // twice the reporting window.
        supabaseAdmin
          .from("support_tickets")
          .select("created_at, triage_category")
          .gte("created_at", new Date(now.getTime() - days * 2 * 86_400_000).toISOString()),
      ]);

    const firstErr = articlesRes.error ?? viewsRes.error ?? feedbackRes.error ??
      deflectionsRes.error ?? missesRes.error ?? ticketsRes.error;
    if (firstErr) {
      return failSafe(c, 500, "Couldn't build the help report.", firstErr, "help.admin.report");
    }

    const meta = (articlesRes.data ?? []) as unknown as HelpArticleMeta[];
    const deflections = (deflectionsRes.data ?? []) as unknown as HelpDeflectionRow[];
    const tickets = (ticketsRes.data ?? []) as unknown as TicketRow[];

    const articles = rankArticles(
      meta,
      (viewsRes.data ?? []) as unknown as HelpViewRow[],
      (feedbackRes.data ?? []) as unknown as HelpFeedbackRow[],
      deflections,
    );

    // Only tickets INSIDE the reporting window belong in the rate; the wider
    // pull above exists for the before/after split.
    const ticketsInWindow = tickets.filter((t) => t.created_at >= sinceIso).length;
    const deflected = deflections.filter((d) => d.article_opened).length;

    // The split is the day the most recent article shipped, because that is the
    // event the question is about. Falling back to the window start keeps the
    // panel truthful on a corpus that has never published anything.
    const latestPublish = meta
      .map((m) => m.published_at)
      .filter((v): v is string => typeof v === "string")
      .sort()
      .at(-1);

    return c.json({
      window_days: days,
      since: sinceIso,
      articles,
      zero_result_queries: missesRes.data ?? [],
      deflection: {
        deflected,
        tickets: ticketsInWindow,
        rate: deflectionRate(deflected, ticketsInWindow),
      },
      tickets: splitTicketsByCategory(
        tickets,
        latestPublish ? new Date(latestPublish) : new Date(sinceIso),
        days,
        now,
      ),
    });
  } catch (err) {
    return failSafe(c, 500, "Couldn't build the help report.", err, "help.admin.report");
  }
});

// Registered BEFORE /:id so the literal path wins the match.
helpAdminRoutes.get("/categories", async (c) => {
  try {
    return c.json({ categories: await loadCategories() });
  } catch (err) {
    return failSafe(c, 500, "Couldn't load help categories.", err, "help.admin.categories");
  }
});

helpAdminRoutes.get("/:id", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("help_articles")
    .select(ARTICLE_COLUMNS)
    .eq("id", c.req.param("id"))
    .maybeSingle();
  if (error) return failSafe(c, 500, "Couldn't load the article.", error, "help.admin.get");
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json({ article: data });
});

// ── CREATE ────────────────────────────────────────────────
helpAdminRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as HelpArticleInput;
  const title = String(body.title ?? "").trim();
  if (!title) return c.json({ error: "title is required" }, 400);
  const categoryKey = String(body.category_key ?? "").trim();
  if (!categoryKey) return c.json({ error: "category_key is required" }, 400);

  const slug = slugifyHelp(body.slug || title);
  if (!slug) return c.json({ error: "slug could not be derived from the title" }, 400);
  if (isReservedHelpSlug(slug)) return c.json({ error: `"${slug}" is a reserved slug` }, 400);
  if (await slugTaken(slug)) return c.json({ error: `"${slug}" is already taken` }, 409);

  const built = buildPatch({ ...body, title, category_key: categoryKey });
  if ("error" in built) return c.json({ error: built.error }, 400);
  const status = built.patch.status ?? "draft";

  const { data, error } = await supabaseAdmin
    .from("help_articles")
    .insert({
      ...built.patch,
      slug,
      status,
      published_at: status === "published" ? new Date().toISOString() : null,
    })
    .select(ARTICLE_COLUMNS)
    .single();
  if (error) return failSafe(c, 500, "Couldn't create the article.", error, "help.admin.create");

  const created = data as unknown as HelpArticleRow;
  await writeAuditLog(c, {
    action: "help.article_create",
    targetType: "help_article",
    targetId: created.id,
    after: { slug, title, visibility: created.visibility, status: created.status },
  });
  afterHelpWrite(created);
  return c.json({ article: created });
});

// ── UPDATE ────────────────────────────────────────────────
helpAdminRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as HelpArticleInput;

  const { data: existingRaw, error: readErr } = await supabaseAdmin
    .from("help_articles")
    .select(ARTICLE_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (readErr) return failSafe(c, 500, "Couldn't load the article.", readErr, "help.admin.update");
  const existing = existingRaw as HelpArticleRow | null;
  if (!existing) return c.json({ error: "Not found" }, 404);

  const built = buildPatch(body);
  if ("error" in built) return c.json({ error: built.error }, 400);
  const patch = built.patch;

  if (body.slug !== undefined) {
    const slug = slugifyHelp(body.slug);
    if (!slug) return c.json({ error: "slug cannot be empty" }, 400);
    if (isReservedHelpSlug(slug)) return c.json({ error: `"${slug}" is a reserved slug` }, 400);
    if (await slugTaken(slug, id)) return c.json({ error: `"${slug}" is already taken` }, 409);
    patch.slug = slug;
  }

  // Stamp published_at on the first publish only; leave it alone afterwards.
  if (patch.status === "published") {
    patch.published_at = existing.published_at ?? new Date().toISOString();
  } else if ("published_at" in patch) {
    delete patch.published_at;
  }

  const { data, error } = await supabaseAdmin
    .from("help_articles")
    .update(patch)
    .eq("id", id)
    .select(ARTICLE_COLUMNS)
    .single();
  if (error) return failSafe(c, 500, "Couldn't update the article.", error, "help.admin.update");

  const updated = data as unknown as HelpArticleRow;
  await writeAuditLog(c, {
    action: "help.article_update",
    targetType: "help_article",
    targetId: id,
    before: { visibility: existing.visibility, status: existing.status, slug: existing.slug },
    after: { visibility: updated.visibility, status: updated.status, slug: updated.slug },
  });
  // Purge BOTH shapes when the slug or the category moved: the old URL is now a
  // 301 that crawlers still hold a cached 200 for, and the new one has never
  // been rendered. Purging only the new one leaves the old body live at the old
  // address for the whole cache TTL.
  afterHelpWrite(updated);
  if (existing.slug !== updated.slug || existing.category_key !== updated.category_key) {
    afterHelpWrite({ ...existing, visibility: updated.visibility, status: updated.status });
  }
  return c.json({ article: updated });
});

// ── DELETE ────────────────────────────────────────────────
helpAdminRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  // Read it first: after the delete there is no row to derive the URLs from, and
  // a deleted article's page is exactly the one that must stop being served.
  const { data: doomedRaw } = await supabaseAdmin
    .from("help_articles")
    .select(ARTICLE_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  const doomed = doomedRaw as HelpArticleRow | null;

  const { error } = await supabaseAdmin.from("help_articles").delete().eq("id", id);
  if (error) return failSafe(c, 500, "Couldn't delete the article.", error, "help.admin.delete");
  // Purge, but do NOT submit to IndexNow: asking Bing to crawl a URL we just
  // deleted is asking it to record a 404. afterHelpWrite skips the submit for
  // anything that is not published+public, and a deleted row is neither.
  if (doomed) afterHelpWrite({ ...doomed, status: "archived" });
  await writeAuditLog(c, {
    action: "help.article_delete",
    targetType: "help_article",
    targetId: id,
  });
  return c.json({ ok: true });
});
