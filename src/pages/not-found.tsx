import { Link } from "react-router-dom";
import { Home, LayoutDashboard, HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SEO } from "@/components/seo";

// US-450: on-brand, clear 404. Logo + friendly copy + a single clear primary
// action ("Go home") with a few de-emphasized helpful links, and noindex so a
// crawler never indexes the error page. Layout/styling mirrors the
// error-boundary fallbacks for consistency.
const HELPFUL_LINKS = [
  { to: "/dashboard", label: "Your dashboard", icon: LayoutDashboard },
  { to: "/how-it-works", label: "How it works", icon: HelpCircle },
  { to: "/faq", label: "FAQ", icon: HelpCircle },
];

export function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <SEO title="Page not found" noindex />
      <img src="/logo_primary.png" alt="GradeThread" className="h-7" />
      <h1 className="mt-8 text-6xl font-bold text-brand-navy dark:text-foreground">404</h1>
      <p className="mt-4 max-w-md text-lg text-muted-foreground">
        We couldn&apos;t find that page. It may have moved, or the link might be
        out of date.
      </p>
      <Link to="/" className="mt-6">
        <Button>
          <Home className="mr-2 h-4 w-4" />
          Go home
        </Button>
      </Link>
      <nav className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm">
        {HELPFUL_LINKS.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="inline-flex items-center gap-1.5 text-muted-foreground underline-offset-4 hover:text-brand-red-text hover:underline"
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
