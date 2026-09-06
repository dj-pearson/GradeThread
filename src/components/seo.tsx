import { useEffect } from "react";
import {
  SITE_URL,
  normalizePath,
  DEFAULT_OG_IMAGE_ALT,
  OG_IMAGE_WIDTH,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_TYPE,
} from "@/lib/seo/site";
import { twitterSiteHandle, twitterCreatorHandle } from "@/lib/seo/social";

type JsonLdValue = Record<string, unknown>;

interface SEOProps {
  title?: string;
  description?: string;
  ogType?: string;
  ogImage?: string;
  /** Accessible description of the OG image (og:image:alt / twitter:image:alt). */
  ogImageAlt?: string;
  canonicalUrl?: string;
  /** When true, emit noindex,nofollow (dashboard/admin/preview pages). */
  noindex?: boolean;
  /** One or more JSON-LD objects serialized into <script type=ld+json>. */
  jsonLd?: JsonLdValue | JsonLdValue[];
  /** Article metadata for blog/news-style pages. */
  article?: {
    publishedTime?: string;
    modifiedTime?: string;
    author?: string;
  };
  /** Twitter @handle for the content publisher. */
  twitterSite?: string;
  keywords?: string[];
}

const DEFAULT_TITLE = "GradeThread - The Standard for Clothing Condition Grading";
const DEFAULT_DESCRIPTION =
  "The trusted standard for pre-owned clothing condition grading. Get an objective 1.0–10.0 grade and a shareable certificate buyers trust — then run your whole reselling workflow with FlipDesk.";
const DEFAULT_OG_IMAGE = `${SITE_URL}/og-image.png`;

export function SEO({
  title,
  description = DEFAULT_DESCRIPTION,
  ogType = "website",
  ogImage = DEFAULT_OG_IMAGE,
  ogImageAlt = DEFAULT_OG_IMAGE_ALT,
  canonicalUrl,
  noindex = false,
  jsonLd,
  article,
  twitterSite,
  keywords,
}: SEOProps) {
  const fullTitle = title ? `${title} | GradeThread` : DEFAULT_TITLE;

  // US-428: a per-page `twitterSite` prop wins; otherwise fall back to the
  // configured brand handle. twitter:creator defaults to the same handle.
  const resolvedTwitterSite = twitterSite || twitterSiteHandle();
  const resolvedTwitterCreator = twitterCreatorHandle();

  // Default the canonical to the current pathname under the production origin
  // so every page is self-canonical even when the caller forgets to pass one.
  // US-426: normalize the pathname (strip any trailing slash) so a visit to
  // "/pricing/" still emits the canonical "/pricing" — matching the prerendered
  // canonical (head-builder uses absoluteUrl → normalizePath) and the
  // no-trailing-slash policy enforced by the 301s in dist/_redirects. Without
  // this the SPA canonical would drift from the prerendered one on slash URLs.
  const resolvedCanonical =
    canonicalUrl ??
    (typeof window !== "undefined"
      ? `${SITE_URL}${normalizePath(window.location.pathname)}`
      : undefined);

  // Normalize jsonLd to an array and JSON-encode. `<` is escaped so a value
  // can never break out of the <script> element.
  const ldObjects: JsonLdValue[] = jsonLd
    ? Array.isArray(jsonLd)
      ? jsonLd
      : [jsonLd]
    : [];
  const serialized = ldObjects.map((ld) =>
    JSON.stringify(ld).replace(/</g, "\\u003c"),
  );
  // Stable dependency for the effect: re-run only when the payload changes.
  const ldKey = serialized.join(" ");

  // JSON-LD is managed here directly. It always was: react-helmet-async (the
  // v3 fork, removed in US-3120) injected no <script> on the client, which is
  // the reason this effect predates the one below rather than joining it. Appending real <script
  // type="application/ld+json"> nodes works at runtime for the live SPA.
  //
  // IMPORTANT (US-423): the build-time prerender is STRING-BASED
  // (scripts/prerender.mjs) — there is NO headless browser, so it never runs
  // this useEffect. Crawlable JSON-LD for prerendered routes is emitted
  // separately and deterministically by src/prerender/head-builder.ts
  // (jsonLdForRoute), which MUST mirror whatever a page passes here. Any
  // indexable page that ships <SEO jsonLd> must therefore be a prerendered
  // route with a matching jsonLdForRoute entry (or be edge-SSR'd with the LD
  // inlined) — relying on this client-only injection alone would leave the LD
  // invisible to crawlers. The mirror is enforced by
  // src/prerender/__tests__/jsonld-parity.test.tsx.
  useEffect(() => {
    if (serialized.length === 0) return;
    const nodes = serialized.map((json) => {
      const el = document.createElement("script");
      el.type = "application/ld+json";
      el.dataset.seoJsonld = "true";
      el.text = json;
      document.head.appendChild(el);
      return el;
    });
    return () => nodes.forEach((n) => n.remove());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ldKey]);

  // ── The head tags, written directly (US-3120) ────────────────────────────
  //
  // ⚠ THIS USED TO BE <Helmet>. react-helmet-async is gone, and the reason is
  // not only its weight - it was doing half a job in both directions.
  //
  // On the SERVER it renders NO head at all (the v3 fork), so every crawlable
  // <head> already comes from src/prerender/head-builder.ts. What it DID emit
  // server-side was <title>/<meta>/<link> leaking into the SSR BODY, which
  // scripts/prerender.mjs carries a dedicated strip step and leak check for.
  // On the CLIENT it injects no <script>, which is why the JSON-LD above is
  // already a useEffect. So the component had two mechanisms for one job and
  // the library was the one that could not do all of it.
  //
  // It also cost more than it looked: one eager module that drags
  // react-fast-compare, invariant and shallowequal into the entry chunk, which
  // is on a hard byte budget.
  //
  // WHAT THIS DOES NOT CHANGE: crawlers still read head-builder's output. This
  // effect only keeps the LIVE SPA's head correct as the seller navigates.
  useEffect(() => {
    const managed: Element[] = [];

    const set = (selector: string, make: () => Element) => {
      // Replace rather than update: the prerendered head already carries a tag
      // for most of these, and leaving it beside ours is how a page ends up
      // with two canonicals.
      document.head.querySelector(selector)?.remove();
      const el = make();
      el.setAttribute("data-seo-managed", "true");
      document.head.appendChild(el);
      managed.push(el);
    };

    const meta = (key: "name" | "property", value: string, content: string) =>
      set(`meta[${key}="${value}"]`, () => {
        const el = document.createElement("meta");
        el.setAttribute(key, value);
        el.setAttribute("content", content);
        return el;
      });

    const previousTitle = document.title;
    document.title = fullTitle;

    meta("name", "description", description);
    meta(
      "name",
      "robots",
      noindex
        ? "noindex, nofollow"
        : "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1",
    );
    if (keywords && keywords.length > 0) {
      meta("name", "keywords", keywords.join(", "));
    }
    if (resolvedCanonical) {
      set('link[rel="canonical"]', () => {
        const el = document.createElement("link");
        el.setAttribute("rel", "canonical");
        el.setAttribute("href", resolvedCanonical);
        return el;
      });
    }

    meta("property", "og:type", ogType);
    meta("property", "og:title", fullTitle);
    meta("property", "og:description", description);
    meta("property", "og:site_name", "GradeThread");
    if (resolvedCanonical) meta("property", "og:url", resolvedCanonical);
    // US-427: explicit dimensions/type/alt so an unfurl renders the card with
    // no pre-fetch round-trip. Every OG image we ship is 1200x630 PNG.
    meta("property", "og:image", ogImage);
    meta("property", "og:image:secure_url", ogImage);
    meta("property", "og:image:type", OG_IMAGE_TYPE);
    meta("property", "og:image:width", String(OG_IMAGE_WIDTH));
    meta("property", "og:image:height", String(OG_IMAGE_HEIGHT));
    meta("property", "og:image:alt", ogImageAlt);

    if (article?.publishedTime) {
      meta("property", "article:published_time", article.publishedTime);
    }
    if (article?.modifiedTime) {
      meta("property", "article:modified_time", article.modifiedTime);
    }
    if (article?.author) meta("property", "article:author", article.author);

    // US-428: twitter:site is the brand handle on EVERY page for entity
    // recognition, overridable per page; creator falls back to it. Both are
    // emitted only when a real handle is configured, never a placeholder.
    meta("name", "twitter:card", "summary_large_image");
    meta("name", "twitter:title", fullTitle);
    meta("name", "twitter:description", description);
    meta("name", "twitter:image", ogImage);
    meta("name", "twitter:image:alt", ogImageAlt);
    if (resolvedTwitterSite) meta("name", "twitter:site", resolvedTwitterSite);
    if (resolvedTwitterCreator) {
      meta("name", "twitter:creator", resolvedTwitterCreator);
    }

    // US-308: Search Console and Bing verification, site-wide so adding a
    // public route cannot break verification.
    if (VERIFY_GOOGLE) {
      meta("name", "google-site-verification", VERIFY_GOOGLE);
    }
    if (VERIFY_BING) meta("name", "msvalidate.01", VERIFY_BING);

    return () => {
      for (const el of managed) el.remove();
      document.title = previousTitle;
    };
  });

  return null;
}

// Read once at module load so a render isn't paying the env lookup cost.
// import.meta.env is statically replaced by Vite at build time.
const VERIFY_GOOGLE = import.meta.env.VITE_GOOGLE_SITE_VERIFICATION ?? "";
const VERIFY_BING = import.meta.env.VITE_BING_SITE_VERIFICATION ?? "";
