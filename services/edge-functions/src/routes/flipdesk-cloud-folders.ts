// US-3159/US-3160: import photos from a folder the seller already keeps.
//
// Mounted at /api/flipdesk/cloud. One module, one route table, N providers —
// the provider-shaped half lives in lib/cloud-folder-providers.ts and the
// bytes-shaped half in lib/remote-photo-import.ts, so what is left here is the
// grant, the tenancy and the paging.
//
// TENANCY (US-268), and the split is deliberate. The GRANT belongs to the
// authenticating PERSON, so cloud_storage_connections is keyed on `userId` —
// a workspace member connects their own Dropbox and a colleague never inherits
// it. The staged PHOTO belongs to the WORKSPACE, so the storage path uses
// `workspaceOwnerId ?? userId`, which is what the per-user-folder storage RLS
// reads. This is exactly the split flipdesk-google-photos.ts already makes; the
// two ids are not interchangeable and a query that swapped them would either
// hand one member another member's grant or write a photo where the owner
// cannot see it. tenant-isolation_test.ts pins both directions.
//
// /oauth/callback is PUBLIC: the provider redirects the browser back with no
// session, and the single-use state row is the only thing that says whose flow
// this is. It is deleted the moment it is spent.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { decryptToken, encryptToken } from "../lib/crypto-aes.ts";
import {
  cloudFetch,
  type CloudEntry,
  type CloudFolderProvider,
  configuredCloudProviders,
  countUnreadable,
  getCloudProvider,
  isCloudProviderId,
} from "../lib/cloud-folder-providers.ts";
import {
  importRemotePhotos,
  MAX_IMPORT,
  planImportChunk,
  type RemotePhotoFile,
} from "../lib/remote-photo-import.ts";
import { itemPhotoStaging } from "../lib/photo-staging-storage.ts";

type CloudEnv = {
  Variables: {
    userId: string;
    workspaceOwnerId: string;
    workspaceRole: "viewer" | "member" | "listing_manager" | "admin" | "owner";
  };
};

export const flipdeskCloudFolderRoutes = new Hono<CloudEnv>();

/** How long a half-finished OAuth round trip stays valid. */
const STATE_TTL_MS = 10 * 60 * 1000;

function appUrl(path: string): string {
  const base = Deno.env.get("APP_URL")?.replace(/\/$/, "") ?? "https://gradethread.com";
  return `${base}${path}`;
}

// Same shape as GOOGLE_PHOTOS_REDIRECT_URI: a hardcoded production default with
// a per-provider override, so a staging deploy points its own callback back at
// itself without a new concept. The URI is registered with the provider, so it
// must match theirs EXACTLY, trailing slash and all.
function callbackUri(provider: CloudFolderProvider): string {
  return (
    Deno.env.get(`${provider.envPrefix}_REDIRECT_URI`) ??
      `https://functions.gradethread.com/api/flipdesk/cloud/${provider.id}/oauth/callback`
  );
}

function randomState(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

/** The provider named in the path, or null. Never trusts the string itself. */
function providerFromPath(raw: string): CloudFolderProvider | null {
  if (!isCloudProviderId(raw)) return null;
  return getCloudProvider(raw);
}

interface ConnectionRow {
  id: string;
  refresh_token_enc: string | null;
  access_token_enc: string | null;
  token_expires_at: string | null;
  account_label: string | null;
  is_active: boolean;
}

async function loadConnection(
  userId: string,
  providerId: string,
): Promise<ConnectionRow | null> {
  const { data } = await supabaseAdmin
    .from("cloud_storage_connections")
    .select("id, refresh_token_enc, access_token_enc, token_expires_at, account_label, is_active")
    .eq("user_id", userId)
    .eq("provider", providerId)
    .maybeSingle();
  return (data as ConnectionRow | null) ?? null;
}

/** Why an access token could not be produced, in words a seller can act on. */
type TokenFailure = { status: 409 | 502; error: string };

async function accessTokenFor(
  provider: CloudFolderProvider,
  userId: string,
): Promise<{ ok: true; token: string } | { ok: false } & TokenFailure> {
  const conn = await loadConnection(userId, provider.id);
  if (!conn || !conn.is_active) {
    return { ok: false, status: 409, error: `${provider.label} is not connected.` };
  }

  const expMs = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0;
  if (conn.access_token_enc && expMs - Date.now() > 60_000) {
    return { ok: true, token: await decryptToken(conn.access_token_enc, { aad: userId }) };
  }

  if (!conn.refresh_token_enc) {
    return {
      ok: false,
      status: 409,
      error: `Your ${provider.label} sign-in expired. Connect it again.`,
    };
  }

  const refreshToken = await decryptToken(conn.refresh_token_enc, { aad: userId });
  let next;
  try {
    next = await provider.refresh(refreshToken);
  } catch {
    return { ok: false, status: 502, error: `${provider.label} did not answer. Try again.` };
  }
  if (!next) {
    // Revoked at the provider. Deactivate so the UI asks for a reconnect
    // instead of retrying a grant that will never work again.
    await supabaseAdmin
      .from("cloud_storage_connections")
      .update({ is_active: false })
      .eq("user_id", userId)
      .eq("provider", provider.id);
    return {
      ok: false,
      status: 409,
      error: `${provider.label} access was revoked. Connect it again.`,
    };
  }

  await supabaseAdmin
    .from("cloud_storage_connections")
    .update({
      access_token_enc: await encryptToken(next.accessToken, { aad: userId }),
      token_expires_at: new Date(Date.now() + next.expiresInSec * 1000).toISOString(),
    })
    .eq("user_id", userId)
    .eq("provider", provider.id);

  return { ok: true, token: next.accessToken };
}

// ── GET /providers ──────────────────────────────────────────────────
// What this deploy can offer and what this seller has already connected. The
// SPA renders a button per row, so an unconfigured provider is simply absent
// rather than a button that cannot work.
flipdeskCloudFolderRoutes.get("/providers", async (c) => {
  const userId = c.get("userId");
  const available = configuredCloudProviders();
  if (available.length === 0) return c.json({ providers: [] });

  const { data } = await supabaseAdmin
    .from("cloud_storage_connections")
    .select("provider, account_label, is_active")
    .eq("user_id", userId);
  const rows = (data ?? []) as { provider: string; account_label: string | null; is_active: boolean }[];

  return c.json({
    providers: available.map((p) => {
      const row = rows.find((r) => r.provider === p.id);
      return {
        id: p.id,
        label: p.label,
        connected: !!row?.is_active,
        accountLabel: row?.account_label ?? null,
      };
    }),
  });
});

// ── GET /:provider/oauth/start ──────────────────────────────────────
flipdeskCloudFolderRoutes.get("/:provider/oauth/start", async (c) => {
  const provider = providerFromPath(c.req.param("provider"));
  if (!provider) return c.json({ error: "Unknown cloud provider." }, 404);
  if (!provider.isConfigured()) {
    return c.json({ error: `${provider.label} import is not configured on this server.` }, 503);
  }

  const userId = c.get("userId");
  const ownerId = c.get("workspaceOwnerId") ?? userId;
  const state = randomState();

  const { error } = await supabaseAdmin.from("cloud_storage_oauth_states").insert({
    state,
    user_id: userId,
    owner_id: ownerId,
    provider: provider.id,
    expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });
  if (error) {
    console.error("[cloud] state insert failed:", error.message);
    return c.json({ error: `Could not start the ${provider.label} connection.` }, 500);
  }

  return c.json({ consent_url: provider.buildAuthUrl(state, callbackUri(provider)) });
});

// ── GET /:provider/oauth/callback (PUBLIC) ──────────────────────────
flipdeskCloudFolderRoutes.get("/:provider/oauth/callback", async (c) => {
  const provider = providerFromPath(c.req.param("provider"));
  const done = (status: string) =>
    c.redirect(appUrl(`/dashboard/flipdesk/intake?cloud=${status}`));
  if (!provider) return done("unknown");

  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return done("denied");

  // Spend the state row first: read it, then delete it, so a replayed callback
  // finds nothing even if the exchange below is slow.
  const { data } = await supabaseAdmin
    .from("cloud_storage_oauth_states")
    .select("user_id, provider, expires_at")
    .eq("state", state)
    .maybeSingle();
  const row = data as { user_id: string; provider: string; expires_at: string } | null;
  await supabaseAdmin.from("cloud_storage_oauth_states").delete().eq("state", state);

  if (!row || row.provider !== provider.id) return done("expired");
  if (new Date(row.expires_at).getTime() < Date.now()) return done("expired");

  let tokens;
  try {
    tokens = await provider.exchangeCode(code, callbackUri(provider));
  } catch (err) {
    console.error("[cloud] token exchange failed:", err instanceof Error ? err.message : err);
    return done("failed");
  }

  // A grant that already carried a label (Microsoft's id token) is preferred
  // over a second round trip that would need a wider scope to make.
  const label = tokens.accountHint ?? await provider.accountLabel(tokens.accessToken);
  const { error } = await supabaseAdmin
    .from("cloud_storage_connections")
    .upsert(
      {
        user_id: row.user_id,
        provider: provider.id,
        account_label: label,
        refresh_token_enc: tokens.refreshToken
          ? await encryptToken(tokens.refreshToken, { aad: row.user_id })
          : null,
        access_token_enc: await encryptToken(tokens.accessToken, { aad: row.user_id }),
        token_expires_at: new Date(Date.now() + tokens.expiresInSec * 1000).toISOString(),
        scope: tokens.scope,
        is_active: true,
      },
      { onConflict: "user_id,provider" },
    );
  if (error) {
    console.error("[cloud] connection upsert failed:", error.message);
    return done("failed");
  }
  return done("connected");
});

// ── GET /:provider/list?path= ───────────────────────────────────────
// One folder: its subfolders and the images in it. `path` empty is the root.
flipdeskCloudFolderRoutes.get("/:provider/list", async (c) => {
  const provider = providerFromPath(c.req.param("provider"));
  if (!provider) return c.json({ error: "Unknown cloud provider." }, 404);

  const userId = c.get("userId");
  const token = await accessTokenFor(provider, userId);
  if (!token.ok) return c.json({ error: token.error }, token.status);

  const path = c.req.query("path") ?? "";
  let entries: CloudEntry[];
  try {
    entries = await provider.listChildren(token.token, path);
  } catch (err) {
    console.error("[cloud] list failed:", err instanceof Error ? err.message : err);
    return c.json({ error: `Could not read that ${provider.label} folder.` }, 502);
  }

  const folders = entries.filter((e) => e.kind === "folder");
  const files = entries.filter((e) => e.kind === "file");
  return c.json({
    path,
    folders,
    files: files.slice(0, MAX_IMPORT),
    // Named rather than silent: a folder of iPhone HEICs otherwise looks empty
    // and the seller has no idea why.
    unreadable: countUnreadable(entries),
    truncated: files.length > MAX_IMPORT,
  });
});

// ── POST /:provider/import?offset=&limit= ───────────────────────────
// One CHUNK of the chosen files. The client walks offset forward until `done`,
// the same contract the Google Photos import uses.
flipdeskCloudFolderRoutes.post("/:provider/import", async (c) => {
  const provider = providerFromPath(c.req.param("provider"));
  if (!provider) return c.json({ error: "Unknown cloud provider." }, 404);

  const userId = c.get("userId");
  const ownerId = c.get("workspaceOwnerId") ?? userId;

  const body = await c.req.json().catch(() => null) as { paths?: unknown } | null;
  const paths = Array.isArray(body?.paths)
    ? body.paths.filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];
  if (paths.length === 0) return c.json({ error: "No files were chosen." }, 400);

  const token = await accessTokenFor(provider, userId);
  if (!token.ok) return c.json({ error: token.error }, token.status);

  const total = Math.min(paths.length, MAX_IMPORT);
  const { offset, end, nextOffset, done } = planImportChunk(
    total,
    c.req.query("offset"),
    c.req.query("limit"),
  );
  const chunk = paths.slice(0, MAX_IMPORT).slice(offset, end);

  // Resolving the short-lived direct link is a per-file call, so a file that is
  // gone fails HERE rather than poisoning the whole chunk.
  const files: RemotePhotoFile[] = [];
  const failures: { id: string; reason: string }[] = [];
  for (const path of chunk) {
    try {
      files.push({ id: path, url: await provider.resolveDownload(token.token, path) });
    } catch (err) {
      failures.push({ id: path, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const result = await importRemotePhotos(files, {
    ownerId,
    stagingKey: provider.id,
    storage: itemPhotoStaging(),
    allowHost: provider.allowHost,
    fetchFn: cloudFetch,
  });

  return c.json({
    photos: result.photos,
    imported: result.photos.length,
    errors: result.failures.length + failures.length,
    total,
    offset,
    nextOffset,
    done,
  });
});

// ── POST /:provider/disconnect ──────────────────────────────────────
flipdeskCloudFolderRoutes.post("/:provider/disconnect", async (c) => {
  const provider = providerFromPath(c.req.param("provider"));
  if (!provider) return c.json({ error: "Unknown cloud provider." }, 404);

  const userId = c.get("userId");
  // Delete rather than deactivate: the row's only content is a credential, and
  // a disconnect that leaves the token behind is not a disconnect.
  const { error } = await supabaseAdmin
    .from("cloud_storage_connections")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider.id);
  if (error) return c.json({ error: "Could not disconnect." }, 500);
  return c.json({ ok: true });
});
