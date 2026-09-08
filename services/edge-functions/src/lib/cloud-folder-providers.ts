// US-3159/US-3160: the cloud folders a seller already keeps photos in.
//
// A provider here answers five questions and nothing else: how to get a grant,
// how to refresh it, what is in a folder, where one file's bytes are, and which
// hosts those bytes may come from. Everything that happens to the bytes after
// that belongs to remote-photo-import.ts (US-3157), which is why there is no
// download, no validation and no storage call anywhere in this file.
//
// WHY EVERY PROVIDER RESOLVES A DIRECT LINK instead of streaming through us.
// Dropbox's download endpoint is a POST carrying the bearer token in a header,
// and Graph's is a redirect. Both also publish a short-lived, pre-authenticated
// URL for exactly this case. Using those means the shared core makes a plain
// GET with NO credentials attached, so a provider that returned a hostile URL
// gets nothing worth having — and the host allowlist still refuses it first.
//
// Google Drive is deliberately absent. Its non-restricted scope (drive.file)
// only reaches files picked in a browser-side Picker, so it cannot answer
// `listChildren` from the server at all; see the note on US-3158.

import { fetchWithTimeout } from "./circuit-breaker.ts";

/** The marketplace-client deadline (US-499). A cloud API is no different. */
export const CLOUD_FETCH_TIMEOUT_MS = 20_000;

export const cloudFetch: typeof fetch = (input, init) =>
  fetchWithTimeout(
    input as string | URL | Request,
    (init ?? {}) as RequestInit,
    CLOUD_FETCH_TIMEOUT_MS,
  );

export const CLOUD_PROVIDER_IDS = ["dropbox", "onedrive"] as const;
export type CloudProviderId = (typeof CLOUD_PROVIDER_IDS)[number];

export function isCloudProviderId(v: unknown): v is CloudProviderId {
  return typeof v === "string" && (CLOUD_PROVIDER_IDS as readonly string[]).includes(v);
}

/** What a grant is worth: a durable half and a short-lived half. */
export interface CloudTokenSet {
  refreshToken: string | null;
  accessToken: string;
  /** Seconds. Providers report this differently; normalise here. */
  expiresInSec: number;
  scope: string | null;
}

/** One row in a folder listing. A folder is navigable; a file is importable. */
export interface CloudEntry {
  /** Provider-stable id where there is one, else the path. Names a failure. */
  id: string;
  name: string;
  kind: "folder" | "file";
  /** What listChildren and resolveDownload take back. Opaque to callers. */
  path: string;
  sizeBytes: number | null;
  capturedAtMs: number | null;
}

export interface CloudFolderProvider {
  id: CloudProviderId;
  label: string;
  /** False when the deploy has no client credentials — hide the button. */
  isConfigured(): boolean;
  buildAuthUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<CloudTokenSet>;
  /** null when the provider has revoked the grant, so the caller can deactivate. */
  refresh(refreshToken: string): Promise<CloudTokenSet | null>;
  /** Something the seller recognises, usually an email. Never required. */
  accountLabel(accessToken: string): Promise<string | null>;
  /** `""` is the account root for every provider. */
  listChildren(accessToken: string, path: string): Promise<CloudEntry[]>;
  resolveDownload(accessToken: string, path: string): Promise<string>;
  allowHost(host: string): boolean;
}

/**
 * Extensions the import core can actually accept. It validates by magic bytes
 * and allows jpeg, png and webp, so listing a HEIC here would only produce a
 * per-file failure later. Filtering at the listing is the honest version: the
 * seller is told the folder has photos we cannot read rather than watching them
 * fail one by one.
 */
export const IMPORTABLE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"] as const;

export function isImportableName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return (IMPORTABLE_EXTENSIONS as readonly string[]).includes(ext);
}

/** An image the provider holds but the core cannot read. Counted, not hidden. */
export function isUnreadableImageName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return ["heic", "heif", "tif", "tiff", "gif", "bmp", "avif", "raw", "dng", "cr2", "nef", "arw"]
    .includes(ext);
}

// ── Dropbox ─────────────────────────────────────────────────────────
//
// Scopes are the two narrowest that can do the job: files.metadata.read to see
// what is in a folder and files.content.read to fetch one. Neither can write,
// so a stolen grant cannot alter the seller's Dropbox.

const DROPBOX_SCOPES = "files.metadata.read files.content.read account_info.read";
const DROPBOX_AUTH = "https://www.dropbox.com/oauth2/authorize";
const DROPBOX_TOKEN = "https://api.dropboxapi.com/oauth2/token";
const DROPBOX_API = "https://api.dropboxapi.com/2";

function dropboxClientId(): string {
  return Deno.env.get("DROPBOX_CLIENT_ID") ?? "";
}
function dropboxClientSecret(): string {
  return Deno.env.get("DROPBOX_CLIENT_SECRET") ?? "";
}

interface DropboxEntry {
  ".tag"?: string;
  id?: string;
  name?: string;
  path_lower?: string;
  path_display?: string;
  size?: number;
  client_modified?: string;
  server_modified?: string;
}

async function dropboxRpc<T>(
  accessToken: string,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await cloudFetch(`${DROPBOX_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`Dropbox ${path} failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as T;
}

export const dropboxProvider: CloudFolderProvider = {
  id: "dropbox",
  label: "Dropbox",

  isConfigured: () => !!(dropboxClientId() && dropboxClientSecret()),

  buildAuthUrl(state, redirectUri) {
    const p = new URLSearchParams({
      client_id: dropboxClientId(),
      redirect_uri: redirectUri,
      response_type: "code",
      // offline is what returns a refresh token; without it the grant dies in
      // four hours and the seller reconnects every session.
      token_access_type: "offline",
      scope: DROPBOX_SCOPES,
      state,
    });
    return `${DROPBOX_AUTH}?${p.toString()}`;
  },

  async exchangeCode(code, redirectUri) {
    const res = await cloudFetch(DROPBOX_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: dropboxClientId(),
        client_secret: dropboxClientSecret(),
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) {
      throw new Error(`Dropbox token exchange failed (${res.status})`);
    }
    const t = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!t.access_token) throw new Error("Dropbox returned no access token.");
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      expiresInSec: t.expires_in ?? 14_400,
      scope: t.scope ?? DROPBOX_SCOPES,
    };
  },

  async refresh(refreshToken) {
    const res = await cloudFetch(DROPBOX_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: dropboxClientId(),
        client_secret: dropboxClientSecret(),
      }),
    });
    // A revoked grant answers 400. Returning null rather than throwing lets the
    // caller deactivate the row and ask for a reconnect instead of retrying.
    if (res.status === 400 || res.status === 401) return null;
    if (!res.ok) throw new Error(`Dropbox refresh failed (${res.status})`);
    const t = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!t.access_token) return null;
    return {
      accessToken: t.access_token,
      refreshToken,
      expiresInSec: t.expires_in ?? 14_400,
      scope: null,
    };
  },

  async accountLabel(accessToken) {
    try {
      const me = await dropboxRpc<{ email?: string; name?: { display_name?: string } }>(
        accessToken,
        "/users/get_current_account",
        null,
      );
      return me.email ?? me.name?.display_name ?? null;
    } catch {
      // A missing label is cosmetic. Never fail a connect over it.
      return null;
    }
  },

  async listChildren(accessToken, path) {
    const entries: DropboxEntry[] = [];
    let body: unknown = { path, recursive: false, limit: 2000 };
    let endpoint = "/files/list_folder";
    // Dropbox pages with an opaque cursor rather than an offset.
    for (let page = 0; page < 10; page++) {
      const res = await dropboxRpc<{ entries?: DropboxEntry[]; cursor?: string; has_more?: boolean }>(
        accessToken,
        endpoint,
        body,
      );
      for (const e of res.entries ?? []) entries.push(e);
      if (!res.has_more || !res.cursor) break;
      endpoint = "/files/list_folder/continue";
      body = { cursor: res.cursor };
    }
    return entries.map(dropboxEntryToCloudEntry).filter((e): e is CloudEntry => e !== null);
  },

  async resolveDownload(accessToken, path) {
    const link = await dropboxRpc<{ link?: string }>(
      accessToken,
      "/files/get_temporary_link",
      { path },
    );
    if (!link.link) throw new Error("Dropbox returned no download link.");
    return link.link;
  },

  // get_temporary_link always answers on dropboxusercontent.com. Nothing else
  // is a Dropbox download, and the check runs before the fetch.
  allowHost: (host) =>
    host === "dropboxusercontent.com" || host.endsWith(".dropboxusercontent.com"),
};

/** Exported for the test: the mapping is where a listing quietly loses files. */
export function dropboxEntryToCloudEntry(e: DropboxEntry): CloudEntry | null {
  const name = e.name ?? "";
  const path = e.path_lower ?? e.path_display ?? "";
  if (!name || !path) return null;
  if (e[".tag"] === "folder") {
    return { id: e.id ?? path, name, kind: "folder", path, sizeBytes: null, capturedAtMs: null };
  }
  if (e[".tag"] !== "file") return null;
  if (!isImportableName(name)) return null;
  // client_modified is when the CAMERA wrote it where Dropbox knows; the server
  // time is when it synced, which for a card dump is all one instant.
  const taken = e.client_modified ?? e.server_modified;
  const ms = taken ? Date.parse(taken) : NaN;
  return {
    id: e.id ?? path,
    name,
    kind: "file",
    path,
    sizeBytes: typeof e.size === "number" ? e.size : null,
    capturedAtMs: Number.isFinite(ms) ? ms : null,
  };
}

/** How many images in this listing the import core could not have read. */
export function countUnreadable(entries: readonly { name?: string }[]): number {
  return entries.filter((e) => isUnreadableImageName(e.name ?? "")).length;
}

const PROVIDERS: Record<CloudProviderId, CloudFolderProvider | null> = {
  dropbox: dropboxProvider,
  // US-3160 fills this in. Left explicit rather than absent so the registry
  // shape says what is coming and `getCloudProvider` needs no special case.
  onedrive: null,
};

export function getCloudProvider(id: CloudProviderId): CloudFolderProvider | null {
  return PROVIDERS[id];
}

/** Every provider this build can actually offer. */
export function configuredCloudProviders(): CloudFolderProvider[] {
  return CLOUD_PROVIDER_IDS
    .map((id) => PROVIDERS[id])
    .filter((p): p is CloudFolderProvider => p !== null && p.isConfigured());
}
