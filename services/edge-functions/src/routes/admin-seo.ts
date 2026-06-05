// US-308 / US-309: admin SEO endpoints.
//
// /api/admin/seo/gsc/sync         (admin JWT)         — run an ad-hoc GSC pull
// /api/admin/seo/jobs/gsc-sync    (job secret header) — daily cron entry point
// /api/admin/seo/summary          (admin JWT)         — read for US-309 dash
//
// Tenant model: this is PLATFORM-level data, not user-scoped. The admin gate
// is enforced via the existing /api/admin/* middleware in main.ts.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import {
  getGscSiteUrl,
  isGscConfigured,
  querySearchAnalytics,
} from "../lib/gsc-client.ts";
import { submitUrls } from "../lib/indexnow.ts";

export const adminSeoRoutes = new Hono<{
  Variables: {
    userId: string;
  };
}>();

// GSC reports lag by ~2 days. Sync window = today-3 → today-3, with a 7-day
// trailing rolling pull each day to absorb any backfilled rows.
function defaultSyncRange(): { startDate: string; endDate: string } {
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const end = new Date(Date.now() - 3 * 86_400_000);
  const start = new Date(end.getTime() - 7 * 86_400_000);
  return { startDate: ymd(start), endDate: ymd(end) };
}

async function runGscSync(opts?: {
  startDate?: string;
  endDate?: string;
}): Promise<{
  ok: boolean;
  configured: boolean;
  inserted: number;
  startDate?: string;
  endDate?: string;
  error?: string;
}> {
  if (!isGscConfigured()) {
    return { ok: false, configured: false, inserted: 0, error: "GSC env not set" };
  }
  const { startDate, endDate } =
    opts?.startDate && opts?.endDate
      ? { startDate: opts.startDate, endDate: opts.endDate }
      : defaultSyncRange();
  const siteUrl = getGscSiteUrl();

  // Pull the cross-product of dimensions we use in the dashboard. One query
  // is enough — GSC fans out the dimensions server-side and the unique key
  // upsert makes overlap free.
  const rows = await querySearchAnalytics({
    startDate,
    endDate,
    dimensions: ["date", "query", "page", "country", "device"],
  });

  if (rows.length === 0) {
    return { ok: true, configured: true, inserted: 0, startDate, endDate };
  }

  // Chunked upsert — Supabase has a per-request size limit and pgrest is
  // happiest with batches under ~500 rows.
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK).map((r) => {
      const [date, query, page, country, device] = r.keys ?? [];
      return {
        date,
        site_url: siteUrl,
        query: query ?? null,
        page: page ?? null,
        country: country ?? null,
        device: device ?? null,
        impressions: r.impressions ?? 0,
        clicks: r.clicks ?? 0,
        ctr: r.ctr ?? 0,
        position: r.position ?? 0,
      };
    });
    const { error } = await supabaseAdmin
      .from("gsc_performance")
      .upsert(batch, {
        onConflict: "date,site_url,page,query,country,device",
      });
    if (error) {
      console.error("[admin-seo] gsc_performance upsert failed:", error);
      return {
        ok: false,
        configured: true,
        inserted,
        startDate,
        endDate,
        error: error.message,
      };
    }
    inserted += batch.length;
  }
  return { ok: true, configured: true, inserted, startDate, endDate };
}

// US-309: manual IndexNow submission from the admin dashboard. Accepts a
// list of absolute URLs and forwards to lib/indexnow.ts which is the same
// path used by blog publish + grading-pipeline. Best-effort — IndexNow
// returns 200/202 on accept; lib swallows network errors and returns 0.
adminSeoRoutes.post("/indexnow", async (c) => {
  let body: { urls?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const urls = Array.isArray(body.urls)
    ? body.urls.filter((u): u is string => typeof u === "string" && u.length > 0)
    : [];
  if (urls.length === 0) {
    return c.json({ error: "urls must be a non-empty array" }, 400);
  }
  const submitted = await submitUrls(urls);
  return c.json({ ok: true, submitted });
});

// Manual trigger from the admin dashboard (US-309).
adminSeoRoutes.post("/gsc/sync", async (c) => {
  let body: { startDate?: unknown; endDate?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    /* empty body is fine — we'll use the default trailing range */
  }
  const startDate = typeof body.startDate === "string" ? body.startDate : undefined;
  const endDate = typeof body.endDate === "string" ? body.endDate : undefined;
  const result = await runGscSync({ startDate, endDate });
  return c.json(result, result.ok ? 200 : (result.configured ? 502 : 503));
});

// Cron entry point. NOT mounted on adminSeoRoutes because /api/admin/* is
// admin-JWT-middlewared at the app level — a cron has no user JWT. Exported
// separately and mounted under a non-admin path (see main.ts).
export async function handleGscSyncCron(c: {
  req: { header: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  // US-503: daily-ish GSC pull; overlap guard with a 10-min lease.
  const lock = await acquireJobLock("gsc-sync", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const result = await runGscSync();
    return c.json(result, result.ok ? 200 : (result.configured ? 502 : 503));
  } finally {
    await lock.release();
  }
}

// Top-line read for the US-309 dashboard. Returns the top 20 queries + top 20
// pages by clicks over the last 28 days, plus a high-level totals row.
adminSeoRoutes.get("/summary", async (c) => {
  const end = new Date();
  const start = new Date(end.getTime() - 28 * 86_400_000);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  // Try the optional helper RPCs first (a future migration may add them); on
  // any error (incl. "function not found"), fall back to the inline aggregate
  // below. Note: Supabase's .rpc() returns PromiseLike — wrap in a normal
  // async to get .catch semantics.
  async function tryRpc(name: string): Promise<unknown> {
    try {
      const { data, error } = await supabaseAdmin.rpc(name, {
        p_start: startStr,
        p_end: endStr,
        p_limit: 20,
      });
      if (error) return null;
      return data ?? [];
    } catch {
      return null;
    }
  }
  const [queriesRes, pagesRes] = await Promise.all([
    tryRpc("gsc_top_queries"),
    tryRpc("gsc_top_pages"),
  ]);

  let topQueries: unknown = queriesRes;
  let topPages: unknown = pagesRes;
  if (topQueries == null) {
    const { data } = await supabaseAdmin
      .from("gsc_performance")
      .select("query, impressions, clicks")
      .gte("date", startStr)
      .lte("date", endStr)
      .not("query", "is", null)
      .order("clicks", { ascending: false })
      .limit(200);
    topQueries = aggregateBy(data, "query");
  }
  if (topPages == null) {
    const { data } = await supabaseAdmin
      .from("gsc_performance")
      .select("page, impressions, clicks")
      .gte("date", startStr)
      .lte("date", endStr)
      .not("page", "is", null)
      .order("clicks", { ascending: false })
      .limit(200);
    topPages = aggregateBy(data, "page");
  }

  return c.json({
    range: { start: startStr, end: endStr },
    configured: isGscConfigured(),
    top_queries: topQueries,
    top_pages: topPages,
  });
});

function aggregateBy(
  rows: unknown,
  key: "query" | "page",
): Array<{ key: string; impressions: number; clicks: number }> {
  if (!Array.isArray(rows)) return [];
  const agg = new Map<string, { impressions: number; clicks: number }>();
  for (const r of rows as Array<Record<string, unknown>>) {
    const k = typeof r[key] === "string" ? (r[key] as string) : null;
    if (!k) continue;
    const cur = agg.get(k) ?? { impressions: 0, clicks: 0 };
    cur.impressions += Number(r.impressions ?? 0);
    cur.clicks += Number(r.clicks ?? 0);
    agg.set(k, cur);
  }
  return Array.from(agg.entries())
    .map(([k, v]) => ({ key: k, ...v }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 20);
}
