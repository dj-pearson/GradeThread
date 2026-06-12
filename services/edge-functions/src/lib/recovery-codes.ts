// US-374: MFA backup / recovery codes.
//
// Supabase/GoTrue TOTP has no built-in recovery-code path, so we implement our
// own: at generation we hand the user N single-use codes and persist only their
// SHA-256 hashes (`mfa_recovery_codes`). If the user later loses their
// authenticator, they sign in with their password (an AAL1 session) and consume
// a code, which unenrolls their stale TOTP factor server-side so they can
// re-enroll a new device.
//
// The hashing + normalization are PURE (crypto.subtle is available in the edge
// runtime) so they're unit-testable without a DB.

const CODE_COUNT = 10;
// Crockford-ish alphabet: no 0/O/1/I/L to keep hand-typed codes unambiguous.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const GROUP = 4; // chars per group → "XXXX-XXXX"

// Normalize for hashing/compare: uppercase, strip everything but the alphabet
// (so a user can type spaces/dashes/lowercase and still match).
export function normalizeRecoveryCode(input: string): string {
  return (input ?? "")
    .toUpperCase()
    .split("")
    .filter((ch) => ALPHABET.includes(ch))
    .join("");
}

// SHA-256 hex of the normalized code. Same code → same hash, always.
export async function hashRecoveryCode(input: string): Promise<string> {
  const normalized = normalizeRecoveryCode(input);
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Generate `count` formatted plaintext codes (e.g. "ABCD-2345"). Uses the CSPRNG
// (crypto.getRandomValues) with rejection sampling to avoid modulo bias.
export function generateRecoveryCodes(count: number = CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(formatCode(randomChars(GROUP * 2)));
  }
  return codes;
}

function formatCode(raw: string): string {
  return `${raw.slice(0, GROUP)}-${raw.slice(GROUP)}`;
}

function randomChars(n: number): string {
  const out: string[] = [];
  const max = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  const buf = new Uint8Array(1);
  while (out.length < n) {
    crypto.getRandomValues(buf);
    const v = buf[0];
    if (v < max) out.push(ALPHABET[v % ALPHABET.length]);
  }
  return out.join("");
}
