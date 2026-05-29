import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SEO } from "@/components/seo";
import {
  organizationLd,
  breadcrumbLd,
  type JsonLd,
} from "@/lib/seo/json-ld";
import { SITE_URL } from "@/lib/seo/public-routes";

interface MarketingLayoutProps {
  title: string;
  description: string;
  canonicalPath: string;
  /** Extra JSON-LD beyond Organization + BreadcrumbList (e.g. HowTo, FAQPage). */
  jsonLd?: JsonLd[];
  /**
   * Override the default 2-level breadcrumb (GradeThread → title). Glossary
   * pages (US-303) pass a 3-level trail back to the /condition-grading pillar.
   */
  breadcrumbs?: Array<{ name: string; url: string }>;
  children: React.ReactNode;
}

// Shared chrome for the evergreen marketing pages (US-302): /pricing,
// /how-it-works, /for-resellers, /faq, /condition-grading. Mirrors the landing
// header/footer so the design system + brand tokens stay consistent, and emits
// Organization + BreadcrumbList JSON-LD for every page (callers add page-type
// schema via `jsonLd`). All of these are registered in PUBLIC_ROUTES, so they
// auto-prerender (US-292) + sitemap (US-293) + IndexNow (US-297).
export function MarketingLayout({
  title,
  description,
  canonicalPath,
  jsonLd = [],
  breadcrumbs,
  children,
}: MarketingLayoutProps) {
  const trail = breadcrumbs ?? [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: title, url: `${SITE_URL}${canonicalPath}` },
  ];
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SEO
        title={title}
        description={description}
        canonicalUrl={`${SITE_URL}${canonicalPath}`}
        jsonLd={[organizationLd(), breadcrumbLd(trail), ...jsonLd]}
      />

      {/* Header — matches the landing page */}
      <header className="sticky top-0 z-50 flex h-16 items-center justify-between border-b bg-background/95 px-6 backdrop-blur supports-[backdrop-filter]:bg-background/60 lg:px-12">
        <Link to="/" aria-label="GradeThread home">
          <img src="/logo_primary.png" alt="GradeThread" className="h-8" />
        </Link>
        <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
          <Link to="/how-it-works" className="hover:text-foreground">
            How It Works
          </Link>
          <Link to="/pricing" className="hover:text-foreground">
            Pricing
          </Link>
          <Link to="/for-resellers" className="hover:text-foreground">
            For Resellers
          </Link>
          <Link to="/condition-grading" className="hover:text-foreground">
            Condition Grading
          </Link>
        </nav>
        <div className="flex items-center gap-3">
          <Link to="/login">
            <Button variant="ghost" size="sm">
              Sign in
            </Button>
          </Link>
          <Link to="/signup">
            <Button
              size="sm"
              className="bg-brand-red text-white hover:bg-brand-red/90"
            >
              Get Started
              <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </Link>
        </div>
      </header>

      {/* Page content */}
      <main className="flex-1">{children}</main>

      {/* Footer — matches the landing page */}
      <footer className="border-t px-6 py-10 lg:px-12">
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <img src="/logo_primary.png" alt="GradeThread" className="h-6" />
            <nav className="flex flex-wrap gap-4 text-sm text-muted-foreground sm:gap-6">
              <Link to="/how-it-works" className="hover:text-foreground">
                How It Works
              </Link>
              <Link to="/pricing" className="hover:text-foreground">
                Pricing
              </Link>
              <Link to="/for-resellers" className="hover:text-foreground">
                For Resellers
              </Link>
              <Link to="/condition-grading" className="hover:text-foreground">
                Condition Grading
              </Link>
              <Link to="/faq" className="hover:text-foreground">
                FAQ
              </Link>
            </nav>
          </div>
          <div className="flex flex-col gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
            <nav className="flex flex-wrap gap-4 text-xs text-muted-foreground sm:gap-6">
              <Link to="/privacy" className="hover:text-foreground">
                Privacy Policy
              </Link>
              <Link to="/terms" className="hover:text-foreground">
                Terms of Service
              </Link>
              <Link to="/cookies" className="hover:text-foreground">
                Cookie Policy
              </Link>
              <Link to="/acceptable-use" className="hover:text-foreground">
                Acceptable Use
              </Link>
            </nav>
            <p className="text-xs text-muted-foreground">
              &copy; {new Date().getFullYear()} Pearson Media LLC. All rights
              reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

// A reusable bottom CTA band, brand navy, used across marketing pages.
export function MarketingCTA({
  heading = "Ready to Grade Smarter?",
  sub = "Join resellers who trust GradeThread to standardize condition grading, build buyer confidence, and sell faster.",
}: {
  heading?: string;
  sub?: string;
}) {
  return (
    <section className="bg-brand-navy px-6 py-20 text-center text-white">
      <h2 className="text-3xl font-bold">{heading}</h2>
      <p className="mx-auto mt-3 max-w-xl text-white/80">{sub}</p>
      <Link to="/signup" className="mt-8 inline-block">
        <Button
          size="lg"
          className="bg-brand-red text-white hover:bg-brand-red/90"
        >
          Start Grading Free
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </Link>
    </section>
  );
}
