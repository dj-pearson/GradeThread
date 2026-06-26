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
  // US-151: set when the Sell Analytics getTrafficReport call 403s for missing
  // access; the Listing Performance page prompts a reconnect when true.
  analytics_access_denied: boolean;
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
          "id, account_handle, token_expires_at, is_active, last_synced_at, analytics_access_denied"
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

// US-463: surfaces a connection that was DEACTIVATED by a permanent
// token-refresh failure (revoked/expired grant) so the UI can show a "reconnect"
// banner. Unlike useEbayConnection it does NOT filter is_active=true — it reads
// the latest row regardless so a deactivated connection's refresh_error is
// visible. RLS keeps it scoped to the current user.
export interface EbayConnectionIssue {
  is_active: boolean;
  refresh_error: string | null;
}

export function useEbayConnectionIssue() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["ebay_connection_issue", user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<EbayConnectionIssue | null> => {
      const { data, error } = await supabase
        .from("marketplace_connections")
        .select("is_active, refresh_error")
        .eq("marketplace", "ebay")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as EbayConnectionIssue | null;
    },
  });
}

// ── Business policies + ship-from location ──────────────────────────

export interface EbayPolicyDefaults {
  fulfillment_policy_id: string | null;
  payment_policy_id: string | null;
  return_policy_id: string | null;
  merchant_location_key: string | null;
}

export interface EbayPoliciesResponse {
  policies: Array<{
    policy_id: string;
    policy_type: "fulfillment" | "payment" | "return";
    policy_name: string;
    is_default: boolean;
  }>;
  defaults: EbayPolicyDefaults;
}

// Reads the seller's cached business policies + defaults (incl. the merchant
// location key). The edge route syncs once from eBay when the cache is empty,
// so this also tells us whether a ship-from location exists yet. `enabled`
// lets callers defer the call until the account is connected.
export function useEbayPolicies(enabled = true) {
  return useQuery({
    queryKey: ["ebay_policies"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<EbayPoliciesResponse> => {
      const res = await fetch(`${edgeApiUrl()}/api/flipdesk/ebay/policies`, {
        headers: await ebayHeaders(),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not load eBay policies.");
      return json as EbayPoliciesResponse;
    },
  });
}

// Forces a fresh pull of the seller's business policies from eBay (the UI
// "Re-sync" button). Use this when the cached policy ids are stale — e.g. a
// publish fails with "invalid shipping policy" because the cached default no
// longer resolves on eBay.
export function useSyncEbayPolicies() {
  const qc = useQueryClient();
  return useMutation<
    { synced: number; merchant_location_key: string | null; missing: string[] },
    Error,
    void
  >({
    mutationFn: async () => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/policies/sync`,
        { method: "POST", headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not sync eBay policies.");
      return json as {
        synced: number;
        merchant_location_key: string | null;
        missing: string[];
      };
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["ebay_policies"] });
      toast.success(`Synced ${data.synced} business policies from eBay.`);
    },
    onError: (err) => toast.error(err.message),
  });
}

// Sets which fulfillment/payment/return policy (and merchant location) is the
// default used on every published offer. Lets the seller fix a wrong/invalid
// auto-selected default that causes eBay publish errors (e.g. 25007).
export function useSetDefaultPolicies() {
  const qc = useQueryClient();
  return useMutation<
    EbayPoliciesResponse,
    Error,
    {
      fulfillment_policy_id?: string;
      payment_policy_id?: string;
      return_policy_id?: string;
      merchant_location_key?: string;
    }
  >({
    mutationFn: async (selection) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/policies/default`,
        {
          method: "PUT",
          headers: await ebayHeaders(),
          body: JSON.stringify(selection),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Could not save default policies.");
      }
      return json as EbayPoliciesResponse;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ebay_policies"] });
      toast.success("Default policies saved.");
    },
    onError: (err) => toast.error(err.message),
  });
}

// Creates the seller's default eBay ship-from (merchant inventory) location.
// eBay requires one on every offer and has no Seller Hub UI to make it, so
// FlipDesk creates it from a ZIP the seller confirms once.
export function useCreateEbayLocation() {
  const qc = useQueryClient();
  return useMutation<
    { ok: true; merchant_location_key: string },
    Error,
    {
      postal_code: string;
      country?: string;
      address_line1?: string;
      city?: string;
      state?: string;
      name?: string;
    }
  >({
    mutationFn: async (input) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/policies/location`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify(input),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.detail || json.error || "Could not save your location.");
      }
      return json as { ok: true; merchant_location_key: string };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ebay_policies"] });
      toast.success("eBay ship-from location saved. You can now publish listings.");
    },
    onError: (err) => toast.error(err.message),
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

// US-364: revoke the grant upstream at eBay (where supported) and deactivate the
// connection locally, so a long-lived refresh token isn't left valid after the
// seller disconnects.
export function useDisconnectEbay() {
  const qc = useQueryClient();
  return useMutation<{ ok: true; revoked: boolean }, Error, void>({
    mutationFn: async () => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/disconnect`,
        { method: "POST", headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not disconnect eBay.");
      return json as { ok: true; revoked: boolean };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ebay_connection"] });
      qc.invalidateQueries({ queryKey: ["ebay_connection_issue"] });
      toast.success("Disconnected eBay.");
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

// US-1060: how broad the returned comp set is after the fallback ladder.
export type CompBreadth = "exact" | "broadened" | "brand_category" | "category";

interface CompStats {
  count: number;
  currency: string;
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  max: number | null;
}

export interface EbayComp {
  itemId: string;
  title: string;
  price: number | null;
  currency: string;
  imageUrl: string | null;
  itemWebUrl: string | null;
  condition: string | null;
  buyingOptions: string[];
  // US-1060: "active" asking-price comp vs "sold" realized comp. Optional for
  // backward-compatibility with any cached response shape.
  source?: "active" | "sold";
}

export interface EbayCompsResponse {
  items: EbayComp[];
  total: number;
  stats: CompStats;
  // US-1060: ladder metadata. Optional so the UI degrades gracefully if absent.
  soldStats?: CompStats | null;
  breadth?: CompBreadth;
  broadened?: boolean;
  minResults?: number;
  soldEnabled?: boolean;
  ladder?: Array<{ breadth: CompBreadth; count: number }>;
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

// ── Sold-comp, grade-banded price recommendation (US-594) ───────────

export type PricingBasis = "ebay_sold" | "private_sales" | "active_estimated";

export interface GradeBandedPrice {
  recommendedCents: number | null;
  lowCents: number | null;
  highCents: number | null;
  currency: string;
  gradeValue: number | null;
  basis: PricingBasis;
  soldBacked: boolean;
  sufficient: boolean;
  confidence: number;
  compSet: {
    source: PricingBasis;
    count: number;
    currency: string;
    lowCents: number | null;
    medianCents: number | null;
    highCents: number | null;
  };
  sellThrough: {
    sellThroughPct: number;
    daysLow: number;
    daysHigh: number;
    label: "fast" | "moderate" | "slow" | "unknown";
    sampleSize: number;
  };
}

export interface GradeBandedPriceArgs {
  categoryId: string | null;
  q?: string;
  brand?: string;
  size?: string;
  grade: number | null;
}

// Recommends a price from REALIZED sales (eBay Insights → the seller's private
// sales), grade-positioned, with sell-through + the comp set behind it. Falls
// back to active asks only when no sold data exists (soldBacked=false). Distinct
// from useEbayComps, which only ever shows the active-ask distribution.
export function useGradeBandedPrice(args: GradeBandedPriceArgs) {
  return useQuery({
    queryKey: [
      "grade_banded_price",
      args.categoryId,
      args.q ?? null,
      args.brand ?? null,
      args.size ?? null,
      args.grade,
    ],
    enabled: !!(args.categoryId || args.brand || args.q),
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<GradeBandedPrice> => {
      const res = await fetch(`${edgeApiUrl()}/api/flipdesk/pricing/price`, {
        method: "POST",
        headers: await ebayHeaders(),
        body: JSON.stringify({
          categoryId: args.categoryId ?? undefined,
          q: args.q,
          brand: args.brand,
          size: args.size,
          grade: args.grade,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Price recommendation failed.");
      }
      return (json as { recommendation: GradeBandedPrice }).recommendation;
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
// `photos: true` forces the inventory_item re-PUT so the current photo set and
// sort order reach eBay even when no text field changed (eBay blocks editing
// inventory-based listings on its own site, so this is the supported path).
export interface ReviseListingPatch {
  title?: string;
  description?: string;
  listing_price?: number;
  // US-1079: quantity pushes up too — full eBay-owned field coverage.
  quantity?: number;
  photos?: boolean;
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
        quantity: number;
      }>;
      photos_synced?: boolean;
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

// US-1039: mark an eBay order shipped + push tracking/carrier to eBay (Sell
// Fulfillment API). The server records shipped_at + tracking locally too. A 409
// means the sale has no eBay order id (manual/other-marketplace) — the caller
// should fall back to a local-only write.
export function useEbayShipOrder() {
  return useMutation<
    { ok: true; pushed_to_ebay: boolean },
    Error & { status?: number },
    { saleId: string; trackingNumber: string; carrier?: string | null }
  >({
    mutationFn: async ({ saleId, trackingNumber, carrier }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/orders/${encodeURIComponent(
          saleId
        )}/ship`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({
            tracking_number: trackingNumber,
            carrier: carrier ?? null,
          }),
        }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err: Error & { status?: number } = new Error(
          json.detail || json.error || "Mark-shipped failed."
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
  return useMutation<
    SyncEbayListingsResponse,
    Error,
    { full?: boolean } | void
  >({
    mutationFn: async (vars) => {
      // full=true → one-time historical sales backfill (~24 months) instead of
      // the incremental window.
      const full = vars && "full" in vars ? vars.full : false;
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/pull${full ? "?full=true" : ""}`,
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

// ── Sync history ────────────────────────────────────────────────────

export interface EbaySyncRun {
  id: string;
  marketplace: string;
  status: "running" | "success" | "partial" | "failed";
  listings_total: number;
  listings_matched: number;
  listings_unmatched: number;
  listings_skipped: number;
  legacy_matched: number;
  legacy_unmatched: number;
  legacy_duplicates: number;
  sales_new: number;
  sales_updated: number;
  sales_skipped: number;
  sales_enriched: number;
  // US-459: cancelled/refunded line items handled this run.
  sales_reversed?: number;
  error_count: number;
  errors: string[];
  since: string | null;
  started_at: string;
  finished_at: string | null;
}

// Recent eBay sync runs for the Reconciliation page's history box. Each run is
// written by the background pull when it finishes (see doListingsPull). Refetches
// on focus/mount so opening Reconciliation after a sync shows the latest run.
export function useEbaySyncRuns(limit = 20) {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["ebay_sync_runs", user?.id, limit],
    enabled: !!user,
    staleTime: 15_000,
    // While a pull is in flight (a `running` row exists) poll every 5s so the
    // history updates live as it finalizes — or visibly stalls on "running" if
    // the background sync hangs. Idle otherwise.
    refetchInterval: (query) =>
      (query.state.data as EbaySyncRun[] | undefined)?.some(
        (r) => r.status === "running",
      )
        ? 5_000
        : false,
    queryFn: async (): Promise<EbaySyncRun[]> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/sync-runs?limit=${limit}`,
        { headers: await ebayHeaders() },
      );
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        runs?: EbaySyncRun[];
      };
      if (!res.ok) {
        throw new Error(json.error || "Failed to load sync history.");
      }
      return json.runs ?? [];
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
  return useMutation<PublishResponse, Error, { itemId: string; relist?: boolean }>({
    mutationFn: async ({ itemId, relist }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/push`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          // relist=true → if the item still has a live eBay listing the server
          // ends it first, so this publishes a brand-new listing (new item #)
          // instead of adopting the live one.
          body: JSON.stringify({
            inventory_item_id: itemId,
            ...(relist ? { relist: true } : {}),
          }),
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

// Sets a single eBay item specific (e.g. "Department") on an item and persists
// it where the publish validator will actually read it. assemblePublishContext
// resolves aspects as `listing.item_specifics_override ?? item.ebay_aspects`
// (most-recent eBay listing row wins), so we mirror that precedence: write to
// the listing override when a listing row exists, else to inventory_items.
// Both writes are RLS-scoped to the owner. A blank value drops the key so the
// server re-derives it from the item's structured column.
export function useSetItemAspect() {
  const qc = useQueryClient();
  return useMutation<
    void,
    Error,
    { itemId: string; aspect: string; values: string[] }
  >({
    mutationFn: async ({ itemId, aspect, values }) => {
      const clean = values.map((v) => v.trim()).filter((v) => v.length > 0);
      const merge = (map: Record<string, string[]> | null) => {
        const next = { ...(map ?? {}) };
        if (clean.length > 0) next[aspect] = clean;
        else delete next[aspect];
        return next;
      };

      const { data: listingRow } = await supabase
        .from("listings")
        .select("id, item_specifics_override")
        .eq("inventory_item_id", itemId)
        .eq("platform", "ebay")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (listingRow) {
        const row = listingRow as {
          id: string;
          item_specifics_override: Record<string, string[]> | null;
        };
        // When the override is still empty, the server is reading aspects from
        // item.ebay_aspects — seed from there first so writing Department here
        // doesn't shadow Brand/Size/Color the validator would otherwise see.
        let base = row.item_specifics_override;
        if (!base || Object.keys(base).length === 0) {
          const { data: itemRow } = await supabase
            .from("inventory_items")
            .select("ebay_aspects")
            .eq("id", itemId)
            .maybeSingle();
          base =
            (itemRow as { ebay_aspects: Record<string, string[]> | null } | null)
              ?.ebay_aspects ?? null;
        }
        const next = merge(base);
        const { error } = await supabase
          .from("listings")
          .update({ item_specifics_override: next } as never)
          .eq("id", row.id);
        if (error) throw error;
      } else {
        const { data: itemRow } = await supabase
          .from("inventory_items")
          .select("ebay_aspects")
          .eq("id", itemId)
          .maybeSingle();
        const cur =
          (itemRow as { ebay_aspects: Record<string, string[]> | null } | null)
            ?.ebay_aspects ?? null;
        const next = merge(cur);
        const { error } = await supabase
          .from("inventory_items")
          .update({ ebay_aspects: next } as never)
          .eq("id", itemId);
        if (error) throw error;
      }
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["items_full"] });
      qc.invalidateQueries({ queryKey: ["inventory_item", vars.itemId] });
      qc.invalidateQueries({ queryKey: ["inventory_item_ebay", vars.itemId] });
    },
    onError: (err) => toast.error(err.message),
  });
}

// ── US-1040/1041: Best Offers, send-offer, buyer messages ───────────
// Edge returns camelCase keys (see ios NegotiationTypes). All hit the negotiation
// + messages routes that already exist on the edge; this is the web client for
// them (iOS already has the same surface).

export interface EbayBestOffer {
  bestOfferId: string;
  itemId: string;
  itemTitle?: string | null;
  buyerUsername?: string | null;
  price?: number | null;
  currency?: string;
  quantity?: number | null;
  status?: string | null;
  message?: string | null;
  expiresAt?: string | null;
}

export interface EbayEligibleItem {
  listingId: string;
  title?: string | null;
  // US-1062: enriched from the seller's local listing (or an eBay Browse
  // fallback) so the chooser shows a real thumbnail, title, price & condition
  // instead of a bare numeric listing id.
  price?: number | null;
  currency?: string | null;
  imageUrl?: string | null;
  condition?: string | null;
  source?: "local" | "browse" | "ebay";
}

export interface EbayBuyerMessage {
  messageId: string;
  itemId?: string | null;
  senderUsername?: string | null;
  subject?: string | null;
  body?: string | null;
  creationDate?: string | null;
  answered?: boolean;
}

export function useEbayBestOffers(enabled = true) {
  return useQuery({
    queryKey: ["ebay_best_offers"],
    enabled,
    queryFn: async (): Promise<EbayBestOffer[]> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/negotiation/offers`,
        { headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't load best offers.");
      return (json.offers ?? []) as EbayBestOffer[];
    },
  });
}

export function useEbayRespondOffer() {
  return useMutation<
    { ok: true },
    Error & { status?: number },
    {
      bestOfferId: string;
      itemId: string;
      action: "Accept" | "Decline" | "Counter";
      counterPrice?: number;
      message?: string;
    }
  >({
    mutationFn: async ({ bestOfferId, itemId, action, counterPrice, message }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/negotiation/offers/${encodeURIComponent(
          bestOfferId,
        )}/respond`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({
            item_id: itemId,
            action,
            counter_price: counterPrice,
            message,
          }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err: Error & { status?: number } = new Error(
          json.detail || json.error || "Offer response failed.",
        );
        err.status = res.status;
        throw err;
      }
      return json;
    },
  });
}

export function useEbayEligibleOffers(enabled = true) {
  return useQuery({
    queryKey: ["ebay_eligible_offers"],
    enabled,
    queryFn: async (): Promise<EbayEligibleItem[]> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/negotiation/eligible`,
        { headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't load eligible listings.");
      return (json.items ?? []) as EbayEligibleItem[];
    },
  });
}

export function useEbaySendOffer() {
  return useMutation<
    { ok: true; count: number },
    Error & { status?: number },
    { listingIds: string[]; discountPercentage?: string; message?: string }
  >({
    mutationFn: async ({ listingIds, discountPercentage, message }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/negotiation/send-offer`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({
            listing_ids: listingIds,
            discount_percentage: discountPercentage,
            message,
          }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err: Error & { status?: number } = new Error(
          json.detail || json.error || "Send-offer failed.",
        );
        err.status = res.status;
        throw err;
      }
      return json;
    },
  });
}

export function useEbayMessages(enabled = true) {
  return useQuery({
    queryKey: ["ebay_messages"],
    enabled,
    queryFn: async (): Promise<EbayBuyerMessage[]> => {
      const res = await fetch(`${edgeApiUrl()}/api/flipdesk/ebay/messages`, {
        headers: await ebayHeaders(),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't load messages.");
      return (json.messages ?? []) as EbayBuyerMessage[];
    },
  });
}

export function useEbayReplyMessage() {
  return useMutation<
    { ok: true },
    Error & { status?: number },
    { messageId: string; itemId: string; recipientId: string; body: string }
  >({
    mutationFn: async ({ messageId, itemId, recipientId, body }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/messages/${encodeURIComponent(
          messageId,
        )}/reply`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({
            item_id: itemId,
            recipient_id: recipientId,
            body,
          }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err: Error & { status?: number } = new Error(
          json.detail || json.error || "Reply failed.",
        );
        err.status = res.status;
        throw err;
      }
      return json;
    },
  });
}

// ── Returns (US-1043) ───────────────────────────────────────────────

export interface EbayReturn {
  returnId: string;
  state: string | null;
  orderId: string | null;
  itemId: string | null;
  reason: string | null;
  creationDate: string | null;
}

export function useEbayReturns(enabled = true) {
  return useQuery({
    queryKey: ["ebay_returns"],
    enabled,
    queryFn: async (): Promise<EbayReturn[]> => {
      const res = await fetch(`${edgeApiUrl()}/api/flipdesk/ebay/returns`, {
        headers: await ebayHeaders(),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't load returns.");
      return (json.returns ?? []) as EbayReturn[];
    },
  });
}

export function useEbayDecideReturn() {
  return useMutation<
    { ok: true },
    Error,
    { returnId: string; decision: "approve" | "decline"; comments?: string; orderId?: string }
  >({
    mutationFn: async ({ returnId, decision, comments, orderId }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/returns/${encodeURIComponent(returnId)}/decide`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({ decision, comments, order_id: orderId }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Return decision failed.");
      return json;
    },
  });
}

export function useEbayRefundReturn() {
  return useMutation<
    { ok: true },
    Error,
    { returnId: string; comments?: string; orderId?: string }
  >({
    mutationFn: async ({ returnId, comments, orderId }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/returns/${encodeURIComponent(returnId)}/refund`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({ comments, order_id: orderId }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Refund failed.");
      return json;
    },
  });
}

// ── Cancellations (US-1043) ─────────────────────────────────────────

export interface EbayCancellation {
  cancelId: string;
  state: string | null;
  orderId: string | null;
  reason: string | null;
  requestorType: string | null;
  creationDate: string | null;
}

export function useEbayCancellations(enabled = true) {
  return useQuery({
    queryKey: ["ebay_cancellations"],
    enabled,
    queryFn: async (): Promise<EbayCancellation[]> => {
      const res = await fetch(`${edgeApiUrl()}/api/flipdesk/ebay/cancellations`, {
        headers: await ebayHeaders(),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't load cancellations.");
      return (json.cancellations ?? []) as EbayCancellation[];
    },
  });
}

export function useEbayDecideCancellation() {
  return useMutation<
    { ok: true },
    Error,
    { cancelId: string; action: "approve" | "reject"; orderId?: string }
  >({
    mutationFn: async ({ cancelId, action, orderId }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/cancellations/${encodeURIComponent(cancelId)}/${action}`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({ order_id: orderId }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Cancellation action failed.");
      return json;
    },
  });
}

// ── Payment disputes (US-1049) ──────────────────────────────────────

export interface EbayPaymentDispute {
  paymentDisputeId: string;
  orderId: string | null;
  status: string | null;
  reason: string | null;
  amount: number | null;
  currency: string | null;
  openedDate: string | null;
  respondByDate: string | null;
  buyerUsername: string | null;
}

export function useEbayPaymentDisputes(enabled = true) {
  return useQuery({
    queryKey: ["ebay_payment_disputes"],
    enabled,
    queryFn: async (): Promise<EbayPaymentDispute[]> => {
      const res = await fetch(`${edgeApiUrl()}/api/flipdesk/ebay/payment-disputes`, {
        headers: await ebayHeaders(),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't load payment disputes.");
      return (json.disputes ?? []) as EbayPaymentDispute[];
    },
  });
}

export function useEbayResolveDispute() {
  return useMutation<
    { ok: true },
    Error,
    { disputeId: string; action: "accept" | "contest"; note?: string; orderId?: string }
  >({
    mutationFn: async ({ disputeId, action, note, orderId }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/payment-disputes/${encodeURIComponent(disputeId)}/${action}`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({ note, order_id: orderId }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Dispute action failed.");
      return json;
    },
  });
}

// Uploads a supporting-evidence image and attaches it to the dispute. Sent as
// multipart/form-data, so we drop the JSON Content-Type and let the browser set
// the multipart boundary.
export function useEbayAddDisputeEvidence() {
  return useMutation<
    { ok: true; evidenceId: string | null },
    Error,
    { disputeId: string; file: File; evidenceType?: string }
  >({
    mutationFn: async ({ disputeId, file, evidenceType }) => {
      const headers = await ebayHeaders();
      delete headers["Content-Type"];
      const form = new FormData();
      form.append("file", file);
      if (evidenceType) form.append("evidence_type", evidenceType);
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/payment-disputes/${encodeURIComponent(disputeId)}/evidence`,
        { method: "POST", headers, body: form },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Evidence upload failed.");
      return json;
    },
  });
}

// ── Promoted Listings + Sale events (US-1044 / US-1045) ─────────────

export interface EbayPromotion {
  opt_out: boolean;
  rate_pct: number | null;
  ad_id: string | null;
  status: string | null;
  suggested_rate_pct: number;
}

export function useEbayPromotion(listingId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["ebay_promotion", listingId],
    enabled: enabled && !!listingId,
    queryFn: async (): Promise<EbayPromotion> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/${encodeURIComponent(listingId!)}/promotion`,
        { headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't load promotion.");
      return json as EbayPromotion;
    },
  });
}

export function useEbaySetPromotion() {
  return useMutation<
    { ok: true; rate_pct: number; ad_id: string | null },
    Error,
    { listingId: string; ratePct: number }
  >({
    mutationFn: async ({ listingId, ratePct }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/${encodeURIComponent(listingId)}/promotion`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({ rate_pct: ratePct }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't update promotion.");
      return json;
    },
  });
}

export function useEbayRemovePromotion() {
  return useMutation<{ ok: true }, Error, { listingId: string }>({
    mutationFn: async ({ listingId }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/${encodeURIComponent(listingId)}/promotion`,
        { method: "DELETE", headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't remove promotion.");
      return json;
    },
  });
}

// US-1044: promotions overview — the workspace's promoted listings + roll-up
// performance. Performance is what eBay/our sync reliably expose: live ad
// status, bid %, and the Cost-Per-Sale ad fee (charged only on an attributed
// sale). attributed_sales counts listings that accrued an ad fee.
export interface PromotedListing {
  id: string;
  listing_title: string | null;
  listing_url: string | null;
  listing_price: number | null;
  listing_status: string | null;
  promo_status: string | null;
  promo_rate_pct: number | null;
  promo_ad_fees_cents: number | null;
  promo_synced_at: string | null;
}

export interface PromotedOverview {
  listings: PromotedListing[];
  summary: {
    total: number;
    active: number;
    ad_fees_cents: number;
    attributed_sales: number;
  };
}

export function useEbayPromotedOverview(enabled = true) {
  return useQuery({
    queryKey: ["ebay_promoted_overview"],
    enabled,
    queryFn: async (): Promise<PromotedOverview> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/marketing/promoted/overview`,
        { headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Couldn't load promoted listings.");
      }
      return json as PromotedOverview;
    },
  });
}

// Refresh live ad status + bid for the workspace's promoted listings from eBay.
export function useEbaySyncPromoted() {
  return useMutation<
    { ok: true; scanned: number; updated: number },
    Error,
    void
  >({
    mutationFn: async () => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/marketing/promoted/sync`,
        { method: "POST", headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Couldn't refresh promoted listings.");
      }
      return json;
    },
  });
}

export function useEbayStartSale() {
  return useMutation<
    { ok: true; promotion_id: string | null },
    Error,
    { listingId: string; percentOff: number; endDate?: string }
  >({
    mutationFn: async ({ listingId, percentOff, endDate }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/${encodeURIComponent(listingId)}/sale`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({ percent_off: percentOff, end_date: endDate }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't start the Sale.");
      return json;
    },
  });
}

export function useEbayEndSale() {
  return useMutation<{ ok: true }, Error, { listingId: string }>({
    mutationFn: async ({ listingId }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/${encodeURIComponent(listingId)}/sale`,
        { method: "DELETE", headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't end the Sale.");
      return json;
    },
  });
}

// ── Bulk price / quantity update (US-1046 clean surface) ────────────

export interface BulkPriceQtyUpdate {
  listing_id: string;
  price?: number;
  quantity?: number;
}

export interface BulkPriceQtyResult {
  listing_id: string;
  ok: boolean;
  error?: string;
}

export function useEbayBulkPriceQuantity() {
  return useMutation<
    { ok: true; results: BulkPriceQtyResult[]; succeeded: number; total: number },
    Error,
    { updates: BulkPriceQtyUpdate[] }
  >({
    mutationFn: async ({ updates }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/bulk-price-quantity`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({ updates }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Bulk update failed.");
      return json;
    },
  });
}

// ── Bulk-edit live listings (US-1292) ───────────────────────────────

export interface BulkEditFields {
  price?: number;
  quantity?: number;
  ebay_condition?: string;
  ebay_condition_description?: string;
  shipping_policy_id?: string;
  payment_policy_id?: string;
  return_policy_id?: string;
  platform_category_id?: string;
}

export interface BulkEditResult {
  listing_id: string;
  status: "ok" | "blocked" | "error";
  error?: string;
  locked?: string[];
}

export interface BulkEditResponse {
  ok: true;
  results: BulkEditResult[];
  summary: { ok: number; blocked: number; error: number };
  total: number;
}

// Multi-select bulk edit of shared listing fields applied across connected
// marketplaces via adapters. Field-ownership locks on marketplace-originated
// listings come back as per-item status="blocked"; failures as status="error".
export function useBulkEditListings() {
  const qc = useQueryClient();
  return useMutation<
    BulkEditResponse,
    Error,
    { listingIds: string[]; edit: BulkEditFields }
  >({
    mutationFn: async ({ listingIds, edit }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/bulk-edit`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({ listing_ids: listingIds, edit }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Bulk edit failed.");
      return json as BulkEditResponse;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["items_full"] });
    },
  });
}

// ── Leave buyer feedback (US-1047) ──────────────────────────────────
// The edge resolves the legacy ItemID/TransactionID from the order id, so the
// UI only needs the sale's platform_order_id.
export function useEbayLeaveFeedback() {
  return useMutation<
    { ok: true; count: number; already_left: boolean },
    Error,
    { orderId: string; comment?: string }
  >({
    mutationFn: async ({ orderId, comment }) => {
      const res = await fetch(`${edgeApiUrl()}/api/flipdesk/ebay/feedback`, {
        method: "POST",
        headers: await ebayHeaders(),
        body: JSON.stringify({ order_id: orderId, comment }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't leave feedback.");
      return json;
    },
  });
}
