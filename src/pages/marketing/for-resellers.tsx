import { Link } from "react-router";
import {
  ShieldCheck,
  TrendingDown,
  Clock,
  BadgeCheck,
  History,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { StatCounters } from "@/components/marketing/stat-counters";
import { FlipDeskPipelinePreview } from "@/components/marketing/flipdesk-pipeline-preview";

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
    body: "A verified condition grade and certificate is a differentiator on crowded marketplaces where most listings just say 'good, see photos.' Build a Verified Seller profile and embed the badge to win even more trust.",
  },
  {
    icon: History,
    title: "Provenance that travels",
    body: "Attach a Garment Passport to each item — a buyer-scannable history that carries forward on every relist — and back your grades with a condition-backed Buyer Guarantee.",
  },
  {
    icon: Sparkles,
    title: "A full reseller workflow",
    body: "FlipDesk runs your whole pipeline: ScoutAI buy decisions from real sold comps, bulk AI AutoLister drafts, scheduled drops, automatic repricing, and consignment with payouts.",
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

      {/* Live platform counters (US-865) — real aggregate social proof. */}
      <StatCounters />

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-3xl font-bold">Why resellers use GradeThread</h2>
          <div className="mt-10 grid gap-8 sm:grid-cols-2">
            {BENEFITS.map((b) => (
              <div key={b.title} className="flex gap-4">
                <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg bg-brand-navy/10 text-brand-navy dark:text-foreground">
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
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              FlipDesk
            </Link>
            . New here? See{" "}
            <Link
              to="/how-it-works"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              how grading works
            </Link>{" "}
            or the{" "}
            <Link
              to="/condition-grading"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              condition-grading guide
            </Link>
            . Browse the{" "}
            <Link
              to="/verified"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              Verified Seller directory
            </Link>{" "}
            for top graders, and earn grade credits by{" "}
            <Link
              to="/leaderboard"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              referring other sellers
            </Link>
            .
          </p>
        </div>
      </section>

      {/* US-1949: show the FlipDesk pipeline, don't just describe it. Honest
          stylized mocks (not screenshots) of the bulk source→grade→list→
          reprice→reconcile flow so resellers can see the tool before signup. */}
      <section className="py-16">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <h2 className="text-3xl font-bold">The full reseller workflow, built in</h2>
          <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
            FlipDesk runs your whole pipeline — source, catalog, grade, list,
            reprice, and reconcile every item without leaving the app. Here&rsquo;s
            each stage of the tool.
          </p>
        </div>
        <div className="mt-10">
          <FlipDeskPipelinePreview />
        </div>
        <p className="mx-auto mt-4 max-w-2xl px-6 text-center text-xs text-muted-foreground">
          Stylized preview of the FlipDesk workspace — a peek at the tool, not a
          screenshot.
        </p>
        <div className="mt-8 text-center">
          <Link to="/signup">
            <Button
              size="lg"
              className="bg-brand-navy text-white hover:bg-brand-navy/90"
            >
              Try FlipDesk Free
            </Button>
          </Link>
        </div>
      </section>

      <MarketingCTA
        heading="Grade smarter, sell faster"
        sub="Join resellers who use GradeThread to standardize condition, build buyer confidence, and cut returns."
      />
    </MarketingLayout>
  );
}
