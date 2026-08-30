// US-2997 — the QuickBooks Online client.
//
// Shaped after ebay-client.ts on purpose: AES-GCM tokens with the owning user
// id as AAD, lazy refresh on use with a scheduled sweep behind it, and a
// permanent-versus-transient split on failure. What differs is QBO's own
// arithmetic:
//
//   - An access token lasts one hour.
//   - The REFRESH token ROTATES on every use. The new one must be stored or the
//     connection is dead, and there is no way to recover it.
//   - A refresh token expires after 100 days of DISUSE. This is the failure
//     this module is written around: it is slow, silent, and a seller finds out
//     in March that nothing has synced since November.
//
// Every call is scoped by the realm id held on the connection row. The realm is
// never read from a request body -- a seller with a personal file and a business
// file must not have a sale land in the wrong one (AC2).

import { supabaseAdmin } from "./supabase.ts";
import { decryptToken, encryptToken } from "./crypto-aes.ts";
import { fetchWithTimeout } from "./circuit-breaker.ts";

export type QboEnvironment = "sandbox" | "production";

/** Every account under the accounting scope. QBO has no finer grain for this. */
const QBO_SCOPE = "com.intuit.quickbooks.accounting";

const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

const API_BASE: Record<QboEnvironment, string> = {
  production: "https://quickbooks.api.intuit.com",
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
};

/**
 * AC5. Sandbox and production are separate config AND separate rows. They are
 * different company files, and pushing test data into a real one cannot be
 * undone, so nothing here ever falls back from one to the other.
 */
export function qboEnvironment(): QboEnvironment {
  return Deno.env.get("QBO_ENVIRONMENT") === "sandbox" ? "sandbox" : "production";
}

export function qboConfigured(): boolean {
  return Boolean(
    Deno.env.get("QBO_CLIENT_ID") &&
      Deno.env.get("QBO_CLIENT_SECRET") &&
      Deno.env.get("QBO_REDIRECT_URI"),
  );
}

function creds(): { id: string; secret: string; redirect: string } {
  const id = Deno.env.get("QBO_CLIENT_ID");
  const secret = Deno.env.get("QBO_CLIENT_SECRET");
  const redirect = Deno.env.get("QBO_REDIRECT_URI");
  if (!id || !secret || !redirect) {
    throw new Error("QuickBooks is not configured on this server.");
  }
  return { id, secret, redirect };
}

/** Random URL-safe state token for CSRF and replay protection. */
export function generateQboState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildQboConsentUrl(state: string): string {
  const { id, redirect } = creds();
  const q = new URLSearchParams({
    client_id: id,
    response_type: "code",
    scope: QBO_SCOPE,
    redirect_uri: redirect,
    state,
  });
  return `${AUTHORIZE_URL}?${q.toString()}`;
}

export interface QboTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds. QBO sends both; neither is optional in practice. */
  expiresIn: number;
  refreshExpiresIn: number;
}

async function tokenRequest(body: URLSearchParams): Promise<QboTokens> {
  const { id, secret } = creds();
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    // The status is carried in the message because the caller has to tell a
    // 400 invalid_grant (reconnect) from a 503 (retry later), and Intuit puts
    // that distinction in the body rather than in a header.
    throw new Error(`QuickBooks token request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    x_refresh_token_expires_in?: number;
  };
  if (!json.access_token || !json.refresh_token) {
    throw new Error("QuickBooks returned no token.");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in ?? 3600,
    refreshExpiresIn: json.x_refresh_token_expires_in ?? 8726400,
  };
}

export function exchangeQboCode(code: string): Promise<QboTokens> {
  const { redirect } = creds();
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
    }),
  );
}

export function refreshQboTokens(refreshToken: string): Promise<QboTokens> {
  return tokenRequest(
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  );
}

export const QBO_RECONNECT_MESSAGE =
  "Your QuickBooks connection has expired. Connect it again to start syncing.";

/**
 * A failure the seller must act on, versus one that will fix itself.
 *
 * Getting this wrong in either direction is expensive. Treating a transient
 * Intuit 503 as permanent disconnects a working connection; treating an expired
 * refresh token as transient means the sweep retries it silently for months and
 * nobody is told (AC6).
 */
export function isPermanentQboAuthFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/\(400\)|\(401\)/.test(msg)) return true;
  return /invalid_grant|invalid_client|unauthorized_client/i.test(msg);
}

export interface QboConnectionRow {
  id: string;
  user_id: string;
  realm_id: string;
  environment: QboEnvironment;
  company_name: string | null;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  refresh_token_expires_at: string | null;
  is_active: boolean;
  refresh_error: string | null;
}

const CONNECTION_COLUMNS =
  "id, user_id, realm_id, environment, company_name, access_token_encrypted," +
  " refresh_token_encrypted, token_expires_at, refresh_token_expires_at," +
  " is_active, refresh_error";

/** The active connection for a tenant, or null. Always tenant-scoped (US-268). */
export async function getQboConnection(
  userId: string,
): Promise<QboConnectionRow | null> {
  const { data } = await supabaseAdmin
    .from("qbo_connections")
    .select(CONNECTION_COLUMNS)
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data ?? null) as QboConnectionRow | null;
}

/**
 * Find-or-insert, not upsert: the same reason ebay-client.ts avoids it, plus
 * one of QBO's own. Reconnecting the SAME company file must reuse the row so
 * the account mappings hanging off it survive; connecting a DIFFERENT realm is
 * a different company and gets its own row.
 */
export async function upsertQboConnection(args: {
  userId: string;
  realmId: string;
  environment: QboEnvironment;
  tokens: QboTokens;
  companyName?: string | null;
}): Promise<QboConnectionRow> {
  const now = Date.now();
  const patch = {
    access_token_encrypted: await encryptToken(args.tokens.accessToken, {
      aad: args.userId,
    }),
    refresh_token_encrypted: await encryptToken(args.tokens.refreshToken, {
      aad: args.userId,
    }),
    token_expires_at: new Date(now + args.tokens.expiresIn * 1000).toISOString(),
    refresh_token_expires_at: new Date(
      now + args.tokens.refreshExpiresIn * 1000,
    ).toISOString(),
    is_active: true,
    refresh_error: null,
    last_refresh_attempt_at: new Date().toISOString(),
    ...(args.companyName ? { company_name: args.companyName } : {}),
  };

  const { data: existing } = await supabaseAdmin
    .from("qbo_connections")
    .select("id")
    .eq("user_id", args.userId)
    .eq("realm_id", args.realmId)
    .eq("environment", args.environment)
    .maybeSingle();

  if (existing) {
    const { data, error } = await supabaseAdmin
      .from("qbo_connections")
      .update(patch)
      .eq("id", (existing as { id: string }).id)
      .eq("user_id", args.userId)
      .select(CONNECTION_COLUMNS)
      .single();
    if (error) throw new Error(error.message);
    return data as unknown as QboConnectionRow;
  }

  const { data, error } = await supabaseAdmin
    .from("qbo_connections")
    .insert({
      user_id: args.userId,
      realm_id: args.realmId,
      environment: args.environment,
      ...patch,
    })
    .select(CONNECTION_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return data as unknown as QboConnectionRow;
}

export interface QboAuth {
  accessToken: string;
  realmId: string;
  environment: QboEnvironment;
  connectionId: string;
}

/**
 * A usable access token for a tenant, refreshing if it is close to lapsing.
 *
 * THE ROTATION IS THE DANGEROUS PART. QBO issues a NEW refresh token on every
 * refresh and invalidates the old one immediately. If the write below fails
 * after the network call succeeded, the stored token is already dead and the
 * seller must reconnect -- so the write happens straight away, before anything
 * else can throw.
 */
export async function getQboAccessToken(userId: string): Promise<QboAuth> {
  const row = await getQboConnection(userId);
  if (!row) throw new Error("QuickBooks is not connected.");
  return await authFromRow(row);
}

async function authFromRow(row: QboConnectionRow): Promise<QboAuth> {
  const userId = row.user_id;
  const expiresAt = row.token_expires_at ? Date.parse(row.token_expires_at) : 0;
  const fresh = row.access_token_encrypted && expiresAt - Date.now() > 120_000;

  if (fresh) {
    return {
      accessToken: await decryptToken(row.access_token_encrypted!, { aad: userId }),
      realmId: row.realm_id,
      environment: row.environment,
      connectionId: row.id,
    };
  }

  if (!row.refresh_token_encrypted) {
    await markQboReconnect(row.id, userId, QBO_RECONNECT_MESSAGE);
    throw new Error(QBO_RECONNECT_MESSAGE);
  }

  let tokens: QboTokens;
  try {
    const current = await decryptToken(row.refresh_token_encrypted, { aad: userId });
    tokens = await refreshQboTokens(current);
  } catch (err) {
    if (isPermanentQboAuthFailure(err)) {
      await markQboReconnect(row.id, userId, QBO_RECONNECT_MESSAGE);
      throw new Error(QBO_RECONNECT_MESSAGE);
    }
    const msg = err instanceof Error ? err.message : String(err);
    await supabaseAdmin
      .from("qbo_connections")
      .update({
        last_refresh_attempt_at: new Date().toISOString(),
        refresh_error: msg.slice(0, 500),
      })
      .eq("id", row.id)
      .eq("user_id", userId);
    throw err;
  }

  const now = Date.now();
  const { error } = await supabaseAdmin
    .from("qbo_connections")
    .update({
      access_token_encrypted: await encryptToken(tokens.accessToken, { aad: userId }),
      refresh_token_encrypted: await encryptToken(tokens.refreshToken, { aad: userId }),
      token_expires_at: new Date(now + tokens.expiresIn * 1000).toISOString(),
      refresh_token_expires_at: new Date(
        now + tokens.refreshExpiresIn * 1000,
      ).toISOString(),
      last_refresh_attempt_at: new Date().toISOString(),
      refresh_error: null,
      is_active: true,
    })
    .eq("id", row.id)
    .eq("user_id", userId);
  // The rotated token is only in this variable and in the row we just wrote. A
  // failed write means the stored one is already dead upstream, so say so
  // rather than returning a token whose refresh partner is lost.
  if (error) {
    throw new Error(
      "QuickBooks refreshed but the new token could not be saved. Connect it again.",
    );
  }

  return {
    accessToken: tokens.accessToken,
    realmId: row.realm_id,
    environment: row.environment,
    connectionId: row.id,
  };
}

/** AC6: an actionable prompt on the row the status card already reads. */
export async function markQboReconnect(
  connectionId: string,
  userId: string,
  message: string,
): Promise<void> {
  await supabaseAdmin
    .from("qbo_connections")
    .update({
      is_active: false,
      access_token_encrypted: null,
      token_expires_at: null,
      last_refresh_attempt_at: new Date().toISOString(),
      refresh_error: message,
    })
    .eq("id", connectionId)
    .eq("user_id", userId);
}

/**
 * A QBO API call, scoped by the connection's realm. Callers pass a path under
 * the company, never a full URL, so there is no way to address another realm.
 */
export async function qboFetch(
  auth: QboAuth,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const clean = path.startsWith("/") ? path : `/${path}`;
  const url = `${API_BASE[auth.environment]}/v3/company/${auth.realmId}${clean}`;
  return await fetchWithTimeout(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export interface QboAccount {
  Id: string;
  Name: string;
  AccountType?: string;
  AccountSubType?: string;
  Classification?: string;
  Active?: boolean;
  FullyQualifiedName?: string;
}

/**
 * AC3 — the LIVE chart of accounts. The mapping screen validates against this
 * rather than against what we proposed last week, because an account can be
 * deactivated or merged in QuickBooks between the two.
 *
 * QBO caps a query at 1000 rows and pages with STARTPOSITION, which is 1-based.
 */
export async function fetchQboChartOfAccounts(auth: QboAuth): Promise<QboAccount[]> {
  const out: QboAccount[] = [];
  const page = 1000;
  for (let start = 1; ; start += page) {
    const q =
      `select * from Account startposition ${start} maxresults ${page}`;
    const res = await qboFetch(auth, `/query?query=${encodeURIComponent(q)}`, {
      method: "GET",
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Couldn't read your QuickBooks accounts (${res.status}): ${text.slice(0, 300)}`,
      );
    }
    const json = (await res.json()) as {
      QueryResponse?: { Account?: QboAccount[] };
    };
    const batch = json.QueryResponse?.Account ?? [];
    out.push(...batch);
    if (batch.length < page) break;
    // A file with more than 10,000 accounts is a data problem, not a page to
    // keep fetching. Stopping is better than looping against a rate limit.
    if (out.length >= 10_000) break;
  }
  return out;
}

/** Best effort. A company file with no readable name is still a usable one. */
export async function fetchQboCompanyName(auth: QboAuth): Promise<string | null> {
  try {
    const res = await qboFetch(auth, `/companyinfo/${auth.realmId}`, { method: "GET" });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const json = (await res.json()) as {
      CompanyInfo?: { CompanyName?: string };
    };
    return json.CompanyInfo?.CompanyName ?? null;
  } catch {
    return null;
  }
}

/** Best effort, on disconnect. Intuit accepts either token type here. */
export async function revokeQboToken(token: string): Promise<boolean> {
  try {
    const { id, secret } = creds();
    const res = await fetchWithTimeout(REVOKE_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ token }),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}
