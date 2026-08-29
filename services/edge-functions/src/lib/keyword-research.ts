// US-1072: Google Ads keyword-research ingestion → keyword library.
//
// Pulls keyword ideas + demand metrics (avg monthly searches, competition, CPC)
// from the Google Ads API Keyword Plan idea service and upserts them into
// keyword_research_terms. Runs on demand (admin "Refresh now") or on a schedule
// (the /api/jobs/keyword-research cron).
//
// Google Ads auth is the installed/web-app OAuth refresh-token flow: we trade a
// long-lived refresh token for a short-lived access token at the Google OAuth
// endpoint, then call generateKeywordIdeas with the access token + the account's
// developer token. Tokens cache in-process for their TTL.
//
// Required env (documented in vault/10-ops/env-reference.md):
//   GOOGLE_ADS_DEVELOPER_TOKEN   approved developer token
//   GOOGLE_ADS_CLIENT_ID         OAuth client id
//   GOOGLE_ADS_CLIENT_SECRET     OAuth client secret
//   GOOGLE_ADS_REFRESH_TOKEN     refresh token for the manager/account
//   GOOGLE_ADS_CUSTOMER_ID       customer id the ideas are generated for (digits only)
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID optional manager (MCC) id for login-customer-id
//
// `isKeywordResearchConfigured()` lets callers degrade cleanly (a run is recorded
// as 'skipped') instead of crashing when the integration isn't wired yet.

import { supabaseAdmin } from "./supabase.ts";
import { createSharedTokenCache } from "./coherent-cache.ts";
import { GOOGLE_ADS_API_VERSION } from "./google-ads-client.ts";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
// IMPORTED, not re-declared. This file used to carry its own `ADS_API_VERSION`
// and the two copies drifted: google-ads-client.ts sat on v18 while this one sat
// on v17, so keyword-research and ads-sync were calling two different (and by
// 2026-08-18 both sunset) versions of the same API. One declaration, one bump.
const ADS_API_VERSION = GOOGLE_ADS_API_VERSION;

// Default seed phrases — the buyer-intent roots of GradeThread + FlipDesk. The
// scheduled run expands these; a manual run may override them.
//
// THE SEED LIST IS THE BLIND SPOT, not the tool (US-9027, 2026-08-28). Two
// Keyword Planner pulls, 776 keywords between them, sized the whole
// authentication cluster at ONE keyword and 50/mo — while
// /tools/authenticity-check was quietly the best-converting page on the site at
// 10.98% CTR. An autocomplete harvest found 945 distinct authentication queries
// across 20 brands. The pulls were not wrong; they were never asked.
//
// Four clusters were missing entirely and are seeded below: authentication,
// reseller tax and bookkeeping, "what is my X worth", and platform how-to. A
// seed added here is a cluster the next scheduled run can see, so this list
// should grow whenever a build reveals a question the taxonomy could not ask.
export const DEFAULT_SEED_KEYWORDS = [
  "clothing condition grading",
  "used clothing grade",
  "ebay listing tool",
  "reseller inventory software",
  "thrift flipping",
  "garment condition report",
  "resale certificate",
  // US-9027: the four unsized clusters.
  "brand authenticity checker",
  "clothing authentication service",
  "how to spot fake clothing",
  "reseller taxes",
  "reseller bookkeeping software",
  "what is my jacket worth",
  "how to sell clothes on depop",
];

export type KeywordCompetition = "low" | "medium" | "high" | "unspecified";

export interface KeywordIdea {
  keyword: string;
  avgMonthlySearches: number | null;
  competition: KeywordCompetition;
  competitionIndex: number | null;
  cpcLow: number | null; // dollars
  cpcHigh: number | null; // dollars
  raw: unknown;
}

export function isKeywordResearchConfigured(): boolean {
  return !!(
    Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN") &&
    Deno.env.get("GOOGLE_ADS_CLIENT_ID") &&
    Deno.env.get("GOOGLE_ADS_CLIENT_SECRET") &&
    Deno.env.get("GOOGLE_ADS_REFRESH_TOKEN") &&
    Deno.env.get("GOOGLE_ADS_CUSTOMER_ID")
  );
}

// ── Theme classification (pure, unit-tested) ─────────────────────────
//
// Map a keyword phrase to a coarse demand bucket so the operator can
// browse/filter/group by theme. First match wins; order is most→least specific.
const THEME_RULES: Array<{ theme: string; patterns: RegExp[] }> = [
  { theme: "ebay", patterns: [/\bebay\b/i] },
  { theme: "thrift", patterns: [/\bthrift/i, /\bgoodwill\b/i, /\bflea market\b/i] },
  {
    theme: "reselling",
    patterns: [/\bresell/i, /\bresale\b/i, /\bflip(ping)?\b/i, /\binventory\b/i, /\bcross.?list/i, /\bposhmark\b/i, /\bdepop\b/i],
  },
  {
    theme: "authentication",
    patterns: [/\bauthenticat/i, /\bcertificate\b/i, /\bverif/i, /\bcertif/i, /\blegit check\b/i],
  },
  {
    theme: "grading",
    patterns: [/\bgrad(e|ing)\b/i, /\bcondition\b/i, /\bquality\b/i, /\bgarment\b/i, /\bclothing\b/i, /\bapparel\b/i],
  },
];

export function classifyTheme(keyword: string): string {
  const k = keyword.toLowerCase();
  for (const rule of THEME_RULES) {
    if (rule.patterns.some((p) => p.test(k))) return rule.theme;
  }
  return "general";
}

// ── Parsing helpers (pure, unit-tested) ──────────────────────────────

const COMPETITION_MAP: Record<string, KeywordCompetition> = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
};

export function normalizeCompetition(v: unknown): KeywordCompetition {
  return COMPETITION_MAP[String(v ?? "").toUpperCase()] ?? "unspecified";
}

// Google reports bids in micros (1,000,000 micros = 1 currency unit).
export function microsToDollars(micros: unknown): number | null {
  const n = Number(micros);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round((n / 1_000_000) * 100) / 100;
}

interface RawIdeaResult {
  text?: string;
  keywordIdeaMetrics?: {
    avgMonthlySearches?: string | number;
    competition?: string;
    competitionIndex?: string | number;
    lowTopOfPageBidMicros?: string | number;
    highTopOfPageBidMicros?: string | number;
  };
}

/** Normalize one generateKeywordIdeas result row into a KeywordIdea. */
export function parseIdeaResult(result: RawIdeaResult): KeywordIdea | null {
  const keyword = (result.text ?? "").trim();
  if (!keyword) return null;
  const m = result.keywordIdeaMetrics ?? {};
  const avg = Number(m.avgMonthlySearches);
  const idx = Number(m.competitionIndex);
  return {
    keyword,
    avgMonthlySearches: Number.isFinite(avg) ? avg : null,
    competition: normalizeCompetition(m.competition),
    competitionIndex: Number.isFinite(idx) ? idx : null,
    cpcLow: microsToDollars(m.lowTopOfPageBidMicros),
    cpcHigh: microsToDollars(m.highTopOfPageBidMicros),
    raw: result,
  };
}

// ── Google Ads API client ────────────────────────────────────────────

const tokenCache = createSharedTokenCache({
  cacheKey: "google-ads-access-token",
  skewMs: 60_000,
});

async function getAccessToken(): Promise<string> {
  return await tokenCache.get(async () => {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: Deno.env.get("GOOGLE_ADS_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("GOOGLE_ADS_CLIENT_SECRET") ?? "",
      refresh_token: Deno.env.get("GOOGLE_ADS_REFRESH_TOKEN") ?? "",
    });
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google Ads token exchange failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const json = await res.json() as { access_token: string; expires_in: number };
    return { token: json.access_token, expiresInMs: json.expires_in * 1000 };
  });
}

/**
 * Call generateKeywordIdeas for the given seeds. Returns the normalized ideas.
 * Throws if the integration isn't configured (callers should pre-check with
 * isKeywordResearchConfigured()).
 */
export async function generateKeywordIdeas(seeds: string[]): Promise<KeywordIdea[]> {
  if (!isKeywordResearchConfigured()) {
    throw new Error("Google Ads keyword research not configured");
  }
  const customerId = (Deno.env.get("GOOGLE_ADS_CUSTOMER_ID") ?? "").replace(/[^0-9]/g, "");
  const devToken = Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN") ?? "";
  const loginCustomerId = (Deno.env.get("GOOGLE_ADS_LOGIN_CUSTOMER_ID") ?? "").replace(/[^0-9]/g, "");
  const token = await getAccessToken();

  const url =
    `https://googleads.googleapis.com/${ADS_API_VERSION}/customers/${customerId}:generateKeywordIdeas`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "developer-token": devToken,
    "Content-Type": "application/json",
  };
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      keywordSeed: { keywords: seeds },
      // English (1000) + United States (2840). Sensible defaults for the US
      // resale market; can be made configurable later via env if needed.
      language: "languageConstants/1000",
      geoTargetConstants: ["geoTargetConstants/2840"],
      keywordPlanNetwork: "GOOGLE_SEARCH",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`generateKeywordIdeas failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const json = await res.json() as { results?: RawIdeaResult[] };
  const ideas: KeywordIdea[] = [];
  for (const r of json.results ?? []) {
    const idea = parseIdeaResult(r);
    if (idea) ideas.push(idea);
  }
  return ideas;
}

// ── Ingestion orchestration ──────────────────────────────────────────

export interface IngestResult {
  status: "success" | "error" | "skipped";
  runId: string | null;
  seeds: string[];
  keywordsReturned: number;
  keywordsIngested: number;
  error?: string;
}

/**
 * Run a full ingestion: record a run row, fetch ideas (or skip when the
 * integration isn't configured), upsert them into keyword_research_terms tagged
 * with their classified theme, and finalize the run.
 *
 * `fetchIdeas` is injectable so the orchestration can be exercised without the
 * live Google Ads API; it defaults to the real client.
 */
export async function ingestKeywordResearch(opts: {
  trigger: "manual" | "scheduled";
  seeds?: string[];
  fetchIdeas?: (seeds: string[]) => Promise<KeywordIdea[]>;
}): Promise<IngestResult> {
  const seeds = (opts.seeds && opts.seeds.length > 0 ? opts.seeds : DEFAULT_SEED_KEYWORDS)
    .map((s) => s.trim())
    .filter(Boolean);

  // Open the run row so even a failed/skip run is auditable.
  const { data: runRow } = await supabaseAdmin
    .from("keyword_research_runs")
    .insert({ trigger: opts.trigger, status: "running", seeds })
    .select("id")
    .single();
  const runId = (runRow as { id: string } | null)?.id ?? null;

  const finalize = async (
    status: IngestResult["status"],
    fields: { keywordsReturned: number; keywordsIngested: number; error?: string },
  ): Promise<IngestResult> => {
    if (runId) {
      await supabaseAdmin
        .from("keyword_research_runs")
        .update({
          status,
          keywords_returned: fields.keywordsReturned,
          keywords_ingested: fields.keywordsIngested,
          error: fields.error ?? null,
          finished_at: new Date().toISOString(),
        })
        .eq("id", runId);
    }
    return { status, runId, seeds, ...fields };
  };

  if (!opts.fetchIdeas && !isKeywordResearchConfigured()) {
    return await finalize("skipped", {
      keywordsReturned: 0,
      keywordsIngested: 0,
      error: "Google Ads keyword research not configured",
    });
  }

  let ideas: KeywordIdea[];
  try {
    const fetcher = opts.fetchIdeas ?? generateKeywordIdeas;
    ideas = await fetcher(seeds);
  } catch (e) {
    return await finalize("error", {
      keywordsReturned: 0,
      keywordsIngested: 0,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  if (ideas.length === 0) {
    return await finalize("success", { keywordsReturned: 0, keywordsIngested: 0 });
  }

  const nowIso = new Date().toISOString();
  // Dedup by keyword (the API can echo a seed across expansions) and stamp the
  // seed/theme so the upsert respects the (keyword, source) uniqueness.
  const byKeyword = new Map<string, KeywordIdea>();
  for (const idea of ideas) byKeyword.set(idea.keyword.toLowerCase(), idea);

  const rows = [...byKeyword.values()].map((idea) => ({
    keyword: idea.keyword,
    theme: classifyTheme(idea.keyword),
    avg_monthly_searches: idea.avgMonthlySearches,
    competition: idea.competition,
    competition_index: idea.competitionIndex,
    cpc_low: idea.cpcLow,
    cpc_high: idea.cpcHigh,
    source: "google_ads",
    seed_keyword: seeds[0] ?? null,
    is_active: true,
    raw: idea.raw as Record<string, unknown>,
    last_seen_at: nowIso,
  }));

  const { error: upsertErr } = await supabaseAdmin
    .from("keyword_research_terms")
    .upsert(rows, { onConflict: "keyword,source", ignoreDuplicates: false });
  if (upsertErr) {
    return await finalize("error", {
      keywordsReturned: ideas.length,
      keywordsIngested: 0,
      error: upsertErr.message,
    });
  }

  return await finalize("success", {
    keywordsReturned: ideas.length,
    keywordsIngested: rows.length,
  });
}
