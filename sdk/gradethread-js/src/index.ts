/**
 * GradeThread JavaScript/TypeScript SDK (US-596).
 *
 * A zero-dependency, typed client for the GradeThread Grade-as-a-Service API.
 * Works in Node 18+ (global `fetch`) and the browser.
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
}

/** Thrown for any non-2xx API response. Carries the status + parsed message. */
export class GradeThreadError extends Error {
  readonly status: number;
  readonly details: string[];
  constructor(message: string, status: number, details: string[] = []) {
    super(message);
    this.name = "GradeThreadError";
    this.status = status;
    this.details = details;
  }
}

interface Envelope<T> {
  data: T | null;
  error: { message: string; details?: string[] } | null;
  meta: unknown;
}

export class GradeThread {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GradeThreadOptions) {
    if (!options?.apiKey) {
      throw new Error("GradeThread: `apiKey` is required");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const f = options.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (!f) {
      throw new Error(
        "GradeThread: no global `fetch` found — pass `options.fetch` (Node < 18).",
      );
    }
    this.fetchImpl = f;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ data: T; meta: unknown }> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "X-API-Key": this.apiKey,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let json: Envelope<T>;
    try {
      json = (await res.json()) as Envelope<T>;
    } catch {
      throw new GradeThreadError(`Unexpected non-JSON response`, res.status);
    }

    if (!res.ok || json.error) {
      const message = json.error?.message ?? `Request failed with ${res.status}`;
      throw new GradeThreadError(message, res.status, json.error?.details ?? []);
    }
    return { data: json.data as T, meta: json.meta };
  }

  /** Live grading — spends credits. */
  readonly grades = {
    create: async (input: CreateGradeInput): Promise<CreateGradeResult> =>
      (await this.request<CreateGradeResult>("POST", "/api/v1/grades", input)).data,

    get: async (id: string): Promise<Grade> =>
      (await this.request<Grade>("GET", `/api/v1/grades/${encodeURIComponent(id)}`)).data,

    list: async (params: { page?: number; limit?: number; status?: string } = {}): Promise<ListResult<Grade>> => {
      const q = new URLSearchParams();
      if (params.page) q.set("page", String(params.page));
      if (params.limit) q.set("limit", String(params.limit));
      if (params.status) q.set("status", params.status);
      const qs = q.toString();
      const { data, meta } = await this.request<Grade[]>("GET", `/api/v1/grades${qs ? `?${qs}` : ""}`);
      return { data, meta: meta as ListMeta };
    },
  };

  /** Free sandbox — deterministic sample grades, no credits spent. */
  readonly sandbox = {
    grades: {
      create: async (input: Partial<CreateGradeInput> = {}): Promise<Grade> =>
        (await this.request<Grade>("POST", "/api/v1/sandbox/grades", input)).data,

      get: async (id: string): Promise<Grade> =>
        (await this.request<Grade>("GET", `/api/v1/sandbox/grades/${encodeURIComponent(id)}`)).data,
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
      (await this.request<WebhookSetResult>("PATCH", "/api/v1/webhook", { webhook_url: url })).data,

    get: async (): Promise<WebhookConfig> =>
      (await this.request<WebhookConfig>("GET", "/api/v1/webhook")).data,

    /** Mint a new signing secret, returned once. API key rotation does not change it. */
    rotateSecret: async (): Promise<{ signing_secret: string; secret_created_at: string }> =>
      (await this.request<{ signing_secret: string; secret_created_at: string }>(
        "POST",
        "/api/v1/webhook/secret/rotate",
      )).data,

    deliveries: async (params: { limit?: number } = {}): Promise<WebhookDelivery[]> =>
      (await this.request<WebhookDelivery[]>(
        "GET",
        `/api/v1/webhook/deliveries${params.limit ? `?limit=${params.limit}` : ""}`,
      )).data,
  };
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
