// No-login email unsubscribe tokens (US-516 / CAN-SPAM).
//
// Commercial email must offer an unsubscribe that works WITHOUT logging in. We
// put a signed token in the footer link; the public /unsubscribe endpoint
// verifies it and flips the recipient's marketing (product_updates) preference.
// The token is an HMAC over the user id so it can't be forged to unsubscribe
// someone else, and carries no secret itself.
//
// Signing key: UNSUBSCRIBE_SECRET if set, else the service-role key (always
// present, secret, server-only). Either way the token is opaque + unforgeable.

const SITE_URL = "https://gradethread.com";

function signingKey(): string {
  return (
    Deno.env.get("UNSUBSCRIBE_SECRET")?.trim() ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ||
    Deno.env.get("SUPABASE_SERVICE_KEY")?.trim() ||
    "dev-unsubscribe-key"
  );
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(userId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`unsub:${userId}`));
  return toHex(mac);
}

export async function unsubscribeToken(userId: string): Promise<string> {
  return await hmac(userId);
}

// Constant-time compare so a wrong token can't be probed byte-by-byte.
export async function verifyUnsubscribeToken(userId: string, token: string): Promise<boolean> {
  const expected = await hmac(userId);
  if (typeof token !== "string" || token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

// The footer link. Points at the edge unsubscribe endpoint so it works with no
// session and no SPA round-trip.
export async function marketingUnsubscribeUrl(userId: string): Promise<string> {
  const token = await unsubscribeToken(userId);
  const base = Deno.env.get("FUNCTIONS_URL")?.trim() || "https://functions.gradethread.com";
  return `${base}/api/notifications/unsubscribe?u=${encodeURIComponent(userId)}&t=${token}`;
}

// The no-login email-preference center (US-911): a recipient can fine-tune
// individual marketing categories or unsubscribe-all WITHOUT a session. Gated by
// the SAME HMAC token as the one-click unsubscribe (over the user id), so it
// can't be forged for another recipient. Points at the edge endpoint that
// renders + saves the preferences.
export async function marketingPreferenceCenterUrl(userId: string): Promise<string> {
  const token = await unsubscribeToken(userId);
  const base = Deno.env.get("FUNCTIONS_URL")?.trim() || "https://functions.gradethread.com";
  return `${base}/api/notifications/preferences?u=${encodeURIComponent(userId)}&t=${token}`;
}

// In-app (authenticated) preference center — the SPA settings page. Used where a
// recipient already has a session (e.g. links in the app, not email footers).
export function accountPreferenceCenterUrl(): string {
  // US-2102: this pointed at /dashboard/account#email-preferences. BOTH halves
  // were wrong: the preference UI lives on /dashboard/settings (the notifications
  // tab), not the account page, and no #email-preferences anchor existed
  // anywhere in the frontend. A user clicking "manage preferences" from an
  // unsubscribe confirmation landed on the wrong page with no such section —
  // which is a compliance problem the moment lifecycle email is switched on,
  // because the opt-out path we advertise has to actually work.
  //
  // The tab is deep-linkable via ?tab=, and the anchor now exists on the email
  // preferences block, so this resolves to the real control rather than the
  // top of an unrelated page.
  return `${SITE_URL}/dashboard/settings?tab=notifications#email-preferences`;
}

export { SITE_URL };
