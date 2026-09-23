/**
 * GradeThread JavaScript/TypeScript SDK (US-596).
 *
 * A zero-dependency, typed client for the GradeThread Grade-as-a-Service API.
 * Works in Node 20+ (global `fetch` and `crypto`) and the browser.
 *
 * ```ts
 * import { GradeThread } from "@gradethread/sdk";
 * const gt = new GradeThread({ apiKey: process.env.GRADETHREAD_API_KEY! });
 * const sample = await gt.sandbox.grades.create({ title: "Denim jacket" });
 * ```
 */

export const DEFAULT_BASE_URL = "https://functions.gradethread.com";

export type GradeTier = "standard" | "premium" | "express";

export type ImageType =
  | "front"
  | "back"
  | "label"
  | "label_2"
  | "detail"
  | "detail_2"
  | "detail_3"
  | "detail_4"
  | "defect"
  | "measurement_chest"
  | "measurement_waist"
  | "measurement_length"
  | "measurement_sleeve"
  | "measurement_inseam";

export interface GradeImageInput {
  image_type: ImageType;
  /** Public https URL to the image (preferred), or supply `base64`. */
  url?: string;
  /** Base64-encoded image bytes; requires `content_type`. */
  base64?: string;
  content_type?: string;
}

export interface CreateGradeInput {
  title: string;
  garment_type: string;
  garment_category: string;
  brand?: string;
  description?: string;
  tier?: GradeTier;
  images: GradeImageInput[];
}

export interface GradeReport {
  id: string;
  overall_score: number;
  grade_tier: string;
  fabric_condition_score: number;
  structural_integrity_score: number;
  cosmetic_appearance_score: number;
  functional_elements_score: number;
  odor_cleanliness_score: number;
  confidence_score: number;
  ai_summary: string | null;
  detailed_notes: string | null;
  model_version: string;
  certificate_id: string | null;
  created_at: string;
}

export interface Grade {
  id: string;
  status: string;
  garment_type: string | null;
  garment_category: string | null;
  title: string | null;
  brand: string | null;
  description?: string | null;
  grade_report: GradeReport | null;
  created_at?: string;
  updated_at?: string;
}

export interface CreateGradeResult {
  id: string;
  status: string;
  tier: string;
  payment_method: string;
}

export interface ListMeta {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface ListResult<T> {
  data: T[];
  meta: ListMeta;
}

export interface GradeThreadOptions {
  apiKey: string;
  /** Override the API base URL (e.g. a staging host). */
  baseUrl?: string;
  /** Inject a custom fetch (tests, proxies). Defaults to global fetch. */
  fetch?: typeof fetch;
  /**
   * Retries after a 429, a 5xx or a network error (default 2). GETs are always
   * retried; `grades.create` and `grades.batch` are retried only because they
   * carry an Idempotency-Key, so a retry cannot charge twice. Other writes are
   * retried on 429 only, which the API sends before doing anything.
   */
  maxRetries?: number;
  /** First backoff in ms when the response has no Retry-After (default 500, doubles). */
  retryDelayMs?: number;
}

/** Per-call options for the two endpoints that charge. */
export interface IdempotentCallOptions {
  /**
   * Sent as the Idempotency-Key header. Defaults to a fresh UUID per call,
   * reused on that call's own retries. Pass your own to make a retry of the
   * whole call (after a crash, say) a replay rather than a second charge.
   */
  idempotencyKey?: string;
}

/** Thrown for any non-2xx API response. Carries the status + parsed message. */
export class GradeThreadError extends Error {
  readonly status: number;
  readonly details: unknown[];
  /** Machine-readable code when the API sends one, e.g. IDEMPOTENCY_KEY_REQUIRED. */
  readonly code: string | null;
  constructor(message: string, status: number, details: unknown[] = [], code: string | null = null) {
    super(message);
    this.name = "GradeThreadError";
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

interface Envelope<T> {
  data: T | null;
  error: { message: string; code?: string; details?: unknown[] } | null;
  meta: unknown;
}

type Query = Record<string, string | number | boolean | null | undefined>;

interface RequestOptions {
  body?: unknown;
  query?: Query;
  idempotencyKey?: string;
}

/** Longest wait the SDK will honor from a Retry-After header. */
const MAX_RETRY_DELAY_MS = 60_000;

function queryString(query: Query | undefined): string {
  if (!query) return "";
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Retry-After is either delta-seconds or an HTTP date. Null when absent or unreadable. */
function retryAfterMs(header: string | null, nowMs: number): number | null {
  if (header === null || header.trim() === "") return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (!c?.randomUUID) {
    throw new Error(
      "GradeThread: crypto.randomUUID is unavailable. Use Node 20+ or pass `idempotencyKey`.",
    );
  }
  return c.randomUUID();
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class GradeThread {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(options: GradeThreadOptions) {
    if (!options?.apiKey) {
      throw new Error("GradeThread: `apiKey` is required");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const f = options.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (!f) {
      throw new Error("GradeThread: no global `fetch` found; pass `options.fetch`.");
    }
    this.fetchImpl = f;
    this.maxRetries = Math.max(0, Math.trunc(options.maxRetries ?? 2));
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 500);
  }

  private shouldRetry(method: string, status: number, idempotent: boolean): boolean {
    if (status === 429) return true;
    // 409 IDEMPOTENCY_IN_PROGRESS: the first attempt is still running.
    if (status === 409) return idempotent;
    if (status >= 500) return method === "GET" || idempotent;
    return false;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<{ data: T; meta: unknown }> {
    const url = `${this.baseUrl}${path}${queryString(opts.query)}`;
    const headers: Record<string, string> = { "X-API-Key": this.apiKey };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey !== undefined) headers["Idempotency-Key"] = opts.idempotencyKey;
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const idempotent = opts.idempotencyKey !== undefined;

    for (let attempt = 0; ; attempt++) {
      const backoff = this.retryDelayMs * 2 ** attempt;
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, body });
      } catch (err) {
        // A network error may have reached the server, so only a request that
        // cannot double-apply is sent again.
        if (attempt < this.maxRetries && (method === "GET" || idempotent)) {
          await sleep(backoff);
          continue;
        }
        throw err;
      }

      if (attempt < this.maxRetries && this.shouldRetry(method, res.status, idempotent)) {
        const wait = retryAfterMs(res.headers.get("retry-after"), Date.now()) ?? backoff;
        await res.body?.cancel().catch(() => {});
        await sleep(Math.min(wait, MAX_RETRY_DELAY_MS));
        continue;
      }

      let json: Envelope<T>;
      try {
        json = (await res.json()) as Envelope<T>;
      } catch {
        throw new GradeThreadError(`Unexpected non-JSON response`, res.status);
      }

      if (!res.ok || json.error) {
        const message = json.error?.message ?? `Request failed with ${res.status}`;
        throw new GradeThreadError(message, res.status, json.error?.details ?? [], json.error?.code ?? null);
      }
      return { data: json.data as T, meta: json.meta };
    }
  }

  private async get<T>(path: string, query?: Query): Promise<T> {
    return (await this.request<T>("GET", path, { query })).data;
  }

  /** Live grading. Spends credits. */
  readonly grades = {
    /** Submit one garment. Sends an Idempotency-Key, so a retry never charges twice. */
    create: async (input: CreateGradeInput, opts: IdempotentCallOptions = {}): Promise<CreateGradeResult> =>
      (await this.request<CreateGradeResult>("POST", "/api/v1/grades", {
        body: input,
        idempotencyKey: opts.idempotencyKey ?? newIdempotencyKey(),
      })).data,

    /** Submit many garments as one batch. Poll it with `grades.getBatch`. */
    batch: async (garments: CreateGradeInput[], opts: IdempotentCallOptions = {}): Promise<CreateBatchResult> =>
      (await this.request<CreateBatchResult>("POST", "/api/v1/grades/batch", {
        body: { garments },
        idempotencyKey: opts.idempotencyKey ?? newIdempotencyKey(),
      })).data,

    getBatch: (id: string): Promise<GradeBatch> =>
      this.get<GradeBatch>(`/api/v1/grades/batch/${encodeURIComponent(id)}`),

    get: (id: string): Promise<Grade> =>
      this.get<Grade>(`/api/v1/grades/${encodeURIComponent(id)}`),

    list: async (params: { page?: number; limit?: number; status?: string } = {}): Promise<ListResult<Grade>> => {
      const { data, meta } = await this.request<Grade[]>("GET", "/api/v1/grades", { query: { ...params } });
      return { data, meta: meta as ListMeta };
    },
  };

  /** Inventory (FlipDesk items). Cursor-paginated: pass `meta.next_cursor` back as `cursor`. */
  readonly items = {
    list: async (params: ListItemsParams = {}): Promise<CursorPage<ItemSummary>> => {
      const { data, meta } = await this.request<{ items: ItemSummary[] }>("GET", "/api/v1/items", {
        query: { ...params },
      });
      return { data: data.items, meta: meta as CursorMeta };
    },
    get: (id: string): Promise<ItemDetail> =>
      this.get<ItemDetail>(`/api/v1/items/${encodeURIComponent(id)}`),
  };

  /** One row per item, showing its most recent listing. */
  readonly listings = {
    list: async (params: ListListingsParams = {}): Promise<CursorPage<ListingSummary>> => {
      const { data, meta } = await this.request<{ listings: ListingSummary[] }>("GET", "/api/v1/listings", {
        query: { ...params },
      });
      return { data: data.listings, meta: meta as CursorMeta };
    },
  };

  /** Completed sales by default; `meta.totals` covers the whole match. */
  readonly sales = {
    list: async (params: ListSalesParams = {}): Promise<CursorPage<SaleSummary, SalesMeta>> => {
      const { data, meta } = await this.request<{ sales: SaleSummary[] }>("GET", "/api/v1/sales", {
        query: { ...params },
      });
      return { data: data.sales, meta: meta as SalesMeta };
    },
  };

  /** This API key's usage this month against its quota. */
  readonly usage = {
    get: (): Promise<UsageState> => this.get<UsageState>("/api/v1/usage"),
  };

  /** Resale Condition Index price guide. */
  readonly priceGuide = {
    list: async (): Promise<PriceGuideCatalogItem[]> =>
      (await this.get<{ items: PriceGuideCatalogItem[] }>("/api/v1/price-guide")).items,
    get: (slug: string): Promise<PriceGuideEntry> =>
      this.get<PriceGuideEntry>(`/api/v1/price-guide/${encodeURIComponent(slug)}`),
  };

  /** Free sandbox: deterministic sample data, no credits spent. */
  readonly sandbox = {
    grades: {
      create: async (input: Partial<CreateGradeInput> = {}): Promise<Grade> =>
        (await this.request<Grade>("POST", "/api/v1/sandbox/grades", { body: input })).data,

      get: (id: string): Promise<Grade> =>
        this.get<Grade>(`/api/v1/sandbox/grades/${encodeURIComponent(id)}`),
    },
    priceGuide: {
      list: async (): Promise<PriceGuideCatalogItem[]> =>
        (await this.get<{ items: PriceGuideCatalogItem[] }>("/api/v1/sandbox/price-guide")).items,
      get: (slug: string): Promise<PriceGuideEntry> =>
        this.get<PriceGuideEntry>(`/api/v1/sandbox/price-guide/${encodeURIComponent(slug)}`),
    },
  };

  /**
   * Manage the completion webhook (requires the `webhook_manage` scope).
   * One webhook per account; each grade is delivered once.
   */
  readonly webhook = {
    /**
     * Set or clear the URL. The call that CREATES the webhook returns
     * `signing_secret` (`whsec_...`) once; store it for `verifyWebhook`.
     */
    set: async (url: string | null): Promise<WebhookSetResult> =>
      (await this.request<WebhookSetResult>("PATCH", "/api/v1/webhook", { body: { webhook_url: url } })).data,

    get: (): Promise<WebhookConfig> => this.get<WebhookConfig>("/api/v1/webhook"),

    /** Mint a new signing secret, returned once. API key rotation does not change it. */
    rotateSecret: async (): Promise<{ signing_secret: string; secret_created_at: string }> =>
      (await this.request<{ signing_secret: string; secret_created_at: string }>(
        "POST",
        "/api/v1/webhook/secret/rotate",
      )).data,

    deliveries: (params: { limit?: number } = {}): Promise<WebhookDelivery[]> =>
      this.get<WebhookDelivery[]>("/api/v1/webhook/deliveries", { limit: params.limit }),
  };
}

export interface CreateBatchResult {
  id: string;
  status: string;
  item_count: number;
}

export interface GradeBatch {
  id: string;
  status: string;
  item_count: number;
  succeeded_count: number;
  failed_count: number;
  error: string | null;
  results: Array<{ id: string; status: string; grade_id: string | null; error: string | null }>;
}

export interface CursorMeta {
  total: number;
  next_cursor: string | null;
  count: number;
}

export interface SalesMeta extends CursorMeta {
  totals: { gross_cents: number; net_profit_cents: number; count: number; page_only: boolean };
}

export interface CursorPage<T, M extends CursorMeta = CursorMeta> {
  data: T[];
  meta: M;
}

export interface ListItemsParams {
  status?: string;
  brand?: string;
  category?: string;
  search?: string;
  listed?: boolean;
  created_after?: string;
  created_before?: string;
  limit?: number;
  cursor?: string;
}

export interface ListListingsParams {
  marketplace?: string;
  status?: string;
  min_price_cents?: number;
  max_price_cents?: number;
  min_days_live?: number;
  min_watchers?: number;
  limit?: number;
  cursor?: string;
}

export interface ListSalesParams {
  sold_after?: string;
  sold_before?: string;
  marketplace?: string;
  /** Defaults to `completed` on the server. */
  status?: string;
  limit?: number;
  cursor?: string;
}

export interface ItemSummary {
  id: string;
  item_number: string | null;
  title: string;
  brand: string | null;
  size: string | null;
  category: string | null;
  status: string;
  list_price_cents: number | null;
  grade: number | null;
  grade_label: string | null;
  listed: boolean;
  photo_count: number;
  created_at: string;
}

export interface ItemDetail extends ItemSummary {
  description: string | null;
  color: string | null;
  style: string | null;
  notes: string | null;
  purchase_price_cents: number | null;
  purchase_date: string | null;
  target_price_cents: number | null;
  measurements: Record<string, number | string> | null;
  certificate_url: string | null;
  has_required_photos: boolean;
  photos: Array<{ id: string; photo_type: string | null; url: string; sort_order: number | null }>;
  updated_at: string;
  [key: string]: unknown;
}

export interface ListingSummary {
  listing_id: string | null;
  item_id: string;
  title: string;
  brand: string | null;
  size: string | null;
  marketplace: string | null;
  status: string | null;
  price_cents: number | null;
  url: string | null;
  listed_at: string | null;
  days_live: number | null;
  watchers: number | null;
  views: number | null;
  grade: number | null;
}

export interface SaleSummary {
  item_id: string;
  title: string;
  brand: string | null;
  marketplace: string | null;
  status: string | null;
  sale_price_cents: number | null;
  fees_cents: number | null;
  tax_cents: number | null;
  shipping_cost_cents: number | null;
  net_profit_cents: number | null;
  purchase_price_cents: number | null;
  sold_at: string | null;
  days_to_sell: number | null;
}

export interface UsageState {
  /** null = unlimited. */
  quota: number | null;
  used: number;
  remaining: number | null;
  exceeded: boolean;
  resets_at: string;
}

export interface PriceGuideCatalogItem {
  slug: string;
  brand: string;
  label: string;
  currency: string;
  headlineMedianCents: number | null;
  totalSampleSize: number;
  refreshedAt: string;
}

export interface PriceGuideEntry {
  slug: string;
  brand: string;
  label: string;
  categoryId: string;
  currency: string;
  refreshedAt: string;
  totalSampleSize: number;
  bands: Array<{
    band: string;
    label: string;
    gradeRange: string;
    currency: string;
    valueLowCents: number | null;
    valueMedianCents: number | null;
    valueHighCents: number | null;
    valueSampleSize: number;
    sellThrough: number | null;
    medianDaysToSell: number | null;
  }>;
  sellThroughScope: "platform";
}

export interface WebhookSetResult {
  webhook_url: string | null;
  keys_updated: number;
  /** Present only when this call created the webhook. Shown once. */
  signing_secret: string | null;
}

export interface WebhookConfig {
  webhook_url: string | null;
  has_signing_secret: boolean;
  secret_created_at: string | null;
  updated_at: string | null;
}

export interface WebhookDelivery {
  event_id: string;
  event_type: string;
  subject_id: string;
  status: "pending" | "running" | "delivered" | "failed" | "cancelled";
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_attempt_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
}

/** Header lookup that accepts a Fetch `Headers` or a plain (Node) object. */
type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function readHeader(headers: HeaderSource, name: string): string | null {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  const rec = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  const v = key ? rec[key] : undefined;
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a GradeThread webhook (Standard Webhooks format). Pass the RAW
 * request body exactly as received, the request headers, and your `whsec_`
 * secret. Returns false for a bad signature, a missing header, or a timestamp
 * more than `toleranceSeconds` (default 300) from now.
 *
 * ```ts
 * const ok = await verifyWebhook(rawBody, req.headers, process.env.GT_WEBHOOK_SECRET!);
 * if (!ok) return res.status(400).end();
 * ```
 */
export async function verifyWebhook(
  rawBody: string,
  headers: HeaderSource,
  secret: string,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): Promise<boolean> {
  const id = readHeader(headers, "webhook-id");
  const timestamp = readHeader(headers, "webhook-timestamp");
  const signature = readHeader(headers, "webhook-signature");
  if (!id || !timestamp || !signature || !secret.startsWith("whsec_")) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (opts.toleranceSeconds ?? 300)) return false;

  let keyBytes: Uint8Array;
  try {
    keyBytes = b64decode(secret.slice("whsec_".length));
  } catch {
    return false;
  }
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new Uint8Array(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`),
  );
  const expected = b64encode(new Uint8Array(mac));
  // The header may carry several space-separated `v1,<sig>` entries.
  return signature
    .split(" ")
    .map((part) => (part.startsWith("v1,") ? part.slice(3) : ""))
    .some((sig) => sig !== "" && constantTimeEqual(sig, expected));
}

export default GradeThread;
