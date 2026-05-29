import { useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { SITE_URL } from "@/lib/seo/public-routes";

type JsonLdValue = Record<string, unknown>;

interface SEOProps {
  title?: string;
  description?: string;
  ogType?: string;
  ogImage?: string;
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

const DEFAULT_TITLE = "GradeThread - AI-Powered Clothing Condition Grading";
const DEFAULT_DESCRIPTION =
  "Standardize pre-owned clothing grades with AI. Build buyer trust, reduce returns, and sell faster with verified condition certificates.";
const DEFAULT_OG_IMAGE = `${SITE_URL}/logo_icon_512.png`;

export function SEO({
  title,
  description = DEFAULT_DESCRIPTION,
  ogType = "website",
  ogImage = DEFAULT_OG_IMAGE,
  canonicalUrl,
  noindex = false,
  jsonLd,
  article,
  twitterSite,
  keywords,
}: SEOProps) {
  const fullTitle = title ? `${title} | GradeThread` : DEFAULT_TITLE;

  // Default the canonical to the current pathname under the production origin
  // so every page is self-canonical even when the caller forgets to pass one.
  const resolvedCanonical =
    canonicalUrl ??
    (typeof window !== "undefined"
      ? `${SITE_URL}${window.location.pathname}`
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
  // type="application/ld+json"> nodes works at runtime and is captured by the
  // headless-browser prerender (US-292), which executes JS before snapshotting.
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
        content={noindex ? "noindex, nofollow" : "index, follow"}
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
      <meta property="og:image" content={ogImage} />

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

      {/* Twitter */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={ogImage} />
      {twitterSite && <meta name="twitter:site" content={twitterSite} />}
    </Helmet>
  );
}
