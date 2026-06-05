// US-571: APNs push-send infrastructure.
//
// push_device_tokens registration already exists (notifications.ts /register)
// and the iOS app defines 4 notification categories, but no server-side send
// path existed. This module signs a token-based (.p8) ES256 provider JWT and
// delivers pushes over HTTP/2 to Apple, routing dev vs prod by the token's
// stored environment and pruning tokens Apple reports as dead.
//
// Config (all optional — module no-ops cleanly when unset, like email/GSC):
//   APNS_KEY_P8     the .p8 private key PEM (literal newlines or \n-escaped)
//   APNS_KEY_ID     the key's Key ID (10 chars)
//   APNS_TEAM_ID    the Apple Developer Team ID (10 chars)
//   APNS_BUNDLE_ID  the app bundle id → apns-topic (e.g. com.pearsonmedia.gradethread)

import { supabaseAdmin } from "./supabase.ts";

const PROD_HOST = "https://api.push.apple.com";
const SANDBOX_HOST = "https://api.sandbox.push.apple.com";

export interface PushPayload {
  title: string;
  body: string;
  /** Maps to the APNs category (deep-link routing on the client). */
  category?: string;
  /** Custom key/values delivered alongside the aps dictionary. */
  data?: Record<string, unknown>;
  badge?: number;
  sound?: string;
  /** apns-collapse-id — coalesces repeated pushes into one. */
  collapseId?: string;
}

export interface PushTokenResult {
  tokenId: string;
  ok: boolean;
  status: number;
  reason?: string;
}

function apnsConfig(): {
  keyP8: string;
  keyId: string;
  teamId: string;
  bundleId: string;
} | null {
  const keyP8 = Deno.env.get("APNS_KEY_P8");
  const keyId = Deno.env.get("APNS_KEY_ID");
  const teamId = Deno.env.get("APNS_TEAM_ID");
  const bundleId = Deno.env.get("APNS_BUNDLE_ID");
  if (!keyP8 || !keyId || !teamId || !bundleId) return null;
  return { keyP8: keyP8.replace(/\\n/g, "\n"), keyId, teamId, bundleId };
}

export function isApnsConfigured(): boolean {
  return apnsConfig() !== null;
}

// ─── JWT signing (ES256) ────────────────────────────────────────────

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s));
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der;
}

// Provider tokens are valid up to 60 min; refresh well before that. Cached by
// process so we don't re-sign on every push.
let cachedToken: { jwt: string; iat: number; keyId: string } | null = null;
const TOKEN_TTL_SEC = 45 * 60;

async function providerToken(cfg: NonNullable<ReturnType<typeof apnsConfig>>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.keyId === cfg.keyId && now - cachedToken.iat < TOKEN_TTL_SEC) {
    return cachedToken.jwt;
  }
  const header = b64urlStr(JSON.stringify({ alg: "ES256", kid: cfg.keyId }));
  const claims = b64urlStr(JSON.stringify({ iss: cfg.teamId, iat: now }));
  const signingInput = `${header}.${claims}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(cfg.keyP8),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${b64url(new Uint8Array(sig))}`;
  cachedToken = { jwt, iat: now, keyId: cfg.keyId };
  return jwt;
}

// ─── Send ───────────────────────────────────────────────────────────

function buildBody(payload: PushPayload): string {
  const aps: Record<string, unknown> = {
    alert: { title: payload.title, body: payload.body },
    sound: payload.sound ?? "default",
  };
  if (typeof payload.badge === "number") aps.badge = payload.badge;
  if (payload.category) aps.category = payload.category;
  return JSON.stringify({ aps, ...(payload.data ?? {}) });
}

async function sendToToken(
  cfg: NonNullable<ReturnType<typeof apnsConfig>>,
  jwt: string,
  deviceToken: string,
  environment: "development" | "production",
  payload: PushPayload,
): Promise<{ status: number; reason?: string }> {
  const host = environment === "production" ? PROD_HOST : SANDBOX_HOST;
  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    "apns-topic": cfg.bundleId,
    "apns-push-type": "alert",
    "apns-priority": "10",
  };
  if (payload.collapseId) headers["apns-collapse-id"] = payload.collapseId.slice(0, 64);

  try {
    const res = await fetch(`${host}/3/device/${deviceToken}`, {
      method: "POST",
      headers,
      body: buildBody(payload),
    });
    if (res.status === 200) {
      await res.body?.cancel();
      return { status: 200 };
    }
    const text = await res.text().catch(() => "");
    let reason: string | undefined;
    try {
      reason = (JSON.parse(text) as { reason?: string }).reason;
    } catch {
      reason = text || undefined;
    }
    return { status: res.status, reason };
  } catch (err) {
    return { status: 0, reason: err instanceof Error ? err.message : String(err) };
  }
}

// Reasons that mean the token is permanently dead → deactivate it.
const DEAD_REASONS = new Set(["Unregistered", "BadDeviceToken", "DeviceTokenNotForTopic"]);

/**
 * Send a push to every active device of a user. Returns a per-token result
 * set. No-ops (sent=0) when APNs isn't configured — never throws.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<{ configured: boolean; sent: number; failed: number; results: PushTokenResult[] }> {
  const cfg = apnsConfig();
  if (!cfg) return { configured: false, sent: 0, failed: 0, results: [] };

  const { data: tokens } = await supabaseAdmin
    .from("push_device_tokens")
    .select("id, device_token, environment")
    .eq("user_id", userId)
    .eq("is_active", true);

  const rows = (tokens ?? []) as Array<{
    id: string;
    device_token: string;
    environment: "development" | "production";
  }>;
  if (rows.length === 0) return { configured: true, sent: 0, failed: 0, results: [] };

  let jwt: string;
  try {
    jwt = await providerToken(cfg);
  } catch (err) {
    console.error("[apns] provider token signing failed:", err);
    return { configured: true, sent: 0, failed: rows.length, results: [] };
  }

  const results: PushTokenResult[] = [];
  const deadTokenIds: string[] = [];
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    const r = await sendToToken(cfg, jwt, row.device_token, row.environment, payload);
    const ok = r.status === 200;
    results.push({ tokenId: row.id, ok, status: r.status, reason: r.reason });
    if (ok) sent++;
    else {
      failed++;
      if (r.status === 410 || (r.reason && DEAD_REASONS.has(r.reason))) {
        deadTokenIds.push(row.id);
      }
    }
  }

  if (deadTokenIds.length > 0) {
    await supabaseAdmin
      .from("push_device_tokens")
      .update({ is_active: false })
      .in("id", deadTokenIds);
  }

  return { configured: true, sent, failed, results };
}
