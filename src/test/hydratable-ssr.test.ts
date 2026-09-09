import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { requireDist } from "./dist-required";
import {
  mergeIntoShell,
  pageOwnedHead,
  replaceRootContent,
  stripPageOwnedHead,
} from "../../functions/_shared/hydratable-ssr";

// US-3215. These assert against the REAL built shell, not a fixture, because
// every one of them is an assumption about Vite's output. If the build stops
// emitting div#root, or hoists the module script somewhere else, the merge
// silently falls back to the standalone page and /cert/:id quietly goes back to
// being two different pages — which is exactly the failure nobody noticed for
// however long it had been happening.

const DIST_INDEX = resolve(process.cwd(), "dist/index.html");

/**
 * The built shell, or null when there is no build to read.
 *
 * requireDist THROWS in CI (where DIST_TESTS_REQUIRED is set) and returns false
 * on a dev box that has not run `npm run build`, so the cases below skip loudly
 * rather than reading a missing file and failing with a confusing ENOENT.
 * US-2038 exists because 37 hydration tests once skipped silently for months.
 */
const shell = (): string | null => {
  if (!requireDist(DIST_INDEX, "hydratable SSR merge")) return null;
  return readFileSync(DIST_INDEX, "utf8");
};

const RENDERED = `<!DOCTYPE html><html><head>
  <meta charset="UTF-8">
  <title>A Certificate — Grade 7.9</title>
  <meta name="description" content="A graded garment.">
  <link rel="canonical" href="https://gradethread.com/cert/abc">
  <meta property="og:title" content="A Certificate">
  <meta name="twitter:card" content="summary_large_image">
  <script type="application/ld+json">{"@type":"Product"}</script>
</head><body><main>SSR BODY</main></body></html>`;

describe("hydratable SSR (US-3215)", () => {
  it("takes the page's own head tags and nothing else", () => {
    const head = pageOwnedHead(RENDERED);
    expect(head).toContain("<title>A Certificate — Grade 7.9</title>");
    expect(head).toContain('rel="canonical"');
    expect(head).toContain('property="og:title"');
    expect(head).toContain('name="twitter:card"');
    expect(head).toContain("application/ld+json");
    // The shell owns these and already has them right. Copying them would
    // duplicate charset and viewport on every page.
    expect(head).not.toContain("charset");
  });

  it("strips the shell's copies so ours are the only ones", () => {
    const html = shell();
    if (!html) return;
    const stripped = stripPageOwnedHead(html);
    expect(stripped).not.toContain(
      "<title>GradeThread - The Standard for Clothing Condition Grading</title>",
    );
    // Structure survives; only the page-owned tags left.
    expect(stripped).toContain('<div id="root">');
    expect(stripped).toContain("</head>");
  });

  it("the built shell still has the landmarks the merge needs", () => {
    const html = shell();
    if (!html) return;
    // If either of these stops being true the merge returns null and the fix
    // silently reverts. That is the whole reason this test reads dist/.
    expect(html).toContain('<div id="root">');
    expect(html.lastIndexOf("</body>")).toBeGreaterThan(0);
    // Vite hoists the entry module into <head>; the merge relies on nothing but
    // app markup sitting between #root and </body>.
    const headEnd = html.toLowerCase().indexOf("</head>");
    const moduleScript = html.indexOf('type="module"');
    expect(moduleScript).toBeGreaterThan(0);
    expect(moduleScript).toBeLessThan(headEnd);
  });

  it("swaps the shell's prerendered body for the page's", () => {
    const html = shell();
    if (!html) return;
    const out = replaceRootContent(html, "<main>SSR BODY</main>")!;
    expect(out).not.toBeNull();
    expect(out).toContain('<div id="root"><main>SSR BODY</main></div>');
    // The landing page's copy is gone.
    expect(out).not.toContain("data-discover");
  });

  it("keeps the hashed asset names, because they cannot be written by hand", () => {
    const html = shell();
    if (!html) return;
    const merged = mergeIntoShell(html, RENDERED, "<main>SSR BODY</main>")!;
    expect(merged).not.toBeNull();
    expect(merged).toMatch(/<script[^>]+type="module"[^>]+src="\/assets\/[^"]+\.js"/);
    expect(merged).toContain('<div id="root"><main>SSR BODY</main></div>');
    expect(merged).toContain("<title>A Certificate — Grade 7.9</title>");
    // One title, not two.
    expect(merged.match(/<title>/g)?.length).toBe(1);
    expect(merged.match(/rel="canonical"/g)?.length).toBe(1);
  });

  it("refuses rather than half-merging", () => {
    // A shell that is not the shape we expect must produce null so the caller
    // serves the standalone page. Rendering a certificate's title over the
    // landing page's body would be worse than either page on its own.
    expect(replaceRootContent("<html><body>no root</body></html>", "x")).toBeNull();
    expect(mergeIntoShell("<html><body>no root</body></html>", RENDERED, "x")).toBeNull();
    // No page-owned head means we were handed something that is not a page.
    const html = shell();
    if (!html) return;
    expect(mergeIntoShell(html, "<html><head></head><body></body></html>", "x"))
      .toBeNull();
  });
});
