// CSP inline-script hash sync (US-358).
//
// The index.html bootstrap (Consent Mode + GA + Inter font) is inlined for
// performance, so its CSP allowance is a sha256 hash in public/_headers rather
// than 'unsafe-inline'. Hand-maintaining that hash is a footgun: edit the
// script (or let esbuild re-minify it on build) and the committed hash silently
// drifts, so the CSP blocks the bootstrap in production with no error at author
// time.
//
// These pure helpers let the build (scripts/prerender.mjs, which runs last with
// the fully-built dist/) recompute the hash from the ACTUAL built inline script
// and rewrite dist/_headers to match — drift becomes impossible. The helpers
// are exported so a Vitest unit test can pin their behavior in CI.
import { createHash } from "node:crypto";

// Pull the content of the FIRST bare `<script>` (no attributes — the inline
// bootstrap). The module loader (`<script type="module" src=…>`) has
// attributes and is intentionally skipped. Returns null if none is found.
export function extractInlineBootstrap(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  return m ? m[1] : null;
}

// The CSP source token for an inline script, per the spec: sha256 of the exact
// bytes between the tags, base64-encoded, prefixed with the algorithm.
export function cspHashForScript(scriptContent) {
  const b64 = createHash("sha256").update(scriptContent, "utf8").digest("base64");
  return `sha256-${b64}`;
}

// Replace the (single) script-src sha256 token in a _headers file with
// `newHashToken`. Idempotent. Throws if no sha256 token is present, so a
// missing/renamed directive fails the build loudly instead of shipping a CSP
// that no longer allows the bootstrap.
export function replaceCspScriptHash(headersText, newHashToken) {
  const tokenRe = /sha256-[A-Za-z0-9+/]+=*/;
  if (!tokenRe.test(headersText)) {
    throw new Error(
      "no sha256 token found in _headers — the CSP script-src hash is missing.",
    );
  }
  return headersText.replace(tokenRe, newHashToken);
}

// End-to-end: compute the bootstrap hash from `html` and return the updated
// `_headers` text. Throws if the inline bootstrap can't be found.
export function syncCspHash(html, headersText) {
  const script = extractInlineBootstrap(html);
  if (script === null) {
    throw new Error(
      "no bare <script> (inline bootstrap) found in index.html — cannot sync CSP hash.",
    );
  }
  return replaceCspScriptHash(headersText, cspHashForScript(script));
}
