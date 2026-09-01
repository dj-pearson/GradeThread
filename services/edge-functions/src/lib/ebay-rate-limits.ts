/**
 * US-3042: read eBay's OWN account of how much of our quota we have consumed.
 *
 * WHY THIS EXISTS ALONGSIDE ebay-call-log.ts. That module counts what we
 * believe we sent. This one asks eBay. The two numbers are measured on opposite
 * sides of the wire and they will not match:
 *
 *   ours   counts every ATTEMPT, including retries and calls that timed out
 *          before eBay ever saw them
 *   eBay's counts what actually landed against the limit
 *
 * The gap is the useful part. If our count runs well ahead of eBay's, we are
 * burning wall-clock and connections on retries that never arrive. If eBay's
 * runs ahead of ours, something is calling eBay outside the counted choke point,
 * which is a bug worth finding.
 *
 * It also matters for the growth check itself: the reviewer can see eBay's side.
 * Quoting a number in the application that disagrees with their telemetry, with
 * no explanation, is worse than quoting nothing.
 *
 * The Developer Analytics API is NOT restricted and needs only the base
 * application scope, so this works today with the keyset we already have.
 */

import { apiHost, countedEbayFetch, getAppAccessToken } from "./ebay-client.ts";
import { supabaseAdmin } from "./supabase.ts";

const BASE_SCOPE = "https://api.ebay.com/oauth/api_scope";

/** One resource's quota, flattened from eBay's nested response. */
export interface RateLimitRow {
  api_name: string;
  api_context: string | null;
  api_version: string | null;
  resource_name: string;
  limit_count: number | null;
  remaining: number | null;
  time_window_s: number | null;
  reset_at: string | null;
}

/** eBay's response shape. Every field optional — this is a beta API. */
interface RateLimitPayload {
  rateLimits?: Array<{
    apiName?: string;
    apiContext?: string;
    apiVersion?: string;
    resources?: Array<{
      name?: string;
      rates?: Array<{
        limit?: number;
        remaining?: number;
        reset?: string;
        timeWindow?: number;
      }>;
    }>;
  }>;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Flatten eBay's three-level response (api -> resource -> rate) into one row per
 * resource. Pure, so the parsing is tested against a recorded payload rather
 * than against eBay.
 *
 * A resource with several rate windows keeps only the FIRST. eBay returns one
 * window per resource in practice, and picking arbitrarily among several would
 * make the stored `remaining` mean different things on different days — which is
 * worse than dropping the extras, because nothing would show that it happened.
 */
export function parseRateLimits(payload: unknown): RateLimitRow[] {
  const p = (payload ?? {}) as RateLimitPayload;
  if (!Array.isArray(p.rateLimits)) return [];
  const out: RateLimitRow[] = [];
  for (const api of p.rateLimits) {
    if (!Array.isArray(api?.resources)) continue;
    for (const resource of api.resources) {
      const name = typeof resource?.name === "string" ? resource.name.trim() : "";
      if (name === "") continue;
      const rate = Array.isArray(resource.rates) ? resource.rates[0] : undefined;
      // eBay sends `reset` as an ISO timestamp. Anything unparseable is stored
      // as null rather than as an invalid date that would poison a range query.
      let resetAt: string | null = null;
      if (typeof rate?.reset === "string") {
        const t = Date.parse(rate.reset);
        if (Number.isFinite(t)) resetAt = new Date(t).toISOString();
      }
      out.push({
        api_name: (api.apiName ?? "unknown").slice(0, 80),
        api_context: api.apiContext?.slice(0, 40) ?? null,
        api_version: api.apiVersion?.slice(0, 20) ?? null,
        resource_name: name.slice(0, 120),
        limit_count: asNumber(rate?.limit),
        remaining: asNumber(rate?.remaining),
        time_window_s: asNumber(rate?.timeWindow),
        reset_at: resetAt,
      });
    }
  }
  return out;
}

/**
 * How close is the tightest resource to its ceiling? This is the number the
 * growth check turns on, so it gets computed once here rather than in each
 * caller. Returns null when nothing reported a usable limit.
 *
 * Resources with a limit of 0 are skipped: eBay reports unentitled APIs that
 * way, and a 0/0 resource would otherwise read as 100% consumed forever.
 */
export function tightestUtilization(
  rows: readonly RateLimitRow[],
): { resource: string; used: number; limit: number; pct: number } | null {
  let worst: { resource: string; used: number; limit: number; pct: number } | null = null;
  for (const r of rows) {
    if (r.limit_count == null || r.limit_count <= 0) continue;
    if (r.remaining == null) continue;
    const used = Math.max(0, r.limit_count - r.remaining);
    const pct = used / r.limit_count;
    if (worst === null || pct > worst.pct) {
      worst = { resource: r.resource_name, used, limit: r.limit_count, pct };
    }
  }
  return worst;
}

/** Fetch the current limits from eBay. Throws on a non-2xx so the cron reports red. */
export async function fetchEbayRateLimits(): Promise<RateLimitRow[]> {
  const token = await getAppAccessToken(BASE_SCOPE);
  const res = await countedEbayFetch(
    `${apiHost()}/developer/analytics/v1_beta/rate_limit/`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `eBay getRateLimits failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  return parseRateLimits(await res.json());
}

/** Persist a snapshot. Returns how many resource rows were written. */
export async function snapshotEbayRateLimits(): Promise<{
  written: number;
  tightest: ReturnType<typeof tightestUtilization>;
}> {
  const rows = await fetchEbayRateLimits();
  if (rows.length === 0) return { written: 0, tightest: null };
  const { error } = await supabaseAdmin
    .from("ebay_rate_limit_snapshots")
    .insert(rows);
  if (error) throw new Error(`rate-limit snapshot insert failed: ${error.message}`);
  return { written: rows.length, tightest: tightestUtilization(rows) };
}
