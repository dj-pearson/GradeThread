import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { isAdminUserCached } from "../lib/maintenance.ts";
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
  normalizeFaq,
  projectArticle,
  projectListItem,
  readableStatusesFor,
  slugifyHelp,
  visibilitiesFor,
} from "../lib/help-center.ts";

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

function indexPayload(categories: HelpCategoryRow[], rows: HelpArticleRow[]) {
  const articles = rows.map(projectListItem);
  const counts = new Map<string, number>();
  for (const a of articles) counts.set(a.category_key, (counts.get(a.category_key) ?? 0) + 1);
  return {
    categories: categories.map((c) => ({ ...c, article_count: counts.get(c.key) ?? 0 })),
    articles,
  };
}

// ══════════════════════════════════════════════════════════
// PUBLIC — anonymous, mounted at /api/content/public/help
// ══════════════════════════════════════════════════════════

export const helpPublicRoutes = new Hono<PublicEnv>();

helpPublicRoutes.get("/", async (c) => {
  try {
    const [categories, rows] = await Promise.all([loadCategories(), loadIndex("anon")]);
    return c.json(indexPayload(categories, rows));
  } catch (err) {
    return failSafe(c, 500, "Couldn't load help articles.", err, "help.public.index");
  }
});

helpPublicRoutes.get("/:slug", async (c) => {
  try {
    const row = await loadArticle("anon", c.req.param("slug"));
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json({ article: projectArticle(row) });
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

helpReaderRoutes.get("/:slug", async (c) => {
  try {
    const viewer = await viewerFor(c.get("userId"));
    const row = await loadArticle(viewer, c.req.param("slug"));
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json({ article: projectArticle(row) });
  } catch (err) {
    return failSafe(c, 500, "Couldn't load that help article.", err, "help.reader.article");
  }
});

// ══════════════════════════════════════════════════════════
// AUTHORING — admin only, mounted at /api/content/help
// ══════════════════════════════════════════════════════════

export const helpAdminRoutes = new Hono<AdminEnv>();

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
  return c.json({ article: updated });
});

// ── DELETE ────────────────────────────────────────────────
helpAdminRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const { error } = await supabaseAdmin.from("help_articles").delete().eq("id", id);
  if (error) return failSafe(c, 500, "Couldn't delete the article.", error, "help.admin.delete");
  await writeAuditLog(c, {
    action: "help.article_delete",
    targetType: "help_article",
    targetId: id,
  });
  return c.json({ ok: true });
});
