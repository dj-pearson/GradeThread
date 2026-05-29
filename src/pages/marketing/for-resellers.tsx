import { Link } from "react-router-dom";
import { ShieldCheck, TrendingDown, Clock, BadgeCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";

const BENEFITS = [
  {
    icon: ShieldCheck,
    title: "Build buyer trust",
    body: "A standardized, third-party condition grade and verifiable certificate reassure buyers that 'Excellent' means the same thing every time — not just your opinion.",
  },
  {
    icon: TrendingDown,
    title: "Reduce returns and disputes",
    body: "Documenting condition up front — with photos and a factor-by-factor breakdown — sets accurate expectations, so fewer items come back 'not as described.'",
  },
  {
    icon: Clock,
    title: "List faster",
    body: "Skip agonizing over how to describe condition. Get an objective grade in minutes and drop it straight into your listing copy.",
  },
  {
    icon: BadgeCheck,
    title: "Stand out in search",
    body: "A verified condition grade and certificate is a differentiator on crowded marketplaces where most listings just say 'good, see photos.'",
  },
];

const MARKETPLACES = [
  "eBay",
  "Poshmark",
  "Mercari",
  "Depop",
  "Grailed",
  "Facebook Marketplace",
];

export function ForResellersPage() {
  return (
    <MarketingLayout
      title="For Resellers"
      description="Standardized condition grades that build buyer trust, cut returns, and speed up sales for eBay, Poshmark, Mercari, Depop, and Grailed sellers."
      canonicalPath="/for-resellers"
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            GradeThread for resellers
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            If you sell pre-owned clothing on eBay, Poshmark, Mercari, Depop, or
            Grailed, condition is the hardest thing to communicate and the
            biggest driver of returns. GradeThread gives you a standardized
            1.0–10.0 condition grade, a factor-by-factor report, and a shareable
            certificate for every item — so buyers trust your listings, you get
            fewer 'not as described' returns, and you list faster. It works
            alongside your existing tools and marketplaces.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link to="/signup">
              <Button
                size="lg"
                className="bg-brand-navy text-white hover:bg-brand-navy/90"
              >
                Start grading free
              </Button>
            </Link>
            <Link to="/pricing">
              <Button size="lg" variant="outline">
                See pricing
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-3xl font-bold">Why resellers use GradeThread</h2>
          <div className="mt-10 grid gap-8 sm:grid-cols-2">
            {BENEFITS.map((b) => (
              <div key={b.title} className="flex gap-4">
                <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg bg-brand-navy/10 text-brand-navy">
                  <b.icon className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-semibold">{b.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{b.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Works with where you already sell</h2>
          <p className="mt-3 text-muted-foreground">
            Attach a GradeThread certificate to listings across every major
            resale marketplace:
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            {MARKETPLACES.map((m) => (
              <span
                key={m}
                className="rounded-full border bg-card px-4 py-1.5 text-sm font-medium"
              >
                {m}
              </span>
            ))}
          </div>
          <p className="mt-8 text-sm text-muted-foreground">
            Power users can run their full pipeline — source, catalog,
            photograph, draft, list, sell, ship, reconcile — in{" "}
            <Link
              to="/pricing"
              className="font-medium text-brand-navy hover:underline"
            >
              FlipDesk
            </Link>
            . New here? See{" "}
            <Link
              to="/how-it-works"
              className="font-medium text-brand-navy hover:underline"
            >
              how grading works
            </Link>{" "}
            or the{" "}
            <Link
              to="/condition-grading"
              className="font-medium text-brand-navy hover:underline"
            >
              condition-grading guide
            </Link>
            .
          </p>
        </div>
      </section>

      <MarketingCTA
        heading="Grade smarter, sell faster"
        sub="Join resellers who use GradeThread to standardize condition, build buyer confidence, and cut returns."
      />
    </MarketingLayout>
  );
}
