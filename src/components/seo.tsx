import { useEffect } from "react";
import { Helmet } from "react-helmet-async";
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

  // react-helmet-async (v3 fork) does not inject <script> tags into the DOM
  // head on the client, so manage JSON-LD ourselves. Appending real <script
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

  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <meta
        name="robots"
        content={
          noindex
            ? "noindex, nofollow"
            : "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
        }
      />
      {keywords && keywords.length > 0 && (
        <meta name="keywords" content={keywords.join(", ")} />
      )}
      {resolvedCanonical && <link rel="canonical" href={resolvedCanonical} />}

      {/* Open Graph */}
      <meta property="og:type" content={ogType} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:site_name" content="GradeThread" />
      {resolvedCanonical && <meta property="og:url" content={resolvedCanonical} />}
      {/* US-427: explicit image dimensions/type/alt so unfurls render the card
          without a pre-fetch round-trip. Every OG image we ship is 1200×630 PNG. */}
      <meta property="og:image" content={ogImage} />
      <meta property="og:image:secure_url" content={ogImage} />
      <meta property="og:image:type" content={OG_IMAGE_TYPE} />
      <meta property="og:image:width" content={String(OG_IMAGE_WIDTH)} />
      <meta property="og:image:height" content={String(OG_IMAGE_HEIGHT)} />
      <meta property="og:image:alt" content={ogImageAlt} />

      {/* Article metadata */}
      {article?.publishedTime && (
        <meta property="article:published_time" content={article.publishedTime} />
      )}
      {article?.modifiedTime && (
        <meta property="article:modified_time" content={article.modifiedTime} />
      )}
      {article?.author && (
        <meta property="article:author" content={article.author} />
      )}

      {/* Twitter. US-428: default twitter:site (the brand X handle) from the
          shared social config so EVERY page carries it for entity recognition,
          while a caller can still override per-page (e.g. a blog author). Both
          tags are emitted only when a real handle is configured — never a
          placeholder. twitter:creator falls back to the site handle. */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={ogImage} />
      <meta name="twitter:image:alt" content={ogImageAlt} />
      {resolvedTwitterSite && (
        <meta name="twitter:site" content={resolvedTwitterSite} />
      )}
      {resolvedTwitterCreator && (
        <meta name="twitter:creator" content={resolvedTwitterCreator} />
      )}

      {/* US-308: Search Console + Bing Webmaster verification tags. Values
          come from the build-time env (Vite). The string verification flow
          for both engines accepts a meta tag on the homepage with no
          interaction required after verification — keep these site-wide so
          adding a new public route doesn't break verification. */}
      {VERIFY_GOOGLE && (
        <meta name="google-site-verification" content={VERIFY_GOOGLE} />
      )}
      {VERIFY_BING && <meta name="msvalidate.01" content={VERIFY_BING} />}
    </Helmet>
  );
}

// Read once at module load so a render isn't paying the env lookup cost.
// import.meta.env is statically replaced by Vite at build time.
const VERIFY_GOOGLE = import.meta.env.VITE_GOOGLE_SITE_VERIFICATION ?? "";
const VERIFY_BING = import.meta.env.VITE_BING_SITE_VERIFICATION ?? "";
