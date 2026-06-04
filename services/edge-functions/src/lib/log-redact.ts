// Log redaction (US-359).
//
// Server-side logs must never carry PII or secrets: a leaked log sink, an APM
// trace, or a copy/pasted stack into a ticket would otherwise disclose customer
// emails, JWTs, Stripe/eBay tokens, webhook signatures, and API keys. `redact`
// is a pure string scrubber applied before anything reaches console.* on the
// error path (see http-errors.ts) and to the access-log line.
//
// It is intentionally conservative — it can over-redact (replacing a token-like
// blob with a placeholder) but must never under-redact a real secret.

const REPLACEMENT = "[redacted]";

// Ordered most-specific → least-specific so a JWT isn't first mangled by the
// generic long-token rule.
const PATTERNS: Array<[RegExp, string]> = [
  // JWTs / Supabase access tokens: three base64url segments.
  [/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[redacted:jwt]"],
  // Authorization / Bearer headers echoed into a message.
  [/\b[Bb]earer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [redacted]"],
  // Stripe + GradeThread API-key style secrets.
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, "[redacted:key]"],
  [/\bwhsec_[A-Za-z0-9]{8,}/g, "[redacted:whsec]"],
  [/\bgt_[A-Za-z0-9]{12,}/g, "[redacted:apikey]"],
  // eBay / OAuth tokens that carry a recognizable prefix.
  [/\bv\^1\.1#[A-Za-z0-9%._=-]+/g, "[redacted:ebaytoken]"],
  // Email addresses.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[redacted:email]"],
  // x-ebay-signature / generic signature value: long base64 blob (>=40 chars).
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "[redacted:blob]"],
];

export function redact(input: unknown): string {
  let s = typeof input === "string"
    ? input
    : input instanceof Error
    ? `${input.name}: ${input.message}`
    : (() => {
      try {
        return JSON.stringify(input);
      } catch {
        return String(input);
      }
    })();
  for (const [re, repl] of PATTERNS) {
    s = s.replace(re, repl);
  }
  return s;
}

// Convenience: the redacted single-line message for an unknown thrown value.
export function redactError(err: unknown): string {
  if (err instanceof Error) return redact(`${err.name}: ${err.message}`);
  return redact(String(err));
}
