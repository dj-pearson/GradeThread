// Type declarations for the unfed-form-field allowlist, so the Vitest case that
// reads it imports without TS7016.

/**
 * Multipart form fields the edge parses that NO client sends, mapped to the
 * reason each is tolerated. A field on this list has never arrived in
 * production, so anything gated on it has never happened.
 */
export const ALLOWED: Record<string, string>;
