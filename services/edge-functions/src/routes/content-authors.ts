import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";

// Author-entity CRUD (US-874). Admin-only (mounted behind authMiddleware +
// adminAuthMiddleware in main.ts). Backs the blog editor's author picker and
// the public /authors/:slug E-E-A-T pages.

type Env = { Variables: { userId: string } };
export const contentAuthorsRoutes = new Hono<Env>();

const AUTHOR_COLUMNS =
  "id, slug, name, title, bio_md, avatar_url, credentials, same_as, created_at, updated_at";

interface AuthorInput {
  slug?: string;
  name?: string;
  title?: string | null;
  bio_md?: string | null;
  avatar_url?: string | null;
  credentials?: string[];
  same_as?: string[];
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function ensureUniqueSlug(base: string, exceptId?: string): Promise<string> {
  let candidate = base || `author-${Date.now()}`;
  for (let i = 0; i < 10; i++) {
    const { data } = await supabaseAdmin
      .from("content_authors")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();
    if (!data || (exceptId && data.id === exceptId)) return candidate;
    candidate = `${base}-${i + 2}`;
  }
  return `${base}-${Date.now()}`;
}

function cleanStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((s) => String(s).trim()).filter(Boolean);
}

// ── LIST ──────────────────────────────────────────────────
contentAuthorsRoutes.get("/", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("content_authors")
    .select(AUTHOR_COLUMNS)
    .order("name", { ascending: true });
  if (error) return failSafe(c, 500, "Couldn't load authors.", error, "content.authors.list");
  return c.json({ authors: data ?? [] });
});

// ── READ ──────────────────────────────────────────────────
contentAuthorsRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const { data, error } = await supabaseAdmin
    .from("content_authors")
    .select(AUTHOR_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) return failSafe(c, 500, "Couldn't load the author.", error, "content.authors.get");
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json({ author: data });
});

// ── CREATE ────────────────────────────────────────────────
contentAuthorsRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as AuthorInput;
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }
  const slug = await ensureUniqueSlug(slugify(body.slug ?? body.name));

  const { data, error } = await supabaseAdmin
    .from("content_authors")
    .insert({
      slug,
      name: body.name.trim(),
      title: body.title?.trim() || null,
      bio_md: body.bio_md ?? null,
      avatar_url: body.avatar_url?.trim() || null,
      credentials: cleanStringArray(body.credentials),
      same_as: cleanStringArray(body.same_as),
    })
    .select(AUTHOR_COLUMNS)
    .single();
  if (error) return failSafe(c, 500, "Couldn't create the author.", error, "content.authors.create");

  await writeAuditLog(c, {
    action: "content.author_create",
    targetType: "content_author",
    targetId: data.id,
    after: { slug, name: data.name },
  });
  return c.json({ author: data });
});

// ── UPDATE ────────────────────────────────────────────────
contentAuthorsRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as AuthorInput;

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = String(body.name).trim();
  if (body.slug !== undefined) {
    patch.slug = await ensureUniqueSlug(slugify(body.slug), id);
  }
  if (body.title !== undefined) patch.title = body.title?.trim() || null;
  if (body.bio_md !== undefined) patch.bio_md = body.bio_md ?? null;
  if (body.avatar_url !== undefined) {
    patch.avatar_url = body.avatar_url?.trim() || null;
  }
  if (body.credentials !== undefined) {
    patch.credentials = cleanStringArray(body.credentials);
  }
  if (body.same_as !== undefined) patch.same_as = cleanStringArray(body.same_as);

  const { data, error } = await supabaseAdmin
    .from("content_authors")
    .update(patch)
    .eq("id", id)
    .select(AUTHOR_COLUMNS)
    .maybeSingle();
  if (error) return failSafe(c, 500, "Couldn't update the author.", error, "content.authors.update");
  if (!data) return c.json({ error: "Not found" }, 404);

  await writeAuditLog(c, {
    action: "content.author_update",
    targetType: "content_author",
    targetId: id,
    after: { slug: data.slug, name: data.name },
  });
  return c.json({ author: data });
});

// ── DELETE ────────────────────────────────────────────────
// blog_posts.author_id is ON DELETE SET NULL, so deleting an author just unlinks
// their posts (they fall back to the legacy byline / "GradeThread Team").
contentAuthorsRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const { data: prior } = await supabaseAdmin
    .from("content_authors")
    .select("id, slug, name")
    .eq("id", id)
    .maybeSingle();
  const { error } = await supabaseAdmin
    .from("content_authors")
    .delete()
    .eq("id", id);
  if (error) return failSafe(c, 500, "Couldn't delete the author.", error, "content.authors.delete");
  await writeAuditLog(c, {
    action: "content.author_delete",
    targetType: "content_author",
    targetId: id,
    before: prior ?? null,
  });
  return c.json({ ok: true });
});
