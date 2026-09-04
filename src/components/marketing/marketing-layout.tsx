import { ExtensionInstallCta } from "@/components/marketing/extension-install-cta";
import { AppDownloadLinks } from "@/components/get-the-apps";
import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SEO } from "@/components/seo";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { Image } from "@/components/responsive-image";
import {
  organizationLd,
  breadcrumbLd,
  type JsonLd,
} from "@/lib/seo/json-ld";
import { SITE_URL, ogImageForRoute } from "@/lib/seo/public-routes";
import { openCookiePreferences } from "@/lib/cookie-preferences";

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
  /**
   * US-2098: a data-report page noindexes itself while its dataset is below the
   * publishable threshold, so an empty report is never offered to crawlers or
   * answer engines as a finding.
   */
  noindex?: boolean;
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
  noindex = false,
  children,
}: MarketingLayoutProps) {
  const trail = breadcrumbs ?? [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: title, url: `${SITE_URL}${canonicalPath}` },
  ];
  // US-427: use the route's distinct social image (matches the prerendered
  // head-builder output) so the live SPA and crawlers agree on the OG image.
  const og = ogImageForRoute(canonicalPath);
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SEO
        title={title}
        description={description}
        canonicalUrl={`${SITE_URL}${canonicalPath}`}
        ogImage={og.url}
        ogImageAlt={og.alt}
        jsonLd={[organizationLd(), breadcrumbLd(trail), ...jsonLd]}
        noindex={noindex}
      />

      {/* Header — matches the landing page */}
      <header className="sticky top-0 z-50 flex h-16 items-center justify-between border-b bg-background/95 px-6 backdrop-blur supports-[backdrop-filter]:bg-background/60 lg:px-12">
        <Link to="/" aria-label="GradeThread home">
          {/* Responsive logo: 1x/2x srcset (AVIF/WebP), no CLS (US-306). */}
          <Image
            src="/logo_primary.png"
            alt="GradeThread"
            width={154}
            height={32}
            priority
            className="h-8 w-auto"
          />
        </Link>
        <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
          {/* viewTransition (US-1961): cross-page cross-fade where supported. */}
          <Link to="/how-it-works" viewTransition className="hover:text-foreground">
            How It Works
          </Link>
          <Link to="/pricing" viewTransition className="hover:text-foreground">
            Pricing
          </Link>
          <Link to="/for-resellers" viewTransition className="hover:text-foreground">
            For Resellers
          </Link>
          {/* US-9211: the product is one click from every public page. The
              decision (Path 7, seo-strategy-options-2026-08.md) is that
              GradeThread stays the identity and the reseller workflow is the
              capture leg, so FlipDesk takes the nav slot and grading keeps its
              pillar link in the footer rather than competing here. */}
          <Link to="/flipdesk" viewTransition className="hover:text-foreground">
            FlipDesk
          </Link>
          {/* US-1109: top-of-funnel lead magnet, promoted into the primary nav. */}
          <Link to="/whats-it-worth" viewTransition className="hover:text-foreground">
            What's It Worth?
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
      <main className="flex-1">
        {/* Visible breadcrumb trail (US-433) — same items as the BreadcrumbList
            JSON-LD above, so the on-page hierarchy matches the structured data. */}
        <Breadcrumbs items={trail} className="mx-auto max-w-3xl px-6 pt-6" />
        {children}
        {/* US-9210: the extension install call to action, on the pages whose
            reader is about to visit a marketplace. Self-hides elsewhere. */}
        <ExtensionInstallCta path={canonicalPath} />
      </main>

      {/* Footer — matches the landing page */}
      <footer className="border-t px-6 py-10 lg:px-12">
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          {/* US-1109: grouped footer so every public surface is discoverable —
              the trust/social-proof pages (Verified, Leaderboard, Buyer
              Guarantee, What's It Worth) were previously reachable only by
              direct URL. */}
          <div className="flex flex-col gap-8 sm:flex-row sm:justify-between">
            <Image
              src="/logo_primary.png"
              alt="GradeThread"
              width={115}
              height={24}
              className="h-6 w-auto"
            />
            <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 lg:grid-cols-5">
              <FooterColumn title="Product">
                {/* US-9211: FlipDesk first — it is the product the reseller
                    came for. Condition Grading keeps its link one column over,
                    so the pillar stays crawlable without leading the site. */}
                <FooterLink to="/flipdesk">FlipDesk</FooterLink>
                <FooterLink to="/how-it-works">How It Works</FooterLink>
                <FooterLink to="/pricing">Pricing</FooterLink>
                <FooterLink to="/for-resellers">For Resellers</FooterLink>
              </FooterColumn>
              {/* US-291: surface the pSEO hubs so the long programmatic tail
                  (glossary, comparisons, standards, guides, tools) is reachable
                  by crawlers via the global footer, not only the XML sitemap. */}
              <FooterColumn title="Guides & Tools">
                <FooterLink to="/condition-grading">Condition Grading</FooterLink>
                <FooterLink to="/grading/scale">Grading Scale</FooterLink>
                <FooterLink to="/grading/glossary">Condition Glossary</FooterLink>
                <FooterLink to="/condition-index">Condition Index</FooterLink>
                <FooterLink to="/compare">Compare Marketplaces</FooterLink>
                <FooterLink to="/reselling">Reselling Guides</FooterLink>
                <FooterLink to="/tools/grade-checker">Free Grading Tools</FooterLink>
                {/* US-2582: the help center, on every public page. 213 marketing
                    routes already rank; a help center nothing links to is an
                    orphan no matter how good it is. */}
                <FooterLink to="/help">Help Center</FooterLink>
              </FooterColumn>
              <FooterColumn title="Sellers">
                <FooterLink to="/whats-it-worth">What's It Worth?</FooterLink>
                <FooterLink to="/verified">Verified Directory</FooterLink>
                <FooterLink to="/leaderboard">Top Referrers</FooterLink>
                <FooterLink to="/faq">FAQ</FooterLink>
              </FooterColumn>
              {/* US-3110: the apps, on every public page. The iOS app and both
                  extensions existed with nothing on the marketing site linking
                  to any of them. External links, so these are plain <a>s and
                  the footer-links-routed test correctly ignores them. */}
              <FooterColumn title="Get GradeThread">
                {/* US-3111: the page that explains which one you want, above
                    the three store links themselves. */}
                <FooterLink to="/download">Apps & extensions</FooterLink>
                <AppDownloadLinks surface="marketing-footer" />
              </FooterColumn>
              <FooterColumn title="Trust">
                {/* US-593: buyer-facing verify entry point, not just seller pages. */}
                <FooterLink to="/verify">Verify a Grade</FooterLink>
                {/* US-1106: buyer-facing "scan before you buy" passport lookup. */}
                <FooterLink to="/scan">Scan a Passport</FooterLink>
                <FooterLink to="/buyer-guarantee">Buyer Guarantee</FooterLink>
                <FooterLink to="/transparency">Transparency</FooterLink>
              </FooterColumn>
            </div>
          </div>
          <div className="flex flex-col gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
            <nav className="flex flex-wrap gap-4 text-xs text-muted-foreground sm:gap-6">
              <Link to="/about" className="hover:text-foreground">
                About
              </Link>
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
              <Link to="/refund" className="hover:text-foreground">
                Refunds
              </Link>
              <Link to="/accessibility" className="hover:text-foreground">
                Accessibility
              </Link>
              <Link to="/dmca" className="hover:text-foreground">
                DMCA
              </Link>
              <Link to="/trademarks" className="hover:text-foreground">
                Trademarks
              </Link>
              <Link to="/subprocessors" className="hover:text-foreground">
                Subprocessors
              </Link>
              <Link to="/dpa" className="hover:text-foreground">
                DPA
              </Link>
              <Link to="/imprint" className="hover:text-foreground">
                Imprint
              </Link>
              <Link to="/status" className="hover:text-foreground">
                Status
              </Link>
              {/* US-291: human HTML sitemap — one hop to every public page. */}
              <Link to="/sitemap" className="hover:text-foreground">
                Sitemap
              </Link>
              <button
                type="button"
                onClick={openCookiePreferences}
                className="hover:text-foreground"
              >
                Cookie settings
              </button>
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

// US-1109: small footer building blocks so the grouped link columns stay
// consistent (label + vertical list) without repeating markup per column.
function FooterColumn({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-foreground/70">
        {title}
      </p>
      <nav className="flex flex-col gap-2 text-sm text-muted-foreground">
        {children}
      </nav>
    </div>
  );
}

function FooterLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    // viewTransition (US-1961): cross-fade between marketing pages so the site
    // feels continuous. No-op on browsers without the View Transitions API.
    <Link to={to} viewTransition className="hover:text-foreground">
      {children}
    </Link>
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
