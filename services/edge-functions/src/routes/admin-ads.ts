import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  type AdPayload,
  type AdPlatform,
  adCreativeToAdsEditorCsv,
  adCreativeToCsv,
} from "../lib/ad-copy.ts";
import {
  generateAdCopy,
  type KeywordTheme,
} from "../lib/ad-copy-ai.ts";

// US-1073: AI Ad Copy Studio (admin-only). Generates Google Ads RSA copy and
// Apple Search Ads keyword/creative sets grounded in the keyword library + brand
// voice, saves generations to ad_creatives, and exports them (CSV / Ads Editor).
//
// Mounted at /api/admin/ads — the /api/admin/* stack already applies
// authMiddleware + adminAuthMiddleware, so every handler here is admin-gated.

type Env = { Variables: { userId: string } };
export const adminAdsRoutes = new Hono<Env>();

const PLATFORMS: AdPlatform[] = ["google_ads", "apple_search_ads"];

function isPlatform(v: unknown): v is AdPlatform {
  return typeof v === "string" && (PLATFORMS as string[]).includes(v);
}

interface KeywordLibraryRow {
  id: string;
  theme: string;
  platform: string;
  keywords: string[] | null;
  pillar: string | null;
  notes: string | null;
  is_active: boolean;
}

// ── KEYWORD LIBRARY: list ────────────────────────────────────────────
adminAdsRoutes.get("/themes", async (c) => {
  const includeArchived = c.req.query("include_archived") === "1";
  let q = supabaseAdmin
    .from("keyword_library")
    .select("*")
    .order("created_at", { ascending: false });
  if (!includeArchived) q = q.eq("is_active", true);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ themes: (data ?? []) as KeywordLibraryRow[] });
});

// ── KEYWORD LIBRARY: create ──────────────────────────────────────────
adminAdsRoutes.post("/themes", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    theme?: string;
    platform?: string;
    keywords?: unknown;
    pillar?: string;
    notes?: string;
  };
  const theme = (body.theme ?? "").trim();
  if (!theme) return c.json({ error: "theme is required" }, 400);
  const platform = body.platform ?? "both";
  if (platform !== "both" && !isPlatform(platform)) {
    return c.json({ error: "platform must be google_ads | apple_search_ads | both" }, 400);
  }
  const keywords = Array.isArray(body.keywords)
    ? body.keywords.map((k) => String(k).trim()).filter(Boolean)
    : [];

  const { data, error } = await supabaseAdmin
    .from("keyword_library")
    .insert({
      theme,
      platform,
      keywords,
      pillar: body.pillar?.trim() || null,
      notes: body.notes?.trim() || null,
    })
    .select("*")
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ theme: data as KeywordLibraryRow });
});

// ── KEYWORD LIBRARY: archive (soft delete) ───────────────────────────
adminAdsRoutes.post("/themes/:id/archive", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("keyword_library")
    .update({ is_active: false })
    .eq("id", c.req.param("id"))
    .select("*")
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json({ theme: data as KeywordLibraryRow });
});

async function loadThemes(ids: string[]): Promise<KeywordTheme[]> {
  const { data, error } = await supabaseAdmin
    .from("keyword_library")
    .select("id, theme, keywords, pillar, notes")
    .in("id", ids);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Omit<KeywordLibraryRow, "platform" | "is_active">>).map((r) => ({
    id: r.id,
    theme: r.theme,
    keywords: Array.isArray(r.keywords) ? r.keywords : [],
    pillar: r.pillar,
    notes: r.notes,
  }));
}

// ── GENERATE (does not persist) ──────────────────────────────────────
adminAdsRoutes.post("/generate", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as {
    platform?: string;
    theme_ids?: unknown;
    instruction?: string;
    model?: string;
  };
  if (!isPlatform(body.platform)) {
    return c.json({ error: "platform must be google_ads | apple_search_ads" }, 400);
  }
  const themeIds = Array.isArray(body.theme_ids)
    ? body.theme_ids.map((v) => String(v)).filter(Boolean)
    : [];
  if (themeIds.length === 0) {
    return c.json({ error: "theme_ids[] is required" }, 400);
  }

  try {
    const themes = await loadThemes(themeIds);
    if (themes.length === 0) {
      return c.json({ error: "No matching keyword themes found" }, 404);
    }
    const result = await generateAdCopy({
      platform: body.platform,
      themes,
      userId,
      instruction: typeof body.instruction === "string" ? body.instruction : undefined,
      model: typeof body.model === "string" && body.model ? body.model : undefined,
    });
    return c.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[admin-ads] generate failed:", msg);
    return c.json({ error: msg }, 500);
  }
});

interface AdCreativeRow {
  id: string;
  platform: AdPlatform;
  name: string | null;
  source_theme_ids: string[];
  source_keywords: string[];
  payload: AdPayload;
  model: string | null;
  created_at: string;
}

// ── SAVE a generation ────────────────────────────────────────────────
adminAdsRoutes.post("/creatives", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as {
    platform?: string;
    name?: string;
    source_theme_ids?: unknown;
    source_keywords?: unknown;
    payload?: unknown;
    model?: string;
  };
  if (!isPlatform(body.platform)) {
    return c.json({ error: "platform must be google_ads | apple_search_ads" }, 400);
  }
  if (!body.payload || typeof body.payload !== "object") {
    return c.json({ error: "payload is required" }, 400);
  }
  const { data, error } = await supabaseAdmin
    .from("ad_creatives")
    .insert({
      platform: body.platform,
      name: body.name?.trim() || null,
      source_theme_ids: Array.isArray(body.source_theme_ids)
        ? body.source_theme_ids.map((v) => String(v))
        : [],
      source_keywords: Array.isArray(body.source_keywords)
        ? body.source_keywords.map((v) => String(v).trim()).filter(Boolean)
        : [],
      payload: body.payload,
      model: body.model?.trim() || null,
      created_by: userId,
    })
    .select("*")
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ creative: data as AdCreativeRow });
});

// ── LIST saved creatives ─────────────────────────────────────────────
adminAdsRoutes.get("/creatives", async (c) => {
  const platform = c.req.query("platform");
  const limit = Math.min(Number(c.req.query("limit") ?? "100") || 100, 200);
  let q = supabaseAdmin
    .from("ad_creatives")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (isPlatform(platform)) q = q.eq("platform", platform);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ creatives: (data ?? []) as AdCreativeRow[] });
});

// ── EXPORT a saved creative (CSV / Google Ads Editor) ────────────────
adminAdsRoutes.get("/creatives/:id/export", async (c) => {
  const id = c.req.param("id");
  const format = c.req.query("format") === "ads_editor" ? "ads_editor" : "csv";
  const { data, error } = await supabaseAdmin
    .from("ad_creatives")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "Not found" }, 404);
  const row = data as AdCreativeRow;

  const csv = format === "ads_editor"
    ? adCreativeToAdsEditorCsv(row.platform, row.payload)
    : adCreativeToCsv(row.platform, row.payload, row.source_keywords);

  const filename = `${row.platform}_${format}_${id.slice(0, 8)}.csv`;
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});
