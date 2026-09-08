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
  /**
   * An account label the grant itself already carried, when it did. Microsoft
   * returns one in the id token, so asking for it separately would mean
   * requesting a profile scope this integration otherwise has no use for. The
   * caller prefers this over calling `accountLabel`.
   */
  accountHint?: string | null;
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
  /**
   * The env-var family this provider's credentials live under. Not always the
   * provider id: OneDrive is reached with a MICROSOFT_* app, because the same
   * app registration also covers Outlook and Teams and naming it ONEDRIVE_*
   * would be a lie about what the operator created.
   */
  envPrefix: string;
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
  envPrefix: "DROPBOX",

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

// ── OneDrive (Microsoft Graph) ──────────────────────────────────────
//
// Files.Read is the narrowest scope that can list and download; there is no
// read-only-plus-nothing-else below it, and nothing here can write. offline_access
// is what returns a refresh token. User.Read is NOT requested: the account label
// comes from the id token's own claims, and asking for a profile scope to print
// an email address on a settings row is not a trade worth making.
//
// PATHS HERE ARE ITEM IDS, not slash-delimited paths. Graph addresses a folder
// by id, ids contain no separator, and CloudEntry.path is opaque by contract —
// which is exactly why the client stopped parsing it when this provider landed.

const ONEDRIVE_SCOPES = "Files.Read offline_access";
const MS_AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MS_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_API = "https://graph.microsoft.com/v1.0";

function microsoftClientId(): string {
  return Deno.env.get("MICROSOFT_CLIENT_ID") ?? "";
}
function microsoftClientSecret(): string {
  return Deno.env.get("MICROSOFT_CLIENT_SECRET") ?? "";
}

interface GraphItem {
  id?: string;
  name?: string;
  size?: number;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
  photo?: { takenDateTime?: string };
  fileSystemInfo?: { createdDateTime?: string; lastModifiedDateTime?: string };
  createdDateTime?: string;
  "@microsoft.graph.downloadUrl"?: string;
}

async function graphGet<T>(accessToken: string, url: string): Promise<T> {
  const res = await cloudFetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`Microsoft Graph failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as T;
}

/** Decode the `name` claim of an id token without verifying it. */
function idTokenLabel(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const body = idToken.split(".")[1];
  if (!body) return null;
  try {
    const json = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(json) as { preferred_username?: string; email?: string };
    // Cosmetic only: it labels a settings row. Nothing is authorised by it, so
    // not verifying the signature costs nothing — and the token came straight
    // from Microsoft's own token endpoint over TLS.
    return claims.preferred_username ?? claims.email ?? null;
  } catch {
    return null;
  }
}

/** Exported for the test: this mapping is where a listing quietly loses files. */
export function graphItemToCloudEntry(item: GraphItem): CloudEntry | null {
  const id = item.id;
  const name = item.name ?? "";
  if (!id || !name) return null;
  if (item.folder) {
    return { id, name, kind: "folder", path: id, sizeBytes: null, capturedAtMs: null };
  }
  if (!item.file) return null;
  if (!isImportableName(name)) return null;
  // takenDateTime is the shutter; the filesystem time is when it reached the
  // drive, which for a phone sync is all one instant.
  const taken = item.photo?.takenDateTime ??
    item.fileSystemInfo?.createdDateTime ??
    item.createdDateTime;
  const ms = taken ? Date.parse(taken) : NaN;
  return {
    id,
    name,
    kind: "file",
    path: id,
    sizeBytes: typeof item.size === "number" ? item.size : null,
    capturedAtMs: Number.isFinite(ms) ? ms : null,
  };
}

export const oneDriveProvider: CloudFolderProvider = {
  id: "onedrive",
  label: "OneDrive",
  envPrefix: "MICROSOFT",

  isConfigured: () => !!(microsoftClientId() && microsoftClientSecret()),

  buildAuthUrl(state, redirectUri) {
    const p = new URLSearchParams({
      client_id: microsoftClientId(),
      redirect_uri: redirectUri,
      response_type: "code",
      response_mode: "query",
      scope: ONEDRIVE_SCOPES,
      state,
    });
    return `${MS_AUTH}?${p.toString()}`;
  },

  async exchangeCode(code, redirectUri) {
    const res = await cloudFetch(MS_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: microsoftClientId(),
        client_secret: microsoftClientSecret(),
        redirect_uri: redirectUri,
        scope: ONEDRIVE_SCOPES,
      }),
    });
    if (!res.ok) throw new Error(`Microsoft token exchange failed (${res.status})`);
    const t = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      id_token?: string;
    };
    if (!t.access_token) throw new Error("Microsoft returned no access token.");
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      expiresInSec: t.expires_in ?? 3600,
      scope: t.scope ?? ONEDRIVE_SCOPES,
      // Carried so accountLabel does not need a second round trip or a wider scope.
      accountHint: idTokenLabel(t.id_token),
    };
  },

  async refresh(refreshToken) {
    const res = await cloudFetch(MS_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: microsoftClientId(),
        client_secret: microsoftClientSecret(),
        scope: ONEDRIVE_SCOPES,
      }),
    });
    if (res.status === 400 || res.status === 401) return null;
    if (!res.ok) throw new Error(`Microsoft refresh failed (${res.status})`);
    const t = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!t.access_token) return null;
    return {
      accessToken: t.access_token,
      // Microsoft ROTATES the refresh token on every use. Keeping the old one
      // would work until it did not, and the seller would be told to reconnect
      // for no reason they could see.
      refreshToken: t.refresh_token ?? refreshToken,
      expiresInSec: t.expires_in ?? 3600,
      scope: null,
    };
  },

  accountLabel(_accessToken) {
    // The label arrives with the grant (see exchangeCode). Asking Graph for
    // /me would need User.Read, a scope this integration has no other use for.
    return Promise.resolve(null);
  },

  async listChildren(accessToken, path) {
    const entries: GraphItem[] = [];
    let url = path
      ? `${GRAPH_API}/me/drive/items/${encodeURIComponent(path)}/children?$top=200`
      : `${GRAPH_API}/me/drive/root/children?$top=200`;
    for (let page = 0; page < 10; page++) {
      const body = await graphGet<{ value?: GraphItem[]; "@odata.nextLink"?: string }>(
        accessToken,
        url,
      );
      for (const item of body.value ?? []) entries.push(item);
      const next = body["@odata.nextLink"];
      if (!next) break;
      url = next;
    }
    return entries.map(graphItemToCloudEntry).filter((e): e is CloudEntry => e !== null);
  },

  async resolveDownload(accessToken, path) {
    const item = await graphGet<GraphItem>(
      accessToken,
      `${GRAPH_API}/me/drive/items/${encodeURIComponent(path)}`,
    );
    const url = item["@microsoft.graph.downloadUrl"];
    if (!url) throw new Error("OneDrive returned no download link.");
    return url;
  },

  // Graph's pre-authenticated download URLs land on the tenant's SharePoint host
  // for work accounts and on the 1drv content hosts for personal ones. Both are
  // Microsoft; nothing else is, and the check runs before the fetch.
  allowHost: (host) =>
    host.endsWith(".sharepoint.com") ||
    host.endsWith(".files.1drv.com") ||
    host.endsWith(".1drv.com") ||
    host.endsWith(".onedrive.com"),
};

const PROVIDERS: Record<CloudProviderId, CloudFolderProvider | null> = {
  dropbox: dropboxProvider,
  onedrive: oneDriveProvider,
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
