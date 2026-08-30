import { edgeFetch } from "./edge-fetch";
import type { QboAccount } from "./qbo-mapping";

// US-2997 — the browser half of the QuickBooks connection.
//
// Everything goes through the edge, not supabase-js: the tokens are encrypted
// with a key the browser has never seen, and the chart of accounts is fetched
// from Intuit server-side. The one thing the SPA could read directly is the
// connection row (it has per-user RLS), and it does not, because then the
// status card would have two sources and they would disagree the first time a
// refresh failed.

export interface QboConnectionStatus {
  configured: boolean;
  environment: "sandbox" | "production";
  connected: boolean;
  connection: {
    id: string;
    realm_id: string;
    environment: "sandbox" | "production";
    company_name: string | null;
    token_expires_at: string | null;
    refresh_token_expires_at: string | null;
    refresh_error: string | null;
  } | null;
}

export interface StoredMapping {
  account_code: string;
  qbo_account_id: string;
  qbo_account_name: string | null;
  basis: string;
  updated_at: string;
}

async function errorFrom(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export async function fetchQboStatus(): Promise<QboConnectionStatus> {
  const res = await edgeFetch("/api/flipdesk/qbo/status");
  if (!res.ok) throw new Error(await errorFrom(res, "Couldn't check QuickBooks."));
  return (await res.json()) as QboConnectionStatus;
}

export async function startQboConnect(redirectTo: string): Promise<string> {
  const res = await edgeFetch(
    `/api/flipdesk/qbo/oauth/start?redirect_to=${encodeURIComponent(redirectTo)}`,
  );
  if (!res.ok) throw new Error(await errorFrom(res, "Couldn't start the connection."));
  const body = (await res.json()) as { consent_url?: string };
  if (!body.consent_url) throw new Error("Couldn't start the connection.");
  return body.consent_url;
}

export async function disconnectQbo(): Promise<void> {
  const res = await edgeFetch("/api/flipdesk/qbo/disconnect", {
    method: "POST",
    json: {},
  });
  if (!res.ok) throw new Error(await errorFrom(res, "Couldn't disconnect."));
}

/**
 * The LIVE chart. A 409 means the connection needs reconnecting rather than
 * retrying, and the caller has to be able to tell those apart, so it comes back
 * as a typed flag instead of a message the UI has to pattern-match.
 */
export async function fetchQboAccounts(): Promise<
  { accounts: QboAccount[]; reconnect: false } | { accounts: []; reconnect: true }
> {
  const res = await edgeFetch("/api/flipdesk/qbo/accounts");
  if (res.status === 409) {
    await res.body?.cancel();
    return { accounts: [], reconnect: true };
  }
  if (!res.ok) throw new Error(await errorFrom(res, "Couldn't read your QuickBooks accounts."));
  const body = (await res.json()) as { accounts?: QboAccount[] };
  return { accounts: body.accounts ?? [], reconnect: false };
}

export async function fetchQboMappings(): Promise<StoredMapping[]> {
  const res = await edgeFetch("/api/flipdesk/qbo/mappings");
  if (!res.ok) throw new Error(await errorFrom(res, "Couldn't read your mapping."));
  const body = (await res.json()) as { mappings?: StoredMapping[] };
  return body.mappings ?? [];
}

export async function saveQboMappings(
  mappings: {
    account_code: string;
    qbo_account_id: string | null;
    qbo_account_name?: string | null;
    basis?: string;
  }[],
): Promise<void> {
  const res = await edgeFetch("/api/flipdesk/qbo/mappings", {
    method: "PUT",
    json: { mappings },
  });
  if (!res.ok) throw new Error(await errorFrom(res, "Couldn't save the mapping."));
}
