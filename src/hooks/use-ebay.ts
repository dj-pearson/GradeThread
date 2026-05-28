import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";
import { useAuthStore } from "@/stores/auth-store";

// ── Connection state ────────────────────────────────────────────────

export interface EbayConnection {
  id: string;
  account_handle: string | null;
  token_expires_at: string | null;
  is_active: boolean;
  last_synced_at: string | null;
}

// Reads marketplace_connections directly via supabase-js so we don't need a
// dedicated edge endpoint just to answer "is this user connected?". RLS keeps
// it scoped to the current user.
// Pass `pollingInterval` (ms) to fast-poll while a background sync is running.
export function useEbayConnection(pollingInterval?: number) {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["ebay_connection", user?.id],
    enabled: !!user,
    staleTime: pollingInterval ? 0 : 60_000,
    refetchInterval: pollingInterval ?? false,
    queryFn: async (): Promise<EbayConnection | null> => {
      const { data, error } = await supabase
        .from("marketplace_connections")
        .select(
          "id, account_handle, token_expires_at, is_active, last_synced_at"
        )
        .eq("marketplace", "ebay")
        .eq("is_active", true)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as EbayConnection | null;
    },
  });
}

// Legacy single-header helper. Most call sites use it via
// `Authorization: await authHeader()`; new sites should prefer the shared
// edgeAuthHeaders() from @/lib/edge-fetch, which also attaches the
// X-Workspace-Owner header.
async function authHeader(): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error("You must be signed in.");
  }
  return `Bearer ${session.access_token}`;
}

// Returns Authorization + X-Workspace-Owner so eBay endpoints scope to the
// active workspace (marketplace connections, listings, payouts all live
// under the workspace owner).
async function ebayHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Authorization: await authHeader(),
    "Content-Type": "application/json",
  };
  const { activeWorkspaceOwnerId, user } = useAuthStore.getState();
  const ownerId = activeWorkspaceOwnerId ?? user?.id;
  if (ownerId) headers["X-Workspace-Owner"] = ownerId;
  return headers;
}

// Kicks off the OAuth dance: GETs /oauth/start, then assigns window.location
// to the returned consent URL. On return, eBay redirects to /oauth/callback,
// which on success bounces back to /dashboard/flipdesk/marketplaces?ebay=connected.
export function useStartEbayOauth() {
  return useMutation<void, Error, { redirectTo?: string } | void>({
    mutationFn: async (input) => {
      const params = new URLSearchParams();
      if (input && input.redirectTo) params.set("redirect_to", input.redirectTo);
      const qs = params.toString() ? `?${params.toString()}` : "";
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/oauth/start${qs}`,
        { headers: await ebayHeaders() }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Could not start eBay sign-in.");
      }
      if (!json.consent_url) {
        throw new Error("Server did not return a consent URL.");
      }
      window.location.href = json.consent_url as string;
    },
    onError: (err) => toast.error(err.message),
  });
}

// ── Taxonomy ────────────────────────────────────────────────────────

export interface EbayCategorySuggestion {
  categoryId: string;
  categoryName: string;
  categoryTreePath: string;
}

// Live suggestions for a free-text query. We don't debounce here — the
// consumer (composer) controls the input frequency.
export function useEbayCategorySuggest(query: string) {
  return useQuery({
    queryKey: ["ebay_category_suggest", query],
    enabled: query.trim().length >= 2,
    staleTime: 60_000,
    queryFn: async (): Promise<EbayCategorySuggestion[]> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/category/suggest?q=${encodeURIComponent(
          query
        )}`,
        { headers: await ebayHeaders() }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Category lookup failed.");
      }
      return (json.suggestions ?? []) as EbayCategorySuggestion[];
    },
  });
}

// Aspect spec for a leaf category. eBay's shape is preserved verbatim under
// `aspects.aspects[]`. Cached server-side; safe to call eagerly.
export interface EbayAspectValue {
  localizedValue: string;
}
export interface EbayAspect {
  localizedAspectName: string;
  aspectConstraint: {
    aspectDataType?: string;
    aspectMode?: string;
    aspectRequired?: boolean;
    aspectUsage?: string; // "RECOMMENDED" | "OPTIONAL"
    expectedRequiredByDate?: string;
    itemToAspectCardinality?: string; // "SINGLE" | "MULTI"
  };
  aspectValues?: EbayAspectValue[];
}
export interface EbayAspectsResponse {
  aspects: { aspects?: EbayAspect[] };
  categoryName: string | null;
  cached: boolean;
}

export function useEbayCategoryAspects(categoryId: string | null) {
  return useQuery({
    queryKey: ["ebay_category_aspects", categoryId],
    enabled: !!categoryId,
    staleTime: 24 * 60 * 60_000,
    queryFn: async (): Promise<EbayAspectsResponse> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/category/${encodeURIComponent(
          categoryId!
        )}/aspects`,
        { headers: await ebayHeaders() }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Aspect lookup failed.");
      }
      return json as EbayAspectsResponse;
    },
  });
}

// ── AI aspect fill (Week 2) ─────────────────────────────────────────

export interface AiAspectSuggestion {
  values: string[];
  confidence: number;
  source: string;
}

export interface AiAspectExtractResponse {
  category_id: string;
  suggestions: Record<string, AiAspectSuggestion>;
  model: string | null;
  log_id: string | null;
  actions_remaining: number;
  aspects_considered?: number;
  aspects_available?: number;
}

// Mutation hook used by the eBay category picker's "AI fill from photos"
// button. Returns Claude's per-aspect suggestions constrained to eBay's
// allowed values.
export function useAiExtractAspects() {
  return useMutation<
    AiAspectExtractResponse,
    Error,
    {
      itemId: string;
      categoryId: string;
      categoryPath?: string;
      knownAspects?: Record<string, string[]>;
    }
  >({
    mutationFn: async ({ itemId, categoryId, categoryPath, knownAspects }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ai/extract-aspects`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({
            item_id: itemId,
            category_id: categoryId,
            category_path: categoryPath,
            known_aspects: knownAspects,
          }),
        }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "AI fill failed.");
      }
      return json as AiAspectExtractResponse;
    },
    onError: (err) => toast.error(err.message),
  });
}

// ── Comps (Browse API) ──────────────────────────────────────────────

export interface EbayComp {
  itemId: string;
  title: string;
  price: number | null;
  currency: string;
  imageUrl: string | null;
  itemWebUrl: string | null;
  condition: string | null;
  buyingOptions: string[];
}

export interface EbayCompsResponse {
  items: EbayComp[];
  total: number;
  stats: {
    count: number;
    currency: string;
    min: number | null;
    p25: number | null;
    median: number | null;
    p75: number | null;
    max: number | null;
  };
}

export interface EbayCompsArgs {
  categoryId: string | null;
  q?: string;
  brand?: string;
  size?: string;
  conditionId?: string;
  limit?: number;
}

export function useEbayComps(args: EbayCompsArgs) {
  return useQuery({
    queryKey: [
      "ebay_comps",
      args.categoryId,
      args.q ?? null,
      args.brand ?? null,
      args.size ?? null,
      args.conditionId ?? null,
    ],
    enabled: !!args.categoryId,
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<EbayCompsResponse> => {
      const params = new URLSearchParams({ category_id: args.categoryId! });
      if (args.q) params.set("q", args.q);
      if (args.brand) params.set("brand", args.brand);
      if (args.size) params.set("size", args.size);
      if (args.conditionId) params.set("condition_id", args.conditionId);
      if (args.limit) params.set("limit", String(args.limit));
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/comps?${params.toString()}`,
        { headers: await ebayHeaders() }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Comps lookup failed.");
      }
      return json as EbayCompsResponse;
    },
  });
}

// ── Category check (Week 5) ─────────────────────────────────────────

export interface CategoryCheckEntry {
  id: string;
  name: string | null;
  path: string | null;
}

export interface CategoryCheckResponse {
  listing_id: string;
  current: CategoryCheckEntry | null;
  suggested: CategoryCheckEntry[];
  match: boolean;
  query_used: string;
}

// Compares the eBay category a listing is currently in vs what the
// Taxonomy API would suggest today. Returns null when the listing has no
// stored category (e.g. it pre-dates the category-capture migration).
export function useEbayCategoryCheck() {
  return useMutation<
    CategoryCheckResponse,
    Error,
    { listingId: string }
  >({
    mutationFn: async ({ listingId }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/${encodeURIComponent(
          listingId,
        )}/category-check`,
        { headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Category check failed.");
      }
      return json as CategoryCheckResponse;
    },
    onError: (err) => toast.error(err.message),
  });
}

// ── Manage live listings (Week 4) ───────────────────────────────────

// Updates a published listing's price on eBay via the Sell API. The
// endpoint also writes-through to local `listings.listing_price` on
// success so the UI doesn't need a follow-up refetch.
//
// 409 — listing has no platform_offer_id (typically a manually-marked
// "listed" item that never went through Sell API). Callers should fall
// back to local-only update.
export function useEbayUpdateListingPrice() {
  return useMutation<
    { ok: true; listing_id: string; price: number },
    Error & { status?: number },
    { listingId: string; price: number }
  >({
    mutationFn: async ({ listingId, price }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/${encodeURIComponent(
          listingId
        )}/price`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({ price }),
        }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err: Error & { status?: number } = new Error(
          json.error || "Price update failed."
        );
        err.status = res.status;
        throw err;
      }
      return json;
    },
  });
}

// Revises a live listing — title / description / price all optional.
// Server PUTs the inventory_item and offer as needed. 409 → no offer_id
// (caller should treat the listing as not-yet-on-eBay and edit locally).
export interface ReviseListingPatch {
  title?: string;
  description?: string;
  listing_price?: number;
}

export function useEbayReviseListing() {
  return useMutation<
    {
      ok: true;
      listing_id: string;
      updated: Partial<{
        listing_title: string;
        listing_description: string;
        listing_price: number;
      }>;
    },
    Error & { status?: number },
    { listingId: string; patch: ReviseListingPatch }
  >({
    mutationFn: async ({ listingId, patch }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/${encodeURIComponent(
          listingId
        )}/revise`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify(patch),
        }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err: Error & { status?: number } = new Error(
          json.detail || json.error || "Listing revision failed."
        );
        err.status = res.status;
        throw err;
      }
      return json;
    },
  });
}

// Ends a live listing on eBay (Sell API withdrawOffer). Writes through to
// local state on success: listings.listing_status='ended', inventory_items.
// status='drafted'. Returns 409 when there's no platform_offer_id.
export function useEbayEndListing() {
  return useMutation<
    { ok: true; listing_id: string },
    Error & { status?: number },
    { listingId: string }
  >({
    mutationFn: async ({ listingId }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/${encodeURIComponent(
          listingId
        )}`,
        {
          method: "DELETE",
          headers: await ebayHeaders(),
        }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err: Error & { status?: number } = new Error(
          json.error || "End listing failed."
        );
        err.status = res.status;
        throw err;
      }
      return json;
    },
  });
}

// ── Sync from eBay (pull) ──────────────────────────────────────────

export interface SyncEbayListingsResponse {
  ok: boolean;
  /** True when the server accepted the request and is running the sync in
   *  the background (HTTP 202). The frontend should poll last_synced_at. */
  started?: boolean;
  total?: number;
  matched?: number;
  unmatched?: number;
  skipped?: number;
  legacy_matched?: number;
  legacy_unmatched?: number;
  legacy_duplicates?: number;
  sales_new?: number;
  sales_updated?: number;
  sales_skipped?: number;
  sales_enriched?: number;
  since?: string | null;
  errors?: string[];
}

// Pulls every offer from the connected eBay seller account into FlipDesk.
// Matched (by SKU) → updates the local `listings` row + status.
// Unmatched → snapshots into `flipdesk_ebay_listings` for reconciliation.
//
// The server returns 202 immediately and runs the actual work in the
// background, so `started: true` means "accepted" not "completed".
// The marketplaces page polls `useEbayConnection` until `last_synced_at`
// advances to detect completion.
export function useSyncEbayListings() {
  const qc = useQueryClient();
  return useMutation<SyncEbayListingsResponse, Error, void>({
    mutationFn: async () => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/pull`,
        {
          method: "POST",
          headers: await ebayHeaders(),
        }
      );
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
      } & Partial<SyncEbayListingsResponse>;
      if (!res.ok) {
        // Surface the eBay error detail so the user can diagnose without
        // digging through edge logs.
        const top = json.error || "Sync failed.";
        const err = new Error(json.detail ? `${top}\n${json.detail}` : top);
        throw err;
      }
      // 202 = accepted, running in background
      if (res.status === 202) {
        return { ok: true, started: true };
      }
      return json as SyncEbayListingsResponse;
    },
    onSuccess: (data) => {
      // If the sync completed synchronously (200), invalidate immediately.
      // If it's still running (202), the marketplaces page will poll and
      // call these invalidations when last_synced_at changes.
      if (!data.started) {
        qc.invalidateQueries({ queryKey: ["items_full"] });
        qc.invalidateQueries({ queryKey: ["ebay_connection"] });
      }
    },
    onError: (err) => {
      const [head, ...rest] = err.message.split("\n");
      toast.error(head ?? "Sync failed.", {
        description: rest.length > 0 ? rest.join(" • ") : undefined,
        duration: 12_000,
      });
    },
  });
}

// ── Publish to eBay (Week 3) ────────────────────────────────────────

export interface PublishSummary {
  title: string;
  description: string;
  priceValue: string;
  currency: string;
  condition: string;
  conditionDescription: string;
}

export interface ValidatePublishResponse {
  ok: boolean;
  blockers: string[];
  summary?: PublishSummary;
}

export interface PublishResponse {
  ok: boolean;
  listing_id?: string;
  listing_url?: string;
  offer_id?: string;
  sku?: string;
  blockers?: string[];
  error?: string;
  detail?: string;
}

export function useValidatePublish() {
  return useMutation<ValidatePublishResponse, Error, { itemId: string }>({
    mutationFn: async ({ itemId }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/validate`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({ inventory_item_id: itemId }),
        }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Validation failed.");
      }
      return json as ValidatePublishResponse;
    },
  });
}

export function usePublishToEbay() {
  const qc = useQueryClient();
  return useMutation<PublishResponse, Error, { itemId: string }>({
    mutationFn: async ({ itemId }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/push`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({ inventory_item_id: itemId }),
        }
      );
      const json = (await res.json().catch(() => ({}))) as PublishResponse;
      if (!res.ok || json.ok === false) {
        // 422 surfaces blockers; bubble them via the error.
        const blockerMsg = (json.blockers ?? []).join("\n");
        const detail = json.detail ?? json.error ?? "Publish failed.";
        throw new Error(blockerMsg ? `${detail}\n${blockerMsg}` : detail);
      }
      return json;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["items_full"] });
      qc.invalidateQueries({ queryKey: ["item_photos", vars.itemId] });
      qc.invalidateQueries({ queryKey: ["inventory_item_ebay", vars.itemId] });
    },
  });
}

// ── Persistence ─────────────────────────────────────────────────────

// Saves the chosen eBay category + aspect values on the inventory item.
// Values are arrays so we can handle MULTI-cardinality aspects uniformly.
export function useSaveEbayCategoryMapping() {
  const qc = useQueryClient();
  return useMutation<
    void,
    Error,
    { itemId: string; categoryId: string; aspects: Record<string, string[]> }
  >({
    mutationFn: async ({ itemId, categoryId, aspects }) => {
      const { error } = await supabase
        .from("inventory_items")
        .update({
          ebay_category_id: categoryId,
          ebay_aspects: aspects,
        } as never)
        .eq("id", itemId);
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["items_full"] });
      qc.invalidateQueries({ queryKey: ["inventory_item", vars.itemId] });
    },
    onError: (err) => toast.error(err.message),
  });
}
