import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";

// Knowledge docs CRUD. These are the CLAUDE.md-style reference docs
// loaded into every AI prompt to keep voice/style consistent. The
// migration seeds six baseline docs (brand.voice, blog.gradethread.style,
// blog.flipdesk.style, social.long.style, social.short.style, seo.pillars).
// Admins can edit them in the dashboard.

type Env = { Variables: { userId: string } };
export const contentKnowledgeRoutes = new Hono<Env>();

interface UpsertInput {
  title?: string;
  body_md: string;
}

// Cheap "tokens ≈ chars/4" heuristic. Stored as a hint for the UI to
// help admins see when a doc is getting large; not authoritative.
function estimateTokens(body: string): number {
  return Math.ceil(body.length / 4);
}

// ── LIST ─────────────────────────────────────────────────
contentKnowledgeRoutes.get("/", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("content_knowledge")
    .select("id, key, title, token_count_est, updated_at")
    .order("key", { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ docs: data ?? [] });
});

// ── READ ─────────────────────────────────────────────────
contentKnowledgeRoutes.get("/:key", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("content_knowledge")
    .select("*")
    .eq("key", c.req.param("key"))
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json({ doc: data });
});

// ── UPSERT (PUT /:key) ───────────────────────────────────
contentKnowledgeRoutes.put("/:key", async (c) => {
  const key = c.req.param("key");
  const body = (await c.req.json().catch(() => ({}))) as UpsertInput;
  if (typeof body.body_md !== "string") {
    return c.json({ error: "body_md (string) is required" }, 400);
  }

  const tokenEst = estimateTokens(body.body_md);

  const { data, error } = await supabaseAdmin
    .from("content_knowledge")
    .upsert(
      {
        key,
        title: body.title ?? key,
        body_md: body.body_md,
        token_count_est: tokenEst,
      },
      { onConflict: "key" },
    )
    .select("*")
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ doc: data });
});

// ── DELETE ───────────────────────────────────────────────
contentKnowledgeRoutes.delete("/:key", async (c) => {
  const { error } = await supabaseAdmin
    .from("content_knowledge")
    .delete()
    .eq("key", c.req.param("key"));
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});
