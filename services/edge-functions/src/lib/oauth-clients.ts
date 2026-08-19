// US-9120: how a client gets a client_id.
//
// Three ways, in the order the MCP authorization spec prefers them:
//
//   1. CLIENT ID METADATA DOCUMENT. The client_id IS an https URL, and we fetch
//      the client's metadata from it. This is the mechanism the spec now points
//      at, and it needs no registration step at all.
//   2. PRE-REGISTERED. A row someone put there deliberately.
//   3. DYNAMIC REGISTRATION (RFC 7591). DEPRECATED in the MCP authorization
//      spec, kept for clients that cannot do (1).
//
// ── The dangerous part, and why it is guarded the way it is ────────────────
//
// (1) means fetching a URL a stranger supplied, from inside our network. That
// is SSRF with a specification attached to it. Every fetch here goes through
// lib/ssrf.ts's safeFetch, which resolves the host, refuses private and
// link-local addresses, and connects to the IP it cleared rather than
// re-resolving — so DNS cannot change its answer between the check and the
// connection.
//
// The response is also capped and content-type checked before parsing, because
// "fetch an attacker's URL and parse whatever comes back" is the other half of
// the same problem.

import { supabaseAdmin } from "./supabase.ts";
import { safeFetch, SsrfError } from "./ssrf.ts";
import { redactError } from "./log-redact.ts";
import { invalidRedirectUris } from "./oauth-metadata.ts";
import { logEvent } from "./observability.ts";

// deno-lint-ignore no-explicit-any
export type ClientsDb = any;

export interface OAuthClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  registrationSource: "metadata_document" | "dynamic" | "preregistered";
}

export type ClientFailure =
  | { reason: "unknown_client"; message: string }
  | { reason: "metadata_unreachable"; message: string }
  | { reason: "metadata_invalid"; message: string };

export type ClientResult =
  | { ok: true; client: OAuthClient }
  | { ok: false; failure: ClientFailure };

/** A metadata document is a small JSON object. Anything larger is not one. */
const MAX_METADATA_BYTES = 64 * 1024;
const METADATA_TIMEOUT_MS = 5_000;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function toClient(row: Record<string, unknown>): OAuthClient {
  return {
    clientId: String(row.client_id),
    clientName: (row.client_name as string | null) ?? null,
    redirectUris: (row.redirect_uris as string[] | null) ?? [],
    registrationSource: (row.registration_source as OAuthClient["registrationSource"]) ??
      "dynamic",
  };
}

/**
 * Parse and validate a fetched client metadata document.
 *
 * Exported so the validation is testable without a network. The rules are the
 * same ones registration applies, because a client that arrives by URL must not
 * get a laxer redirect check than one that arrives by POST.
 */
export function parseClientMetadata(
  clientId: string,
  raw: unknown,
): ClientResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      failure: { reason: "metadata_invalid", message: "the document is not a JSON object" },
    };
  }
  const doc = raw as Record<string, unknown>;

  // The document must claim the id it was fetched from. Without this, a
  // document at one URL could assert redirect URIs on behalf of another client.
  if (typeof doc.client_id === "string" && doc.client_id !== clientId) {
    return {
      ok: false,
      failure: {
        reason: "metadata_invalid",
        message: "the document declares a different client_id than the URL it came from",
      },
    };
  }

  const redirectUris = Array.isArray(doc.redirect_uris)
    ? doc.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];
  if (redirectUris.length === 0) {
    return {
      ok: false,
      failure: { reason: "metadata_invalid", message: "redirect_uris is required" },
    };
  }

  const bad = invalidRedirectUris(redirectUris);
  if (bad.length > 0) {
    return {
      ok: false,
      failure: {
        reason: "metadata_invalid",
        message: `these redirect_uris are not acceptable: ${bad.join(", ")}`,
      },
    };
  }

  return {
    ok: true,
    client: {
      clientId,
      clientName: typeof doc.client_name === "string" ? doc.client_name : null,
      redirectUris,
      registrationSource: "metadata_document",
    },
  };
}

/**
 * Resolve a client_id to a client.
 *
 * An https client_id is fetched as a metadata document and cached as a row;
 * anything else must already be a row. A stored metadata_document client is
 * re-fetched rather than trusted forever — a client that changes its redirect
 * URIs should not need us to notice, and a stale cached copy is a redirect
 * allowlist nobody is maintaining.
 */
export async function resolveClient(
  clientId: string,
  db: ClientsDb = supabaseAdmin,
  fetcher: typeof safeFetch = safeFetch,
): Promise<ClientResult> {
  if (isHttpsUrl(clientId)) {
    return await resolveMetadataDocument(clientId, db, fetcher);
  }

  const { data, error } = await db
    .from("oauth_clients")
    .select("*")
    .eq("client_id", clientId)
    .maybeSingle();

  if (error || !data) {
    return {
      ok: false,
      failure: {
        reason: "unknown_client",
        message: "that client_id is not registered",
      },
    };
  }
  return { ok: true, client: toClient(data as Record<string, unknown>) };
}

async function resolveMetadataDocument(
  clientId: string,
  db: ClientsDb,
  fetcher: typeof safeFetch,
): Promise<ClientResult> {
  let body: string;
  let contentType: string | null;
  try {
    const response = await fetcher(clientId, {
      maxBytes: MAX_METADATA_BYTES,
      timeoutMs: METADATA_TIMEOUT_MS,
      maxRedirects: 2,
    });
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        failure: {
          reason: "metadata_unreachable",
          message: `the client metadata document answered ${response.status}`,
        },
      };
    }
    contentType = response.contentType;
    body = new TextDecoder().decode(response.bytes);
  } catch (err) {
    if (err instanceof SsrfError) {
      // Logged as a warning rather than an error: this is the guard doing its
      // job, and it is the shape of a probe rather than of a broken client.
      logEvent("warn", "oauth.client_metadata_blocked", { error: redactError(err) });
      return {
        ok: false,
        failure: {
          reason: "metadata_unreachable",
          message: "the client metadata document is not at a reachable public address",
        },
      };
    }
    logEvent("warn", "oauth.client_metadata_fetch_failed", { error: redactError(err) });
    return {
      ok: false,
      failure: {
        reason: "metadata_unreachable",
        message: "could not fetch the client metadata document",
      },
    };
  }

  // Checked BEFORE parsing. A 40KB HTML error page is not a metadata document,
  // and trying to parse one wastes the only thing an attacker controls here.
  if (contentType && !contentType.toLowerCase().includes("json")) {
    return {
      ok: false,
      failure: {
        reason: "metadata_invalid",
        message: "the client metadata document is not JSON",
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      ok: false,
      failure: { reason: "metadata_invalid", message: "the document is not valid JSON" },
    };
  }

  const result = parseClientMetadata(clientId, parsed);
  if (!result.ok) return result;

  // Cache it as a row so the grant and code foreign keys have something to
  // point at. Upsert, because a client that changed its redirect URIs should
  // end up with the new ones rather than the ones we saw first.
  const { error } = await db.from("oauth_clients").upsert({
    client_id: result.client.clientId,
    client_name: result.client.clientName,
    redirect_uris: result.client.redirectUris,
    registration_source: "metadata_document",
    updated_at: new Date().toISOString(),
  });
  if (error) {
    logEvent("error", "oauth.client_cache_failed", { error: redactError(error) });
    return {
      ok: false,
      failure: {
        reason: "metadata_unreachable",
        message: "could not record the client",
      },
    };
  }

  return result;
}
