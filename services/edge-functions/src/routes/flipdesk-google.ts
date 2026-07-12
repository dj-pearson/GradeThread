import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { encryptToken, decryptToken } from "../lib/crypto-aes.ts";
import { SheetsClient } from "../lib/google-sheets-api.ts";
import {
  MAPPABLE_FIELDS,
  type SheetMap,
  suggestFieldForHeader,
  validateSheetMap,
} from "../lib/sheet-map.ts";

// Google Sheets connection (US-146). A long-lived OAuth grant that lets FlipDesk
// read and write ONE designated "FlipDesk Sync" spreadsheet on the user's Drive.
//
// Scopes: drive.file (per-file — only files this app creates or the user opens
// via the Picker) + spreadsheets. No full-Drive access is requested.
//
// Tokens are stored ENCRYPTED in google_connections (AES-256-GCM, AAD = user_id)
// — same posture as the eBay grant. The refresh token is long-lived; the access
// token is refreshed on demand by getGoogleAccessToken().
//
// Mounted at /api/flipdesk/google. /oauth/callback is PUBLIC (Google redirects
// the browser there unauthenticated; the single-use `state` row identifies the
// user); everything else is user-authed + workspace-scoped.

type GoogleEnv = {
  Variables: {
    userId: string;
    workspaceOwnerId: string;
    workspaceRole: "viewer" | "member" | "listing_manager" | "admin" | "owner";
  };
};

export const flipdeskGoogleRoutes = new Hono<GoogleEnv>();

const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/spreadsheets",
  "openid",
  "email",
].join(" ");
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

// Shared Google OAuth client by default (one client serves every Google
// integration), with an optional GOOGLE_SHEETS_* override so this service can
// point at a different client without disturbing the rest.
function clientId(): string {
  return (
    Deno.env.get("GOOGLE_SHEETS_CLIENT_ID") ??
    Deno.env.get("GOOGLE_CLIENT_ID") ??
    ""
  );
}
function clientSecret(): string {
  return (
    Deno.env.get("GOOGLE_SHEETS_CLIENT_SECRET") ??
    Deno.env.get("GOOGLE_CLIENT_SECRET") ??
    ""
  );
}
function redirectUri(): string {
  return (
    Deno.env.get("GOOGLE_SHEETS_REDIRECT_URI") ??
    "https://functions.gradethread.com/api/flipdesk/google/oauth/callback"
  );
}
function appUrl(path: string): string {
  const base = Deno.env.get("APP_URL")?.replace(/\/$/, "") ?? "https://gradethread.com";
  return `${base}${path}`;
}
export function isGoogleSheetsConfigured(): boolean {
  return !!(clientId() && clientSecret());
}

const SETUP_PATH = "/dashboard/flipdesk/marketplaces/google";

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
    scope: SCOPES,
    state,
    // Long-lived: we need a refresh token to write the sheet on a schedule.
    access_type: "offline",
    // Force the consent screen so Google re-issues a refresh token even on a
    // re-connect (it only returns one on the first grant otherwise).
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

function randomState(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

// Only allow same-origin relative redirect targets (open-redirect guard).
function sanitizeRelativePath(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== "string") return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}

// ── GET /oauth/start ────────────────────────────────────────────────
flipdeskGoogleRoutes.get("/oauth/start", async (c) => {
  if (!isGoogleSheetsConfigured()) {
    return c.json({ error: "Google Sheets sync is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const redirectTo = sanitizeRelativePath(c.req.query("redirect_to"));
  const state = randomState();

  const { error } = await supabaseAdmin.from("google_oauth_states").insert({
    state,
    user_id: userId,
    redirect_to: redirectTo,
  });
  if (error) {
    console.error("[flipdesk-google] failed to persist oauth state:", error.message);
    return c.json({ error: "Could not start Google sign-in." }, 500);
  }

  return c.json({
    consent_url: buildGoogleConsentUrl(state, clientId(), redirectUri()),
  });
});

// ── GET /oauth/callback (PUBLIC) ────────────────────────────────────
flipdeskGoogleRoutes.get("/oauth/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const oauthError = c.req.query("error");

  // Read + delete the single-use state row up front so a code can't be replayed,
  // and so every exit path bounces back to the same claimed destination.
  let redirectTo: string | null = null;
  let stateUserId: string | null = null;
  let stateFound = false;
  let stateExpired = false;
  if (state) {
    const { data: stateRow } = await supabaseAdmin
      .from("google_oauth_states")
      .delete()
      .eq("state", state)
      .select("user_id, redirect_to, expires_at")
      .maybeSingle();
    const row = stateRow as
      | { user_id: string; redirect_to: string | null; expires_at: string }
      | null;
    if (row) {
      stateFound = true;
      redirectTo = sanitizeRelativePath(row.redirect_to);
      stateUserId = row.user_id;
      stateExpired = new Date(row.expires_at).getTime() < Date.now();
    }
  }

  const finish = (status: string) => {
    const base = redirectTo ?? SETUP_PATH;
    const sep = base.includes("?") ? "&" : "?";
    return c.redirect(appUrl(`${base}${sep}google=${encodeURIComponent(status)}`));
  };

  if (oauthError) {
    return finish(oauthError === "access_denied" ? "cancelled" : "error");
  }
  if (!code || !state) return finish("cancelled");
  if (!stateFound || !stateUserId) return finish("invalid_state");
  if (stateExpired) return finish("state_expired");

  try {
    // Exchange the code for tokens.
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
      refresh_token?: string;
      expires_in?: number;
    };
    if (!token.access_token) throw new Error("no access_token in response");

    // Capture the Google account email (non-fatal).
    let email: string | null = null;
    try {
      const infoRes = await fetch(USERINFO_ENDPOINT, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      if (infoRes.ok) {
        email = ((await infoRes.json()) as { email?: string }).email ?? null;
      }
    } catch {
      /* non-fatal — email backfills on next refresh */
    }

    await upsertGoogleConnection({
      userId: stateUserId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresInSeconds: token.expires_in ?? 3600,
      email,
    });
  } catch (err) {
    console.error("[flipdesk-google] OAuth exchange failed:", err instanceof Error ? err.message : err);
    return finish("exchange_failed");
  }

  return finish("connected");
});

// Upsert the per-user Google grant. A re-connect that doesn't return a fresh
// refresh token keeps the existing one (Google only returns it on first grant
// unless prompt=consent forces it — which we do).
async function upsertGoogleConnection(args: {
  userId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  email: string | null;
}): Promise<void> {
  const accessEnc = await encryptToken(args.accessToken, { aad: args.userId });
  const expiresAt = new Date(Date.now() + args.expiresInSeconds * 1000).toISOString();

  const patch: Record<string, unknown> = {
    user_id: args.userId,
    access_token_enc: accessEnc,
    token_expires_at: expiresAt,
    is_active: true,
    sync_error: null,
  };
  if (args.refreshToken) {
    patch.refresh_token_enc = await encryptToken(args.refreshToken, { aad: args.userId });
  }
  if (args.email) patch.google_email = args.email;

  const { error } = await supabaseAdmin
    .from("google_connections")
    .upsert(patch, { onConflict: "user_id" });
  if (error) throw new Error(error.message);
}

interface GoogleConnectionRow {
  id: string;
  user_id: string;
  google_email: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  sheet_id: string | null;
  sheet_url: string | null;
  last_sync_at: string | null;
  sync_status: string;
  sync_error: string | null;
  is_active: boolean;
}

type ConnWithMap = GoogleConnectionRow & { sheet_map: SheetMap | null };

async function loadConnection(userId: string): Promise<ConnWithMap | null> {
  const { data } = await supabaseAdmin
    .from("google_connections")
    .select(
      "id, user_id, google_email, access_token_enc, refresh_token_enc, token_expires_at, sheet_id, sheet_url, last_sync_at, sync_status, sync_error, is_active, sheet_map",
    )
    .eq("user_id", userId)
    .maybeSingle();
  return (data as ConnWithMap | null) ?? null;
}

// Returns a valid access token for the user, refreshing via the refresh token
// when the stored one is within 60s of expiry. Re-encrypts + persists rotated
// tokens. Throws when the grant is missing/revoked so callers surface a reconnect.
export async function getGoogleAccessToken(userId: string): Promise<string> {
  const conn = await loadConnection(userId);
  if (!conn || !conn.is_active) {
    throw new Error("Google is not connected.");
  }

  const expMs = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0;
  if (conn.access_token_enc && expMs - Date.now() > 60_000) {
    return decryptToken(conn.access_token_enc, { aad: userId });
  }

  if (!conn.refresh_token_enc) {
    throw new Error("Google sign-in expired — reconnect required.");
  }
  const refreshToken = await decryptToken(conn.refresh_token_enc, { aad: userId });

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
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    // A revoked/expired grant returns 400 invalid_grant — deactivate so the UI
    // prompts a reconnect instead of retrying forever.
    if (res.status === 400 || res.status === 401) {
      await supabaseAdmin
        .from("google_connections")
        .update({ is_active: false, sync_status: "error", sync_error: "Google access was revoked." })
        .eq("user_id", userId);
    }
    throw new Error(`Google token refresh failed (${res.status}): ${detail}`);
  }
  const token = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };
  if (!token.access_token) throw new Error("Google refresh returned no access_token.");

  const accessEnc = await encryptToken(token.access_token, { aad: userId });
  const update: {
    access_token_enc: string;
    token_expires_at: string;
    refresh_token_enc?: string;
  } = {
    access_token_enc: accessEnc,
    token_expires_at: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(),
  };
  // US-1480: Google may rotate the refresh token on a refresh. Persist the new
  // one (re-encrypted) when present so a later refresh doesn't fail on a stale
  // token and force an avoidable reconnect. When the response omits it (the
  // common case), leave the stored refresh_token_enc untouched.
  if (token.refresh_token) {
    update.refresh_token_enc = await encryptToken(token.refresh_token, { aad: userId });
  }
  await supabaseAdmin
    .from("google_connections")
    .update(update)
    .eq("user_id", userId);
  return token.access_token;
}

// ── GET /connection ─────────────────────────────────────────────────
// Connection status for the SPA (no secrets).
flipdeskGoogleRoutes.get("/connection", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const conn = await loadConnection(userId);
  if (!conn || !conn.is_active) {
    return c.json({ connected: false });
  }
  return c.json({
    connected: true,
    google_email: conn.google_email,
    sheet_id: conn.sheet_id,
    sheet_url: conn.sheet_url,
    has_sheet: !!conn.sheet_id,
    last_sync_at: conn.last_sync_at,
    sync_status: conn.sync_status,
    sync_error: conn.sync_error,
    // "Bring your own sheet": the current column map (null = classic tabs mode).
    sheet_map: conn.sheet_map,
  });
});

// ── GET /config ─────────────────────────────────────────────────────
flipdeskGoogleRoutes.get("/config", (c) =>
  c.json({ configured: isGoogleSheetsConfigured() }),
);

// ── POST /sheet/create ──────────────────────────────────────────────
// Creates a brand-new "FlipDesk Sync" spreadsheet in the user's Drive (owned by
// them; drive.file scope covers files we create) and records it on the grant.
flipdeskGoogleRoutes.post("/sheet/create", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let token: string;
  try {
    token = await getGoogleAccessToken(userId);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Google is not connected." }, 409);
  }

  const res = await fetch(SHEETS_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: { title: "FlipDesk Sync" },
      sheets: [{ properties: { title: "Inventory" } }],
    }),
  });
  if (!res.ok) {
    console.error("[flipdesk-google] sheet create failed:", res.status, (await res.text()).slice(0, 200));
    return c.json({ error: "Could not create the sync sheet." }, 502);
  }
  const sheet = (await res.json()) as { spreadsheetId?: string; spreadsheetUrl?: string };
  if (!sheet.spreadsheetId) {
    return c.json({ error: "Google did not return a spreadsheet id." }, 502);
  }
  const sheetUrl =
    sheet.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit`;

  const { error } = await supabaseAdmin
    .from("google_connections")
    .update({ sheet_id: sheet.spreadsheetId, sheet_url: sheetUrl, sync_status: "idle", sync_error: null })
    .eq("user_id", userId);
  if (error) {
    return c.json({ error: "Sheet created but could not be saved." }, 500);
  }
  return c.json({ ok: true, sheet_id: sheet.spreadsheetId, sheet_url: sheetUrl });
});

// ── POST /sheet/use ─────────────────────────────────────────────────
// Designate an EXISTING spreadsheet (picked via the Drive Picker, or pasted).
// Validates the app can read it under the drive.file grant before saving.
flipdeskGoogleRoutes.post("/sheet/use", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { sheet_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const sheetId = typeof body.sheet_id === "string" ? body.sheet_id.trim() : "";
  // Drive file ids are URL-safe base64-ish tokens; reject anything else so we
  // never build a Sheets API URL from arbitrary input.
  if (!sheetId || !/^[A-Za-z0-9_-]{20,}$/.test(sheetId)) {
    return c.json({ error: "A valid spreadsheet id is required." }, 400);
  }

  let token: string;
  try {
    token = await getGoogleAccessToken(userId);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Google is not connected." }, 409);
  }

  // Confirm access under the drive.file grant. A 403/404 means the user hasn't
  // opened this file with the app (Picker) — the app can't reach it.
  const checkRes = await fetch(
    `${SHEETS_API}/${encodeURIComponent(sheetId)}?fields=spreadsheetId,spreadsheetUrl,properties.title`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (checkRes.status === 403 || checkRes.status === 404) {
    return c.json(
      {
        error:
          "FlipDesk can't access that sheet. Use the picker to select it (which grants per-file access), or create a new sync sheet.",
      },
      403,
    );
  }
  if (!checkRes.ok) {
    return c.json({ error: "Could not verify that sheet." }, 502);
  }
  const meta = (await checkRes.json()) as { spreadsheetId?: string; spreadsheetUrl?: string };
  const sheetUrl =
    meta.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;

  const { error } = await supabaseAdmin
    .from("google_connections")
    .update({ sheet_id: sheetId, sheet_url: sheetUrl, sync_status: "idle", sync_error: null })
    .eq("user_id", userId);
  if (error) {
    return c.json({ error: "Could not save the sheet selection." }, 500);
  }
  return c.json({ ok: true, sheet_id: sheetId, sheet_url: sheetUrl });
});

// ── "Bring your own sheet" mapping (00433) ───────────────────────────

// GET /sheet/tabs — the tab titles in the connected spreadsheet.
flipdeskGoogleRoutes.get("/sheet/tabs", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const conn = await loadConnection(userId);
  if (!conn?.sheet_id) return c.json({ error: "No spreadsheet is connected." }, 409);
  let token: string;
  try {
    token = await getGoogleAccessToken(userId);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Google is not connected." }, 409);
  }
  try {
    const tabs = await new SheetsClient(token, conn.sheet_id).getTabs();
    return c.json({ tabs: tabs.map((t) => t.title) });
  } catch (err) {
    console.error("[flipdesk-google] tab list failed:", err);
    return c.json({ error: "Could not read the spreadsheet tabs." }, 502);
  }
});

// POST /sheet/map/suggest {tab} — read that tab's header row, auto-suggest a
// field for each header, and return the field catalog for the mapping UI.
flipdeskGoogleRoutes.post("/sheet/map/suggest", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const conn = await loadConnection(userId);
  if (!conn?.sheet_id) return c.json({ error: "No spreadsheet is connected." }, 409);
  let body: { tab?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const tab = typeof body.tab === "string" ? body.tab.trim() : "";
  if (!tab) return c.json({ error: "A tab name is required." }, 400);

  let token: string;
  try {
    token = await getGoogleAccessToken(userId);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Google is not connected." }, 409);
  }
  try {
    const range = `'${tab}'!1:1`;
    const rows = (await new SheetsClient(token, conn.sheet_id).batchGetValues([range])).get(range) ?? [];
    const headers = (rows[0] ?? [])
      .map((h) => String(h ?? "").trim())
      .filter((h) => h.length > 0);
    const suggested = headers
      .map((h) => suggestFieldForHeader(h))
      .filter((c): c is NonNullable<typeof c> => c !== null);
    const keyCol = suggested.find((s) => s.role === "key");
    return c.json({
      tab,
      headers,
      fields: MAPPABLE_FIELDS,
      map: {
        tab,
        keyColumn: keyCol?.header ?? "",
        createFromSheet: true,
        columns: suggested,
      },
    });
  } catch (err) {
    console.error("[flipdesk-google] header read failed:", err);
    return c.json({ error: `Could not read the header row of "${tab}".` }, 502);
  }
});

// PUT /sheet/map {map} — validate + save the map (mapped mode). DELETE clears it.
flipdeskGoogleRoutes.put("/sheet/map", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (c.get("workspaceRole") === "viewer") {
    return c.json({ error: "Viewers can't change the sync mapping." }, 403);
  }
  let body: { map?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const map = body.map as SheetMap | undefined;
  if (!map || typeof map !== "object") {
    return c.json({ error: "A map is required." }, 400);
  }
  const errors = validateSheetMap(map);
  if (errors.length > 0) {
    return c.json({ error: errors[0], details: errors }, 400);
  }
  const { error } = await supabaseAdmin
    .from("google_connections")
    .update({ sheet_map: map })
    .eq("user_id", userId);
  if (error) return c.json({ error: "Could not save the mapping." }, 500);
  return c.json({ ok: true });
});

flipdeskGoogleRoutes.delete("/sheet/map", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (c.get("workspaceRole") === "viewer") {
    return c.json({ error: "Viewers can't change the sync mapping." }, 403);
  }
  const { error } = await supabaseAdmin
    .from("google_connections")
    .update({ sheet_map: null })
    .eq("user_id", userId);
  if (error) return c.json({ error: "Could not clear the mapping." }, 500);
  return c.json({ ok: true });
});

// ── POST /disconnect ────────────────────────────────────────────────
// Revoke the grant upstream at Google, then mark inactive locally.
flipdeskGoogleRoutes.post("/disconnect", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const conn = await loadConnection(userId);
  if (!conn) return c.json({ ok: true });

  // Best-effort upstream revoke (revoking the refresh token kills the whole
  // grant). Non-fatal — we always deactivate locally regardless.
  const encToken = conn.refresh_token_enc ?? conn.access_token_enc;
  if (encToken) {
    try {
      const tokenToRevoke = await decryptToken(encToken, { aad: userId });
      await fetch(REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokenToRevoke }),
      });
    } catch (err) {
      console.error("[flipdesk-google] revoke failed (continuing):", err instanceof Error ? err.message : err);
    }
  }

  const { error } = await supabaseAdmin
    .from("google_connections")
    .update({
      is_active: false,
      access_token_enc: null,
      refresh_token_enc: null,
      token_expires_at: null,
      sync_status: "never",
    })
    .eq("user_id", userId);
  if (error) {
    return c.json({ error: "Could not disconnect Google." }, 500);
  }
  return c.json({ ok: true });
});
