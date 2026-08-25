import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { supabase } from "@/lib/supabase";
import { getFreshAccessToken } from "@/lib/auth-token";
import { edgeApiUrl } from "@/lib/edge-api";
import { useAuthStore } from "@/stores/auth-store";
// US-2170: the score shape the /listings/validate response already carries. The
// component file owns it because that is where it is rendered; the edge's
// lib/listing-quality-score.ts is the authority for how it is COMPUTED.
import type { ListingQualityScore } from "@/components/flipdesk/quality-score-chip";
import type { ValueBasis } from "@/components/value/value-basis-note";

// US-1933: tenant partition for eBay query keys — the active workspace owner
// (or the user for a solo account). Every eBay query keys on this so a workspace
// switch or a new sign-in on a shared browser can never serve the prior tenant's
// cached eBay data, independent of the fragile queryClient.clear() on switch.
// Mirrors the useEbayPayouts precedent (US-1617 / US-1624).
function useEbayTenantKey(): string | undefined {
  return useAuthStore((s) => s.activeWorkspaceOwnerId ?? s.user?.id);
}

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
  const tenantKey = useEbayTenantKey();
  return useQuery({
    queryKey: ["ebay_policies", tenantKey],
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

// Category-aware eBay condition options for the composer dropdown. Many apparel
// leaves (Dresses, Women's Sweaters, …) accept only {1000,1500,1750,2990,3000,
// 3010} and reject the legacy USED_* tiers, so a fixed list offers conditions
// eBay rejects at publish. This returns the SELECTABLE conditions for the leaf
// (best→worst, with eBay's category-correct labels). `restricted:false` or a null
// result → the composer falls back to its full static option list.
export interface EbayCategoryConditionOption {
  value: string; // the emittable eBay condition enum
  id: string; // eBay numeric conditionId
  label: string; // category-correct human label
}
export interface EbayCategoryConditions {
  categoryId: string;
  restricted: boolean;
  conditionIds: string[];
  options: EbayCategoryConditionOption[];
  allowedLabels: string[];
}

export function useEbayCategoryConditions(
  categoryId: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ["ebay_category_conditions", categoryId],
    enabled: enabled && !!categoryId,
    staleTime: 60 * 60_000, // condition policies are effectively static
    retry: false,
    queryFn: async (): Promise<EbayCategoryConditions | null> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/category/${
          encodeURIComponent(categoryId!)
        }/conditions`,
        { headers: await ebayHeaders() },
      );
      // Advisory only — on any non-200 the composer falls back to the static
      // list rather than surfacing an error or blocking condition entry.
      if (!res.ok) return null;
      return (await res.json()) as EbayCategoryConditions;
    },
  });
}

// US-1473: account-level eBay health (Seller Standards + customer-service
// defect metrics). `access:false` means Sell Analytics isn't granted — the card
// shows a reconnect affordance rather than an error.
export interface EbaySellerStandards {
  cycle: "CURRENT" | "PROJECTED";
  program: string;
  standardsLevel: string | null;
  evaluationDate: string | null;
  evaluationReason: string | null;
}
export interface EbayCustomerServiceMetric {
  metricType: "ITEM_NOT_AS_DESCRIBED" | "ITEM_NOT_RECEIVED";
  cycle: "CURRENT" | "PROJECTED";
  rate: number | null;
  count: number | null;
}
export interface EbayAccountHealth {
  access: boolean;
  standards?: { current: EbaySellerStandards; projected: EbaySellerStandards };
  customer_service?: EbayCustomerServiceMetric[];
  projected_below_standard?: boolean;
}

export function useEbayAccountHealth(enabled = true) {
  const tenantKey = useEbayTenantKey();
  return useQuery({
    queryKey: ["ebay_account_health", tenantKey],
    enabled,
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<EbayAccountHealth> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/analytics/account-health`,
        { headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Could not load eBay account health.");
      }
      return json as EbayAccountHealth;
    },
  });
}

// US-1422: Listing Health — the Sell Compliance violation summary. `access:false`
// means the sell.inventory grant is stale (reconnect needed).
export interface EbayListingViolationSummary {
  complianceType: string;
  listingCount: number;
}
export interface EbayListingHealth {
  access: boolean;
  summaries?: EbayListingViolationSummary[];
  total?: number;
}

export function useEbayListingHealth(enabled = true) {
  const tenantKey = useEbayTenantKey();
  return useQuery({
    queryKey: ["ebay_listing_health", tenantKey],
    enabled,
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<EbayListingHealth> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/compliance/summary`,
        { headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Could not load eBay listing health.");
      }
      return json as EbayListingHealth;
    },
  });
}

// US-1422 chunk 2: re-check listings against the Sell Compliance API and persist
// per-listing violation counts (drives the pipeline Listing-Health badge).
export function useSyncListingHealth() {
  const qc = useQueryClient();
  return useMutation({
    // US-2329: `cleared` counts listings whose violations are gone. A non-2xx
    // now means some listings could not be updated at all, and the message says
    // health may be out of date rather than reporting a plausible `flagged`.
    mutationFn: async (): Promise<{
      access: boolean;
      flagged?: number;
      cleared?: number;
    }> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/compliance/sync`,
        { method: "POST", headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Could not re-check listing health.");
      }
      return json as { access: boolean; flagged?: number; cleared?: number };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ebay_listing_health"] });
      qc.invalidateQueries({ queryKey: ["listing_compliance_flags"] });
    },
  });
}

// US-1422 chunk 2: the persisted per-listing compliance flags (RLS-scoped to the
// user), keyed by inventory_item_id, for the pipeline Listing-Health indicator.
export interface ListingComplianceFlag {
  id: string;
  inventory_item_id: string;
  compliance_violation_count: number;
  compliance_types: string[] | null;
  // US-2158: eBay returns violations keyed by ITS listing id, so the detail view
  // needs this to match a violation back to the local row the fix acts on. The
  // title is what makes the row readable — a bare eBay id names nothing.
  platform_listing_id: string | null;
  listing_url: string | null;
  inventory_items: { title: string | null } | null;
}
export function useListingComplianceFlags() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["listing_compliance_flags", user?.id],
    enabled: !!user,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ListingComplianceFlag[]> => {
      const { data, error } = await supabase
        .from("listings")
        .select(
          "id, inventory_item_id, compliance_violation_count, compliance_types, " +
            "platform_listing_id, listing_url, inventory_items(title)",
        )
        .gt("compliance_violation_count", 0);
      if (error) throw error;
      return (data ?? []) as unknown as ListingComplianceFlag[];
    },
  });
}

// US-2158: the per-listing violation DETAIL behind the summary counts. Until
// this, GET /compliance/violations had no caller at all — a seller saw "3
// listings with compliance issues" and had no way to learn which three or why.
//
// Fetched per compliance type and only when a summary row is expanded: each
// call is a live eBay round-trip, so loading every type up front would spend
// several on data nobody asked to see.
export interface EbayAspectRecommendation {
  name: string;
  values: string[];
}
export interface EbayListingViolation {
  listingId: string | null;
  sku: string | null;
  offerId: string | null;
  complianceType: string;
  reasons: string[];
  aspectRecommendations: EbayAspectRecommendation[];
}

export function useEbayListingViolations(
  complianceType: string,
  enabled: boolean,
) {
  const tenantKey = useEbayTenantKey();
  return useQuery({
    queryKey: ["ebay_listing_violations", tenantKey, complianceType],
    enabled,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<{
      access: boolean;
      violations?: EbayListingViolation[];
    }> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/compliance/violations?type=${
          encodeURIComponent(complianceType)
        }`,
        { headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Could not load eBay listing violations.");
      }
      return json as { access: boolean; violations?: EbayListingViolation[] };
    },
  });
}

// US-1422 chunk 3 (AC3): merge eBay's corrective aspect recommendations into a
// listing's item_specifics_override (add-only, server-side). The caller then
// pushes them live via the existing revise mutation (resync_ebay_fields).
export function useApplyComplianceRecommendations() {
  return useMutation<{ applied: number; aspects?: string[] }, Error, string>({
    mutationFn: async (listingId: string) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/compliance/apply-recommendations/${listingId}`,
        { method: "POST", headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Could not apply eBay recommendations.");
      }
      return json as { applied: number; aspects?: string[] };
    },
  });
}

// US-1446: recent eBay payouts (bank deposits). `access:false` = the
// sell.finances grant is stale (reconnect needed).
export interface EbayPayout {
  payoutId: string;
  payoutStatus: string;
  payoutDate: string | null;
  amount: { value: string; currency: string } | null;
  transactionCount: number | null;
}
export interface EbayPayoutsResponse {
  access: boolean;
  payouts?: EbayPayout[];
}
export function useEbayPayouts(enabled = true) {
  // Key on the active workspace owner (falling back to the user) so a
  // workspace-switch or a new sign-in on a shared browser never serves the
  // prior tenant's payouts from cache (US-1617 / US-1624).
  const activeWorkspaceOwnerId = useAuthStore((s) => s.activeWorkspaceOwnerId);
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["ebay_payouts", activeWorkspaceOwnerId ?? user?.id],
    enabled,
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<EbayPayoutsResponse> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/finances/payouts`,
        { headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not load eBay payouts.");
      return json as EbayPayoutsResponse;
    },
  });
}

// US-1446 chunk 2: a payout's constituent sales + net (payout -> transactions
// -> net). Fetched on demand when a payout row is expanded.
export interface EbayPayoutSale {
  id: string;
  inventory_item_id: string | null;
  sale_price: number | null;
  platform_fees: number | null;
  payout_amount: number | null;
  sold_at: string | null;
}
export interface EbayPayoutSalesResponse {
  sales: EbayPayoutSale[];
  net: number;
}
export function useEbayPayoutSales(payoutId: string | null) {
  return useQuery({
    queryKey: ["ebay_payout_sales", payoutId],
    enabled: !!payoutId,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<EbayPayoutSalesResponse> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/finances/payouts/${encodeURIComponent(payoutId!)}/sales`,
        { headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Could not load payout details.");
      }
      return json as EbayPayoutSalesResponse;
    },
  });
}

// US-1475: eBay Catalog (EPID) product match for an item — candidates + the top
// product's authoritative aspects.
export interface CatalogMatchCandidate {
  epid: string;
  title: string;
  brand: string | null;
  gtins: string[];
  imageUrl: string | null;
}
export interface CatalogMatchResponse {
  candidates: CatalogMatchCandidate[];
  top: { epid: string; title: string; brand: string | null; aspects: Record<string, string[]> } | null;
}
export function useCatalogMatch(itemId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["ebay_catalog_match", itemId],
    enabled: enabled && !!itemId,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<CatalogMatchResponse> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/catalog/match?item_id=${encodeURIComponent(itemId!)}`,
        { headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not search the eBay catalog.");
      return json as CatalogMatchResponse;
    },
  });
}

// US-1475: adopt a catalog product (persist EPID + merge catalog aspects).
export function useAdoptCatalogProduct() {
  const qc = useQueryClient();
  return useMutation<{ epid: string; applied: number }, Error, { itemId: string; epid: string }>({
    mutationFn: async ({ itemId, epid }) => {
      const res = await fetch(`${edgeApiUrl()}/api/flipdesk/ebay/catalog/adopt`, {
        method: "POST",
        headers: await ebayHeaders(),
        body: JSON.stringify({ item_id: itemId, epid }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not adopt the catalog product.");
      return json as { epid: string; applied: number };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["items_full"] });
      qc.invalidateQueries({ queryKey: ["ebay_catalog_match"] });
    },
  });
}

// US-1448: the seller's eBay Promotions Manager item promotions (order/volume
// discounts, coupons, sale events). `access:false` = stale grant.
export interface EbayItemPromotion {
  promotionId: string;
  name: string | null;
  promotionType: string | null;
  promotionStatus: string | null;
  startDate: string | null;
  endDate: string | null;
}
export interface EbayPromotionsResponse {
  access: boolean;
  promotions?: EbayItemPromotion[];
}
export function useEbayPromotions(enabled = true) {
  const tenantKey = useEbayTenantKey();
  return useQuery({
    queryKey: ["ebay_promotions", tenantKey],
    enabled,
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<EbayPromotionsResponse> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/promotions`,
        { headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not load eBay promotions.");
      return json as EbayPromotionsResponse;
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
    onError: (err) => toastError(err),
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
    onError: (err) => toastError(err),
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
    onError: (err) => toastError(err),
  });
}

// Legacy single-header helper. Most call sites use it via
// `Authorization: await authHeader()`; new sites should prefer the shared
// edgeAuthHeaders() from @/lib/edge-fetch, which also attaches the
// X-Workspace-Owner header.
async function authHeader(): Promise<string> {
  // getFreshAccessToken() refreshes a near-expiry token before we send it, so an
  // eBay edge call made just past the 1h token boundary doesn't 401 into a
  // spurious "session expired" (these fetch sites don't have edgeFetch's
  // 401-retry backstop, so the proactive refresh is what keeps them alive).
  const token = await getFreshAccessToken();
  if (!token) {
    throw new Error("You must be signed in.");
  }
  return `Bearer ${token}`;
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
    onError: (err) => toastError(err),
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
    onError: (err) => toastError(err),
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
    onError: (err) => toastError(err),
  });
}

// ── Comps (Browse API) ──────────────────────────────────────────────

// US-1060: how broad the returned comp set is after the fallback ladder.
export type CompBreadth =
  // US-2245: comps that carry the item's own style code — narrower than "exact".
  | "style_code"
  | "exact"
  | "broadened"
  | "brand_category"
  | "category";

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
  /**
   * US-2245: the style/product code off the tag. When present the server tries a
   * style-code rung ABOVE the exact query — one comp carrying the same code is a
   * better price basis than a page of same-brand listings.
   */
  styleCode?: string;
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
      args.styleCode ?? null,
    ],
    enabled: !!args.categoryId,
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<EbayCompsResponse> => {
      const params = new URLSearchParams({ category_id: args.categoryId! });
      if (args.q) params.set("q", args.q);
      if (args.brand) params.set("brand", args.brand);
      if (args.size) params.set("size", args.size);
      if (args.conditionId) params.set("condition_id", args.conditionId);
      if (args.styleCode) params.set("style_code", args.styleCode);
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
  /** US-2850: what this number is, worded by the edge. */
  valueBasis?: ValueBasis;
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
    onError: (err) => toastError(err),
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
  // US-1490: re-assert the structured eBay-owned fields the seller edited
  // post-publish — category, condition, and item specifics — which the server
  // sources from the (already-saved) listing/inventory rows. Lets a
  // specifics/category/condition-only edit reach a live listing.
  resync_ebay_fields?: boolean;
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

// US-1895: how many of eBay's RECOMMENDED aspects (ranked by 30-day buyer
// search volume) the listing fills.
export interface AspectCoverage {
  filled: number;
  total: number;
  missing: string[];
}

export interface ValidatePublishResponse {
  ok: boolean;
  blockers: string[];
  warnings?: string[];
  // US-1896: hero-thumbnail reorder nudge ("your search thumbnail is a tag shot
  // — drag a full front view first"), or null when the first photo is fine.
  photoNudge?: string | null;
  recommendedCoverage?: AspectCoverage;
  summary?: PublishSummary;
  // US-2170: the full Listing Quality Score — score, per-component breakdown and
  // ranked fixes. The edge has returned this since US-1897 (scoreAndPersist on
  // the validate response); it was simply never declared here, so every caller
  // dropped it on the floor. Only `score` and `blocked` are persisted to
  // listings.quality_score, so this response is the ONLY source of the
  // breakdown — the part that tells a seller which fix is worth the most.
  qualityScore?: ListingQualityScore;
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

// US-1895: recommended-aspect coverage for a single item, from the same
// preflight/validate source (recommendedAspectCoverage on the edge). Read-only
// query for the composer meter; refetches when its ["recommended-coverage", id]
// key is invalidated after an aspect save.
export function useRecommendedCoverage(itemId: string | null | undefined) {
  return useQuery({
    queryKey: ["recommended-coverage", itemId],
    enabled: !!itemId,
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<AspectCoverage | null> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/validate`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({ inventory_item_id: itemId }),
        },
      );
      if (!res.ok) return null;
      const json = (await res.json().catch(() => ({}))) as ValidatePublishResponse;
      return json.recommendedCoverage ?? null;
    },
  });
}

/**
 * US-2170: the full Listing Quality Score for ONE item, including the
 * per-component breakdown and the ranked list of highest-value fixes.
 *
 * Mirrors useRecommendedCoverage — same endpoint, same read-only shape, a
 * different field off the response. The listings TABLE reads the persisted
 * score column instead (cheap, page-scoped, no preflight per row); this hook is
 * for the item page, where one seller is looking at one listing and the
 * breakdown is the whole point.
 *
 * Returns null rather than throwing when preflight can't run — an item with no
 * eBay category yet has no score, and that is a normal state, not an error.
 */
/**
 * US-2679: the query key, exported so it can be ASSERTED rather than described.
 *
 * The property that matters is what is NOT in it. Scoring runs the full publish
 * preflight, which resolves business policies, probes the category tree and
 * talks to eBay — putting the title (or any other edited field) in this key
 * would fire that on every keystroke. The key is the item id and nothing else,
 * so the score refreshes when the seller changes ITEM, never while they type.
 */
export function listingQualityQueryKey(itemId: string | null | undefined) {
  return ["listing-quality", itemId] as const;
}

/**
 * The rest of the same guarantee. `refetchOnWindowFocus` is off explicitly
 * rather than left at TanStack's default of true: alt-tabbing away and back is
 * not a change to the listing, and it would cost a preflight every time.
 */
export const LISTING_QUALITY_QUERY_OPTIONS = {
  staleTime: 60_000,
  retry: 1,
  refetchOnWindowFocus: false,
} as const;

export function useListingQuality(itemId: string | null | undefined) {
  return useQuery({
    queryKey: listingQualityQueryKey(itemId),
    enabled: !!itemId,
    ...LISTING_QUALITY_QUERY_OPTIONS,
    queryFn: async (): Promise<ListingQualityScore | null> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/validate`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({ inventory_item_id: itemId }),
        },
      );
      if (!res.ok) return null;
      const json = (await res.json().catch(() => ({}))) as ValidatePublishResponse;
      return json.qualityScore ?? null;
    },
  });
}

// US-1895: bulk recommended-aspect coverage for a set of items (the AutoLister
// drafts list), so low-coverage drafts are sortable/fixable in bulk. One call
// per visible page; the edge de-dupes category-spec fetches.
export function useBulkAspectCoverage(itemIds: string[]) {
  const key = [...itemIds].sort().join(",");
  return useQuery({
    queryKey: ["aspect-coverage-bulk", key],
    enabled: itemIds.length > 0,
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<Record<string, AspectCoverage>> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/aspect-coverage`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({ itemIds }),
        },
      );
      if (!res.ok) return {};
      const json = (await res.json().catch(() => ({}))) as {
        coverage?: Record<string, AspectCoverage>;
      };
      return json.coverage ?? {};
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
      // Publishing is what flips the listings row to active and gives it a
      // platform_offer_id, and that row is exactly what the composer reads to
      // decide between "Save & Publish to eBay" and "Save & resubmit to eBay".
      // Without this the composer kept offering to publish an already-live
      // listing until the seller reloaded the page. Invalidated by PREFIX (the
      // push response carries eBay's item id, not our listings row id).
      qc.invalidateQueries({ queryKey: ["listing"] });
    },
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
    onError: (err) => toastError(err),
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
  // US-2236 AC2: the item's acquisition cost (dollars) for margin context on the
  // counter input. null when the listing/cost isn't known.
  itemCost?: number | null;
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
  const tenantKey = useEbayTenantKey();
  return useQuery({
    queryKey: ["ebay_best_offers", tenantKey],
    enabled,
    // US-2236 AC4: Best Offers carry short (often 48h) deadlines, so a stale
    // inbox can cost a sale. Refresh in the background every 90s and on window
    // focus — but only while the tab is visible (refetchIntervalInBackground
    // stays false) so a parked tab doesn't burn the eBay call budget.
    refetchInterval: 90_000,
    refetchOnWindowFocus: true,
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

// US-1967: whether this connection can send offers to interested buyers at all.
// The sell.negotiation scope isn't licensed on the production keyset, so the
// send-offer endpoints 501 there — surfaces gate on this instead of rendering a
// button that always fails. Cheap (no eBay round trip); a failed probe degrades
// to "available" so a transient blip can't hide a working feature.
export interface EbayNegotiationCapability {
  sendOfferAvailable: boolean;
  code: "feature_unavailable" | "reconnect_required" | null;
  detail: string | null;
}

export function useEbayNegotiationCapability(enabled = true) {
  const tenantKey = useEbayTenantKey();
  return useQuery({
    queryKey: ["ebay_negotiation_capability", tenantKey],
    enabled,
    // Licensing state doesn't change minute to minute.
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<EbayNegotiationCapability> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/negotiation/capabilities`,
        { headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return { sendOfferAvailable: true, code: null, detail: null };
      return {
        sendOfferAvailable: json.send_offer_available !== false,
        code: json.code ?? null,
        detail: json.detail ?? null,
      };
    },
  });
}

export function useEbayEligibleOffers(enabled = true) {
  const tenantKey = useEbayTenantKey();
  return useQuery({
    queryKey: ["ebay_eligible_offers", tenantKey],
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

// US-2494: offers and buyer messages are keyed by eBay's item id, but the AI
// negotiation route reads the LOCAL inventory_items row (title, target price,
// cost) and so wants that row's UUID. The listings table is the only place the
// two ids meet. RLS scopes `listings` to the owner, so null means the listing
// was never synced into FlipDesk (or isn't ours), never someone else's item.
export async function resolveInventoryItemIdForEbayItem(
  ebayItemId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("listings")
    .select("inventory_item_id")
    .eq("platform", "ebay")
    .eq("platform_listing_id", ebayItemId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = (data ?? null) as { inventory_item_id: string | null } | null;
  return row?.inventory_item_id ?? null;
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

/**
 * US-2706: what the grade-evidence pack would say for one return.
 *
 * A read. It calls no eBay endpoint and writes nothing — the send is a separate
 * mutation behind a separate click, because the seller has to be able to look
 * at the verdict before it goes anywhere.
 */
export interface ReturnEvidencePlan {
  available: boolean;
  verdict?: "contradicted" | "supported" | "not_covered";
  reason?: string;
  mayAutoAssemble?: boolean;
  citations?: Array<{
    defectType: string;
    location: string;
    severity: string;
    reportText: string;
    disclosedIn: "description" | "aspects";
    disclosureQuote: string;
  }>;
  hasPublicationSnapshot?: boolean;
  certificateNumber?: string | null;
  gradedAt?: string | null;
  defectCount?: number;
  includesConditionSheet?: boolean;
}

export function useEbayReturnEvidencePlan() {
  return useMutation<
    ReturnEvidencePlan,
    Error,
    { orderId: string; complaint: string }
  >({
    mutationFn: async ({ orderId, complaint }) => {
      // Not scoped to a return or a dispute: the plan is built from the ORDER's
      // graded item and the listing text we published, and both case types ask
      // the same question of it (US-2707).
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/evidence/preview`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({ order_id: orderId, complaint }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't read the evidence plan.");
      return json as ReturnEvidencePlan;
    },
  });
}

/**
 * US-2706 / US-2707: send the pack, on a return or on a payment dispute.
 *
 * Refuses with 409 when the grade report agrees with the buyer — that refusal
 * carries the plain-language reason and is surfaced rather than swallowed,
 * because it is the one answer the seller most needs.
 *
 * The two case types are different eBay endpoints with different upload
 * mechanics, so the PATH differs; everything else about the call does not, and
 * a second hook would be a second place for the refusal to go missing.
 */
export function useEbaySendReturnEvidence() {
  return useMutation<
    { ok: true; attached: number; removed?: number },
    Error,
    {
      caseId: string;
      kind: "return" | "dispute";
      orderId: string;
      complaint: string;
      files: File[];
    }
  >({
    mutationFn: async ({ caseId, kind, orderId, complaint, files }) => {
      const form = new FormData();
      for (const file of files) form.append("file", file);
      form.append("order_id", orderId);
      form.append("complaint", complaint);
      const headers = await ebayHeaders();
      // FormData sets its own multipart boundary; a JSON content-type here
      // makes the route reject the request before it reads a file.
      delete (headers as Record<string, string>)["Content-Type"];
      const path = kind === "return"
        ? `returns/${encodeURIComponent(caseId)}/evidence`
        : `payment-disputes/${encodeURIComponent(caseId)}/evidence`;
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/${path}`,
        { method: "POST", headers, body: form },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          json.reason || json.error || "eBay rejected the evidence.",
        );
      }
      return json;
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
  /**
   * US-1979 (AC1): where suggested_rate_pct came from. "ebay_trending" is eBay's
   * own data — the average ad rate of listings that recently SOLD in this
   * category. "category_heuristic" is our fallback map, used when eBay has no
   * suggestion for the listing (it is CPS-only and US/GB/DE/AU-only) or the
   * listing isn't live yet. The UI must not present our guess as eBay's number.
   */
  suggested_rate_basis?: "ebay_trending" | "category_heuristic";
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
  /**
   * US-2172: the values the applied fields held BEFORE the edit, keyed by
   * listings column. Present only on "ok". This is what an undo sends back —
   * a null entry means the column WAS null, which is a real value to restore.
   */
  previous?: Record<string, unknown>;
}

/** One row of the per-listing body shape (US-2172), which undo needs. */
export interface BulkEditItem {
  listing_id: string;
  edit: BulkEditFields;
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
    // US-2172: either ONE edit across many listings, or a per-listing edit.
    // Undo is always the second shape: each row goes back to its own former
    // value, which no shared patch can express.
    { listingIds: string[]; edit: BulkEditFields } | { items: BulkEditItem[] }
  >({
    mutationFn: async (input) => {
      const body = "items" in input
        ? { items: input.items }
        : { listing_ids: input.listingIds, edit: input.edit };
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/bulk-edit`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify(body),
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

// ── US-1979 (AC2): item_promotion write hooks ─────────────────────────────
//
// NAMING: this file already has useEbayPromotion(listingId) for PROMOTED LISTINGS
// (the per-listing ad rate) — a different eBay product entirely. These are
// Promotions Manager item_promotions (order/volume/coupon discounts), hence the
// ItemPromotion names and the SEPARATE ebay_item_promotion query key: sharing the
// key would make ending a coupon blow away the ad-rate cache.
//
// updateItemPromotion/deleteItemPromotion had no routes until now, and
// createItemPromotion only ran as an automation side-effect — so a seller could
// never deliberately create, edit or end an order/volume/coupon promo. These back
// the promotions card's create/edit/delete.

export type ItemPromotionType = "ORDER_DISCOUNT" | "VOLUME_DISCOUNT" | "CODED_COUPON";

export interface ItemPromotionDraft {
  type: ItemPromotionType;
  name: string;
  listing_ids: string[];
  percent_off: number;
  min_spend?: { value: string; currency: string };
  buy_quantity?: number;
  promotion_image_url?: string;
  coupon_code?: string;
  start_date?: string;
  end_date?: string;
}

/** The FULL promotion (GET /promotions/:id) — what an edit must prefill from.
 *  The LIST shape omits listings/percent/minSpend/coupon, and the PUT replaces the
 *  whole promotion, so editing off the list would wipe them. */
export interface EbayItemPromotionDetail extends EbayItemPromotion {
  listingIds: string[];
  percentOff: number | null;
  minSpend: { value: string; currency: string } | null;
  buyQuantity: number | null;
  couponCode: string | null;
  promotionImageUrl: string | null;
  priority: string | null;
}

export function useEbayItemPromotion(promotionId: string | null) {
  const tenantKey = useEbayTenantKey();
  return useQuery({
    queryKey: ["ebay_item_promotion", tenantKey, promotionId],
    enabled: !!promotionId,
    // No staleTime: an edit form must never prefill from a stale copy, because
    // whatever it prefills is what the PUT writes back.
    staleTime: 0,
    queryFn: async (): Promise<EbayItemPromotionDetail> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/promotions/${encodeURIComponent(promotionId!)}`,
        { headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not load that promotion.");
      return json.promotion as EbayItemPromotionDetail;
    },
  });
}

/** Active eBay listings a promotion can target, with the item title + cover photo.
 *  No existing hook exposes these — listings.tsx queries supabase inline. */
export interface PromotableListing {
  listingId: string;
  itemId: string;
  title: string;
  coverPhotoUrl: string | null;
}

export function useEbayPromotableListings(enabled = true) {
  const { user } = useAuthStore();
  return useQuery({
    queryKey: ["ebay_promotable_listings", user?.id],
    enabled: enabled && !!user,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<PromotableListing[]> => {
      // Only LIVE eBay listings can be promoted, and only those eBay knows about
      // (platform_listing_id) — a draft has no id for eBay to target.
      const { data, error } = await supabase
        .from("listings")
        .select("inventory_item_id, platform_listing_id, inventory_items(title)")
        .eq("platform", "ebay")
        .eq("listing_status", "active")
        .not("platform_listing_id", "is", null);
      if (error) throw error;
      const rows = (data ?? []) as unknown as Array<{
        inventory_item_id: string;
        platform_listing_id: string;
        inventory_items: { title: string | null } | null;
      }>;
      if (rows.length === 0) return [];

      // Cover photos in one round trip rather than N.
      const itemIds = rows.map((r) => r.inventory_item_id);
      const { data: photos } = await supabase
        .from("item_photos")
        .select("inventory_item_id, photo_url, sort_order")
        .in("inventory_item_id", itemIds)
        .order("sort_order", { ascending: true });
      const cover = new Map<string, string>();
      for (const p of (photos ?? []) as Array<{
        inventory_item_id: string;
        photo_url: string | null;
      }>) {
        if (p.photo_url && !cover.has(p.inventory_item_id)) {
          cover.set(p.inventory_item_id, p.photo_url);
        }
      }
      return rows.map((r) => ({
        listingId: r.platform_listing_id,
        itemId: r.inventory_item_id,
        title: r.inventory_items?.title ?? "Untitled",
        coverPhotoUrl: cover.get(r.inventory_item_id) ?? null,
      }));
    },
  });
}

function invalidatePromotions(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["ebay_promotions"] });
  void qc.invalidateQueries({ queryKey: ["ebay_item_promotion"] });
}

export function useCreateItemPromotion() {
  const qc = useQueryClient();
  return useMutation<{ promotion_id: string | null }, Error, ItemPromotionDraft>({
    mutationFn: async (draft) => {
      const res = await fetch(`${edgeApiUrl()}/api/flipdesk/ebay/promotions`, {
        method: "POST",
        headers: await ebayHeaders(),
        body: JSON.stringify(draft),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not create the promotion.");
      return json;
    },
    onSuccess: () => {
      toast.success("Promotion created on eBay.");
      invalidatePromotions(qc);
    },
    onError: (e) => toastError(e),
  });
}

export function useUpdateItemPromotion() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { promotionId: string; draft: ItemPromotionDraft }>({
    mutationFn: async ({ promotionId, draft }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/promotions/${encodeURIComponent(promotionId)}`,
        { method: "PUT", headers: await ebayHeaders(), body: JSON.stringify(draft) },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not update the promotion.");
      return json;
    },
    onSuccess: () => {
      toast.success("Promotion updated.");
      invalidatePromotions(qc);
    },
    onError: (e) => toastError(e),
  });
}

export function useDeleteItemPromotion() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: async (promotionId) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/promotions/${encodeURIComponent(promotionId)}`,
        { method: "DELETE", headers: await ebayHeaders() },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not end the promotion.");
      return json;
    },
    onSuccess: () => {
      toast.success("Promotion ended on eBay.");
      invalidatePromotions(qc);
    },
    onError: (e) => toastError(e),
  });
}

// US-1968: bring existing eBay (Trading-created) listings under management.
//
// An imported listing is a read-only mirror — revise/reprice/withdraw/relist all
// refuse it — so this is the seller's way out of that wall. The endpoint is bulk
// and answers PER LISTING, so the result must be reported per listing: eBay
// declines individual listings for real product reasons (multi-variation
// listings are the common one) and a seller can only act on that if they're told
// which listing and why. Never collapse the response to a single "done".
export interface MigrateListingResult {
  listing_id: string;
  status: "migrated" | "already_managed" | "skipped" | "failed";
  sku?: string | null;
  offer_id?: string | null;
  reason?: string;
}

export interface MigrateListingsResponse {
  ok: true;
  summary: {
    migrated: number;
    already_managed: number;
    skipped: number;
    failed: number;
  };
  results: MigrateListingResult[];
}

export function useMigrateEbayListings() {
  const qc = useQueryClient();
  return useMutation<MigrateListingsResponse, Error, string[]>({
    mutationFn: async (listingIds) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/listings/migrate`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({ listing_ids: listingIds }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Could not migrate the listing(s).");
      }
      return json as MigrateListingsResponse;
    },
    onSuccess: (data) => {
      const { migrated, already_managed, failed, skipped } = data.summary;
      if (migrated > 0) {
        toast.success(
          migrated === 1
            ? "Listing is now managed in FlipDesk — you can revise, reprice and promote it."
            : `${migrated} listings are now managed in FlipDesk.`,
        );
      } else if (already_managed > 0 && failed === 0 && skipped === 0) {
        toast.info("Already managed in FlipDesk.");
      }
      // Surface eBay's own reason per listing rather than a generic failure —
      // "multi-variation listings can't be migrated" is actionable; "failed"
      // is not. Cap the toasts so a large batch can't bury the screen; the
      // remainder stays in `results` for the caller to render.
      const problems = data.results.filter(
        (r) => r.status === "failed" || r.status === "skipped",
      );
      for (const p of problems.slice(0, 3)) {
        toast.error(p.reason || "eBay declined the migration.");
      }
      if (problems.length > 3) {
        toast.error(`…and ${problems.length - 3} more could not be migrated.`);
      }
      // The origin flip changes what the whole UI allows on these rows, so the
      // reads that gate those affordances must be refetched. item_ebay_sync is
      // the load-bearing one: it backs the item canvas's lockedByEbay banner, so
      // without it a seller sees "this listing is locked" and the migrate button
      // still sitting there immediately after a successful migration.
      void qc.invalidateQueries({ queryKey: ["item_ebay_sync"] });
      void qc.invalidateQueries({ queryKey: ["item_listing_platforms"] });
      void qc.invalidateQueries({ queryKey: ["inventory"] });
      void qc.invalidateQueries({ queryKey: ["item"] });
    },
    onError: (e) => toastError(e),
  });
}

// ── US-2157: eBay seller programs (opt-in/opt-out) ───────────────────
//
// The routes (GET/POST/DELETE /programs) shipped with US-1979 but never got a
// frontend, so the only way a seller could change these was eBay Seller Hub.
//
// The one that matters is OUT_OF_STOCK_CONTROL. eBay ENDS a multi-quantity
// listing the moment quantity hits 0; for evergreen clothing (the same tee in
// eight sizes, restocked continuously) that loses the item id, the watchers,
// the search standing and the sales history. Opted in, the listing stays live
// at qty 0 and keeps all of it.
//
// It stays an explicit opt-in and this UI never decides for the seller: for a
// single-quantity thrift item — most of FlipDesk — eBay's default is CORRECT,
// and a blanket opt-in would leave sold-out one-offs sitting live. The copy
// below has to carry that trade-off, not just the upside.

/** Slug in the route path ←→ what the seller is actually turning on. */
export const EBAY_PROGRAMS = [
  {
    slug: "out-of-stock",
    apiName: "OUT_OF_STOCK_CONTROL",
    label: "Out-of-stock control",
    description:
      "Keep a listing live at zero quantity instead of letting eBay end it — so restocked items keep their item id, watchers and sales history. Leave off for one-of-a-kind items, or they stay listed after they sell.",
  },
  {
    slug: "selling-policy-management",
    apiName: "SELLING_POLICY_MANAGEMENT",
    label: "Business policy management",
    description:
      "Required for FlipDesk to attach your shipping, payment and return policies when it publishes. Turn this off and publishing falls back to whatever eBay defaults your account has.",
  },
] as const;

export type EbayProgramSlug = (typeof EBAY_PROGRAMS)[number]["slug"];

export interface EbayPrograms {
  programs: string[];
  out_of_stock: boolean;
}

export function useEbayPrograms(enabled = true) {
  const tenantKey = useEbayTenantKey();
  return useQuery({
    queryKey: ["ebay_programs", tenantKey],
    enabled,
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<EbayPrograms> => {
      const res = await fetch(`${edgeApiUrl()}/api/flipdesk/ebay/programs`, {
        headers: await ebayHeaders(),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || "Could not load your eBay programs.");
      }
      return json as EbayPrograms;
    },
  });
}

/**
 * Opt in / out of a program. The edge treats "already in the state you asked
 * for" as success, so a double-click is harmless rather than an error toast.
 */
export function useSetEbayProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      vars: { slug: EbayProgramSlug; optIn: boolean },
    ): Promise<{ ok: boolean }> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/programs/${vars.slug}`,
        {
          method: vars.optIn ? "POST" : "DELETE",
          headers: await ebayHeaders(),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          json.error ||
            (vars.optIn
              ? "eBay rejected the opt-in."
              : "eBay rejected the opt-out."),
        );
      }
      return json as { ok: boolean };
    },
    onSuccess: (_d, vars) => {
      const program = EBAY_PROGRAMS.find((p) => p.slug === vars.slug);
      toast.success(
        `${program?.label ?? "Program"} ${vars.optIn ? "turned on" : "turned off"}.`,
      );
      void qc.invalidateQueries({ queryKey: ["ebay_programs"] });
    },
    onError: (e) => toastError(e),
  });
}

// ── US-2160: buy an eBay shipping label without leaving FlipDesk ─────────────
//
// Three steps, and the middle one spends money:
//   1. useEbayLogisticsCapability — can this seller buy labels at all? Cheap,
//      no eBay round trip. Surfaces gate on it so the entry point is hidden
//      rather than failing mid-checkout (same contract as the negotiation
//      capability above, US-1967).
//   2. useEbayShippingRates — price the parcel. Buys nothing, safe to re-run as
//      the seller adjusts the weight.
//   3. useEbayBuyLabel — BUYS the chosen rate. The server records the real
//      postage as the sale's shipping cost and pushes the tracking number to
//      eBay through the existing fulfillment path.
// Plus reprint (label URLs expire, so the server re-fetches) and void.

export interface EbayLogisticsCapability {
  labelPurchaseAvailable: boolean;
  code: "feature_unavailable" | "reconnect_required" | null;
  detail: string | null;
}

export function useEbayLogisticsCapability(enabled = true) {
  const tenantKey = useEbayTenantKey();
  return useQuery({
    queryKey: ["ebay_logistics_capability", tenantKey],
    enabled,
    // Licensing state doesn't change minute to minute.
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<EbayLogisticsCapability> => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/logistics/capabilities`,
        { headers: await ebayHeaders() }
      );
      const json = await res.json().catch(() => ({}));
      // Fail CLOSED here, unlike the negotiation probe: showing a "Buy label"
      // button that can't work invites the seller to start spending money and
      // then dead-ends. Hiding it costs them one manual label.
      if (!res.ok) {
        return {
          labelPurchaseAvailable: false,
          code: "feature_unavailable",
          detail: null,
        };
      }
      return {
        labelPurchaseAvailable: json.label_purchase_available === true,
        code: json.code ?? null,
        detail: json.detail ?? null,
      };
    },
  });
}

export interface EbayShippingRate {
  rateId: string;
  carrier: string | null;
  serviceName: string | null;
  totalCostCents: number | null;
  currency: string | null;
  minDeliveryDate: string | null;
  maxDeliveryDate: string | null;
  additionalOptions: string[];
}

export interface EbayShippingQuote {
  shippingQuoteId: string;
  expiresAt: string | null;
  rates: EbayShippingRate[];
}

export interface ParcelInput {
  weightValue: number;
  weightUnit?: "POUND" | "OUNCE" | "KILOGRAM" | "GRAM";
  lengthValue?: number | null;
  widthValue?: number | null;
  heightValue?: number | null;
}

function parcelBody(parcel: ParcelInput): Record<string, unknown> {
  return {
    weight_value: parcel.weightValue,
    weight_unit: parcel.weightUnit ?? "POUND",
    length_value: parcel.lengthValue ?? undefined,
    width_value: parcel.widthValue ?? undefined,
    height_value: parcel.heightValue ?? undefined,
  };
}

/** Step 2: price the parcel. A 409 means the ship-from address is missing. */
export function useEbayShippingRates() {
  return useMutation<
    EbayShippingQuote,
    Error & { status?: number; code?: string },
    { saleId: string; parcel: ParcelInput }
  >({
    mutationFn: async ({ saleId, parcel }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/logistics/sales/${encodeURIComponent(
          saleId
        )}/rates`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify(parcelBody(parcel)),
        }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err: Error & { status?: number; code?: string } = new Error(
          json.detail || json.error || "Couldn't price this shipment."
        );
        err.status = res.status;
        err.code = json.code;
        throw err;
      }
      return {
        shippingQuoteId: json.shipping_quote_id ?? "",
        expiresAt: json.expires_at ?? null,
        rates: (json.rates ?? []) as EbayShippingRate[],
      };
    },
  });
}

export interface EbayPurchasedLabel {
  ok?: true;
  already_purchased?: true;
  shipment_id: string;
  tracking_number: string | null;
  carrier?: string | null;
  label_download_url?: string | null;
  cost_cents?: number | null;
  currency?: string | null;
  marked_shipped_on_ebay?: boolean;
}

/**
 * Step 3: BUY the rate. Both ids are required — the server never picks a rate,
 * because a wrong default here spends the seller's money.
 */
export function useEbayBuyLabel() {
  return useMutation<
    EbayPurchasedLabel,
    Error & { status?: number; code?: string },
    { saleId: string; shippingQuoteId: string; rateId: string }
  >({
    mutationFn: async ({ saleId, shippingQuoteId, rateId }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/logistics/sales/${encodeURIComponent(
          saleId
        )}/label`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({
            shipping_quote_id: shippingQuoteId,
            rate_id: rateId,
          }),
        }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err: Error & { status?: number; code?: string } = new Error(
          json.detail || json.error || "Couldn't buy this label."
        );
        err.status = res.status;
        err.code = json.code;
        throw err;
      }
      return json as EbayPurchasedLabel;
    },
  });
}

/** Reprint: the server re-reads the shipment because label URLs expire. */
export function useEbayReprintLabel() {
  return useMutation<
    EbayPurchasedLabel,
    Error & { status?: number },
    { saleId: string }
  >({
    mutationFn: async ({ saleId }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/logistics/sales/${encodeURIComponent(
          saleId
        )}/label`,
        { headers: await ebayHeaders() }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err: Error & { status?: number } = new Error(
          json.detail || json.error || "Couldn't fetch this label."
        );
        err.status = res.status;
        throw err;
      }
      return json as EbayPurchasedLabel;
    },
  });
}

// ── Partial refunds (US-2227) ───────────────────────────────────────
//
// POST /orders/:orderId/refund is the ONLY refund path that carries an amount.
// The returns route (useEbayRefundReturn above) calls eBay's Post-Order
// issue_refund, which takes a comment and nothing else — a return refund is for
// the return's full value. See src/lib/refund-amount.ts for the full argument.
//
// This route shipped in US-1978 with no frontend caller at all, which is why a
// seller wanting to offer "keep it, here's $10 back" had to push the buyer into
// opening a return first — worse for both sides, and it drags the seller's
// return metrics.

/** The order total a partial refund is checked against. Null when unknown. */
export function useEbayOrderTotal(orderId: string | null) {
  return useQuery({
    queryKey: ["ebay_order_total", orderId],
    enabled: Boolean(orderId),
    // RLS scopes `sales` to the caller, so this cannot read another tenant's
    // order even though the id came off an eBay payload.
    queryFn: async (): Promise<number | null> => {
      const { data } = await supabase
        .from("sales")
        .select("sale_price")
        .eq("platform_order_id", orderId as string)
        .maybeSingle();
      const price = (data as { sale_price?: number | null } | null)?.sale_price;
      return typeof price === "number" && Number.isFinite(price) ? price : null;
    },
  });
}

export function useEbayIssueOrderRefund() {
  return useMutation<
    { ok: true; refund_id?: string },
    Error,
    { orderId: string; reason: string; amountValue: string; comment?: string }
  >({
    mutationFn: async ({ orderId, reason, amountValue, comment }) => {
      const res = await fetch(
        `${edgeApiUrl()}/api/flipdesk/ebay/orders/${encodeURIComponent(orderId)}/refund`,
        {
          method: "POST",
          headers: await ebayHeaders(),
          body: JSON.stringify({
            reason,
            comment,
            // eBay wants a decimal string; the currency rides with it because
            // the route rejects an amount with no currency rather than assuming
            // USD for a seller who is not selling in it.
            amount: { currency: "USD", value: amountValue },
          }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Refund failed.");
      return json;
    },
  });
}
