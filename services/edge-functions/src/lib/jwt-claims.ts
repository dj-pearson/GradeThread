// Supabase auth-assurance claims (US-270).
//
// Supabase/GoTrue access tokens carry an authenticator-assurance level (`aal`)
// and an authentication-methods-reference list (`amr`: [{ method, timestamp }]).
// AAL2 means MFA was satisfied this session; a fresh `amr` entry for an MFA
// method is how we prove a recent step-up re-auth before a destructive action.
//
// These helpers are PURE (decode + predicates) so the assurance logic is
// unit-testable without a live auth server. The token's SIGNATURE is verified
// upstream by supabaseAdmin.auth.getUser() in authMiddleware — we only decode
// the (already-validated) payload here to read claims.

export interface AmrEntry {
  method: string;
  timestamp: number; // unix seconds
}

export interface AuthAssuranceClaims {
  aal: string | null; // "aal1" | "aal2" | null
  amr: AmrEntry[];
}

// MFA / strong-auth methods that count as a step-up factor (not "password").
const MFA_METHODS = new Set(["totp", "mfa", "otp", "phone", "webauthn"]);

function base64UrlDecode(seg: string): string {
  let s = seg.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad === 2) s += "==";
  else if (pad === 3) s += "=";
  else if (pad === 1) return ""; // malformed
  try {
    return atob(s);
  } catch {
    return "";
  }
}

// Decode the claims of a JWT (no signature check — done upstream). Returns safe
// defaults (aal:null, amr:[]) for anything malformed.
export function decodeJwtClaims(token: string): AuthAssuranceClaims {
  const parts = (token ?? "").split(".");
  if (parts.length < 2) return { aal: null, amr: [] };
  const json = base64UrlDecode(parts[1] ?? "");
  if (!json) return { aal: null, amr: [] };
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(json);
  } catch {
    return { aal: null, amr: [] };
  }
  const aal = typeof payload.aal === "string" ? payload.aal : null;
  const amr: AmrEntry[] = [];
  if (Array.isArray(payload.amr)) {
    for (const e of payload.amr) {
      if (e && typeof e === "object") {
        const m = (e as Record<string, unknown>).method;
        const t = (e as Record<string, unknown>).timestamp;
        if (typeof m === "string" && typeof t === "number") {
          amr.push({ method: m, timestamp: t });
        }
      }
    }
  }
  return { aal, amr };
}

export function isAal2(claims: AuthAssuranceClaims): boolean {
  return claims.aal === "aal2";
}

// The most recent MFA-method timestamp in the amr (unix seconds), or null.
export function latestMfaAuthAt(claims: AuthAssuranceClaims): number | null {
  let latest: number | null = null;
  for (const e of claims.amr) {
    if (MFA_METHODS.has(e.method)) {
      if (latest === null || e.timestamp > latest) latest = e.timestamp;
    }
  }
  return latest;
}

// True when the session is AAL2 AND an MFA factor was exercised within
// maxAgeSec — i.e. a valid step-up for a destructive action.
export function hasFreshStepUp(
  claims: AuthAssuranceClaims,
  maxAgeSec: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!isAal2(claims)) return false;
  const at = latestMfaAuthAt(claims);
  if (at === null) return false;
  return nowSec - at <= maxAgeSec;
}
