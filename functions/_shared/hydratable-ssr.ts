// US-3215: one certificate page instead of two.
//
// THE DEFECT. /cert/:id had two implementations. Arriving by a React
// navigation rendered src/pages/certificate.tsx; arriving by a fresh load
// rendered functions/cert/[id].ts. Measured on production for one id, minutes
// apart: 11,477px with 16 images by the first route, 2,860px with 10 by the
// second. The Pages Function's own header claimed "the SPA route at /cert/:id
// still hydrates for humans", and it could not — renderLayout emits JSON-LD
// script tags and nothing else, so the document it produced had no div#root and
// no module bundle to hydrate into. Which page a buyer saw was decided by how
// they arrived, which is not a decision anyone made.
//
// THE FIX. Serve the BUILT APP SHELL with the page's own <head> swapped in and
// the server-rendered HTML placed inside #root. That is exactly what every
// prerendered static page in this app already does (scripts/prerender.mjs):
// crawlers get real HTML, `createRoot` replaces it on mount, and the human ends
// up on the full React page whichever way they arrived.
//
// WHY THE SHELL AND NOT A HAND-WRITTEN SCRIPT TAG. Vite hashes every asset
// name. Reading them out of the shell means they can never be stale; writing
// them into a Pages Function means they are wrong on the next deploy and the
// page silently stops hydrating, which looks exactly like the bug this fixes.

/**
 * Tags the PAGE owns. Taken from our rendered head, and stripped from the
 * shell's so the shell's landing-page copies cannot win.
 *
 * A whitelist rather than a blacklist on our side: renderLayout also emits
 * charset, viewport, icons and PWA tags, which are the SHELL's business and are
 * already correct there. Copying them would duplicate every one.
 */
const PAGE_OWNED_TAGS: RegExp[] = [
  /<title>[\s\S]*?<\/title>/gi,
  /<meta\s+name=["'](?:description|robots)["'][^>]*>/gi,
  /<link\s+rel=["']canonical["'][^>]*>/gi,
  /<meta\s+property=["']og:[^"']*["'][^>]*>/gi,
  /<meta\s+name=["']twitter:[^"']*["'][^>]*>/gi,
  /<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi,
];

/** Everything between <head> and </head>, or "" when the shape is unexpected. */
function headInner(html: string): string {
  const m = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  return m?.[1] ?? "";
}

/** The page-owned tags from a rendered document, in source order. */
export function pageOwnedHead(renderedDoc: string): string {
  const head = headInner(renderedDoc);
  const out: string[] = [];
  for (const re of PAGE_OWNED_TAGS) {
    re.lastIndex = 0;
    for (const m of head.matchAll(re)) out.push(m[0]);
  }
  return out.join("\n    ");
}

/** The same tags removed from the shell, so ours are the only ones left. */
export function stripPageOwnedHead(shell: string): string {
  const head = headInner(shell);
  if (!head) return shell;
  let stripped = head;
  for (const re of PAGE_OWNED_TAGS) {
    re.lastIndex = 0;
    stripped = stripped.replace(re, "");
  }
  return shell.replace(head, stripped);
}

/**
 * Replace the shell's prerendered body with this page's.
 *
 * The root element opens at `<div id="root">` and closes at the LAST `</div>`
 * before `</body>` — Vite hoists the module script into <head>, so nothing but
 * the app's own markup sits between them. Returns null rather than guessing
 * when either landmark is missing: serving a page whose content silently did
 * not swap is worse than serving the plain shell, and the caller falls back.
 */
export function replaceRootContent(shell: string, bodyHtml: string): string | null {
  const openTag = '<div id="root">';
  const open = shell.indexOf(openTag);
  if (open < 0) return null;
  const bodyClose = shell.lastIndexOf("</body>");
  if (bodyClose < 0) return null;
  const close = shell.lastIndexOf("</div>", bodyClose);
  if (close < open) return null;
  return (
    shell.slice(0, open + openTag.length) + bodyHtml + shell.slice(close)
  );
}

/**
 * The shell, wearing this page's head and body.
 *
 * Returns null when the shell is not the shape we expect. Every caller treats
 * that as "fall back to the standalone SSR document" rather than shipping a
 * half-merged page — a certificate that renders the landing page's copy under a
 * certificate's title would be worse than either page on its own.
 */
export function mergeIntoShell(
  shell: string,
  renderedDoc: string,
  bodyHtml: string,
): string | null {
  const ourHead = pageOwnedHead(renderedDoc);
  if (!ourHead) return null;
  const withBody = replaceRootContent(stripPageOwnedHead(shell), bodyHtml);
  if (!withBody) return null;
  const headClose = withBody.toLowerCase().lastIndexOf("</head>");
  if (headClose < 0) return null;
  return (
    withBody.slice(0, headClose) + "    " + ourHead + "\n  " +
    withBody.slice(headClose)
  );
}
