// US-832: read-only, tenant-scoped tool layer for the AI Support Assistant.
//
// This is the COMPLETE set of things the support bot may ever see. It is a
// FIXED, minimal allowlist of read-only tools — there is intentionally NO
// write/update/delete tool here. The assistant engine (US-834) exposes these
// (and only these) as Claude tool-use functions.
//
// SECURITY GUARANTEES (every reviewer should be able to confirm these by
// reading this file alone):
//   1. Every query is scoped to the caller's tenant — the `ownerId` argument,
//      which the engine always supplies as `c.get("workspaceOwnerId") ?? c.get("userId")`.
//      Parent-scoped tables (listings, sales, grade_reports) are reached ONLY
//      through inventory_items / submissions rows the caller owns — never by a
//      raw id from the request body (US-268 rule).
//   2. `itemId`-style arguments are ownership-verified BEFORE any read: the
//      loadOwned check filters by (id AND user_id = ownerId); a row the caller
//      does not own resolves to null and the tool returns a refusal/empty DTO.
//   3. DTOs are EXPLICIT field allowlists — no `select("*")` passthrough. They
//      deliberately EXCLUDE: email/name/address, payment methods, Stripe ids,
//      API keys, auth/MFA, raw buyer usernames/ids, internal config, and any
//      model/prompt details. getSalesSummary returns ONLY aggregates.
//
// The service-role client bypasses RLS, so these explicit filters are the only
// tenant wall. The `db` is injectable so lib/tests can exercise the real
// filtering logic without a live database (see tenant-isolation_test.ts).

import { supabaseAdmin } from "./supabase.ts";
import { getPlanMatrix } from "./pricing-config.ts";
import type { FlipdeskPlan, PlanConfig } from "./pricing-config.ts";
import { effectivePlanFor } from "./grade-pricing.ts";

// ── Minimal structural DB surface (so the tools are unit-testable) ──
//
// A narrow subset of the supabase-js query builder — just the chain operations
// these read-only tools use. The real service-role client satisfies it; tests
// inject a faithful in-memory fake that honours .eq/.in/.gte filtering so the
// tenant-scoping logic in THIS file is what gets exercised.

interface DbResult<Row> {
  data: Row[] | null;
  error: { message: string } | null;
}

export interface SupportQuery<Row = Record<string, unknown>>
  extends PromiseLike<DbResult<Row>> {
  select(columns: string): SupportQuery<Row>;
  eq(column: string, value: unknown): SupportQuery<Row>;
  in(column: string, values: readonly unknown[]): SupportQuery<Row>;
  gte(column: string, value: unknown): SupportQuery<Row>;
  textSearch(
    column: string,
    query: string,
    opts?: { config?: string; type?: "plain" | "phrase" | "websearch" },
  ): SupportQuery<Row>;
  order(column: string, opts?: { ascending?: boolean }): SupportQuery<Row>;
  limit(count: number): SupportQuery<Row>;
  maybeSingle(): PromiseLike<{ data: Row | null; error: { message: string } | null }>;
}

export interface SupportDb {
  from(table: string): SupportQuery;
}

const defaultDb = supabaseAdmin as unknown as SupportDb;

// Coerce a PostgREST numeric/decimal (string | number | null) to a number.
function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

// All inventory_item ids the caller owns. Every parent-scoped read funnels
// through this so listings/sales/grades can only ever be reached via a row the
// caller's tenant owns.
async function ownedItemIds(ownerId: string, db: SupportDb): Promise<string[]> {
  const { data, error } = await db
    .from("inventory_items")
    .select("id")
    .eq("user_id", ownerId);
  if (error || !data) return [];
  return (data as { id: string }[]).map((r) => r.id);
}

// ── Tool 1: inventory status counts ────────────────────────────────

export interface InventoryStatusCounts {
  total: number;
  byStatus: Record<string, number>;
}

export async function getMyInventoryStatusCounts(
  ownerId: string,
  db: SupportDb = defaultDb,
): Promise<InventoryStatusCounts> {
  const { data, error } = await db
    .from("inventory_items")
    .select("status")
    .eq("user_id", ownerId);
  if (error || !data) return { total: 0, byStatus: {} };
  const rows = data as { status: string }[];
  const byStatus: Record<string, number> = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  }
  return { total: rows.length, byStatus };
}

// ── Tool 2: listings summary ───────────────────────────────────────

export interface ListingSummary {
  id: string;
  title: string | null;
  status: string;
  platform: string;
  price: number;
  views: number;
  watchers: number;
  listedAt: string;
}

export interface ListingsSummaryArgs {
  status?: string;
  limit?: number;
}

export async function getMyListingsSummary(
  ownerId: string,
  args: ListingsSummaryArgs = {},
  db: SupportDb = defaultDb,
): Promise<ListingSummary[]> {
  const itemIds = await ownedItemIds(ownerId, db);
  if (itemIds.length === 0) return [];
  const limit = Math.min(Math.max(1, args.limit ?? 20), 20);

  let q = db
    .from("listings")
    .select(
      "id, inventory_item_id, listing_title, listing_status, platform, listing_price, views, watchers, listed_at",
    )
    .in("inventory_item_id", itemIds);
  if (args.status) q = q.eq("listing_status", args.status);
  const { data, error } = await q.order("listed_at", { ascending: false }).limit(limit);
  if (error || !data) return [];

  return (data as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    title: (r.listing_title as string | null) ?? null,
    status: String(r.listing_status ?? "draft"),
    platform: String(r.platform ?? ""),
    price: num(r.listing_price),
    views: num(r.views),
    watchers: num(r.watchers),
    listedAt: String(r.listed_at ?? ""),
  }));
}

// ── Tool 3: sales summary (aggregates ONLY — never buyer identity) ──

export type SalesPeriod = "30d" | "90d" | "1y" | "ytd" | "all";

export interface SalesSummary {
  period: SalesPeriod;
  count: number;
  gross: number;
  fees: number;
  net: number;
}

function periodStart(period: SalesPeriod, now: Date): Date | null {
  const d = new Date(now);
  switch (period) {
    case "30d":
      d.setDate(d.getDate() - 30);
      return d;
    case "90d":
      d.setDate(d.getDate() - 90);
      return d;
    case "1y":
      d.setFullYear(d.getFullYear() - 1);
      return d;
    case "ytd":
      return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    case "all":
      return null;
  }
}

export async function getSalesSummary(
  ownerId: string,
  args: { period?: SalesPeriod } = {},
  db: SupportDb = defaultDb,
  now: Date = new Date(),
): Promise<SalesSummary> {
  const period = args.period ?? "all";
  const empty: SalesSummary = { period, count: 0, gross: 0, fees: 0, net: 0 };

  const itemIds = await ownedItemIds(ownerId, db);
  if (itemIds.length === 0) return empty;

  let q = db
    .from("sales")
    // EXPLICIT aggregate-only field list. buyer_username / buyer_id /
    // buyer_notes / tracking_number / payout_reference are deliberately NOT
    // selected — this tool must never surface buyer identity or logistics PII.
    .select(
      "sale_price, platform_fees, payment_processing_fees, shipping_collected, shipping_cost, grading_cost, other_costs, net_profit, sale_date",
    )
    .in("inventory_item_id", itemIds);
  const start = periodStart(period, now);
  if (start) q = q.gte("sale_date", start.toISOString());

  const { data, error } = await q;
  if (error || !data) return empty;
  const rows = data as Array<Record<string, unknown>>;

  let gross = 0;
  let fees = 0;
  let net = 0;
  for (const r of rows) {
    const salePrice = num(r.sale_price);
    const rowFees = num(r.platform_fees) + num(r.payment_processing_fees);
    gross += salePrice;
    fees += rowFees;
    // Prefer the precomputed net_profit when present; otherwise derive a
    // conservative net from the recorded cost/fee fields on the sale.
    if (r.net_profit !== null && r.net_profit !== undefined) {
      net += num(r.net_profit);
    } else {
      net += salePrice + num(r.shipping_collected) - rowFees -
        num(r.shipping_cost) - num(r.grading_cost) - num(r.other_costs);
    }
  }
  return {
    period,
    count: rows.length,
    gross: round2(gross),
    fees: round2(fees),
    net: round2(net),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Tool 4: grade report for an item the caller owns ───────────────

export interface GradeReportDto {
  itemId: string;
  overallScore: number;
  tier: string;
  factors: {
    fabricCondition: number;
    structuralIntegrity: number;
    cosmeticAppearance: number;
    functionalElements: number;
    odorCleanliness: number;
  };
  summary: string;
  confidence: number;
}

export async function getGradeReportForMyItem(
  ownerId: string,
  itemId: string,
  db: SupportDb = defaultDb,
): Promise<GradeReportDto | null> {
  // Ownership verification FIRST: filter by (id AND user_id). A row the caller
  // does not own resolves to null → refusal, before any grade read.
  const { data: item } = await db
    .from("inventory_items")
    .select("id, grade_report_id")
    .eq("id", itemId)
    .eq("user_id", ownerId)
    .maybeSingle();
  const owned = item as { id: string; grade_report_id: string | null } | null;
  if (!owned || !owned.grade_report_id) return null;

  const { data: report, error } = await db
    .from("grade_reports")
    .select(
      "overall_score, grade_tier, fabric_condition_score, structural_integrity_score, cosmetic_appearance_score, functional_elements_score, odor_cleanliness_score, ai_summary, confidence_score",
    )
    .eq("id", owned.grade_report_id)
    .maybeSingle();
  if (error || !report) return null;
  const r = report as Record<string, unknown>;

  return {
    itemId,
    overallScore: num(r.overall_score),
    tier: String(r.grade_tier ?? ""),
    factors: {
      fabricCondition: num(r.fabric_condition_score),
      structuralIntegrity: num(r.structural_integrity_score),
      cosmeticAppearance: num(r.cosmetic_appearance_score),
      functionalElements: num(r.functional_elements_score),
      odorCleanliness: num(r.odor_cleanliness_score),
    },
    summary: String(r.ai_summary ?? ""),
    confidence: num(r.confidence_score),
  };
}

// ── Tool 5: open grading submissions ───────────────────────────────

// Non-terminal submission states: the user is still waiting on (or owes photos
// to) a grade. completed / failed / disputed are terminal and excluded.
const OPEN_SUBMISSION_STATUSES = ["pending", "processing", "needs_photos"] as const;

export interface OpenSubmissionDto {
  id: string;
  title: string;
  status: string;
  createdAt: string;
}

export async function getMyOpenSubmissions(
  ownerId: string,
  db: SupportDb = defaultDb,
): Promise<OpenSubmissionDto[]> {
  const { data, error } = await db
    .from("submissions")
    .select("id, title, status, created_at")
    .eq("user_id", ownerId)
    .in("status", OPEN_SUBMISSION_STATUSES)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error || !data) return [];
  return (data as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    title: String(r.title ?? ""),
    status: String(r.status ?? ""),
    createdAt: String(r.created_at ?? ""),
  }));
}

// ── Tool 6: plan tier, caps & usage ────────────────────────────────

export interface PlanAndLimits {
  plan: FlipdeskPlan;
  caps: {
    activeListings: number;
    includedGradesPerMonth: number;
    aiActionsPerMonth: number;
    marketplaces: number;
    teamSeats: number;
  };
  usage: {
    activeListings: number;
    gradesUsedThisMonth: number;
    aiActionsUsedThisMonth: number;
  };
}

interface PlanUserSlice {
  flipdesk_plan: FlipdeskPlan;
  subscription_status: string | null;
  trial_ends_at: string | null;
  past_due_since: string | null;
  grades_used_this_month: number | string | null;
  grade_reset_at: string | null;
  ai_actions_used_this_month: number | string | null;
}

export async function getMyPlanAndLimits(
  ownerId: string,
  db: SupportDb = defaultDb,
  loadMatrix: () => Promise<Record<FlipdeskPlan, PlanConfig>> = getPlanMatrix,
  now: Date = new Date(),
): Promise<PlanAndLimits | null> {
  // EXPLICIT non-sensitive slice — no email/name/Stripe ids/API keys/MFA.
  const { data, error } = await db
    .from("users")
    .select(
      "flipdesk_plan, subscription_status, trial_ends_at, past_due_since, grades_used_this_month, grade_reset_at, ai_actions_used_this_month",
    )
    .eq("id", ownerId)
    .maybeSingle();
  if (error || !data) return null;
  const u = data as unknown as PlanUserSlice;

  const effective = effectivePlanFor(
    u.flipdesk_plan,
    u.subscription_status,
    u.trial_ends_at,
    now,
    u.past_due_since,
  ) as FlipdeskPlan;
  const matrix = await loadMatrix();
  const plan = matrix[effective] ?? matrix.free;

  // Active-listing usage: items currently in the 'listed' state (same source
  // of truth the plan-gate uses).
  const { data: listed } = await db
    .from("inventory_items")
    .select("id")
    .eq("user_id", ownerId)
    .eq("status", "listed");
  const activeListings = Array.isArray(listed) ? listed.length : 0;

  // Included-grade counter rolls over on a clock boundary (US-393): once the
  // reset boundary has passed, the used count reads as 0 until the next grade.
  const resetPassed = u.grade_reset_at
    ? new Date(u.grade_reset_at).getTime() <= now.getTime()
    : true;
  const gradesUsed = resetPassed ? 0 : num(u.grades_used_this_month);

  return {
    plan: effective,
    caps: {
      activeListings: plan.activeListingCap,
      includedGradesPerMonth: plan.includedStandardGradesPerMonth,
      aiActionsPerMonth: plan.aiActionsPerMonth,
      marketplaces: plan.marketplacesCap,
      teamSeats: plan.teamSeatCap,
    },
    usage: {
      activeListings,
      gradesUsedThisMonth: gradesUsed,
      aiActionsUsedThisMonth: num(u.ai_actions_used_this_month),
    },
  };
}

// ── Tool 7: knowledge-base retrieval (US-833) ──────────────────────
//
// This is the ONLY source of product/how-to knowledge the assistant may speak
// from (US-835 forbids answering product questions from the model's training
// priors). It keyword-searches the GIN-indexed `search_tsv` column on
// support_kb_articles (migration 00183), filtered to PUBLISHED rows the caller's
// audience is allowed to see, and returns concise snippets — never whole
// articles — sized for the prompt budget. An empty result is an explicit signal
// the engine maps to "I don't have that — want a human?" rather than inventing
// an answer.

// Audience the caller is permitted to read. 'public' (anonymous / pre-auth)
// sees only public articles; 'subscriber' (an authenticated user) additionally
// sees subscriber-only articles. Mirrors the RLS SELECT policies on 00183.
export type KbAudience = "public" | "subscriber";

export interface KbSearchResult {
  slug: string;
  title: string;
  snippet: string;
}

export interface KbSearchArgs {
  query: string;
  audience: KbAudience;
}

// Top-K cap — the assistant only ever needs a handful of references, and the
// snippets must fit the prompt budget.
const KB_MAX_RESULTS = 5;
const KB_SNIPPET_MAX = 240;

// Audiences a caller may read, widest-first. A subscriber sees subscriber +
// public; a public/anon caller sees public only. Never the reverse — a public
// caller must NOT reach subscriber-only content.
function visibleAudiences(audience: KbAudience): KbAudience[] {
  return audience === "subscriber" ? ["public", "subscriber"] : ["public"];
}

// Build a concise, prompt-budget-sized snippet from an article body. Collapses
// whitespace and, when possible, centres the window on the first query term so
// the returned excerpt is actually about what was asked.
function kbSnippet(body: string, query: string, max = KB_SNIPPET_MAX): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return text.slice(0, max).trimEnd() + "…";

  const start = Math.max(0, idx - Math.floor(max / 4));
  const end = Math.min(text.length, start + max);
  let snip = text.slice(start, end).trim();
  if (start > 0) snip = "…" + snip;
  if (end < text.length) snip = snip + "…";
  return snip;
}

export async function searchKnowledgeBase(
  args: KbSearchArgs,
  db: SupportDb = defaultDb,
): Promise<KbSearchResult[]> {
  const query = (args.query ?? "").trim();
  // No query → no fabrication, explicit empty set.
  if (!query) return [];

  const audiences = visibleAudiences(args.audience);

  // FTS via the GIN tsvector index (idx_support_kb_articles_search_tsv).
  // `websearch` is the most forgiving parse for free-text user questions. Only
  // PUBLISHED rows in an allowed audience are ever matched. Fetch the body so we
  // can derive a snippet locally; never return the whole article.
  const { data, error } = await db
    .from("support_kb_articles")
    .select("slug, title, body_md")
    .eq("is_published", true)
    .in("audience", audiences)
    .textSearch("search_tsv", query, { config: "english", type: "websearch" })
    .limit(KB_MAX_RESULTS);
  if (error || !data) return [];

  return (data as Array<Record<string, unknown>>)
    .slice(0, KB_MAX_RESULTS)
    .map((r) => ({
      slug: String(r.slug ?? ""),
      title: String(r.title ?? ""),
      snippet: kbSnippet(String(r.body_md ?? ""), query),
    }));
}
