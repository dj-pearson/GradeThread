import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
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
import {
  ingestKeywordResearch,
  isKeywordResearchConfigured,
} from "../lib/keyword-research.ts";
import { requireScope } from "../lib/scope-guard.ts";
import { performGoogleAdsSync } from "../lib/google-ads-sync-job.ts";

// US-1073: AI Ad Copy Studio (admin-only). Generates Google Ads RSA copy and
// Apple Search Ads keyword/creative sets grounded in the keyword library + brand
// voice, saves generations to ad_creatives, and exports them (CSV / Ads Editor).
//
// Mounted at /api/admin/ads — the /api/admin/* stack already applies
// authMiddleware + adminAuthMiddleware, so every handler here is admin-gated.

type Env = { Variables: { userId: string; adminRole?: "admin" | "super_admin" } };
export const adminAdsRoutes = new Hono<Env>();

// US-1560: whole-router scope guard (see lib/admin-scope-map.ts).
adminAdsRoutes.use("*", requireScope("marketplace:write"));

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
  if (error) return failSafe(c, 500, "Couldn't load ad themes.", error, "admin.ads.themes.list");
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
  if (error) return failSafe(c, 500, "Couldn't save the ad theme.", error, "admin.ads.themes.create");
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
  if (error) return failSafe(c, 500, "Couldn't archive the ad theme.", error, "admin.ads.themes.archive");
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

// ════════════════════════════════════════════════════════════════════
// US-1072: KEYWORD RESEARCH — ingested keyword ideas + demand metrics.
// The demand-data layer beneath the curated themes above. Browse/filter/group
// by theme, plus a manual "refresh now" that runs the Google Ads ingestion.
// ════════════════════════════════════════════════════════════════════

interface KeywordTermRow {
  id: string;
  keyword: string;
  theme: string | null;
  avg_monthly_searches: number | null;
  competition: string;
  competition_index: number | null;
  cpc_low: number | null;
  cpc_high: number | null;
  source: string;
  seed_keyword: string | null;
  is_active: boolean;
  last_seen_at: string;
}

// ── KEYWORD RESEARCH: browse / filter ────────────────────────────────
adminAdsRoutes.get("/keywords", async (c) => {
  const theme = c.req.query("theme");
  const competition = c.req.query("competition");
  const q = (c.req.query("q") ?? "").trim();
  const limit = Math.min(Number(c.req.query("limit") ?? "500") || 500, 1000);

  let query = supabaseAdmin
    .from("keyword_research_terms")
    .select("*")
    .eq("is_active", true)
    .order("avg_monthly_searches", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (theme) query = query.eq("theme", theme);
  if (competition) query = query.eq("competition", competition);
  if (q) query = query.ilike("keyword", `%${q}%`);

  const { data, error } = await query;
  if (error) return failSafe(c, 500, "Couldn't load keywords.", error, "admin.ads.keywords.list");
  const rows = (data ?? []) as KeywordTermRow[];

  // Theme counts for the grouping UI (over the returned slice).
  const byTheme: Record<string, number> = {};
  for (const r of rows) {
    const t = r.theme ?? "general";
    byTheme[t] = (byTheme[t] ?? 0) + 1;
  }

  return c.json({ keywords: rows, themeCounts: byTheme, configured: isKeywordResearchConfigured() });
});

// ── KEYWORD RESEARCH: recent ingestion runs ──────────────────────────
adminAdsRoutes.get("/keywords/runs", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("keyword_research_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return failSafe(c, 500, "Couldn't load keyword runs.", error, "admin.ads.keywords.runs");
  return c.json({ runs: data ?? [] });
});

// ── KEYWORD RESEARCH: trigger an ingestion (manual refresh) ───────────
adminAdsRoutes.post("/keywords/ingest", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { seeds?: unknown };
  const seeds = Array.isArray(body.seeds)
    ? body.seeds.map((s) => String(s).trim()).filter(Boolean)
    : undefined;
  try {
    const result = await ingestKeywordResearch({ trigger: "manual", seeds });
    const code = result.status === "error" ? 502 : 200;
    return c.json(result, code);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[admin-ads] keyword ingest failed:", msg);
    return c.json({ error: msg }, 500);
  }
});

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
  if (error) return failSafe(c, 500, "Couldn't save the creative.", error, "admin.ads.creatives.create");
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
  if (error) return failSafe(c, 500, "Couldn't load creatives.", error, "admin.ads.creatives.list");
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
  if (error) return failSafe(c, 500, "Couldn't export the creative.", error, "admin.ads.creatives.export");
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

// ── US-1698: Google Ads → local snapshot sync ────────────────────────────
// POST /api/admin/ads/google/sync — super-admin only. Manual trigger for the
// same job the daily Coolify cron runs (POST /api/jobs/ads-sync); pulls
// structure + last-N-days metrics and upserts snapshots, recording a run row.
// No-ops with a clear message when US-1697 is unconfigured.
adminAdsRoutes.post("/google/sync", async (c) => {
  // Super-admin only: touches platform-level ad-spend config, not per-user data.
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin required for the Ads sync." }, 403);
  }
  let days: number | undefined;
  const body = (await c.req.json().catch(() => ({}))) as { days?: unknown };
  if (typeof body.days === "number") days = body.days;

  const result = await performGoogleAdsSync({ ownerUserId: c.get("userId") ?? null, days });
  const { httpStatus, ...payload } = result;
  return c.json(payload, httpStatus as 200 | 500 | 502);
});
