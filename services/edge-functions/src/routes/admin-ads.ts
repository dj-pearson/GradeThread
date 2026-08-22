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
import { requireFreshStepUp } from "../lib/step-up.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { performGoogleAdsSync } from "../lib/google-ads-sync-job.ts";
import { analyzeAds } from "../lib/ads-analysis.ts";
import { applyRecommendation, revertChange } from "../lib/google-ads-apply-job.ts";
import { recordDecision } from "../lib/ads-decisions.ts";
import { uploadOfflineConversions } from "../lib/google-ads-conversions-upload.ts";
import { performAppleSearchAdsSync } from "../lib/apple-search-ads-sync-job.ts";
import { isGoogleAdsConfigured } from "../lib/google-ads-client.ts";
import { isAppleSearchAdsConfigured } from "../lib/apple-search-ads-client.ts";
import {
  aggregateKpis,
  campaignBreakdown,
  dailyTimeseries,
  type RawMetric,
} from "../lib/google-ads-overview.ts";
import { microsToDollars } from "../lib/google-ads-sync.ts";
import { computePacing } from "../lib/ads-anomaly.ts";

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
  // US-2803: archive was filed OPEN by admin-audit-policy — an admin mutation
  // with no audit row and no domain trail either. Auditing the pair closes
  // that rather than adding a second silent mutation beside it.
  await writeAuditLog(c, {
    action: "archive_ad_theme",
    targetType: "keyword_library",
    targetId: data.id,
    details: { theme: data.theme, platform: data.platform },
  });
  return c.json({ theme: data as KeywordLibraryRow });
});

// ── KEYWORD LIBRARY: restore ─────────────────────────────────────────
//
// US-2803. "Soft delete" promises the row is recoverable, and until now it was
// not: archive was the ONLY writer of is_active, there is no update route for a
// theme, and the list defaults to active-only while no caller passed
// ?include_archived=1. So archiving a theme removed it from the product with
// the row still sitting in the table and no route able to bring it back — a
// one-way door wearing the word "soft".
//
// The pair is what makes the list filter meaningful: being able to SEE an
// archived theme and not restore it would only move the dead end one screen
// later.
adminAdsRoutes.post("/themes/:id/restore", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("keyword_library")
    .update({ is_active: true })
    .eq("id", c.req.param("id"))
    .select("*")
    .maybeSingle();
  if (error) {
    return failSafe(c, 500, "Couldn't restore the ad theme.", error, "admin.ads.themes.restore");
  }
  if (!data) return c.json({ error: "Not found" }, 404);
  await writeAuditLog(c, {
    action: "restore_ad_theme",
    targetType: "keyword_library",
    targetId: data.id,
    details: { theme: data.theme, platform: data.platform },
  });
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
// GET /api/admin/ads/overview — super-admin Command Center data (US-1699). Reads
// the local ads_* snapshots (never Google Ads directly) and returns account KPIs,
// a spend-sorted campaign breakdown, and a daily time-series. Degrades to an
// explicit empty/unconfigured state (never 500) when the tables don't exist yet
// (pre-00381) or Google Ads isn't configured.
adminAdsRoutes.get("/overview", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin required." }, 403);
  }
  const daysRaw = Number(c.req.query("days") ?? "30");
  const days = Number.isFinite(daysRaw) && daysRaw >= 1 && daysRaw <= 365 ? Math.floor(daysRaw) : 30;
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  // US-1707: the same dashboard serves both platforms via ?platform.
  const platform = c.req.query("platform") === "apple_search_ads" ? "apple_search_ads" : "google_ads";
  const configured = platform === "apple_search_ads" ? isAppleSearchAdsConfigured() : isGoogleAdsConfigured();

  const empty = {
    configured,
    tablesReady: false,
    account: null,
    lastSync: null,
    kpis: aggregateKpis([]),
    campaigns: [],
    timeseries: [],
    platform,
    windowDays: days,
  };

  try {
    const [metricsRes, campaignsRes, accountRes, lastRunRes] = await Promise.all([
      supabaseAdmin
        .from("ads_metrics_daily")
        .select("entity_id, metric_date, impressions, clicks, cost_micros, conversions, conversion_value")
        .eq("platform", platform)
        .eq("entity_type", "campaign")
        .gte("metric_date", since),
      supabaseAdmin
        .from("ads_campaigns")
        .select("external_id, name, status, budget_micros")
        .eq("platform", platform),
      supabaseAdmin
        .from("ads_accounts")
        .select("external_customer_id, descriptive_name, currency_code, time_zone")
        .eq("platform", platform)
        .maybeSingle(),
      supabaseAdmin
        .from("ads_sync_runs")
        .select("status, started_at, finished_at, counts, error")
        .eq("platform", platform)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    // A missing table (pre-migration) reads as an error — degrade, don't 500.
    if (metricsRes.error || campaignsRes.error) {
      return c.json(empty);
    }

    const metrics = (metricsRes.data ?? []) as RawMetric[];
    const campaigns = (campaignsRes.data ?? []) as Array<
      { external_id: string; name: string | null; status: string | null; budget_micros?: number | string | null }
    >;

    const timeseries = dailyTimeseries(metrics);
    // Monthly budget ≈ sum of active campaigns' DAILY budgets × days in month.
    const dailyBudget = campaigns
      .filter((c) => c.status !== "REMOVED")
      .reduce((s, c) => s + microsToDollars(c.budget_micros ?? 0), 0);
    const now = new Date();
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const pacing = computePacing(
      timeseries.map((t) => ({ date: t.date, spend: t.spend })),
      Math.round(dailyBudget * daysInMonth * 100) / 100,
    );

    return c.json({
      configured,
      tablesReady: true,
      account: accountRes.data ?? null,
      lastSync: lastRunRes.data ?? null,
      kpis: aggregateKpis(metrics),
      campaigns: campaignBreakdown(metrics, campaigns),
      timeseries,
      pacing,
      platform,
      windowDays: days,
    });
  } catch (_err) {
    return c.json(empty);
  }
});

// GET /api/admin/ads/recommendations — the latest report-only recommendations
// (US-1701), grouped-ready for the Command Center. Degrades to [] pre-00383.
adminAdsRoutes.get("/recommendations", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin required." }, 403);
  }
  try {
    const platform = c.req.query("platform") === "apple_search_ads" ? "apple_search_ads" : "google_ads";
    const { data, error } = await supabaseAdmin
      .from("ads_recommendations")
      .select("*")
      .eq("platform", platform)
      .in("status", ["proposed", "approved", "applied", "snoozed"])
      .order("severity", { ascending: true })
      .order("generated_at", { ascending: false })
      .limit(200);
    if (error) return c.json({ recommendations: [] });
    return c.json({ recommendations: data ?? [] });
  } catch (_err) {
    return c.json({ recommendations: [] });
  }
});

// POST /api/admin/ads/analyze — run the REPORT-ONLY Claude analysis (US-1701);
// writes recommendations, never mutates Google Ads.
adminAdsRoutes.post("/analyze", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin required." }, 403);
  }
  try {
    const platform = c.req.query("platform") === "apple_search_ads" ? "apple_search_ads" : "google_ads";
    const result = await analyzeAds({ supabase: supabaseAdmin, ownerUserId: c.get("userId") ?? null, platform });
    return c.json({ ok: true, generated: result.generated });
  } catch (err) {
    return failSafe(c, 502, "Ads analysis failed.", err, "admin.ads.analyze");
  }
});

// US-1704: manually trigger the offline conversion upload (super-admin).
adminAdsRoutes.post("/conversions/upload", async (c) => {
  if (c.get("adminRole") !== "super_admin") return c.json({ error: "Super-admin required." }, 403);
  try {
    const result = await uploadOfflineConversions({ supabase: supabaseAdmin, ownerUserId: c.get("userId") ?? null });
    // Sends first-party conversion data to Google/Apple. Not a spend change,
    // but it is an outbound transfer of customer-derived data to an ad
    // platform, which is exactly the kind of action a privacy review needs to
    // be able to reconstruct after the fact.
    await writeAuditLog(c, {
      action: "ads.conversions.upload",
      targetType: "ads_conversion_upload",
      targetId: null,
      after: result as unknown,
    });
    return c.json(result);
  } catch (err) {
    return failSafe(c, 502, "Conversion upload failed.", err, "admin.ads.conversions.upload");
  }
});

// US-1702: review decisions — approve / dismiss / snooze (each audited).
adminAdsRoutes.post("/recommendations/:id/approve", async (c) => {
  if (c.get("adminRole") !== "super_admin") return c.json({ error: "Super-admin required." }, 403);
  const r = await recordDecision(supabaseAdmin, { recId: c.req.param("id"), decision: "approve", actorUserId: c.get("userId") ?? null });
  return c.json({ ok: r.ok, status: r.status, message: r.message }, r.httpStatus as 200 | 400 | 404 | 409 | 422 | 500);
});

adminAdsRoutes.post("/recommendations/:id/dismiss", async (c) => {
  if (c.get("adminRole") !== "super_admin") return c.json({ error: "Super-admin required." }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;
  const r = await recordDecision(supabaseAdmin, { recId: c.req.param("id"), decision: "dismiss", actorUserId: c.get("userId") ?? null, reason });
  return c.json({ ok: r.ok, status: r.status, message: r.message }, r.httpStatus as 200 | 400 | 404 | 409 | 500);
});

adminAdsRoutes.post("/recommendations/:id/snooze", async (c) => {
  if (c.get("adminRole") !== "super_admin") return c.json({ error: "Super-admin required." }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { until?: unknown };
  const until = typeof body.until === "string" && !Number.isNaN(Date.parse(body.until)) ? body.until : null;
  const r = await recordDecision(supabaseAdmin, { recId: c.req.param("id"), decision: "snooze", actorUserId: c.get("userId") ?? null, until });
  return c.json({ ok: r.ok, status: r.status, message: r.message }, r.httpStatus as 200 | 400 | 404 | 409 | 500);
});

// US-1703: guarded apply (dry-run by default). Body { dryRun?: boolean }.
adminAdsRoutes.post("/recommendations/:id/apply", async (c) => {
  if (c.get("adminRole") !== "super_admin") return c.json({ error: "Super-admin required." }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { dryRun?: unknown };
  const dryRun = body.dryRun !== false; // default true — dry-run unless explicitly false
  // US-2772: a fresh second factor, but ONLY for the live call.
  //
  // This route moves bids and budgets in the real Google/Apple ad accounts, so
  // it belongs in requireFreshStepUp's tier alongside refunds and kill
  // switches: "you verified this morning" is not evidence that you are at the
  // keyboard now, and a borrowed super_admin session should not be able to
  // change spend unchallenged.
  //
  // GATED ON dryRun BECAUSE THE DEFAULT IS A SIMULATION. `dryRun` defaults to
  // true and a dry run changes nothing anywhere — prompting for TOTP on every
  // preview would make the Ads Command Center's normal loop unusable, and a
  // second factor people work around is worse than one they do not have. The
  // check sits after the body parse for exactly that reason.
  //
  // The one thing this must never become is a check the CLIENT decides. dryRun
  // arrives in the body, so a caller can set it to false — and that is the
  // point: false is the live call, and the live call is the one that prompts.
  if (!dryRun) {
    const blocked = requireFreshStepUp(c);
    if (blocked) return blocked;
  }
  const recId = c.req.param("id");
  const result = await applyRecommendation({
    recId,
    dryRun,
    ownerUserId: c.get("userId") ?? null,
  });
  const { httpStatus, ...payload } = result;
  // US-2355 AC4: this changes bids and budgets in the LIVE Google/Apple ad
  // accounts — real spend. It was recorded only in ads_change_audit, a
  // domain-local table, so the central admin log (the one an investigation
  // actually reads, and the one that carries actor, role, IP and user agent)
  // had no idea any money decision had been made. A domain table is a good
  // operational record and a poor forensic one.
  //
  // dryRun is part of the row on purpose: "applied" and "simulated" are the
  // same call with one flag, and an audit trail that cannot tell them apart
  // is worse than none.
  await writeAuditLog(c, {
    action: dryRun ? "ads.recommendation.apply_dry_run" : "ads.recommendation.apply",
    targetType: "ads_recommendation",
    targetId: recId,
    after: { dryRun, httpStatus, ok: (payload as { ok?: unknown }).ok ?? null },
    details: { live_spend_change: !dryRun },
  });
  return c.json(payload, httpStatus as 200 | 400 | 404 | 409 | 422 | 500 | 502);
});

// US-1703: one-click rollback of a recommendation's latest applied change.
adminAdsRoutes.post("/recommendations/:id/revert", async (c) => {
  if (c.get("adminRole") !== "super_admin") return c.json({ error: "Super-admin required." }, 403);
  // US-2772: always. Revert has NO dry-run mode — every call moves live spend,
  // so unlike /apply there is no preview to exempt. The direction differs from
  // an apply; the blast radius does not.
  const blocked = requireFreshStepUp(c);
  if (blocked) return blocked;
  const { data } = await supabaseAdmin
    .from("ads_change_audit")
    .select("id")
    .eq("recommendation_id", c.req.param("id"))
    .eq("action", "apply")
    .eq("dry_run", false)
    .eq("success", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return c.json({ ok: false, error: "No applied change to roll back." }, 404);
  const auditId = (data as { id: string }).id;
  const result = await revertChange({ auditId, ownerUserId: c.get("userId") ?? null });
  const { httpStatus, ...payload } = result;
  // Reverting moves live spend just as applying does — the direction differs,
  // the blast radius does not.
  await writeAuditLog(c, {
    action: "ads.recommendation.revert",
    targetType: "ads_recommendation",
    targetId: c.req.param("id"),
    before: { ads_change_audit_id: auditId },
    after: { httpStatus, ok: (payload as { ok?: unknown }).ok ?? null },
    details: { live_spend_change: true },
  });
  return c.json(payload, httpStatus as 200 | 400 | 404 | 409 | 422 | 500 | 502);
});

// US-1707: manual Apple Search Ads sync (super-admin) into the shared tables.
adminAdsRoutes.post("/apple/sync", async (c) => {
  if (c.get("adminRole") !== "super_admin") return c.json({ error: "Super-admin required." }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { days?: unknown };
  const result = await performAppleSearchAdsSync({
    ownerUserId: c.get("userId") ?? null,
    days: typeof body.days === "number" ? body.days : undefined,
  });
  const { httpStatus, ...payload } = result;
  return c.json(payload, httpStatus as 200 | 500 | 502);
});

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
