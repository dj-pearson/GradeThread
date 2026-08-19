// US-2683: eBay's own buyer search terms, from the Promoted Listings reports.
//
// WHY THIS IS THE ONLY REAL SOURCE. Everything else FlipDesk knows about buyer
// language is inferred. US-2675 improved demand-term mining by ranking sold
// titles over active ones, but both are still SELLER writing — the words other
// people chose, weighted by outcome. Promoted Listings Priority (CPC) reports
// are the one place eBay hands a seller the queries buyers actually TYPED
// against their own items. That is ground truth, and nothing else on the
// platform gives it.
//
// GATED ON THE SELLER RUNNING PRIORITY, which is most of the point of the
// no-op path below. A seller on Cost-Per-Sale only, or on no ads at all, has no
// report to pull and must not be told anything is wrong.
//
// THE FLOW IS THREE CALLS, not one. eBay generates these asynchronously:
//   1. POST /sell/marketing/v1/ad_report_task   -> a task id
//   2. GET  /sell/marketing/v1/ad_report_task/{id} -> status, eventually a
//      report id (SUCCESS) or a reason (FAILED)
//   3. GET  /sell/marketing/v1/ad_report/{id}   -> the report body, TSV
//
// Polling is the caller's business, not this module's: a cron tick that blocks
// on a report eBay has not finished is a cron tick that holds its lease until
// the sweeper takes it. Step 1 stores the task id, and a later tick picks it up.

import { supabaseAdmin } from "./supabase.ts";

/**
 * The report types that carry query text.
 *
 * KEYWORD is the seller's own bid terms and is available on every CPC campaign.
 * SEARCH_QUERY is what the buyer actually typed and is the valuable one — eBay
 * exposes it on Priority campaigns and not on every account, so a 400 for this
 * type is an ordinary outcome rather than a failure.
 */
export const AD_REPORT_TYPES = ["KEYWORD_PERFORMANCE_REPORT", "SEARCH_QUERY_REPORT"] as const;
export type AdReportType = (typeof AD_REPORT_TYPES)[number];

/** How far back a pull reaches. eBay caps the window; 30 days is inside it. */
export const REPORT_WINDOW_DAYS = 30;

export interface AdReportTask {
  taskId: string;
  reportType: AdReportType;
}

export interface SearchTermRow {
  /** The query text, lowercased and collapsed. The join key. */
  term: string;
  impressions: number;
  clicks: number;
  /** Sales eBay attributed to the ad, in whole units. */
  attributedSales: number;
}

// ---------------------------------------------------------------------------
// Parsing — pure, and the part worth testing
// ---------------------------------------------------------------------------

/**
 * eBay's report bodies are TSV with a header row, and the column NAMES are the
 * contract rather than their positions.
 *
 * Reading by index is the obvious shortcut and it is wrong here: eBay adds
 * columns to these reports between releases, and a positional parser silently
 * reads impressions out of whichever column moved into slot 3. Reading by name
 * fails loudly instead, which is the outcome you want from a report you are
 * about to feed into someone's listing titles.
 */
const TERM_COLUMNS = ["search_query", "keyword_text", "keyword", "query"];
const IMPRESSION_COLUMNS = ["impressions", "impression"];
const CLICK_COLUMNS = ["clicks", "click"];
const SALE_COLUMNS = ["attributed_sales", "sales", "ad_attributed_sales", "quantity_sold"];

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function findColumn(headers: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const at = headers.indexOf(candidate);
    if (at >= 0) return at;
  }
  return -1;
}

function toInt(raw: string | undefined): number {
  if (!raw) return 0;
  // eBay writes thousands separators and currency symbols into these columns.
  const n = Number.parseFloat(raw.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export class AdReportShapeError extends Error {}

/**
 * Parse a TSV report body into term rows.
 *
 * Throws AdReportShapeError when the columns this needs are absent, rather than
 * returning an empty list. An empty list means "this seller got no impressions",
 * and a report we could not read must not be able to say that.
 */
export function parseAdReportTsv(body: string): SearchTermRow[] {
  const lines = (body ?? "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  // eBay prefixes these files with metadata lines before the header. The header
  // is the first line that carries a term column.
  let headerAt = -1;
  let headers: string[] = [];
  for (let i = 0; i < lines.length && i < 20; i++) {
    const candidate = lines[i]!.split("\t").map(normalizeHeader);
    if (findColumn(candidate, TERM_COLUMNS) >= 0) {
      headerAt = i;
      headers = candidate;
      break;
    }
  }
  if (headerAt < 0) {
    throw new AdReportShapeError(
      "no header row carrying a search-query or keyword column; eBay's report shape changed",
    );
  }

  const termAt = findColumn(headers, TERM_COLUMNS);
  const impressionAt = findColumn(headers, IMPRESSION_COLUMNS);
  const clickAt = findColumn(headers, CLICK_COLUMNS);
  const saleAt = findColumn(headers, SALE_COLUMNS);
  if (impressionAt < 0) {
    throw new AdReportShapeError(
      `no impressions column; found: ${headers.filter(Boolean).join(", ")}`,
    );
  }

  const byTerm = new Map<string, SearchTermRow>();
  for (let i = headerAt + 1; i < lines.length; i++) {
    const cells = lines[i]!.split("\t");
    const term = (cells[termAt] ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!term) continue;

    // Rolled up rather than pushed: the same query appears once per listing in
    // a keyword report, and a seller wants "how often did anyone type this",
    // not one row per item it matched.
    const row = byTerm.get(term) ?? { term, impressions: 0, clicks: 0, attributedSales: 0 };
    row.impressions += toInt(cells[impressionAt]);
    if (clickAt >= 0) row.clicks += toInt(cells[clickAt]);
    if (saleAt >= 0) row.attributedSales += toInt(cells[saleAt]);
    byTerm.set(term, row);
  }

  return [...byTerm.values()].sort((a, b) =>
    b.impressions - a.impressions || (a.term < b.term ? -1 : 1)
  );
}

// ---------------------------------------------------------------------------
// AC6: the terms to REMOVE
// ---------------------------------------------------------------------------

/**
 * Impressions a term needs before its zero-click record means anything.
 *
 * Below this, no clicks is the expected outcome rather than evidence: a term
 * shown twice and not clicked has told you nothing. Same reasoning as
 * MIN_VARIANT_IMPRESSIONS in title-variant-ctr.ts, and deliberately a separate
 * number — that one compares two variants of one listing, this one judges a
 * single query across a store.
 */
export const MIN_TERM_IMPRESSIONS = 50;

export type TermVerdict = "add" | "remove" | "not_enough_data";

/**
 * What to do with a term, which is the half of this story that is not obvious.
 *
 * A query with impressions and NO clicks is not neutral. It means buyers are
 * being shown this listing for that query and rejecting it at the thumbnail —
 * so the word is pulling in the wrong traffic, and carrying it in a title costs
 * the characters AND dilutes the listing's relevance signal. Reporting only
 * terms to add would leave the seller adding words and never removing one.
 */
export function termVerdict(
  row: SearchTermRow,
  minImpressions: number = MIN_TERM_IMPRESSIONS,
): TermVerdict {
  if (row.impressions < minImpressions) return "not_enough_data";
  return row.clicks > 0 ? "add" : "remove";
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Upsert a pull's rows for one seller.
 *
 * TENANT SCOPING (US-268): every row carries user_id and the upsert conflicts
 * on (user_id, term, report_type), so a write can only ever touch the caller's
 * own rows even though the service-role client bypasses RLS.
 */
export async function storeSearchTerms(
  ownerId: string,
  reportType: AdReportType,
  rows: SearchTermRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const payload = rows.map((r) => ({
    user_id: ownerId,
    term: r.term,
    report_type: reportType,
    impressions: r.impressions,
    clicks: r.clicks,
    attributed_sales: r.attributedSales,
    last_seen_at: new Date().toISOString(),
  }));

  const { error } = await supabaseAdmin
    .from("ebay_search_terms")
    .upsert(payload, { onConflict: "user_id,term,report_type" });
  if (error) throw new Error(`Failed to store search terms: ${error.message}`);
  return payload.length;
}

/**
 * A seller's own eBay search terms, best first.
 *
 * Scoped on the resolved owner id. The caller passes
 * workspaceOwnerId ?? userId — a member acting in someone's workspace reads the
 * OWNER's terms, because the ad account is the owner's.
 */
export async function loadSearchTerms(
  ownerId: string,
  opts: { limit?: number } = {},
): Promise<SearchTermRow[]> {
  const { data, error } = await supabaseAdmin
    .from("ebay_search_terms")
    .select("term, impressions, clicks, attributed_sales")
    .eq("user_id", ownerId)
    .order("impressions", { ascending: false })
    .limit(opts.limit ?? 100);
  if (error) {
    console.error("[ebay-ad-reports] loadSearchTerms:", error.message);
    return [];
  }
  return ((data ?? []) as Array<{
    term: string;
    impressions: number | null;
    clicks: number | null;
    attributed_sales: number | null;
  }>).map((r) => ({
    term: r.term,
    impressions: r.impressions ?? 0,
    clicks: r.clicks ?? 0,
    attributedSales: r.attributed_sales ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// The eBay side
// ---------------------------------------------------------------------------

/** What a pull did, in the shape the cron reports. */
export interface PullOutcome {
  ownerId: string;
  status: "stored" | "no_campaign" | "not_available" | "pending" | "failed";
  reportType?: AdReportType;
  terms?: number;
  reason?: string;
}

/**
 * AC5: is this seller running a Priority (CPC) campaign at all?
 *
 * Most sellers are not, and that is the ordinary state rather than a fault. The
 * check reads the campaigns the marketing module already syncs rather than
 * asking eBay again — a cron that made a live call per seller just to discover
 * "no" would spend the whole rate budget finding out nothing.
 */
export async function hasPriorityCampaign(ownerId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id, ebay_cpc_campaign_id")
    .eq("user_id", ownerId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    .maybeSingle();
  if (error) return false;
  const id = (data as { ebay_cpc_campaign_id?: string | null } | null)?.ebay_cpc_campaign_id;
  return typeof id === "string" && id.trim().length > 0;
}

/** Injected so the report flow is testable without an eBay account. */
export interface AdReportTransport {
  createTask(
    ownerId: string,
    reportType: AdReportType,
    windowDays: number,
  ): Promise<{ taskId: string } | { unavailable: true; reason: string }>;
  taskStatus(
    ownerId: string,
    taskId: string,
  ): Promise<{ state: "pending" } | { state: "done"; reportId: string } | {
    state: "failed";
    reason: string;
  }>;
  download(ownerId: string, reportId: string): Promise<string>;
}

let transport: AdReportTransport | null = null;

/**
 * Register the live transport.
 *
 * The eBay calls live in ebay-marketing.ts, which owns the authed fetch and the
 * campaign state. Injecting rather than importing keeps this module free of the
 * Marketing client, so the parsing and the verdict rules -- the parts with real
 * logic in them -- stay unit-testable without an eBay account.
 */
export function registerAdReportTransport(t: AdReportTransport): void {
  transport = t;
}

export function hasAdReportTransport(): boolean {
  return transport !== null;
}

/**
 * Pull one report for one seller, end to end.
 *
 * NON-THROWING. This runs from a cron across every connected seller, and one
 * account's expired token must not stop the other two hundred. Every failure
 * comes back as a PullOutcome the caller can count.
 *
 * "pending" is a normal answer, not a retry loop. eBay generates these
 * asynchronously and a tick that blocks waiting holds its lease until the
 * sweeper takes it away; the next tick picks the task up.
 */
export async function pullSearchTerms(
  ownerId: string,
  reportType: AdReportType,
): Promise<PullOutcome> {
  if (!transport) return { ownerId, status: "failed", reason: "no transport registered" };

  if (!(await hasPriorityCampaign(ownerId))) {
    // AC5: not an error, not a toast, not a log line worth reading. Most
    // sellers live here permanently.
    return { ownerId, status: "no_campaign" };
  }

  try {
    const created = await transport.createTask(ownerId, reportType, REPORT_WINDOW_DAYS);
    if ("unavailable" in created) {
      // SEARCH_QUERY is exposed on some accounts and not others, so a refusal
      // for that type is an ordinary outcome and must not read as broken.
      return { ownerId, status: "not_available", reportType, reason: created.reason };
    }

    const status = await transport.taskStatus(ownerId, created.taskId);
    if (status.state === "pending") return { ownerId, status: "pending", reportType };
    if (status.state === "failed") {
      return { ownerId, status: "failed", reportType, reason: status.reason };
    }

    const body = await transport.download(ownerId, status.reportId);
    const rows = parseAdReportTsv(body);
    const stored = await storeSearchTerms(ownerId, reportType, rows);
    return { ownerId, status: "stored", reportType, terms: stored };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // A shape error is worth shouting about: it means eBay changed the report
    // and every seller's pull is now returning nothing useful.
    if (err instanceof AdReportShapeError) {
      console.error("[ebay-ad-reports] REPORT SHAPE CHANGED:", reason);
    }
    return { ownerId, status: "failed", reportType, reason };
  }
}

/** Roll a batch of outcomes into the counts a cron response reports. */
export function summarizePulls(outcomes: PullOutcome[]): Record<string, number> {
  const out: Record<string, number> = {
    stored: 0,
    no_campaign: 0,
    not_available: 0,
    pending: 0,
    failed: 0,
    terms: 0,
  };
  for (const o of outcomes) {
    out[o.status] = (out[o.status] ?? 0) + 1;
    out.terms += o.terms ?? 0;
  }
  return out;
}
