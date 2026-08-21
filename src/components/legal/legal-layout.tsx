import { Link, NavLink } from "react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SEO } from "@/components/seo";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { breadcrumbLd, organizationLd } from "@/lib/seo/json-ld";
import { SITE_URL } from "@/lib/seo/site";
import { openCookiePreferences } from "@/lib/cookie-preferences";

interface LegalLayoutProps {
  title: string;
  description: string;
  canonicalPath: string;
  effectiveDate: string;
  children: React.ReactNode;
}

const legalNav = [
  { to: "/privacy", label: "Privacy Policy" },
  { to: "/terms", label: "Terms of Service" },
  { to: "/cookies", label: "Cookie Policy" },
  { to: "/acceptable-use", label: "Acceptable Use" },
  { to: "/refund", label: "Refund & Cancellation" },
  { to: "/account-deletion", label: "Delete your account" },
  { to: "/dpa", label: "Data Processing Addendum" },
  { to: "/subprocessors", label: "Subprocessors" },
  { to: "/dmca", label: "Copyright / DMCA" },
  { to: "/trademarks", label: "Trademarks" },
  { to: "/accessibility", label: "Accessibility" },
  { to: "/imprint", label: "Imprint / Legal Notice" },
];

export function LegalLayout({
  title,
  description,
  canonicalPath,
  effectiveDate,
  children,
}: LegalLayoutProps) {
  // Shared trail powers both the visible breadcrumb (US-433) and the JSON-LD.
  const trail = [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: title, url: `${SITE_URL}${canonicalPath}` },
  ];
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SEO
        title={title}
        description={description}
        canonicalUrl={`${SITE_URL}${canonicalPath}`}
        jsonLd={[organizationLd(), breadcrumbLd(trail)]}
      />

      {/* Header */}
      <header className="sticky top-0 z-50 flex h-16 items-center justify-between border-b bg-background/95 px-6 backdrop-blur supports-[backdrop-filter]:bg-background/60 lg:px-12">
        <Link to="/" aria-label="GradeThread home">
          <img src="/logo_primary.png" width={1806} height={376} alt="GradeThread" className="h-8" />
        </Link>
        <div className="flex items-center gap-4">
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

      {/* Page */}
      <div className="mx-auto w-full max-w-5xl flex-1 px-6 py-12 lg:px-12 lg:py-16">
        <div className="grid gap-10 lg:grid-cols-[200px_1fr]">
          {/* Side nav */}
          <aside className="hidden lg:block">
            <div className="sticky top-24">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Legal
              </p>
              <nav className="flex flex-col gap-1 text-sm">
                {legalNav.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end
                    className={({ isActive }) =>
                      `rounded-md px-3 py-2 transition-colors ${
                        isActive
                          ? "bg-brand-navy text-white"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground"
                      }`
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </nav>
            </div>
          </aside>

          {/* Content */}
          <article>
            <Breadcrumbs items={trail} className="mb-6" />
            <header className="mb-8 border-b pb-6">
              <h1 className="text-3xl font-bold tracking-tight text-brand-navy sm:text-4xl dark:text-foreground">
                {title}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Effective date: {effectiveDate}
              </p>
            </header>

            <div className="prose-legal">{children}</div>

            {/* Mobile nav */}
            <nav className="mt-12 flex flex-wrap gap-2 border-t pt-6 lg:hidden">
              {legalNav.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end
                  className={({ isActive }) =>
                    `rounded-full border px-3 py-1 text-xs ${
                      isActive
                        ? "border-brand-navy bg-brand-navy text-white"
                        : "text-muted-foreground hover:bg-accent"
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </article>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t px-6 py-8 lg:px-12">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-4 text-sm text-muted-foreground sm:flex-row sm:justify-between">
          <img src="/logo_primary.png" width={1806} height={376} alt="GradeThread" className="h-6" />
          <nav className="flex flex-wrap justify-center gap-4">
            {legalNav.map((item) => (
              <Link key={item.to} to={item.to} className="hover:text-foreground">
                {item.label}
              </Link>
            ))}
            <button
              type="button"
              onClick={openCookiePreferences}
              className="hover:text-foreground"
            >
              Cookie settings
            </button>
          </nav>
          <p>&copy; {new Date().getFullYear()} Pearson Media LLC</p>
        </div>
      </footer>
    </div>
  );
}
