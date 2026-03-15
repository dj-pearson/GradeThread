import { Helmet } from "react-helmet-async";

interface SEOProps {
  title?: string;
  description?: string;
  ogType?: string;
  ogImage?: string;
  canonicalUrl?: string;
}

const DEFAULT_TITLE = "GradeThread - AI-Powered Clothing Condition Grading";
const DEFAULT_DESCRIPTION =
  "Standardize pre-owned clothing grades with AI. Build buyer trust, reduce returns, and sell faster with verified condition certificates.";

export function SEO({
  title,
  description = DEFAULT_DESCRIPTION,
  ogType = "website",
  ogImage,
  canonicalUrl,
}: SEOProps) {
  const fullTitle = title ? `${title} | GradeThread` : DEFAULT_TITLE;

  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <meta property="og:type" content={ogType} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:site_name" content="GradeThread" />
      {ogImage && <meta property="og:image" content={ogImage} />}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      {ogImage && <meta name="twitter:image" content={ogImage} />}
      {canonicalUrl && <link rel="canonical" href={canonicalUrl} />}
    </Helmet>
  );
}
