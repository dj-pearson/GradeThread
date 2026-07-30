import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { encryptToken, decryptToken } from "../lib/crypto-aes.ts";
import { validateImageUpload } from "../lib/upload-validation.ts";
import { stripImageMetadata } from "../lib/image-metadata.ts";

// Google Photos import via the Photos PICKER API (the Library API's
// list-everything access was retired 2025-03-31). The user consents once, picks
// photos in a Google-hosted picker, and we download ONLY what they selected —
// server-side, through the same US-276 validation + EXIF strip as every other
// upload — then stage them into item-photos for AutoLister.
//
// Two token lifetimes:
//   • DURABLE refresh token — stored ENCRYPTED per user in
//     google_photos_connections (migration 00491, offline access). Reused to
//     mint a fresh access token and open the picker DIRECTLY on every import
//     after the first, so the user is NOT dragged through Google's consent
//     screen every time. Cleared automatically if Google reports it revoked.
//   • EPHEMERAL access token + picker session — live on a 30-min session row
//     (migration 00089), long enough to create the picker session and download
//     the picks, then the session row is deleted.
//
// Mounted at /api/flipdesk/google/photos. /oauth/callback is PUBLIC (Google
// redirects the browser there); everything else is user-authed.

type GooglePhotosEnv = {
  Variables: {
    userId: string;
    workspaceOwnerId: string;
    workspaceRole: "viewer" | "member" | "listing_manager" | "admin" | "owner";
  };
};

export const flipdeskGooglePhotosRoutes = new Hono<GooglePhotosEnv>();

const SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const PICKER_API = "https://photospicker.googleapis.com/v1";
const MAX_IMPORT = 100; // bound a single import
const DOWNLOAD_CONCURRENCY = 4;
const IMPORT_MAX_BYTES = 15 * 1024 * 1024;

// Shared Google OAuth client by default (one client can serve every Google
// integration), with an optional per-service override so a specific service can
// point at a different client later without disturbing the rest.
function clientId(): string {
  return (
    Deno.env.get("GOOGLE_PHOTOS_CLIENT_ID") ??
    Deno.env.get("GOOGLE_CLIENT_ID") ??
    ""
  );
}
function clientSecret(): string {
  return (
    Deno.env.get("GOOGLE_PHOTOS_CLIENT_SECRET") ??
    Deno.env.get("GOOGLE_CLIENT_SECRET") ??
    ""
  );
}
function redirectUri(): string {
  return (
    Deno.env.get("GOOGLE_PHOTOS_REDIRECT_URI") ??
    "https://functions.gradethread.com/api/flipdesk/google/photos/oauth/callback"
  );
}
function appUrl(path: string): string {
  const base = Deno.env.get("APP_URL")?.replace(/\/$/, "") ?? "https://gradethread.com";
  return `${base}${path}`;
}
export function isGooglePhotosConfigured(): boolean {
  return !!(clientId() && clientSecret());
}

/** Pure (testable) consent-URL builder. */
export function buildGoogleConsentUrl(
  state: string,
  cId: string,
  redirect: string,
): string {
  const p = new URLSearchParams({
    client_id: cId,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPE,
    state,
    // offline + prompt=consent so Google returns a refresh token we can store
    // and reuse — that's what lets later imports skip this consent screen.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

function randomState(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

// Mint a fresh short-lived access token from a stored refresh token. Returns
// null if Google rejects it (refresh token revoked/expired) — the caller then
// clears the stored connection and falls back to the consent flow.
async function mintAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number } | null> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) return null;
  const t = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!t.access_token) return null;
  return { accessToken: t.access_token, expiresIn: t.expires_in ?? 3600 };
}

// Create a Google Picker session for an access token. Returns null on failure.
async function createPickerSession(
  accessToken: string,
): Promise<{ id: string; pickerUri: string } | null> {
  const res = await fetch(`${PICKER_API}/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!res.ok) return null;
  const p = (await res.json()) as { id?: string; pickerUri?: string };
  if (!p.id || !p.pickerUri) return null;
  return { id: p.id, pickerUri: p.pickerUri };
}

// ── GET /oauth/start ────────────────────────────────────────────────
// Opens an import session. If the user already has a stored Google Photos grant
// (refresh token), we mint an access token + Picker session server-side and
// return `picker_uri` so the SPA opens the Google picker DIRECTLY — no consent
// screen. Otherwise we return `consent_url` for the first-time OAuth dance.
flipdeskGooglePhotosRoutes.get("/oauth/start", async (c) => {
  if (!isGooglePhotosConfigured()) {
    return c.json({ error: "Google Photos import is not configured on this server." }, 503);
  }
  const userId = c.get("userId");
  const ownerId = c.get("workspaceOwnerId") ?? userId;
  const state = randomState();

  const { data, error } = await supabaseAdmin
    .from("google_photos_import_sessions")
    .insert({ user_id: userId, owner_id: ownerId, state, status: "pending" })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[gphotos] session create failed:", error?.message);
    return c.json({ error: "Could not start Google Photos import." }, 500);
  }
  const sessionId = (data as { id: string }).id;

  // Fast path: reuse a stored refresh token to skip Google's consent screen.
  // Tenant scope: the Google grant belongs to the authenticating PERSON, so it
  // is keyed on userId (not the workspace owner). A foreign id can't reach this
  // — the row is looked up strictly by the request's own userId.
  const { data: connRow } = await supabaseAdmin
    .from("google_photos_connections")
    .select("refresh_token_enc")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();
  const refreshEnc = (connRow as { refresh_token_enc?: string } | null)?.refresh_token_enc;
  if (refreshEnc) {
    try {
      const refresh = await decryptToken(refreshEnc, { aad: userId });
      const minted = await mintAccessToken(refresh);
      const picker = minted ? await createPickerSession(minted.accessToken) : null;
      if (minted && picker) {
        const accessTokenEnc = await encryptToken(minted.accessToken, { aad: sessionId });
        const expiresAt = new Date(Date.now() + minted.expiresIn * 1000).toISOString();
        await supabaseAdmin
          .from("google_photos_import_sessions")
          .update({
            status: "picking",
            access_token_enc: accessTokenEnc,
            token_expires_at: expiresAt,
            picker_session_id: picker.id,
            picker_uri: picker.pickerUri,
            error: null,
          })
          .eq("id", sessionId);
        return c.json({ session_id: sessionId, picker_uri: picker.pickerUri });
      }
      // Mint or picker create failed → the grant is likely revoked. Drop it so
      // the consent flow below re-establishes one.
      await supabaseAdmin
        .from("google_photos_connections")
        .delete()
        .eq("user_id", userId);
    } catch (err) {
      console.warn(
        "[gphotos] stored-grant fast path failed, falling back to consent:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return c.json({
    session_id: sessionId,
    consent_url: buildGoogleConsentUrl(state, clientId(), redirectUri()),
  });
});

// ── GET /oauth/callback (PUBLIC) ────────────────────────────────────
// Google redirects the browser here. We exchange the code, create a Picker
// session, and redirect the browser INTO the Google-hosted picker.
flipdeskGooglePhotosRoutes.get("/oauth/callback", async (c) => {
  const state = c.req.query("state");
  const code = c.req.query("code");
  const oauthError = c.req.query("error");

  const fail = (reason: string) =>
    c.redirect(appUrl(`/dashboard/flipdesk/autolister?gphotos=${reason}`));

  if (!state) return fail("error");

  const { data: sessionRow } = await supabaseAdmin
    .from("google_photos_import_sessions")
    .select("id, user_id, status, expires_at")
    .eq("state", state)
    .maybeSingle();
  const session = sessionRow as
    | { id: string; user_id: string; status: string; expires_at: string }
    | null;
  if (!session) return fail("error");
  if (new Date(session.expires_at) < new Date()) return fail("expired");

  if (oauthError || !code) {
    await supabaseAdmin
      .from("google_photos_import_sessions")
      .update({ status: "error", error: oauthError ?? "no_code" })
      .eq("id", session.id);
    return fail(oauthError === "access_denied" ? "denied" : "error");
  }

  try {
    // 1. Exchange the code for a short-lived access token.
    const tokenRes = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId(),
        client_secret: clientSecret(),
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      throw new Error(`token exchange ${tokenRes.status}: ${(await tokenRes.text()).slice(0, 200)}`);
    }
    const token = (await tokenRes.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      scope?: string;
    };
    if (!token.access_token) throw new Error("no access_token in response");

    // Persist the refresh token (offline access) so future imports skip this
    // consent screen. Encrypted with AAD = user_id (per-tenant binding), one row
    // per user (upsert on the unique user_id index). Google only returns a
    // refresh_token on a fresh consent — if absent (e.g. an incremental grant),
    // keep whatever we already stored.
    if (token.refresh_token) {
      const refreshTokenEnc = await encryptToken(token.refresh_token, {
        aad: session.user_id,
      });
      const { error: connErr } = await supabaseAdmin
        .from("google_photos_connections")
        .upsert(
          {
            user_id: session.user_id,
            refresh_token_enc: refreshTokenEnc,
            scope: token.scope ?? SCOPE,
            is_active: true,
          },
          { onConflict: "user_id" },
        );
      if (connErr) {
        // Non-fatal: the import can still proceed on the access token we just
        // got; the user just won't get the skip-consent benefit next time.
        console.warn("[gphotos] could not persist Google grant:", connErr.message);
      }
    }

    const accessTokenEnc = await encryptToken(token.access_token, { aad: session.id });
    const expiresAt = new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString();

    // 2. Create a Picker session.
    const picker = await createPickerSession(token.access_token);
    if (!picker) throw new Error("picker session create failed");

    await supabaseAdmin
      .from("google_photos_import_sessions")
      .update({
        status: "picking",
        access_token_enc: accessTokenEnc,
        token_expires_at: expiresAt,
        picker_session_id: picker.id,
        picker_uri: picker.pickerUri,
        error: null,
      })
      .eq("id", session.id);

    // 3. Send the browser straight into the Google-hosted picker. pickerUri is
    //    a google.com URL; sanitizeRelativePath does NOT apply (it's absolute &
    //    Google-issued), so we redirect to it directly.
    return c.redirect(picker.pickerUri);
  } catch (err) {
    console.error("[gphotos] callback failed:", err instanceof Error ? err.message : err);
    await supabaseAdmin
      .from("google_photos_import_sessions")
      .update({ status: "error", error: "exchange_failed" })
      .eq("id", session.id);
    return fail("error");
  }
});

// Load an owned, non-expired session + its decrypted access token.
async function loadSessionWithToken(
  sessionId: string,
  userId: string,
): Promise<
  | { ok: true; session: Record<string, unknown>; token: string }
  | { ok: false; status: 404 | 409 | 410 | 500; error: string }
> {
  const { data } = await supabaseAdmin
    .from("google_photos_import_sessions")
    .select(
      "id, user_id, owner_id, status, access_token_enc, token_expires_at, picker_session_id, expires_at",
    )
    .eq("id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  const s = data as Record<string, unknown> | null;
  if (!s) return { ok: false, status: 404, error: "Session not found" };
  if (new Date(String(s.expires_at)) < new Date()) {
    return { ok: false, status: 410, error: "This import session expired — start again." };
  }
  if (!s.access_token_enc || !s.picker_session_id) {
    return { ok: false, status: 409, error: "Picker not started yet." };
  }
  if (new Date(String(s.token_expires_at)) < new Date()) {
    return { ok: false, status: 410, error: "Google sign-in expired — start again." };
  }
  let token: string;
  try {
    token = await decryptToken(String(s.access_token_enc), { aad: String(s.id) });
  } catch {
    return { ok: false, status: 500, error: "Could not read the session token." };
  }
  return { ok: true, session: s, token };
}

// ── GET /poll?session=ID ────────────────────────────────────────────
// Has the user finished picking? Asks Google's Picker session.get.
flipdeskGooglePhotosRoutes.get("/poll", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.query("session");
  if (!sessionId) return c.json({ error: "session is required" }, 400);

  const loaded = await loadSessionWithToken(sessionId, userId);
  if (!loaded.ok) return c.json({ ready: false, error: loaded.error }, loaded.status);
  const { session, token } = loaded;
  if (session.status === "ready" || session.status === "imported") {
    return c.json({ ready: true });
  }

  const res = await fetch(`${PICKER_API}/sessions/${session.picker_session_id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    return c.json({ ready: false, error: "Could not check the picker." }, 502);
  }
  const picker = (await res.json()) as { mediaItemsSet?: boolean };
  if (picker.mediaItemsSet) {
    await supabaseAdmin
      .from("google_photos_import_sessions")
      .update({ status: "ready" })
      .eq("id", session.id);
    return c.json({ ready: true });
  }
  return c.json({ ready: false });
});

interface ImportedPhoto {
  url: string;
  storagePath: string;
  width: number | null;
  height: number | null;
  bytes: number;
  capturedAtMs: number | null;
}

// ── POST /import?session=ID ─────────────────────────────────────────
// Download the picked photos server-side, validate + strip EXIF, stage them.
flipdeskGooglePhotosRoutes.post("/import", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.query("session");
  if (!sessionId) return c.json({ error: "session is required" }, 400);

  const loaded = await loadSessionWithToken(sessionId, userId);
  if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status);
  const { session, token } = loaded;
  const ownerId = String(session.owner_id);

  // List the user's picked media items (paginated, capped).
  interface PickerMediaItem {
    id: string;
    type?: string;
    createTime?: string;
    mediaFile?: { baseUrl?: string; mimeType?: string };
  }
  const items: PickerMediaItem[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${PICKER_API}/mediaItems`);
    url.searchParams.set("sessionId", String(session.picker_session_id));
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return c.json({ error: "Could not list the picked photos." }, 502);
    }
    const body = (await res.json()) as {
      mediaItems?: PickerMediaItem[];
      nextPageToken?: string;
    };
    for (const m of body.mediaItems ?? []) items.push(m);
    pageToken = body.nextPageToken;
  } while (pageToken && items.length < MAX_IMPORT);

  const photos = items
    .filter((m) => (m.type ?? "PHOTO") === "PHOTO" && m.mediaFile?.baseUrl)
    .slice(0, MAX_IMPORT);

  const imported: ImportedPhoto[] = [];
  const errors: string[] = [];

  async function importOne(m: PickerMediaItem): Promise<void> {
    try {
      // US-579: the baseUrl comes from the Picker response, not a hardcoded
      // googleapis host. We attach the user's Google bearer token to the
      // download, so a poisoned/spoofed baseUrl pointing at an attacker host
      // would exfiltrate that token. Validate the host is a real Google photo
      // host BEFORE fetching; reject anything else.
      const baseUrl = m.mediaFile?.baseUrl;
      if (!baseUrl) throw new Error("invalid baseUrl");
      let host: string;
      try {
        host = new URL(baseUrl).hostname.toLowerCase();
      } catch {
        throw new Error("invalid baseUrl");
      }
      const allowedHost = host === "googleusercontent.com" ||
        host === "google.com" ||
        host.endsWith(".googleusercontent.com") ||
        host.endsWith(".google.com");
      if (!allowedHost) {
        throw new Error(`refused non-Google baseUrl host: ${host}`);
      }
      // Sized download returns a JPEG (Google transcodes sized variants), so we
      // never have to decode HEIC server-side.
      const res = await fetch(`${baseUrl}=w2400-h2400`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`download ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());

      const valid = validateImageUpload(bytes, {
        allow: ["jpeg", "png", "webp"],
        maxBytes: IMPORT_MAX_BYTES,
      });
      if (!valid.ok) throw new Error(valid.reason);

      const clean = stripImageMetadata(bytes, valid.format);
      const id = crypto.randomUUID();
      const path = `${ownerId}/_staging/gphotos/${id}.${valid.ext}`;
      const { error: upErr } = await supabaseAdmin.storage
        .from("item-photos")
        .upload(path, clean.bytes, { upsert: false, contentType: valid.contentType });
      if (upErr) throw new Error(upErr.message);

      // item-photo-url-ok: a staging/just-uploaded object in the public bucket,
      // not an item_photos row — there is no private variant to resolve.
      const url = supabaseAdmin.storage.from("item-photos").getPublicUrl(path).data.publicUrl;
      const createMs = m.createTime ? Date.parse(m.createTime) : NaN;
      imported.push({
        url,
        storagePath: path,
        width: valid.width,
        height: valid.height,
        bytes: clean.bytes.length,
        capturedAtMs: Number.isFinite(createMs) ? createMs : null,
      });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  for (let i = 0; i < photos.length; i += DOWNLOAD_CONCURRENCY) {
    await Promise.all(photos.slice(i, i + DOWNLOAD_CONCURRENCY).map(importOne));
  }

  // One-shot: consume the session so the token can't be reused.
  await supabaseAdmin
    .from("google_photos_import_sessions")
    .delete()
    .eq("id", session.id);

  return c.json({ photos: imported, imported: imported.length, errors: errors.length });
});

// ── GET /config ─────────────────────────────────────────────────────
// Lets the SPA show/hide the "Import from Google Photos" button.
flipdeskGooglePhotosRoutes.get("/config", (c) =>
  c.json({ configured: isGooglePhotosConfigured() }),
);
