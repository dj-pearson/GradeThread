import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import {
  type CheckedUpdateClient,
  updateByIdChecked,
  ZeroRowsAffectedError,
} from "../lib/db-write.ts";
import { requireScope } from "../lib/scope-guard.ts";

// US-840: admin authoring surface for the support knowledge base — the ONLY
// system-side corpus the AI Support Assistant may speak from (US-830 schema,
// US-833 retrieval, US-835 prompt). Mounted at /api/admin/knowledge-base, it
// inherits authMiddleware + adminAuthMiddleware (admin/super_admin + AAL2 MFA)
// from the /api/admin/* group in main.ts.
//
// All reads + writes run service-role on the server: support_kb_articles has NO
// client INSERT/UPDATE/DELETE policy (00183), so authoring MUST happen here. The
// admin+MFA gate is the authorization boundary; these are intentionally
// cross-tenant/system writes (no per-tenant scoping), mirroring admin-support.ts.
//
// VERSIONING + edited_by: the DB triggers (00183) bump `version` on a content
// edit and snapshot every distinct version into support_kb_revisions. The
// revision trigger records `edited_by = auth.uid()`, which is NULL under the
// service-role client — so after each content write we explicitly stamp the
// just-written revision with the acting admin's id so history is attributable
// (an acceptance-criteria requirement).

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminKnowledgeBaseRoutes = new Hono<AdminEnv>();

// US-1560: whole-router scope guard (see lib/admin-scope-map.ts).
adminKnowledgeBaseRoutes.use("*", requireScope("content:publish"));

const db = supabaseAdmin as unknown as CheckedUpdateClient;

// Value sets mirror the CHECK constraints on support_kb_articles (00183). Kept
// in sync here so the API rejects bad input with a clear 400 rather than letting
// the DB throw a generic constraint error.
const CATEGORIES = new Set([
  "grading",
  "pricing",
  "plans",
  "photos",
  "disputes",
  "flipdesk",
  "billing",
  "account",
  "getting_started",
]);
const AUDIENCES = new Set(["public", "subscriber"]);

const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 50_000;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface ArticleRow {
  id: string;
  slug: string;
  title: string;
  body_md: string;
  category: string;
  audience: string;
  version: number;
  is_published: boolean;
  created_at: string;
  updated_at: string;
}

// Columns returned to the editor (full body) vs the list (no body, lighter).
const ARTICLE_COLS =
  "id, slug, title, body_md, category, audience, version, is_published, " +
  "created_at, updated_at";
const LIST_COLS =
  "id, slug, title, category, audience, version, is_published, updated_at";

function auditLog(
  c: Context,
  action: string,
  targetId: string | null,
  details: Record<string, unknown>,
) {
  return writeAuditLog(c, {
    action,
    targetType: "support_kb_article",
    targetId,
    details,
  });
}

// Derive a URL-safe slug from a title (fallback when none supplied on create).
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Re-attribute the auto-written revision (trigger sets edited_by NULL under the
// service-role client) to the acting admin. Scoped to the exact (article, version)
// just written so it can never touch an older revision. Best-effort: a failure
// here must not fail the save the admin already saw succeed.
async function stampRevisionEditor(
  articleId: string,
  version: number,
  adminId: string,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("support_kb_revisions")
    .update({ edited_by: adminId } as never)
    .eq("article_id", articleId)
    .eq("version", version);
  if (error) {
    console.error("[admin-kb] stamp revision editor failed:", error.message);
  }
}

// ── GET / — list + search articles ──────────────────────────────────────────
// Query params: ?q= (full-text over title+body), ?category=, ?audience=,
// ?status=published|draft|all (default all).
adminKnowledgeBaseRoutes.get("/", async (c) => {
  const q = c.req.query("q")?.trim();
  const category = c.req.query("category");
  const audience = c.req.query("audience");
  const status = c.req.query("status") ?? "all";

  let query = supabaseAdmin
    .from("support_kb_articles")
    .select(LIST_COLS)
    .order("updated_at", { ascending: false })
    .limit(200);

  if (category && CATEGORIES.has(category)) query = query.eq("category", category);
  if (audience && AUDIENCES.has(audience)) query = query.eq("audience", audience);
  if (status === "published") query = query.eq("is_published", true);
  else if (status === "draft") query = query.eq("is_published", false);
  if (q) {
    query = query.textSearch("search_tsv", q, {
      config: "english",
      type: "websearch",
    });
  }

  const { data, error } = await query;
  if (error) {
    console.error("[admin-kb] list failed:", error.message);
    return c.json({ error: "Could not load knowledge base articles" }, 500);
  }
  return c.json({ articles: data ?? [] });
});

// ── GET /:id — full article (incl. body) ─────────────────────────────────────
adminKnowledgeBaseRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const { data, error } = await supabaseAdmin
    .from("support_kb_articles")
    .select(ARTICLE_COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("[admin-kb] read failed:", error.message);
    return c.json({ error: "Could not load article" }, 500);
  }
  if (!data) return c.json({ error: "Article not found" }, 404);
  return c.json({ article: data });
});

// ── GET /:id/revisions — append-only edit history (newest first) ─────────────
adminKnowledgeBaseRoutes.get("/:id/revisions", async (c) => {
  const id = c.req.param("id");

  const { data, error } = await supabaseAdmin
    .from("support_kb_revisions")
    .select("id, article_id, version, title, body_md, edited_by, created_at")
    .eq("article_id", id)
    .order("version", { ascending: false })
    .limit(200);
  if (error) {
    console.error("[admin-kb] revisions failed:", error.message);
    return c.json({ error: "Could not load revision history" }, 500);
  }

  const rows = (data ?? []) as Array<
    { edited_by: string | null } & Record<string, unknown>
  >;

  // Resolve editor emails in one read so history shows WHO made each edit.
  const editorIds = [
    ...new Set(rows.map((r) => r.edited_by).filter(Boolean) as string[]),
  ];
  const editorEmail = new Map<string, string | null>();
  if (editorIds.length > 0) {
    const { data: users } = await supabaseAdmin
      .from("users")
      .select("id, email")
      .in("id", editorIds);
    for (const u of (users ?? []) as Array<{ id: string; email: string | null }>) {
      editorEmail.set(u.id, u.email);
    }
  }

  const revisions = rows.map((r) => ({
    ...r,
    edited_by_email: r.edited_by ? editorEmail.get(r.edited_by) ?? null : null,
  }));
  return c.json({ revisions });
});

// ── POST / — create a new article (version 1) ────────────────────────────────
adminKnowledgeBaseRoutes.post("/", async (c) => {
  const adminId = c.get("userId");

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || title.length > MAX_TITLE_CHARS) {
    return c.json({ error: "A title (1–200 chars) is required" }, 400);
  }
  const bodyMd = typeof body.body_md === "string" ? body.body_md : "";
  if (bodyMd.length > MAX_BODY_CHARS) {
    return c.json({ error: "Body exceeds the 50,000 character limit" }, 400);
  }
  const category = typeof body.category === "string" ? body.category : "";
  if (!CATEGORIES.has(category)) {
    return c.json({ error: "A valid category is required" }, 400);
  }
  const audience = typeof body.audience === "string" ? body.audience : "public";
  if (!AUDIENCES.has(audience)) {
    return c.json({ error: "Audience must be 'public' or 'subscriber'" }, 400);
  }
  const rawSlug = typeof body.slug === "string" && body.slug.trim()
    ? body.slug.trim().toLowerCase()
    : slugify(title);
  if (!SLUG_RE.test(rawSlug)) {
    return c.json(
      { error: "Slug must be lowercase letters, numbers and single hyphens" },
      400,
    );
  }
  const isPublished = body.is_published === true;

  const { data, error } = await supabaseAdmin
    .from("support_kb_articles")
    .insert({
      slug: rawSlug,
      title,
      body_md: bodyMd,
      category,
      audience,
      is_published: isPublished,
    } as never)
    .select(ARTICLE_COLS)
    .single();

  if (error) {
    // 23505 = unique_violation on the slug.
    if ((error as { code?: string }).code === "23505") {
      return c.json({ error: "An article with that slug already exists" }, 409);
    }
    console.error("[admin-kb] create failed:", error.message);
    return c.json({ error: "Could not create article" }, 500);
  }

  const article = data as unknown as ArticleRow;
  // The INSERT trigger wrote revision v1 with edited_by NULL — stamp it.
  await stampRevisionEditor(article.id, article.version, adminId);

  await auditLog(c, "support_kb_article_create", article.id, {
    slug: article.slug,
    category: article.category,
    audience: article.audience,
    is_published: article.is_published,
  });

  return c.json({ article }, 201);
});

// ── PATCH /:id — edit content / metadata / publish state ─────────────────────
// Accepts any subset of { title, body_md, category, audience, slug, is_published }.
// A content edit (title or body_md change) bumps version + writes a revision via
// the DB triggers; we then stamp that revision with the acting admin. A pure
// publish/unpublish toggle changes neither version nor history.
adminKnowledgeBaseRoutes.patch("/:id", async (c) => {
  const adminId = c.get("userId");
  const id = c.req.param("id");

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { data: existing, error: readErr } = await supabaseAdmin
    .from("support_kb_articles")
    .select(ARTICLE_COLS)
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    console.error("[admin-kb] update read failed:", readErr.message);
    return c.json({ error: "Could not load article" }, 500);
  }
  if (!existing) return c.json({ error: "Article not found" }, 404);
  const prev = existing as unknown as ArticleRow;

  const update: Record<string, unknown> = {};

  if (body.title !== undefined) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > MAX_TITLE_CHARS) {
      return c.json({ error: "A title (1–200 chars) is required" }, 400);
    }
    update.title = title;
  }
  if (body.body_md !== undefined) {
    if (typeof body.body_md !== "string" || body.body_md.length > MAX_BODY_CHARS) {
      return c.json({ error: "Body must be a string under 50,000 chars" }, 400);
    }
    update.body_md = body.body_md;
  }
  if (body.category !== undefined) {
    if (typeof body.category !== "string" || !CATEGORIES.has(body.category)) {
      return c.json({ error: "A valid category is required" }, 400);
    }
    update.category = body.category;
  }
  if (body.audience !== undefined) {
    if (typeof body.audience !== "string" || !AUDIENCES.has(body.audience)) {
      return c.json({ error: "Audience must be 'public' or 'subscriber'" }, 400);
    }
    update.audience = body.audience;
  }
  if (body.slug !== undefined) {
    const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
    if (!SLUG_RE.test(slug)) {
      return c.json(
        { error: "Slug must be lowercase letters, numbers and single hyphens" },
        400,
      );
    }
    update.slug = slug;
  }
  if (body.is_published !== undefined) {
    update.is_published = body.is_published === true;
  }

  if (Object.keys(update).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  // Verify a row actually changed (service-role updates no-op silently on a
  // vanished id), mirroring the admin-support / admin-disputes pattern.
  try {
    await updateByIdChecked(db, "support_kb_articles", id, update);
  } catch (err) {
    if (err instanceof ZeroRowsAffectedError) {
      return c.json({ error: "Article could not be updated (no row changed)" }, 409);
    }
    // updateByIdChecked rewraps the PostgrestError as a plain Error, so the
    // unique-violation code is gone — detect the slug collision by message.
    if (err instanceof Error && /duplicate key|unique constraint/i.test(err.message)) {
      return c.json({ error: "An article with that slug already exists" }, 409);
    }
    console.error("[admin-kb] update failed:", err);
    return c.json({ error: "Could not update article" }, 500);
  }

  // Re-read the post-write row to learn the (possibly bumped) version.
  const { data: after } = await supabaseAdmin
    .from("support_kb_articles")
    .select(ARTICLE_COLS)
    .eq("id", id)
    .maybeSingle();
  const article = (after ?? prev) as unknown as ArticleRow;

  // A content edit advanced the version + wrote a fresh revision — attribute it.
  const contentChanged = article.version !== prev.version;
  if (contentChanged) {
    await stampRevisionEditor(id, article.version, adminId);
  }

  await auditLog(c, "support_kb_article_update", id, {
    slug: article.slug,
    version: article.version,
    content_changed: contentChanged,
    published_changed: update.is_published !== undefined &&
      update.is_published !== prev.is_published,
    is_published: article.is_published,
  });

  return c.json({ article });
});
