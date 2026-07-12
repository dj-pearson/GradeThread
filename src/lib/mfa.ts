import { supabase } from "@/lib/supabase";

// Shared TOTP challenge→verify with IPv6-mismatch resilience.
//
// GoTrue binds each MFA challenge to the IP that CREATED it and rejects the
// verify (422, code `mfa_ip_address_mismatch`) when the verifying request
// egresses from a different IP. The check reads the first `X-Forwarded-For`
// entry and is hardcoded server-side — no env flag disables it. With IPv6
// (rotating RFC 4941 privacy/temporary addresses, or dual-stack Happy Eyeballs
// opening a fresh connection for the verify), the challenge POST and the verify
// POST can leave from different source addresses, so a SINGLE attempt flakes.
//
// The guaranteed fix normalises the client IP the GoTrue container sees at the
// proxy (see docs/runbooks/mfa-ipv6-ip-mismatch.md). This helper is the client
// half: re-running challenge→verify as one tight unit re-stamps the challenge IP
// immediately before the verify, so the retry's verify reuses the just-warmed
// keep-alive connection and usually carries the same source IP — the transient
// case self-heals. A wrong TOTP code is surfaced immediately (never retried).

/** True when an error is GoTrue's MFA challenge/verify IP-address mismatch. */
export function isMfaIpMismatch(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; status?: number; message?: string };
  if (e.code === "mfa_ip_address_mismatch") return true;
  return (
    e.status === 422 &&
    typeof e.message === "string" &&
    /ip address(?:es)? mismatch/i.test(e.message)
  );
}

const IP_MISMATCH_MESSAGE =
  "Your network changed IP address between requesting and confirming the code " +
  "(this is common with IPv6 or a VPN). Please try again — if it keeps failing, " +
  "turn off IPv6 or your VPN for this sign-in, or contact support.";

/**
 * Create a fresh TOTP challenge for `factorId` and verify `code` against it,
 * retrying the whole unit when GoTrue reports an IP-address mismatch. On
 * success the session is elevated to AAL2 (and carries a fresh `amr` timestamp
 * for step-up). Throws on a genuine failure (wrong code, expired factor, or a
 * persistent IP mismatch after all retries — the last surfaced with a clear,
 * actionable message rather than GoTrue's raw string).
 */
export async function challengeAndVerifyTotp(
  factorId: string,
  code: string,
  { retries = 3 }: { retries?: number } = {},
): Promise<void> {
  const trimmed = code.trim();
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ch = await supabase.auth.mfa.challenge({ factorId });
    if (ch.error) {
      lastErr = ch.error;
      // A mismatch can't surface on challenge (it stamps the IP), but any other
      // challenge error is terminal.
      throw ch.error;
    }

    const v = await supabase.auth.mfa.verify({
      factorId,
      challengeId: ch.data.id,
      code: trimmed,
    });
    if (!v.error) return; // AAL2 achieved

    lastErr = v.error;
    if (!isMfaIpMismatch(v.error)) throw v.error; // wrong code, etc. — surface now

    // Transient IP flip: brief settle, then re-challenge + re-verify. The TOTP
    // code is still valid inside this sub-second window.
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  if (isMfaIpMismatch(lastErr)) throw new Error(IP_MISMATCH_MESSAGE);
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
