import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  findDuplicateKeywords,
  isKeywordDuplicate,
  type ContentProduct,
  type ContentSurface,
} from "../lib/content-history.ts";
import { researchTopics } from "../lib/content-ai-research.ts";

// Topic bank: queued titles partitioned by (surface, product_focus).
// The bank is filled by /research (AI-driven, stub here in Phase A) or
// /bulk (manual). The scheduler tick pulls oldest 'queued' and marks
// it 'assigned' → eventually 'used' once a post is published.

type Env = { Variables: { userId: string } };
export const contentTopicsRoutes = new Hono<Env>();

interface Candidate {
  title: string;
  angle?: string;
  primary_keyword: string;
  secondary_keywords?: string[];
  search_intent?: string;
}

// ── LIST ─────────────────────────────────────────────────
contentTopicsRoutes.get("/", async (c) => {
  const surface = c.req.query("surface") as ContentSurface | undefined;
  const productFocus = c.req.query("product_focus") as
    | ContentProduct
    | undefined;
  const status = c.req.query("status");
  const limit = Math.min(Number(c.req.query("limit") ?? "200") || 200, 500);

  let q = supabaseAdmin
    .from("content_topics")
    .select("*")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (surface) q = q.eq("surface", surface);
  if (productFocus) q = q.eq("product_focus", productFocus);
  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ topics: data ?? [] });
});

// ── COUNTS PER BUCKET ────────────────────────────────────
// Quick dashboard summary: how full is each (surface, product_focus, status) bucket?
contentTopicsRoutes.get("/counts", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("content_topics")
    .select("surface, product_focus, status");
  if (error) return c.json({ error: error.message }, 500);

  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    const k = `${row.surface}:${row.product_focus}:${row.status}`;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return c.json({ counts });
});

// ── BULK CREATE (manual) ─────────────────────────────────
contentTopicsRoutes.post("/bulk", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    surface: ContentSurface;
    product_focus: ContentProduct;
    candidates: Candidate[];
  };
  if (
    !body.surface ||
    !body.product_focus ||
    !Array.isArray(body.candidates) ||
    body.candidates.length === 0
  ) {
    return c.json(
      { error: "surface, product_focus, candidates[] are required" },
      400,
    );
  }

  // Dedup against existing bank + history.
  const keywords = body.candidates
    .map((c) => c.primary_keyword)
    .filter(Boolean);
  const dupes = await findDuplicateKeywords(
    body.surface,
    body.product_focus,
    keywords,
  );
  const accepted = body.candidates.filter(
    (c) => !dupes.has(c.primary_keyword.trim().toLowerCase()),
  );

  if (accepted.length === 0) {
    return c.json({ inserted: 0, rejected: body.candidates.length, topics: [] });
  }

  const { data, error } = await supabaseAdmin
    .from("content_topics")
    .insert(
      accepted.map((c) => ({
        surface: body.surface,
        product_focus: body.product_focus,
        title: c.title,
        angle: c.angle ?? null,
        primary_keyword: c.primary_keyword,
        secondary_keywords: c.secondary_keywords ?? [],
        search_intent: c.search_intent ?? null,
        status: "queued" as const,
        generated_by: "human" as const,
        source: "manual" as const,
      })),
    )
    .select("*");
  if (error) return c.json({ error: error.message }, 500);
  return c.json({
    inserted: data?.length ?? 0,
    rejected: body.candidates.length - (data?.length ?? 0),
    topics: data ?? [],
  });
});

// ── REJECT ───────────────────────────────────────────────
contentTopicsRoutes.post("/:id/reject", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("content_topics")
    .update({ status: "rejected" })
    .eq("id", c.req.param("id"))
    .select("*")
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json({ topic: data });
});

// ── PROMOTE TO DRAFT ─────────────────────────────────────
// Pulls a topic out of the bank and creates a matching draft (blog or
// social, depending on the topic's surface). Marks topic 'assigned'.
contentTopicsRoutes.post("/:id/promote", async (c) => {
  const id = c.req.param("id");
  const { data: topic, error: loadErr } = await supabaseAdmin
    .from("content_topics")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) return c.json({ error: loadErr.message }, 500);
  if (!topic) return c.json({ error: "Not found" }, 404);
  if (topic.status !== "queued") {
    return c.json({ error: `topic status is ${topic.status}, not queued` }, 409);
  }

  if (topic.surface === "blog") {
    // Slug uniqueness handled in content-blog when status flips; for the
    // initial draft we just take a best-effort slug.
    const baseSlug = topic.title
      .toLowerCase()
      .trim()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || `post-${Date.now()}`;

    let slug = baseSlug;
    for (let i = 0; i < 5; i++) {
      const { data: clash } = await supabaseAdmin
        .from("blog_posts")
        .select("id")
        .eq("slug", slug)
        .maybeSingle();
      if (!clash) break;
      slug = `${baseSlug}-${i + 2}`;
    }

    const { data: post, error: insErr } = await supabaseAdmin
      .from("blog_posts")
      .insert({
        title: topic.title,
        slug,
        product_focus: topic.product_focus,
        topic_id: topic.id,
        primary_keyword: topic.primary_keyword,
        secondary_keywords: topic.secondary_keywords ?? [],
        generated_by: "human" as const,
        status: "draft" as const,
      })
      .select("*")
      .single();
    if (insErr) return c.json({ error: insErr.message }, 500);

    await supabaseAdmin
      .from("content_topics")
      .update({ status: "assigned" })
      .eq("id", id);
    return c.json({ post, surface: "blog" });
  }

  // social
  const { data: post, error: insErr } = await supabaseAdmin
    .from("social_posts")
    .insert({
      product_focus: topic.product_focus,
      topic_id: topic.id,
      generated_by: "human" as const,
      status: "draft" as const,
    })
    .select("*")
    .single();
  if (insErr) return c.json({ error: insErr.message }, 500);
  await supabaseAdmin
    .from("content_topics")
    .update({ status: "assigned" })
    .eq("id", id);
  return c.json({ post, surface: "social" });
});

// ── DEDUP CHECK (utility for the dashboard) ──────────────
contentTopicsRoutes.post("/check-keyword", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    surface: ContentSurface;
    product_focus: ContentProduct;
    primary_keyword: string;
  };
  if (!body.surface || !body.product_focus || !body.primary_keyword) {
    return c.json(
      { error: "surface, product_focus, primary_keyword are required" },
      400,
    );
  }
  const isDup = await isKeywordDuplicate(
    body.surface,
    body.product_focus,
    body.primary_keyword,
  );
  return c.json({ duplicate: isDup });
});

// ── RESEARCH ─────────────────────────────────────────────
// Generates fresh topic candidates via the lightweight model, dedup-
// filters against history + bank, and inserts the survivors as 'queued'.
// Response includes counts so the UI can show "Added 7 (3 dupes rejected)".
//
// Refill mode (US-851): when `count` is omitted the endpoint tops the bank
// back up TOWARD content_settings.min_topics_in_bank — it counts the queued
// topics already in this (surface, product_focus) bucket and only asks the
// model for the shortfall. If the bucket is already at/above the minimum it
// returns inserted:0 without calling the model. An explicit `count` overrides
// this and always requests that many (the admin "Research N more" button).
contentTopicsRoutes.post("/research", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    surface: ContentSurface;
    product_focus: ContentProduct;
    count?: number;
    model?: string;
  };
  if (!body.surface || !body.product_focus) {
    return c.json({ error: "surface and product_focus are required" }, 400);
  }

  try {
    let count = body.count;
    let alreadyFull = false;
    if (count === undefined) {
      const [{ data: settings }, { count: queued }] = await Promise.all([
        supabaseAdmin
          .from("content_settings")
          .select("min_topics_in_bank")
          .eq("id", 1)
          .maybeSingle(),
        supabaseAdmin
          .from("content_topics")
          .select("id", { count: "exact", head: true })
          .eq("surface", body.surface)
          .eq("product_focus", body.product_focus)
          .eq("status", "queued"),
      ]);
      const minimum = (settings as { min_topics_in_bank?: number } | null)
        ?.min_topics_in_bank ?? 3;
      const shortfall = minimum - (queued ?? 0);
      if (shortfall <= 0) {
        alreadyFull = true;
        count = 0;
      } else {
        count = shortfall;
      }
    }

    if (alreadyFull) {
      return c.json({
        inserted: 0,
        rejected_duplicates: 0,
        topics: [],
        meta: { skipped: "bank_at_minimum" },
      });
    }

    const result = await researchTopics({
      surface: body.surface,
      productFocus: body.product_focus,
      count,
      model: body.model,
    });

    if (result.candidates.length === 0) {
      return c.json({
        inserted: 0,
        rejected_duplicates: result.rejected_duplicates,
        topics: [],
        meta: result.meta,
      });
    }

    const { data, error } = await supabaseAdmin
      .from("content_topics")
      .insert(
        result.candidates.map((c) => ({
          surface: body.surface,
          product_focus: body.product_focus,
          title: c.title,
          angle: c.angle,
          primary_keyword: c.primary_keyword,
          secondary_keywords: c.secondary_keywords,
          search_intent: c.search_intent,
          status: "queued" as const,
          generated_by: "ai" as const,
          source: "research" as const,
        })),
      )
      .select("*");
    if (error) return c.json({ error: error.message }, 500);

    return c.json({
      inserted: data?.length ?? 0,
      rejected_duplicates: result.rejected_duplicates,
      topics: data ?? [],
      meta: result.meta,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[content-topics] research failed:", msg);
    return c.json({ error: msg }, 500);
  }
});
