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

export function getEbayEnv(): EbayEnv {
  return (Deno.env.get("EBAY_ENV") as EbayEnv) === "production"
    ? "production"
    : "sandbox";
}

export function isEbayConfigured(): boolean {
  return !!(
    Deno.env.get("EBAY_APP_ID") &&
    Deno.env.get("EBAY_CERT_ID") &&
    Deno.env.get("EBAY_RU_NAME")
  );
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
    Deno.env.get("EBAY_SCOPES") ??
    [
      "https://api.ebay.com/oauth/api_scope",
      "https://api.ebay.com/oauth/api_scope/sell.inventory",
      "https://api.ebay.com/oauth/api_scope/sell.marketing",
      "https://api.ebay.com/oauth/api_scope/sell.account",
    ].join(" ")
  );
}

function basicAuthHeader(): string {
  const appId = Deno.env.get("EBAY_APP_ID")!;
  const certId = Deno.env.get("EBAY_CERT_ID")!;
  return `Basic ${btoa(`${appId}:${certId}`)}`;
}

// ── User OAuth ──────────────────────────────────────────────────────

export function buildConsentUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: Deno.env.get("EBAY_APP_ID")!,
    response_type: "code",
    // eBay's `redirect_uri` parameter takes the RuName, not the URL itself.
    redirect_uri: Deno.env.get("EBAY_RU_NAME")!,
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
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: Deno.env.get("EBAY_RU_NAME")!,
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
  return Deno.env.get("EBAY_MARKETPLACE_ID") ?? "EBAY_US";
}

export function getCategoryTreeId(): string {
  return Deno.env.get("EBAY_CATEGORY_TREE_ID") ?? "0";
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
