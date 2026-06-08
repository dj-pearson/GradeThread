import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cfImage, buildSrcSet } from "../lib/images";
import {
  cfImage as cfImageSsr,
  buildSrcSet as buildSrcSetSsr,
  renderHeroImage,
  rewriteContentImages,
} from "../../functions/_shared/blog-render";

// US-306: responsive images via Cloudflare Image Resizing. The frontend helper
// (src/lib/images.ts) and the SSR helper (functions/_shared/blog-render.ts) are
// independent copies, so both are tested. A dist smoke test asserts the landing
// logo ships a srcset.

describe("cfImage (frontend + SSR parity)", () => {
  for (const [label, fn] of [
    ["frontend", cfImage],
    ["ssr", cfImageSsr],
  ] as const) {
    it(`${label}: wraps a root-relative path (drops leading slash, format=auto)`, () => {
      const url = fn("/logo_primary.png", 154);
      expect(url).toBe(
        "/cdn-cgi/image/width=154,quality=80,format=auto,fit=scale-down,onerror=redirect/logo_primary.png",
      );
    });
    it(`${label}: appends an absolute URL whole`, () => {
      const url = fn("https://cdn.gradethread.com/hero.jpg", 1024);
      expect(url).toContain(
        "/cdn-cgi/image/width=1024,quality=80,format=auto,fit=scale-down,onerror=redirect/https://cdn.gradethread.com/hero.jpg",
      );
    });
    it(`${label}: leaves data:, empty, and already-transformed src untouched`, () => {
      expect(fn("", 100)).toBe("");
      expect(fn("data:image/png;base64,AAAA", 100)).toBe(
        "data:image/png;base64,AAAA",
      );
      const once = fn("/x.png", 100);
      expect(fn(once, 200)).toBe(once); // idempotent — no double wrap
    });
  }
});

describe("buildSrcSet", () => {
  it("emits `<url> <w>w` candidates", () => {
    const set = buildSrcSet("/logo.png", [154, 308]);
    expect(set).toContain("width=154");
    expect(set).toContain("154w");
    expect(set).toContain("308w");
    expect(set.split(", ")).toHaveLength(2);
  });
  it("matches the SSR copy", () => {
    expect(buildSrcSet("/a.png", [640, 1024])).toBe(
      buildSrcSetSsr("/a.png", [640, 1024]),
    );
  });
  it("is empty for data:/empty src", () => {
    expect(buildSrcSet("", [100])).toBe("");
    expect(buildSrcSet("data:abc", [100])).toBe("");
  });
});

describe("renderHeroImage (blog SSR)", () => {
  it("renders nothing without a hero", () => {
    expect(renderHeroImage(null, "x", true)).toBe("");
    expect(renderHeroImage(undefined, "x", true)).toBe("");
  });
  it("renders an eager, high-priority responsive hero when resizing is on", () => {
    const html = renderHeroImage("https://cdn/hero.jpg", "My Post", true);
    expect(html).toContain('class="hero"');
    expect(html).toContain('src="https://cdn/hero.jpg"'); // original fallback
    expect(html).toContain("srcset=");
    expect(html).toContain("/cdn-cgi/image/");
    expect(html).toContain('loading="eager"');
    expect(html).toContain('fetchpriority="high"');
    expect(html).toContain('alt="My Post"');
  });
  it("omits the resize srcset when resizing is off (default)", () => {
    const html = renderHeroImage("https://cdn/hero.jpg", "My Post");
    expect(html).toContain('src="https://cdn/hero.jpg"');
    expect(html).not.toContain("srcset=");
    expect(html).not.toContain("/cdn-cgi/image/");
    expect(html).toContain('loading="eager"'); // still the LCP hero
    expect(html).toContain('fetchpriority="high"');
  });
});

describe("rewriteContentImages (blog SSR)", () => {
  it("adds srcset + lazy loading to a plain content image when resizing is on", () => {
    const out = rewriteContentImages('<p><img src="https://cdn/in.jpg" alt="x"></p>', true);
    expect(out).toContain("srcset=");
    expect(out).toContain("/cdn-cgi/image/");
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('decoding="async"');
    expect(out).toContain('alt="x"'); // original attrs preserved
  });
  it("adds lazy/decoding but NO resize srcset when resizing is off", () => {
    const out = rewriteContentImages('<p><img src="https://cdn/in.jpg" alt="x"></p>');
    expect(out).not.toContain("/cdn-cgi/image/");
    expect(out).not.toContain("srcset=");
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('decoding="async"');
    expect(out).toContain('alt="x"');
  });
  it("is idempotent — skips images that already have a srcset", () => {
    const already = '<img src="/a.png" srcset="/a.png 1x">';
    expect(rewriteContentImages(already, true)).toBe(already);
  });
  it("skips data: URIs and leaves non-image markup alone", () => {
    expect(rewriteContentImages('<img src="data:abc">', true)).toBe('<img src="data:abc">');
    expect(rewriteContentImages("<p>no images</p>", true)).toBe("<p>no images</p>");
  });
});

// Smoke test (AC#5): the prerendered landing logo. Requires a prior
// `npm run build` (same precondition as the prerender dist tests). The srcset is
// gated behind VITE_CF_IMAGE_RESIZING (the <Image> component only emits a
// /cdn-cgi/image srcset once Cloudflare Transformations is enabled), so this
// asserts the behavior that matches the flag the build ran with.
const distIndex = resolve(process.cwd(), "dist", "index.html");
const hasDist = existsSync(distIndex);
// Build-independent suite: skip when dist/ is absent (same precondition as the
// prerender dist tests). The unit suite runs before `npm run build` in CI, so a
// hard `existsSync` assertion here would fail the build — skip instead.
describe.skipIf(!hasDist)("landing responsive image smoke test (US-306)", () => {
  const resizingEnabled = process.env.VITE_CF_IMAGE_RESIZING === "true";
  it(`landing logo ${resizingEnabled ? "ships a Cloudflare-resized srcset" : "ships the original (resizing off)"}`, () => {
    // HTML attributes are case-insensitive; React's SSR emits `srcSet` (camel),
    // which browsers parse identically to `srcset`. Lowercase before matching.
    const html = readFileSync(distIndex, "utf8").toLowerCase();
    expect(html).toContain("logo_primary.png");
    if (resizingEnabled) {
      expect(html).toContain("srcset=");
      expect(html).toContain("/cdn-cgi/image/");
    } else {
      // Off → plain original, no 404-ing resize URLs in the prerendered HTML.
      expect(html).not.toContain("/cdn-cgi/image/");
    }
  });
});
