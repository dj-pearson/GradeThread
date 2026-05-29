// Single source of truth for every INDEXABLE static public route.
//
// This registry is the engine of the SEO machine (PRD: tasks/prd-seo-hardening.md,
// US-291). It is consumed by:
//   - the build-time SEO manifest (vite.config.ts → dist/seo-manifest.json)
//   - the dynamic sitemap Pages Function (functions/sitemap.xml.ts, US-293)
//   - the llms.txt Pages Function (functions/llms.txt.ts, US-295)
//   - the deploy-time IndexNow submitter (US-297)
//   - the CI guard test (./__tests__/public-routes.test.ts) which fails the
//     build if a public router path is missing here, so you CANNOT ship a
//     public page that isn't indexable.
//
// Dynamic collections (blog posts, certificates) are NOT listed here — they
// enter the sitemap via the edge API, which already knows them.
//
// Keep this file dependency-free (pure data): it is imported by the Vite
// config in a plain Node context as well as by the browser bundle.

export const SITE_URL = "https://gradethread.com";

export type ChangeFreq =
  | "always"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "never";

export interface PublicRoute {
  /** Absolute path, no trailing slash (except "/"). */
  path: string;
  /** <title> (without the " | GradeThread" suffix the SEO component adds). */
  title: string;
  /** Meta description. */
  description: string;
  changefreq: ChangeFreq;
  /** Sitemap priority 0.0–1.0. */
  priority: number;
  /** Primary JSON-LD type rendered on the page (for documentation/audit). */
  jsonLdType?: string;
}

export const PUBLIC_ROUTES: PublicRoute[] = [
  {
    path: "/",
    title: "AI-Powered Clothing Condition Grading",
    description:
      "Standardize pre-owned clothing grades with AI. Build buyer trust, reduce returns, and sell faster with verified condition certificates.",
    changefreq: "weekly",
    priority: 1.0,
    jsonLdType: "WebSite",
  },
  {
    path: "/privacy",
    title: "Privacy Policy",
    description:
      "How GradeThread (Pearson Media LLC) collects, uses, and protects your data.",
    changefreq: "yearly",
    priority: 0.3,
  },
  {
    path: "/terms",
    title: "Terms of Service",
    description: "The terms governing your use of GradeThread.",
    changefreq: "yearly",
    priority: 0.3,
  },
  {
    path: "/cookies",
    title: "Cookie Policy",
    description: "How GradeThread uses cookies and similar technologies.",
    changefreq: "yearly",
    priority: 0.3,
  },
  {
    path: "/acceptable-use",
    title: "Acceptable Use Policy",
    description: "What is and isn't allowed when using GradeThread.",
    changefreq: "yearly",
    priority: 0.3,
  },
];

/** Normalize a pathname for lookup (strip trailing slash, keep root as "/"). */
export function normalizePath(path: string): string {
  if (path === "/" || path === "") return "/";
  return path.replace(/\/+$/, "");
}

/** Registry entry for a path, or undefined if the route is not registered. */
export function getRouteMeta(path: string): PublicRoute | undefined {
  const norm = normalizePath(path);
  return PUBLIC_ROUTES.find((r) => r.path === norm);
}

/** Absolute canonical URL for a registry path. */
export function absoluteUrl(path: string): string {
  const norm = normalizePath(path);
  return norm === "/" ? `${SITE_URL}/` : `${SITE_URL}${norm}`;
}
