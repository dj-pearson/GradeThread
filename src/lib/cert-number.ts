// Certificate-number helpers for the buyer-facing /verify flow.
//
// US-1945: there is ONE human-facing certificate-number scheme — the stored,
// unique `grade_reports.certificate_number` (`GT-XXXXXXX`, Crockford base32,
// minted at grading time; see the edge cert-number lib). That is the code
// printed on the certificate, advertised on /verify, and resolvable via the
// public by-number lookup. We intentionally do NOT derive a second, look-alike
// number from the certificate UUID: a UUID-derived "GT-XXXX-XXXX" is not stored
// and never resolves through /verify, so printing it as "Certificate No." would
// hand buyers a code that fails verification. When a report has no
// `certificate_number`, the certificate is identified by its /cert/<uuid> URL +
// QR instead, and no verifiable-looking number is shown.

// Normalize buyer-typed input for a /verify lookup: uppercase, strip spaces +
// dashes, and ensure a single "GT-" prefix (so "gt 7k2m9", "7K2M9", "GT-7K2M9"
// all match). Mirrors normalizeCertNumber in the edge lib of the same name.
export function normalizeCertNumber(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/[\s-]+/g, "");
  const bare = cleaned.startsWith("GT") ? cleaned.slice(2) : cleaned;
  return `GT-${bare}`;
}
