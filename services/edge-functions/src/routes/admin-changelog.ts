import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import {
  type ChangelogAudience,
  type ChangelogCategory,
  type ChangelogRow,
  type ChangelogStatus,
  isChangelogAudience,
  isChangelogCategory,
  isChangelogStatus,
} from "../lib/changelog.ts";
import { autoCaptureChangelogDrafts, CHANGELOG_COLS } from "../lib/changelog-job.ts";

// US-916: Product "What's New" changelog — admin CRUD.
//
// Mounted at /api/admin/changelog, inheriting authMiddleware + adminAuthMiddleware
// (admin JWT + AAL2) from the /api/admin/* group in main.ts. Operators author /
// curate entries here; the public feed (routes/changelog.ts) and the autonomous
// newsletter assembler consume the PUBLISHED ones. changelog_entries is an
// operator surface (service-role client; no tenant scoping needed).

type Env = { Variables: { userId: string; adminRole: "admin" | "super_admin" } };
export const adminChangelogRoutes = new Hono<Env>();

interface ChangelogInput {
  title?: string;
  summary?: string | null;
  body?: string | null;
  category?: string;
  audience?: string;
  image_url?: string | null;
  status?: string;
}

function nullableStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
}

// ── LIST ──────────────────────────────────────────────────
// Optional ?status= / ?audience= filters; newest first.
adminChangelogRoutes.get("/", async (c) => {
  const status = c.req.query("status");
  const audience = c.req.query("audience");
  let q = supabaseAdmin
    .from("changelog_entries")
    .select(CHANGELOG_COLS)
    .order("created_at", { ascending: false })
    .limit(500);
  if (status && isChangelogStatus(status)) q = q.eq("status", status);
  if (audience && isChangelogAudience(audience)) q = q.eq("audience", audience);
  const { data, error } = await q;
  if (error) return failSafe(c, 500, "Couldn't load changelog entries.", error, "admin.changelog.list");
  return c.json({ entries: data ?? [] });
});

// ── READ ──────────────────────────────────────────────────
adminChangelogRoutes.get("/:id", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("changelog_entries")
    .select(CHANGELOG_COLS)
    .eq("id", c.req.param("id"))
    .maybeSingle();
  if (error) return failSafe(c, 500, "Couldn't load the changelog entry.", error, "admin.changelog.get");
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json({ entry: data });
});

// ── CREATE ────────────────────────────────────────────────
adminChangelogRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as ChangelogInput;
  const title = nullableStr(body.title);
  if (!title) return c.json({ error: "title is required" }, 400);

  const category: ChangelogCategory = isChangelogCategory(body.category)
    ? body.category
    : "feature";
  const audience: ChangelogAudience = isChangelogAudience(body.audience)
    ? body.audience
    : "all";
  const status: ChangelogStatus = isChangelogStatus(body.status) ? body.status : "draft";

  const { data, error } = await supabaseAdmin
    .from("changelog_entries")
    .insert({
      title,
      summary: nullableStr(body.summary),
      body: nullableStr(body.body),
      category,
      audience,
      image_url: nullableStr(body.image_url),
      status,
      // Publishing on create stamps published_at now.
      published_at: status === "published" ? new Date().toISOString() : null,
      source: "manual",
      created_by: c.get("userId"),
    })
    .select(CHANGELOG_COLS)
    .single();
  if (error) return failSafe(c, 500, "Couldn't create the changelog entry.", error, "admin.changelog.create");
  const entry = data as unknown as ChangelogRow;

  await writeAuditLog(c, {
    action: "changelog.create",
    targetType: "changelog_entry",
    targetId: entry.id,
    after: { title, category, audience, status },
  });
  return c.json({ entry });
});

// ── UPDATE ────────────────────────────────────────────────
// A status transition draft→published stamps published_at (if not already set);
// published→draft clears featured bookkeeping so it can be re-featured later.
adminChangelogRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as ChangelogInput;

  const { data: prior } = await supabaseAdmin
    .from("changelog_entries")
    .select("status, published_at")
    .eq("id", id)
    .maybeSingle();
  if (!prior) return c.json({ error: "Not found" }, 404);

  const patch: Record<string, unknown> = {};
  if (body.title !== undefined) {
    const t = nullableStr(body.title);
    if (!t) return c.json({ error: "title cannot be empty" }, 400);
    patch.title = t;
  }
  if (body.summary !== undefined) patch.summary = nullableStr(body.summary);
  if (body.body !== undefined) patch.body = nullableStr(body.body);
  if (body.image_url !== undefined) patch.image_url = nullableStr(body.image_url);
  if (body.category !== undefined && isChangelogCategory(body.category)) {
    patch.category = body.category;
  }
  if (body.audience !== undefined && isChangelogAudience(body.audience)) {
    patch.audience = body.audience;
  }
  if (body.status !== undefined && isChangelogStatus(body.status)) {
    patch.status = body.status;
    if (body.status === "published") {
      // Stamp published_at on first publish; keep an existing timestamp.
      if (!(prior as { published_at: string | null }).published_at) {
        patch.published_at = new Date().toISOString();
      }
    } else {
      // Back to draft → eligible to be featured again next time it's published.
      patch.featured_at = null;
      patch.featured_issue_id = null;
    }
  }

  const { data, error } = await supabaseAdmin
    .from("changelog_entries")
    .update(patch)
    .eq("id", id)
    .select(CHANGELOG_COLS)
    .maybeSingle();
  if (error) return failSafe(c, 500, "Couldn't update the changelog entry.", error, "admin.changelog.update");
  if (!data) return c.json({ error: "Not found" }, 404);
  const entry = data as unknown as ChangelogRow;

  await writeAuditLog(c, {
    action: "changelog.update",
    targetType: "changelog_entry",
    targetId: id,
    after: { status: entry.status, audience: entry.audience, category: entry.category },
  });
  return c.json({ entry });
});

// ── DELETE ────────────────────────────────────────────────
adminChangelogRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const { data: prior } = await supabaseAdmin
    .from("changelog_entries")
    .select("id, title, status")
    .eq("id", id)
    .maybeSingle();
  const { error } = await supabaseAdmin.from("changelog_entries").delete().eq("id", id);
  if (error) return failSafe(c, 500, "Couldn't delete the changelog entry.", error, "admin.changelog.delete");
  await writeAuditLog(c, {
    action: "changelog.delete",
    targetType: "changelog_entry",
    targetId: id,
    before: prior ?? null,
  });
  return c.json({ ok: true });
});

// ── AUTO-CAPTURE (manual trigger) ─────────────────────────
// Drafts changelog entries from recently published blog posts on demand (the
// assembler also runs this weekly). Returns how many new drafts were created.
adminChangelogRoutes.post("/auto-capture", async (c) => {
  const created = await autoCaptureChangelogDrafts(Date.now());
  await writeAuditLog(c, {
    action: "changelog.auto_capture",
    targetType: "changelog_entry",
    after: { created },
  });
  return c.json({ ok: true, created });
});
