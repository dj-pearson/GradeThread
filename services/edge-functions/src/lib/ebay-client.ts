// Thin wrapper around the eBay OAuth + REST surface area FlipDesk needs.
//
// Two token flavors live here:
//   1. App token  — client_credentials grant. Used for Taxonomy + Browse
//      (public catalog data). Single token shared by the whole edge service;
//      cached in-memory until ~5 minutes before expiry.
//   2. User token — authorization_code grant. Per-seller. Stored encrypted
//      in marketplace_connections; refreshed lazily on use.
//
// All endpoint hosts switch between sandbox and production based on EBAY_ENV.

import { supabaseAdmin } from "./supabase.ts";
import { decryptToken, encryptToken } from "./crypto-aes.ts";

export type EbayEnv = "sandbox" | "production";

// All env reads go through here — they trim whitespace from copy-paste and
// treat empty strings as "unset". eBay's OAuth host rejects requests with
// "OAuth client not found" if a single trailing space sneaks into the App ID,
// so be paranoid.
function readEnv(name: string): string | undefined {
  const v = Deno.env.get(name);
  if (v == null) return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function getEbayEnv(): EbayEnv {
  const raw = readEnv("EBAY_ENV")?.toLowerCase();
  return raw === "production" ? "production" : "sandbox";
}

export function isEbayConfigured(): boolean {
  return !!(
    readEnv("EBAY_APP_ID") &&
    readEnv("EBAY_CERT_ID") &&
    readEnv("EBAY_RU_NAME")
  );
}

// Sanitized snapshot for the /oauth/debug endpoint. Never returns secrets;
// shows enough for a human to spot env-var problems (env, host, RuName format).
export function debugSnapshot(): {
  configured: boolean;
  env: EbayEnv;
  auth_host: string;
  api_host: string;
  marketplace_id: string;
  category_tree_id: string;
  app_id_present: boolean;
  app_id_prefix: string | null;
  cert_id_present: boolean;
  dev_id_present: boolean;
  ru_name_present: boolean;
  ru_name_looks_like_url: boolean;
  edge_encryption_key_present: boolean;
  edge_encryption_key_byte_length: number | null;
} {
  const appId = readEnv("EBAY_APP_ID");
  const ruName = readEnv("EBAY_RU_NAME");
  const encKey = readEnv("EDGE_ENCRYPTION_KEY");
  let keyBytes: number | null = null;
  if (encKey) {
    try {
      keyBytes = atob(encKey).length;
    } catch {
      keyBytes = -1; // signals "not valid base64"
    }
  }
  return {
    configured: isEbayConfigured(),
    env: getEbayEnv(),
    auth_host: authHost(),
    api_host: apiHost(),
    marketplace_id: getMarketplaceId(),
    category_tree_id: getCategoryTreeId(),
    app_id_present: !!appId,
    // Just the leading and trailing characters — enough to confirm SBX vs PRD
    // and spot whitespace, but not enough to leak.
    app_id_prefix: appId
      ? `${appId.slice(0, 12)}…${appId.slice(-6)} (len ${appId.length})`
      : null,
    cert_id_present: !!readEnv("EBAY_CERT_ID"),
    dev_id_present: !!readEnv("EBAY_DEV_ID"),
    ru_name_present: !!ruName,
    // A common confusion: people paste the redirect URL into EBAY_RU_NAME
    // instead of the RuName identifier. Flag that explicitly.
    ru_name_looks_like_url: ruName ? /^https?:\/\//i.test(ruName) : false,
    edge_encryption_key_present: !!encKey,
    edge_encryption_key_byte_length: keyBytes,
  };
}

// Host resolution. Auth host serves the consent page; API host serves the
// token + REST endpoints.
export function authHost(): string {
  return getEbayEnv() === "production"
    ? "https://auth.ebay.com"
    : "https://auth.sandbox.ebay.com";
}

export function apiHost(): string {
  return getEbayEnv() === "production"
    ? "https://api.ebay.com"
    : "https://api.sandbox.ebay.com";
}

function getScopes(): string {
  return (
    readEnv("EBAY_SCOPES") ??
    [
      "https://api.ebay.com/oauth/api_scope",
      "https://api.ebay.com/oauth/api_scope/sell.inventory",
      "https://api.ebay.com/oauth/api_scope/sell.marketing",
      "https://api.ebay.com/oauth/api_scope/sell.account",
    ].join(" ")
  );
}

function basicAuthHeader(): string {
  const appId = readEnv("EBAY_APP_ID");
  const certId = readEnv("EBAY_CERT_ID");
  if (!appId || !certId) {
    throw new Error("EBAY_APP_ID / EBAY_CERT_ID are not set.");
  }
  return `Basic ${btoa(`${appId}:${certId}`)}`;
}

// ── User OAuth ──────────────────────────────────────────────────────

export function buildConsentUrl(state: string): string {
  const appId = readEnv("EBAY_APP_ID");
  const ruName = readEnv("EBAY_RU_NAME");
  if (!appId || !ruName) {
    throw new Error("EBAY_APP_ID / EBAY_RU_NAME are not set.");
  }
  const params = new URLSearchParams({
    client_id: appId,
    response_type: "code",
    // eBay's `redirect_uri` parameter takes the RuName, not the URL itself.
    redirect_uri: ruName,
    scope: getScopes(),
    state,
  });
  return `${authHost()}/oauth2/authorize?${params.toString()}`;
}

export interface EbayUserTokenResponse {
  access_token: string;
  expires_in: number; // seconds
  refresh_token: string;
  refresh_token_expires_in: number; // seconds
  token_type: string;
}

export async function exchangeCodeForTokens(
  code: string
): Promise<EbayUserTokenResponse> {
  const ruName = readEnv("EBAY_RU_NAME");
  if (!ruName) throw new Error("EBAY_RU_NAME is not set.");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: ruName,
  });
  const res = await fetch(`${apiHost()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as EbayUserTokenResponse;
}

export interface EbayUserRefreshResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export async function refreshUserToken(
  refreshToken: string
): Promise<EbayUserRefreshResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: getScopes(),
  });
  const res = await fetch(`${apiHost()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay token refresh failed (${res.status}): ${text}`);
  }
  return (await res.json()) as EbayUserRefreshResponse;
}

// Persists or rotates a user's eBay connection. `accountHandle` is the
// stable handle we derive at the callback (eBay returns it later via
// /commerce/identity/v1/user — for now we store null on first connect).
//
// We can't rely on Postgres' UNIQUE(user_id, marketplace, account_handle)
// for upsert: NULLs are distinct in unique indexes, so a null handle on
// reconnect would always create a new row. Find-or-insert instead.
export async function upsertConnection(args: {
  userId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresInSeconds: number;
  accountHandle?: string | null;
}): Promise<void> {
  const access = await encryptToken(args.accessToken);
  const refresh = await encryptToken(args.refreshToken);
  const expiresAt = new Date(
    Date.now() + args.accessExpiresInSeconds * 1000
  ).toISOString();
  const handle = args.accountHandle ?? null;

  const lookup = supabaseAdmin
    .from("marketplace_connections")
    .select("id")
    .eq("user_id", args.userId)
    .eq("marketplace", "ebay");
  const { data: existing, error: lookupErr } = handle === null
    ? await lookup.is("account_handle", null).maybeSingle()
    : await lookup.eq("account_handle", handle).maybeSingle();

  if (lookupErr) {
    throw new Error(`Failed to look up eBay connection: ${lookupErr.message}`);
  }

  const patch = {
    access_token_encrypted: access,
    refresh_token_encrypted: refresh,
    token_expires_at: expiresAt,
    scopes: getScopes().split(" "),
    is_active: true,
    last_synced_at: new Date().toISOString(),
    refresh_error: null,
  };

  if (existing) {
    const { error } = await supabaseAdmin
      .from("marketplace_connections")
      .update(patch)
      .eq("id", existing.id as string);
    if (error) {
      throw new Error(`Failed to update eBay connection: ${error.message}`);
    }
    return;
  }

  const { error } = await supabaseAdmin
    .from("marketplace_connections")
    .insert({
      user_id: args.userId,
      marketplace: "ebay",
      account_handle: handle,
      ...patch,
    });
  if (error) {
    throw new Error(`Failed to insert eBay connection: ${error.message}`);
  }
}

// Returns a valid user access token, refreshing if it expires within 60s.
// Throws if the user has no eBay connection or refresh fails permanently.
export async function getUserAccessToken(userId: string): Promise<string> {
  const { data: row, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select(
      "id, access_token_encrypted, refresh_token_encrypted, token_expires_at"
    )
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load eBay connection: ${error.message}`);
  }
  if (!row) {
    throw new Error("No active eBay connection for this user.");
  }

  const expiresAt = row.token_expires_at
    ? new Date(row.token_expires_at).getTime()
    : 0;
  const refreshNeeded = !expiresAt || expiresAt - Date.now() < 60_000;

  if (!refreshNeeded) {
    return await decryptToken(row.access_token_encrypted as string);
  }

  const refreshToken = await decryptToken(
    row.refresh_token_encrypted as string
  );
  try {
    const fresh = await refreshUserToken(refreshToken);
    const encryptedAccess = await encryptToken(fresh.access_token);
    const expiresAtNew = new Date(
      Date.now() + fresh.expires_in * 1000
    ).toISOString();
    await supabaseAdmin
      .from("marketplace_connections")
      .update({
        access_token_encrypted: encryptedAccess,
        token_expires_at: expiresAtNew,
        last_refresh_attempt_at: new Date().toISOString(),
        refresh_error: null,
      })
      .eq("id", row.id);
    return fresh.access_token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabaseAdmin
      .from("marketplace_connections")
      .update({
        last_refresh_attempt_at: new Date().toISOString(),
        refresh_error: msg.slice(0, 500),
      })
      .eq("id", row.id);
    throw err;
  }
}

// ── Taxonomy helpers ────────────────────────────────────────────────

export function getMarketplaceId(): string {
  return readEnv("EBAY_MARKETPLACE_ID") ?? "EBAY_US";
}

export function getCategoryTreeId(): string {
  return readEnv("EBAY_CATEGORY_TREE_ID") ?? "0";
}

export interface CategorySuggestion {
  categoryId: string;
  categoryName: string;
  categoryTreePath: string; // "Clothing › Men › Suits & Blazers › Blazers"
}

export async function suggestCategories(
  query: string
): Promise<CategorySuggestion[]> {
  const token = await getAppAccessToken();
  const url =
    `${apiHost()}/commerce/taxonomy/v1/category_tree/${getCategoryTreeId()}` +
    `/get_category_suggestions?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
      "Accept-Language": "en-US",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `eBay category suggest failed (${res.status}): ${text.slice(0, 300)}`
    );
  }
  const payload = (await res.json()) as {
    categorySuggestions?: Array<{
      category: { categoryId: string; categoryName: string };
      categoryTreeNodeAncestors?: Array<{ categoryName: string }>;
    }>;
  };

  return (payload.categorySuggestions ?? []).map((sugg) => {
    const ancestors = (sugg.categoryTreeNodeAncestors ?? [])
      .map((a) => a.categoryName)
      .reverse(); // eBay returns leaf-first; show root-first.
    const path = [...ancestors, sugg.category.categoryName].join(" › ");
    return {
      categoryId: sugg.category.categoryId,
      categoryName: sugg.category.categoryName,
      categoryTreePath: path,
    };
  });
}

// Aspect cache TTL: aspects change rarely. Keep entries warm for 30 days.
const ASPECT_TTL_MS = 30 * 24 * 60 * 60_000;

export interface AspectMetadata {
  // Verbatim from eBay's getItemAspectsForCategory. Shape:
  //   { aspects: [{ localizedAspectName, aspectConstraint, aspectValues }, …] }
  aspects: Record<string, unknown>;
  categoryName?: string | null;
  cached: boolean;
}

export async function getCategoryAspects(
  categoryId: string
): Promise<AspectMetadata> {
  const marketplaceId = getMarketplaceId();
  const treeId = getCategoryTreeId();

  // Read-through cache.
  const { data: cached } = await supabaseAdmin
    .from("ebay_category_aspects")
    .select("aspects, category_name, fetched_at")
    .eq("marketplace_id", marketplaceId)
    .eq("category_tree_id", treeId)
    .eq("category_id", categoryId)
    .maybeSingle();

  if (
    cached &&
    Date.now() - new Date(cached.fetched_at as string).getTime() < ASPECT_TTL_MS
  ) {
    return {
      aspects: cached.aspects as Record<string, unknown>,
      categoryName: (cached.category_name as string | null) ?? null,
      cached: true,
    };
  }

  const token = await getAppAccessToken();
  const url =
    `${apiHost()}/commerce/taxonomy/v1/category_tree/${treeId}` +
    `/get_item_aspects_for_category?category_id=${encodeURIComponent(
      categoryId
    )}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
      "Accept-Language": "en-US",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `eBay category aspects failed (${res.status}): ${text.slice(0, 300)}`
    );
  }
  const payload = (await res.json()) as Record<string, unknown>;

  // Write-through cache. category_name comes from a separate node lookup;
  // skip for now — we have the human path from suggestCategories already.
  await supabaseAdmin.from("ebay_category_aspects").upsert(
    {
      marketplace_id: marketplaceId,
      category_tree_id: treeId,
      category_id: categoryId,
      category_name: null,
      aspects: payload,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "marketplace_id,category_tree_id,category_id" }
  );

  return { aspects: payload, categoryName: null, cached: false };
}

// ── Sell API: business policies + listings (Week 3) ────────────────
//
// Publishing a listing requires three business policies (fulfillment,
// payment, return) and one merchant location to exist on the seller's
// eBay account. We look these up once at publish-time and use the first
// of each. Users with multiple policies can configure defaults later via
// a settings screen.

export interface PolicySet {
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
  merchantLocationKey: string;
}

export interface MissingPolicies {
  missing: string[];
  details: Partial<PolicySet> & {
    helpUrl?: string;
  };
}

async function fetchAuthed<T>(
  userId: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const token = await getUserAccessToken(userId);
  const res = await fetch(`${apiHost()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
      "Content-Type": "application/json",
      "Content-Language": "en-US",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `eBay ${init?.method ?? "GET"} ${path} failed (${res.status}): ${text.slice(0, 500)}`
    );
  }
  // 204 No Content is valid for publishOffer in some paths.
  const body = await res.text();
  return (body ? JSON.parse(body) : {}) as T;
}

export async function getDefaultPolicies(
  userId: string
): Promise<PolicySet | MissingPolicies> {
  const marketplaceId = getMarketplaceId();
  const missing: string[] = [];
  const details: Partial<PolicySet> = {};

  type PolicyList<K extends string> = {
    [k in K]: Array<Record<string, unknown>>;
  };

  // Run all four lookups in parallel. The Account API is rate-limited but
  // these are tiny.
  const [fulfillment, payment, ret, locs] = await Promise.all([
    fetchAuthed<PolicyList<"fulfillmentPolicies">>(
      userId,
      `/sell/account/v1/fulfillment_policy?marketplace_id=${marketplaceId}`
    ).catch((e) => {
      console.error("fulfillment_policy lookup:", e);
      return null;
    }),
    fetchAuthed<PolicyList<"paymentPolicies">>(
      userId,
      `/sell/account/v1/payment_policy?marketplace_id=${marketplaceId}`
    ).catch((e) => {
      console.error("payment_policy lookup:", e);
      return null;
    }),
    fetchAuthed<PolicyList<"returnPolicies">>(
      userId,
      `/sell/account/v1/return_policy?marketplace_id=${marketplaceId}`
    ).catch((e) => {
      console.error("return_policy lookup:", e);
      return null;
    }),
    fetchAuthed<{ locations?: Array<{ merchantLocationKey?: string }> }>(
      userId,
      `/sell/inventory/v1/location`
    ).catch((e) => {
      console.error("location lookup:", e);
      return null;
    }),
  ]);

  const ff = (fulfillment?.fulfillmentPolicies?.[0] as
    | { fulfillmentPolicyId?: string }
    | undefined)?.fulfillmentPolicyId;
  const pp = (payment?.paymentPolicies?.[0] as
    | { paymentPolicyId?: string }
    | undefined)?.paymentPolicyId;
  const rp = (ret?.returnPolicies?.[0] as
    | { returnPolicyId?: string }
    | undefined)?.returnPolicyId;
  const loc = locs?.locations?.[0]?.merchantLocationKey;

  if (ff) details.fulfillmentPolicyId = ff;
  else missing.push("fulfillment policy");
  if (pp) details.paymentPolicyId = pp;
  else missing.push("payment policy");
  if (rp) details.returnPolicyId = rp;
  else missing.push("return policy");
  if (loc) details.merchantLocationKey = loc;
  else missing.push("merchant location");

  if (missing.length > 0) {
    return {
      missing,
      details: {
        ...details,
        helpUrl:
          "https://www.ebay.com/help/selling/business-policies/business-policies?id=4212",
      },
    };
  }
  return details as PolicySet;
}

export interface InventoryItemPayload {
  product: {
    title: string;
    description: string;
    aspects?: Record<string, string[]>;
    imageUrls?: string[];
    brand?: string;
    mpn?: string;
  };
  condition: string;
  conditionDescription?: string;
  availability: {
    shipToLocationAvailability: { quantity: number };
  };
}

export async function createOrReplaceInventoryItem(
  userId: string,
  sku: string,
  payload: InventoryItemPayload
): Promise<void> {
  // PUT is idempotent; safe to re-run on retries.
  await fetchAuthed<unknown>(
    userId,
    `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    { method: "PUT", body: JSON.stringify(payload) }
  );
}

export interface OfferPayload {
  sku: string;
  marketplaceId: string;
  format: "FIXED_PRICE" | "AUCTION";
  availableQuantity: number;
  categoryId: string;
  listingDescription: string;
  listingPolicies: {
    fulfillmentPolicyId: string;
    paymentPolicyId: string;
    returnPolicyId: string;
  };
  pricingSummary: {
    price: { value: string; currency: string };
  };
  merchantLocationKey: string;
}

export async function createOffer(
  userId: string,
  payload: OfferPayload
): Promise<{ offerId: string }> {
  return await fetchAuthed<{ offerId: string }>(
    userId,
    `/sell/inventory/v1/offer`,
    { method: "POST", body: JSON.stringify(payload) }
  );
}

// eBay's "offer already exists for this SKU" error doesn't have a clean
// HTTP code — we detect it via message body. Caller falls back to lookup.
export function isOfferAlreadyExistsError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already exists/i.test(msg) && /offer/i.test(msg);
}

export async function listOffersForSku(
  userId: string,
  sku: string
): Promise<Array<{ offerId: string; status?: string; listing?: { listingId?: string; listingStatus?: string } }>> {
  const payload = await fetchAuthed<{ offers?: Array<{ offerId?: string; status?: string; listing?: { listingId?: string; listingStatus?: string } }> }>(
    userId,
    `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`
  );
  return (payload.offers ?? [])
    .filter((o): o is { offerId: string } => typeof o.offerId === "string")
    .map((o) => ({
      offerId: o.offerId,
      status: o.status,
      listing: o.listing,
    }));
}

export async function publishOffer(
  userId: string,
  offerId: string
): Promise<{ listingId: string }> {
  return await fetchAuthed<{ listingId: string }>(
    userId,
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish_`,
    { method: "POST" }
  );
}

// Reads a single offer's full body. Needed before updateOfferPrice because
// eBay's PUT /offer/{id} replaces the whole body — partial updates aren't
// supported, so we round-trip the current state and patch only the price.
export async function getOffer(
  userId: string,
  offerId: string
): Promise<Record<string, unknown>> {
  return await fetchAuthed<Record<string, unknown>>(
    userId,
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`
  );
}

export async function updateOfferPrice(
  userId: string,
  offerId: string,
  priceValue: number,
  currency: string = "USD"
): Promise<void> {
  const current = await getOffer(userId, offerId);
  // Read-modify-write: keep every field eBay returned and overwrite the
  // price. If pricingSummary is missing we create it; that should not
  // happen for a previously-published offer but covers brand-new drafts.
  const pricingSummary =
    (current.pricingSummary as Record<string, unknown> | undefined) ?? {};
  pricingSummary.price = {
    value: priceValue.toFixed(2),
    currency,
  };
  current.pricingSummary = pricingSummary;

  await fetchAuthed<unknown>(
    userId,
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
    { method: "PUT", body: JSON.stringify(current) }
  );
}

// Withdraws a published offer — ends the live eBay listing. The offer
// record itself stays, so a future re-publish reuses the same offerId.
export async function withdrawOffer(
  userId: string,
  offerId: string
): Promise<void> {
  await fetchAuthed<unknown>(
    userId,
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`,
    { method: "POST" }
  );
}

export interface RemoteOffer {
  offerId: string;
  sku: string | null;
  marketplaceId: string | null;
  format: string | null;
  availableQuantity: number | null;
  status: string | null;
  categoryId: string | null;
  price: { value: string; currency: string } | null;
  listingId: string | null;
  listingStatus: string | null;
  // The HTML listing body. Sync writes this through to listings.listing_description
  // so eBay-side edits in Seller Hub don't leave FlipDesk's copy stale.
  listingDescription: string | null;
}

// Pulls every offer for the connected seller, paginating until eBay returns
// no further results. Limit per page is 100 (Sell Inventory API max).
export async function listAllOffers(userId: string): Promise<RemoteOffer[]> {
  const all: RemoteOffer[] = [];
  let offset = 0;
  const limit = 100;
  // Hard ceiling so a buggy paginator can't loop forever.
  for (let i = 0; i < 50; i++) {
    const payload = await fetchAuthed<{
      offers?: Array<{
        offerId?: string;
        sku?: string;
        marketplaceId?: string;
        format?: string;
        availableQuantity?: number;
        status?: string;
        categoryId?: string;
        listingDescription?: string;
        pricingSummary?: { price?: { value?: string; currency?: string } };
        listing?: { listingId?: string; listingStatus?: string };
      }>;
      total?: number;
    }>(userId, `/sell/inventory/v1/offer?limit=${limit}&offset=${offset}`);
    const batch = payload.offers ?? [];
    for (const o of batch) {
      if (!o.offerId) continue;
      all.push({
        offerId: o.offerId,
        sku: o.sku ?? null,
        marketplaceId: o.marketplaceId ?? null,
        format: o.format ?? null,
        availableQuantity: o.availableQuantity ?? null,
        status: o.status ?? null,
        categoryId: o.categoryId ?? null,
        price: o.pricingSummary?.price
          ? {
              value: String(o.pricingSummary.price.value ?? "0"),
              currency: String(o.pricingSummary.price.currency ?? "USD"),
            }
          : null,
        listingId: o.listing?.listingId ?? null,
        listingStatus: o.listing?.listingStatus ?? null,
        listingDescription: o.listingDescription ?? null,
      });
    }
    if (batch.length < limit) break;
    offset += limit;
  }
  return all;
}

// Best-effort eBay item-URL builder. eBay's documented format is
// https://www.ebay.com/itm/<listingId>; sandbox uses sandbox.ebay.com.
export function ebayListingUrl(listingId: string): string {
  const host = getEbayEnv() === "production"
    ? "https://www.ebay.com"
    : "https://www.sandbox.ebay.com";
  return `${host}/itm/${listingId}`;
}

// ── Sell Fulfillment API: orders (Week 5) ──────────────────────────
//
// Used by /listings/pull to detect sales that happened on eBay while
// FlipDesk wasn't looking. The Fulfillment API supports a lastmodifieddate
// filter so we only pull what's changed since last_synced_at.

export interface RemoteOrderLineItem {
  lineItemId: string | null;
  sku: string | null;
  legacyItemId: string | null; // eBay listingId
  title: string | null;
  quantity: number;
  itemCost: { value: string; currency: string } | null;
  shippingCost: { value: string; currency: string } | null;
  taxes: { value: string; currency: string } | null;
}

export interface RemoteOrder {
  orderId: string;
  creationDate: string | null;
  lastModifiedDate: string | null;
  orderFulfillmentStatus: string | null;
  orderPaymentStatus: string | null;
  buyerUsername: string | null;
  totalAmount: { value: string; currency: string } | null;
  shippingTotal: { value: string; currency: string } | null;
  lineItems: RemoteOrderLineItem[];
}

// Pulls orders modified since `sinceISO` (or all recent ones when omitted).
// eBay caps the date range; we don't enforce a ceiling here — the caller
// passes the connection's last_synced_at and falls back to "90 days ago"
// on first sync.
export async function listRecentOrders(
  userId: string,
  sinceISO?: string | null
): Promise<RemoteOrder[]> {
  const all: RemoteOrder[] = [];
  const limit = 200;
  let offset = 0;
  const filterParts: string[] = [];
  if (sinceISO) {
    // eBay wants ISO 8601 with milliseconds. Trim sub-second precision noise.
    const iso = new Date(sinceISO).toISOString();
    filterParts.push(`lastmodifieddate:[${iso}..]`);
  }
  const filter = filterParts.length > 0
    ? `&filter=${encodeURIComponent(filterParts.join(","))}`
    : "";

  for (let i = 0; i < 50; i++) {
    const payload = await fetchAuthed<{
      orders?: Array<{
        orderId?: string;
        creationDate?: string;
        lastModifiedDate?: string;
        orderFulfillmentStatus?: string;
        orderPaymentStatus?: string;
        buyer?: { username?: string };
        pricingSummary?: {
          total?: { value?: string; currency?: string };
          deliveryCost?: { value?: string; currency?: string };
        };
        lineItems?: Array<{
          lineItemId?: string;
          sku?: string;
          legacyItemId?: string;
          title?: string;
          quantity?: number;
          lineItemCost?: { value?: string; currency?: string };
          deliveryCost?: {
            shippingCost?: { value?: string; currency?: string };
          };
          taxes?: Array<{ amount?: { value?: string; currency?: string } }>;
        }>;
      }>;
      total?: number;
    }>(
      userId,
      `/sell/fulfillment/v1/order?limit=${limit}&offset=${offset}${filter}`
    );

    const batch = payload.orders ?? [];
    for (const o of batch) {
      if (!o.orderId) continue;
      const lineItems: RemoteOrderLineItem[] = (o.lineItems ?? []).map((li) => {
        // Taxes can be an array of per-tax-type entries; sum them.
        const taxesSum = (li.taxes ?? []).reduce(
          (acc, t) => acc + Number(t.amount?.value ?? 0),
          0
        );
        const currency = li.lineItemCost?.currency ?? "USD";
        return {
          lineItemId: li.lineItemId ?? null,
          sku: li.sku ?? null,
          legacyItemId: li.legacyItemId ?? null,
          title: li.title ?? null,
          quantity: li.quantity ?? 1,
          itemCost: li.lineItemCost?.value
            ? {
                value: String(li.lineItemCost.value),
                currency,
              }
            : null,
          shippingCost: li.deliveryCost?.shippingCost?.value
            ? {
                value: String(li.deliveryCost.shippingCost.value),
                currency:
                  li.deliveryCost.shippingCost.currency ?? currency,
              }
            : null,
          taxes: taxesSum > 0
            ? { value: taxesSum.toFixed(2), currency }
            : null,
        };
      });

      all.push({
        orderId: o.orderId,
        creationDate: o.creationDate ?? null,
        lastModifiedDate: o.lastModifiedDate ?? null,
        orderFulfillmentStatus: o.orderFulfillmentStatus ?? null,
        orderPaymentStatus: o.orderPaymentStatus ?? null,
        buyerUsername: o.buyer?.username ?? null,
        totalAmount: o.pricingSummary?.total?.value
          ? {
              value: String(o.pricingSummary.total.value),
              currency: o.pricingSummary.total.currency ?? "USD",
            }
          : null,
        shippingTotal: o.pricingSummary?.deliveryCost?.value
          ? {
              value: String(o.pricingSummary.deliveryCost.value),
              currency:
                o.pricingSummary.deliveryCost.currency ?? "USD",
            }
          : null,
        lineItems,
      });
    }
    if (batch.length < limit) break;
    offset += limit;
  }
  return all;
}

// ── Browse API: active comps ────────────────────────────────────────

export interface BrowseComp {
  itemId: string;
  title: string;
  price: number | null;
  currency: string;
  imageUrl: string | null;
  itemWebUrl: string | null;
  condition: string | null;
  buyingOptions: string[];
}

export interface BrowseCompsArgs {
  categoryId: string;
  q?: string;
  brand?: string;
  size?: string;
  // Maps to eBay conditionId. Defaults to "3000" (Used) for pre-owned resale.
  conditionId?: string;
  limit?: number;
}

export interface BrowseCompsResult {
  items: BrowseComp[];
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

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const w = idx - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

export async function searchBrowseComps(
  args: BrowseCompsArgs
): Promise<BrowseCompsResult> {
  const token = await getAppAccessToken();
  const filters: string[] = [];
  filters.push(`conditionIds:{${args.conditionId ?? "3000"}}`);
  filters.push(`buyingOptions:{FIXED_PRICE|AUCTION|BEST_OFFER}`);

  // Aspect filter: only the most reliable item-specifics. Brand alone moves
  // the needle hard for clothing comps. Size is more variable across brands.
  const aspectFilters: string[] = [];
  if (args.brand) aspectFilters.push(`Brand:{${args.brand}}`);
  if (args.size) aspectFilters.push(`Size:{${args.size}}`);

  const params = new URLSearchParams();
  params.set("category_ids", args.categoryId);
  if (args.q && args.q.trim()) params.set("q", args.q.trim());
  params.set("filter", filters.join(","));
  if (aspectFilters.length > 0) {
    params.set(
      "aspect_filter",
      `categoryId:${args.categoryId},${aspectFilters.join(",")}`
    );
  }
  params.set("limit", String(Math.min(Math.max(args.limit ?? 12, 1), 50)));
  params.set("sort", "newlyListed");

  const url = `${apiHost()}/buy/browse/v1/item_summary/search?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `eBay Browse search failed (${res.status}): ${text.slice(0, 300)}`
    );
  }

  const payload = (await res.json()) as {
    itemSummaries?: Array<{
      itemId?: string;
      title?: string;
      price?: { value?: string; currency?: string };
      image?: { imageUrl?: string };
      thumbnailImages?: Array<{ imageUrl?: string }>;
      itemWebUrl?: string;
      condition?: string;
      buyingOptions?: string[];
    }>;
    total?: number;
  };

  const summaries = payload.itemSummaries ?? [];
  const items: BrowseComp[] = summaries.map((s) => ({
    itemId: s.itemId ?? "",
    title: s.title ?? "",
    price: s.price?.value ? Number(s.price.value) : null,
    currency: s.price?.currency ?? "USD",
    imageUrl:
      s.image?.imageUrl ?? s.thumbnailImages?.[0]?.imageUrl ?? null,
    itemWebUrl: s.itemWebUrl ?? null,
    condition: s.condition ?? null,
    buyingOptions: s.buyingOptions ?? [],
  }));

  const prices = items
    .map((i) => i.price)
    .filter((p): p is number => p != null && p > 0)
    .sort((a, b) => a - b);
  const currency = items[0]?.currency ?? "USD";

  return {
    items,
    total: payload.total ?? items.length,
    stats: {
      count: prices.length,
      currency,
      min: prices[0] ?? null,
      p25: percentile(prices, 0.25),
      median: percentile(prices, 0.5),
      p75: percentile(prices, 0.75),
      max: prices[prices.length - 1] ?? null,
    },
  };
}

// ── App token (client_credentials) ──────────────────────────────────
// Used for Taxonomy + Browse — endpoints that don't need a seller context.

interface AppTokenCache {
  token: string;
  expiresAt: number;
}
let appTokenCache: AppTokenCache | null = null;

export async function getAppAccessToken(): Promise<string> {
  if (appTokenCache && appTokenCache.expiresAt - Date.now() > 5 * 60_000) {
    return appTokenCache.token;
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope",
  });
  const res = await fetch(`${apiHost()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay app token request failed (${res.status}): ${text}`);
  }
  const payload = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  appTokenCache = {
    token: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
  };
  return payload.access_token;
}
