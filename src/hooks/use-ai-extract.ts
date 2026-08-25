import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
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

// US-1527: research-tier product identification (already confidence-floored
// server-side). The style suggestion carries source:"research" when it came
// from here; the panel badges it and shows the rationale.
export interface AiResearchIdentification {
  identified_style: string | null;
  product_line: string | null;
  fabric_technology: string | null;
  msrp_estimate_cents: number | null;
  identification_rationale: string | null;
  identification_confidence: number;
}

// US-821: one canonical listing attribute captured in the same extract pass
// (department, size_type, sleeve_length, …). Always an array; the server has
// ALREADY gap-fill-persisted these onto inventory_items, so clients use them for
// display and telemetry, not to re-persist.
export interface AiAttributeSuggestion {
  values: string[];
  confidence: number;
  source: string;
}

export interface AiExtractResponse {
  suggestions: Record<string, AiFieldSuggestion>;
  // US-1527: null when no identification cleared the confidence floor.
  research?: AiResearchIdentification | null;
  // US-821: canonical attributes captured this pass, keyed by canonical name
  // (NOT eBay aspect names — the per-category mapping happens server-side).
  attributes?: Record<string, AiAttributeSuggestion>;
  // US-821: the generic eBay category search phrase the AI derived (item type +
  // department, no brand/size/colour). Persisted server-side so a later category
  // change can re-resolve without spending another AI action.
  ebay_category_query?: string | null;
  condition_summary: string | null;
  conflicts: AiFieldConflict[];
  // Brand-spec flat measurements (inches) the AI inferred from brand+size+
  // category. null when the AI couldn't identify all three confidently.
  measurements: Record<string, number> | null;
  model: string;
  log_id: string | null;
  actions_remaining: number;
  // Listing prep, resolved from the photos and persisted onto the item.
  //
  // US-2270: this is now ALWAYS null. The category + item-specifics pass runs a
  // SECOND model call (~20s) which doubled the extract's latency, so the server
  // moved it to a background task and returns `ebay_pending: true` instead. Any
  // client branch gated on `ebay` being non-null is dead code — read
  // `ebay_pending` and re-read the item once the pass has had time to land.
  // Kept in the type because an older edge build can still fill it.
  ebay: AiExtractEbayBlock | null;
  // True when the background category/aspects pass was started for this item.
  ebay_pending?: boolean;
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

// US-1531: for a field the user EDITED away from the AI suggestion, the pair we
// want is (what the AI proposed → what the user finalized).
export interface AiCorrectionEntry {
  suggested: unknown;
  final: unknown;
}

// Records which suggested fields the user accepted (acceptance rate) and, for
// edited fields, what they changed the AI value TO (US-1531 correction capture).
// Telemetry only — failures are swallowed so they never block Apply.
export async function recordAiAcceptance(
  logId: string,
  acceptedFields: Record<string, unknown>,
  correctedFields?: Record<string, AiCorrectionEntry>
): Promise<void> {
  try {
    const body: Record<string, unknown> = { accepted_fields: acceptedFields };
    if (correctedFields && Object.keys(correctedFields).length > 0) {
      body.corrected_fields = correctedFields;
    }
    await fetch(`${edgeApiUrl()}/api/flipdesk/ai/log/${logId}`, {
      method: "PATCH",
      headers: await aiHeaders(),
      body: JSON.stringify(body),
    });
  } catch {
    /* non-fatal */
  }
}

function aiErrorToast(err: ApiError): void {
  if (err.status === 403) {
    toastError(err, "AI enrichment is switched off for this account.", {
      nextStep: "Turn it back on in Settings.",
    });
  } else if (err.status === 429) {
    toastError(err, "Monthly AI limit reached.");
  } else if (err.status === 402) {
    // The plan gate answers with a machine code (CAP_REACHED / FEATURE_LOCKED)
    // rather than seller-facing text, so err.message can't be shown here. These
    // hooks bypass edgeFetch, so nothing else catches a 402 for them either.
    // The two codes mean different things and used to read the same: a Starter
    // seller clicking a bulk action was told to raise a limit that is not what
    // is stopping them.
    if (err.message === "FEATURE_LOCKED") {
      toast.error("Bulk AI needs a Pro plan.", {
        description: "Upgrade from Billing, or run items one at a time.",
      });
    } else {
      toast.error("Your plan is out of AI actions.", {
        description: "Raise the limit from Billing to keep using AI.",
      });
    }
  } else if (err.status === 502) {
    toast.error("AI is temporarily unavailable. Please try again.");
  } else {
    toastError(err, "AI request failed.");
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

// US-2494: buyer-facing counter/reply draft plus the pure counter-offer
// guardrail, in one call (the edge route is US-1168, already live for iOS).
// `suggested_counter` is the validated price; the *_flags say why it was moved.
export type NegotiationDraftMode = "counter" | "reply";

export interface NegotiationDraftInput {
  /** inventory_items UUID, not the eBay item id the offer/message carries. */
  item_id: string;
  mode: NegotiationDraftMode;
  offer_price?: number;
  currency?: string;
  buyer_message?: string;
  proposed_counter?: number;
}

export interface NegotiationDraftResponse {
  message: string;
  suggested_counter: number | null;
  warnings: string[];
  below_cost: boolean;
  at_or_below_offer: boolean;
  above_asking: boolean;
  model: string;
  log_id: string | null;
  actions_remaining: number;
}

export function useNegotiationDraft() {
  return useMutation<NegotiationDraftResponse, ApiError, NegotiationDraftInput>({
    mutationFn: (input) =>
      postJson<NegotiationDraftResponse>("/api/flipdesk/ai/negotiate", input),
    onError: aiErrorToast,
  });
}

// US-1088: Size AI — infer a missing/cut-off size (and gender/department) from
// the item's photos vs the brand's sizing. low_confidence flags a "best guess"
// the UI should surface rather than apply silently.
export interface SizeEstimateResponse {
  size: string;
  gender: string | null;
  confidence: number; // 0..1
  rationale: string;
  low_confidence: boolean;
}

export function useAiSizeEstimate() {
  return useMutation<SizeEstimateResponse, ApiError, { item_id: string }>({
    mutationFn: (input) =>
      postJson<SizeEstimateResponse>("/api/flipdesk/ai/size", input),
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
  // US-2677: reword away from one of the seller's own near-duplicate listings.
  | "title_differentiate"
  | "description_tighten"
  | "description_regen";

export interface RewriteInput {
  item_id: string;
  action: RewriteAction;
  title?: string;
  description?: string;
  /**
   * US-2677: the seller's own live titles this rewrite should move away from.
   *
   * Sent rather than re-derived server-side so the model is differentiating
   * from the SAME listings the seller was just shown; two independent lookups
   * could disagree about which one is the conflict.
   */
  conflicting_titles?: string[];
}

export function useAiRewrite() {
  return useMutation<AiExtractResponse, ApiError, RewriteInput>({
    mutationFn: (input) =>
      postJson<AiExtractResponse>("/api/flipdesk/ai/rewrite", input),
    onError: aiErrorToast,
  });
}

// US-2817: "gap_fill" is the original behaviour — fill blanks, touch nothing
// else. "reidentify" re-runs identification on items the AI has already seen:
// the model is NOT shown its own earlier answers, and a confident new value may
// overwrite an AI-written one. Seller-typed values are never overwritten in
// either mode; they come back as `pending`.
export type BulkExtractMode = "gap_fill" | "reidentify";

export interface BulkExtractResult {
  item_id: string;
  status: "enriched" | "needs_review" | "failed";
  applied: string[];
  pending: string[];
  /** Subset of `applied` that replaced an earlier AI value (US-2817). */
  replaced?: string[];
  reason?: string;
}

export interface BulkExtractResponse {
  summary: {
    enriched: number;
    needs_review: number;
    failed: number;
    skipped: number;
    /** Total fields overwritten across the batch. Always 0 in gap-fill. */
    replaced?: number;
  };
  mode?: BulkExtractMode;
  /** Echoes what the server actually applied, not what the client asked for. */
  overwrite_untracked?: boolean;
  results: BulkExtractResult[];
  skipped: string[];
}

export function useBulkExtract() {
  return useMutation<
    BulkExtractResponse,
    ApiError,
    {
      item_ids: string[];
      mode?: BulkExtractMode;
      /**
       * Reidentify only. Per-column provenance is only recorded from US-2817
       * on, so older drafts carry none and every value on them reads as
       * seller-typed. With this on, a value with no recorded source counts as
       * the AI's and can be replaced. Opt-in per run: it cannot tell a stale
       * AI answer from something the seller typed by hand.
       */
      overwrite_untracked?: boolean;
    }
  >({
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
