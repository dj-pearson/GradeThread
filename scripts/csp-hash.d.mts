// Type declarations for the build-time CSP hash-sync helper so the Vitest unit
// test (src/lib/seo/__tests__/csp-hash.test.ts) imports it without TS7016
// (implicit-any on a JS module). Mirrors scripts/csp-hash.mjs's exports.

export function extractInlineBootstrap(html: string): string | null;
export function cspHashForScript(scriptContent: string): string;
export function replaceCspScriptHash(
  headersText: string,
  newHashToken: string,
): string;
export function syncCspHash(
  html: string,
  headersText: string,
): { headers: string; hash: string; changed: boolean };
