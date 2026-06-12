import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";
import { useAuthStore } from "@/stores/auth-store";

export interface AiFieldSuggestion {
  value: string;
  confidence: number; // 0..1
  source: string; // "text" | "photo:tag" | ...
}

export interface AiFieldConflict {
  field: string;
  text_value: string;
  photo_value: string;
}

export interface AiExtractEbayBlock {
  category_id: string;
  category_path: string | null;
  // Merged aspects as persisted on inventory_items.ebay_aspects.
  aspects: Record<string, string[]>;
  suggestions: Record<
    string,
    { values: string[]; confidence: number; source: string }
  >;
}

export interface AiExtractResponse {
  suggestions: Record<string, AiFieldSuggestion>;
  condition_summary: string | null;
  conflicts: AiFieldConflict[];
  // Brand-spec flat measurements (inches) the AI inferred from brand+size+
  // category. null when the AI couldn't identify all three confidently.
  measurements: Record<string, number> | null;
  model: string;
  log_id: string | null;
  actions_remaining: number;
  // One-call listing prep: the eBay category + item-specifics the server
  // resolved and persisted onto the item (null when skipped/unavailable).
  ebay: AiExtractEbayBlock | null;
}

export interface AiExtractInput {
  text?: string;
  photos?: { url: string; type?: string }[];
  known_fields?: Record<string, unknown>;
  item_id?: string;
}

interface ApiError extends Error {
  status?: number;
}

async function authHeader(): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error("You must be signed in to use AI features.");
  }
  return `Bearer ${session.access_token}`;
}

// Build the standard set of headers for an edge request: auth + workspace
// tenant. Pulled from the auth store so it picks up the active workspace
// without needing to plumb it through every hook.
async function aiHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Authorization: await authHeader(),
    "Content-Type": "application/json",
  };
  const { activeWorkspaceOwnerId, user } = useAuthStore.getState();
  const ownerId = activeWorkspaceOwnerId ?? user?.id;
  if (ownerId) headers["X-Workspace-Owner"] = ownerId;
  return headers;
}

// Records which suggested fields the user accepted. Telemetry only — failures
// are swallowed so they never block the user's Apply action.
export async function recordAiAcceptance(
  logId: string,
  acceptedFields: Record<string, unknown>
): Promise<void> {
  try {
    await fetch(`${edgeApiUrl()}/api/flipdesk/ai/log/${logId}`, {
      method: "PATCH",
      headers: await aiHeaders(),
      body: JSON.stringify({ accepted_fields: acceptedFields }),
    });
  } catch {
    /* non-fatal */
  }
}

function aiErrorToast(err: ApiError): void {
  if (err.status === 403) {
    toast.error(err.message, {
      description: "You can re-enable AI enrichment in Settings.",
    });
  } else if (err.status === 429) {
    toast.error(err.message || "Monthly AI limit reached.");
  } else if (err.status === 502) {
    toast.error("AI is temporarily unavailable. Please try again.");
  } else {
    toast.error(err.message || "AI request failed.");
  }
}

async function postJson<T>(path: string, input: unknown): Promise<T> {
  const res = await fetch(`${edgeApiUrl()}${path}`, {
    method: "POST",
    headers: await aiHeaders(),
    body: JSON.stringify(input),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: ApiError = new Error(json.error || "AI request failed.");
    err.status = res.status;
    throw err;
  }
  return json as T;
}

export function useAiExtract() {
  return useMutation<AiExtractResponse, ApiError, AiExtractInput>({
    mutationFn: (input) =>
      postJson<AiExtractResponse>("/api/flipdesk/ai/extract", input),
    onError: aiErrorToast,
  });
}

export interface ListingCopyResponse {
  title: string;
  description: string;
  model: string;
  log_id: string | null;
  actions_remaining: number;
}

export function useListingCopy() {
  return useMutation<ListingCopyResponse, ApiError, { item_id: string }>({
    mutationFn: (input) =>
      postJson<ListingCopyResponse>("/api/flipdesk/ai/listing-copy", input),
    onError: aiErrorToast,
  });
}

// US-552: one-click inline rewrites of the composer's title/description. The
// server returns an AiExtractResponse-shaped payload so the result flows
// straight into AiFillPanel (accept-all, confidence, acceptance logging).
export type RewriteAction =
  | "title_seo"
  | "title_shorten"
  | "title_keywords"
  | "description_tighten"
  | "description_regen";

export interface RewriteInput {
  item_id: string;
  action: RewriteAction;
  title?: string;
  description?: string;
}

export function useAiRewrite() {
  return useMutation<AiExtractResponse, ApiError, RewriteInput>({
    mutationFn: (input) =>
      postJson<AiExtractResponse>("/api/flipdesk/ai/rewrite", input),
    onError: aiErrorToast,
  });
}

export interface BulkExtractResult {
  item_id: string;
  status: "enriched" | "needs_review" | "failed";
  applied: string[];
  pending: string[];
  reason?: string;
}

export interface BulkExtractResponse {
  summary: {
    enriched: number;
    needs_review: number;
    failed: number;
    skipped: number;
  };
  results: BulkExtractResult[];
  skipped: string[];
}

export function useBulkExtract() {
  return useMutation<BulkExtractResponse, ApiError, { item_ids: string[] }>({
    mutationFn: (input) =>
      postJson<BulkExtractResponse>(
        "/api/flipdesk/ai/bulk-extract",
        input
      ),
    onError: aiErrorToast,
  });
}

// ── Reconcile vision endpoints (US-283 embed, US-286 classify) ──────────

export interface ReconcileVisionPhoto {
  id: string;
  /** base64 (no data: prefix) for pre-commit blobs … */
  data?: string;
  media_type?: string;
  /** … or a public URL post-commit. */
  url?: string;
}

export interface EmbedPhotosResponse {
  pairs: Array<{ a: string; b: string }>;
}

export function useEmbedPhotos() {
  // Errors are handled at the call site — the board keeps its time-gap
  // clustering and tells the user the visual pass was skipped.
  return useMutation<EmbedPhotosResponse, ApiError, { photos: ReconcileVisionPhoto[] }>({
    mutationFn: (input) => postJson<EmbedPhotosResponse>("/api/flipdesk/ai/embed-photos", input),
  });
}

export interface ClassifyPhotosResponse {
  classifications: Array<{ id: string; type: string; confidence: number }>;
}

export function useClassifyPhotos() {
  // Best-effort: classification failures fall back to 'detail' and never block.
  return useMutation<
    ClassifyPhotosResponse,
    ApiError,
    { item_id: string } | { photos: ReconcileVisionPhoto[] }
  >({
    mutationFn: (input) =>
      postJson<ClassifyPhotosResponse>("/api/flipdesk/ai/classify-photos", input),
  });
}

export interface MatchHintsResponse {
  brand: string | null;
  keywords: string[];
  confidence: number;
}

export function useSuggestItemMatch() {
  // Errors handled at the call site (the manual picker still works).
  return useMutation<MatchHintsResponse, ApiError, { photos: ReconcileVisionPhoto[] }>({
    mutationFn: (input) =>
      postJson<MatchHintsResponse>("/api/flipdesk/ai/suggest-item-match", input),
  });
}
