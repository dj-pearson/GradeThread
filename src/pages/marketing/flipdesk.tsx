import { Link } from "react-router";
import {
  PackageSearch,
  Ruler,
  Camera,
  BadgeCheck,
  LineChart,
  ListChecks,
  Repeat2,
  Receipt,
  Boxes,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { HelpCategoryLink } from "@/components/marketing/help-category-link";
import {
  FLIPDESK_FAQS,
  flipdeskJsonLd,
} from "@/pages/marketing/marketing-jsonld";

// US-1397 (SEO): public marketing/SEO surface for FlipDesk — the eBay
// reseller-management suite inside GradeThread. Targets the reseller-tools
// keyword clusters (eBay reseller tools, cross-listing, repricing, comps,
// inventory) and ties them to GradeThread's grading authority — the
// differentiator no crosslister/repricer has. Prerendered (AI crawlers don't
// run JS), with SoftwareApplication + FAQPage + BreadcrumbList JSON-LD.

// The reseller pipeline FlipDesk runs end-to-end. Mirrors the in-app
// source→…→reconcile flow but framed for a prospect.
const PIPELINE = [
  {
    icon: PackageSearch,
    title: "Source & catalog",
    body: "Log what you buy and where, with cost basis, so every item carries its true margin from day one.",
  },
  {
    icon: Ruler,
    title: "Measure",
    body: "Capture the measurements buyers actually filter on — fewer 'doesn't fit' returns, faster sales.",
  },
  {
    icon: Camera,
    title: "Photograph",
    body: "A guided, per-category photo set that doubles as the evidence behind the condition grade.",
  },
  {
    icon: BadgeCheck,
    title: "Grade",
    body: "A standardized 1.0–10.0 condition grade + a verifiable certificate — the trust signal a raw listing can't fake.",
  },
  {
    icon: LineChart,
    title: "Comp & price",
    body: "Real eBay sold comps, condition-aware, so you price to what your grade actually sells for — not guesswork.",
  },
  {
    icon: ListChecks,
    title: "Draft & list",
    body: "AI-assisted titles, item specifics, and descriptions that carry the grade straight into the listing.",
  },
  {
    icon: Repeat2,
    title: "Reprice",
    body: "Rules-based repricing keeps stale inventory moving without racing yourself to the bottom.",
  },
  {
    icon: Receipt,
    title: "Sell & reconcile",
    body: "Match payouts, fees, and shipping back to each item so you know real profit, not just revenue.",
  },
];

export function FlipDeskPage() {
  return (
    <MarketingLayout
      title="FlipDesk — Management for eBay Resellers"
      description="FlipDesk is GradeThread's reseller suite and works with eBay: grade, comp, list, reprice and reconcile in one place, with a verifiable grade per listing."
      canonicalPath="/flipdesk"
      jsonLd={flipdeskJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-brand-navy/20 bg-brand-navy/5 px-4 py-1.5 text-sm font-medium text-brand-navy dark:text-foreground">
            <Boxes className="h-4 w-4" />
            FlipDesk — the reseller workspace inside GradeThread
          </div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Run your eBay resale business on graded condition
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            Crosslisters move your listings around. Repricers chase the bottom.
            <strong>
              {" "}
              FlipDesk works with eBay and does the whole reseller workflow
            </strong>{" "}
            —
            sourcing, measurements, photos, comps, listing, repricing, and payout
            reconciliation — and puts the one thing they can&rsquo;t in every
            listing: a <strong>standardized condition grade</strong> and a{" "}
            <Link
              to="/verify"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              verifiable certificate
            </Link>
            . The same grade that builds buyer trust also drives how you price.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/signup">
              <Button
                size="lg"
                className="bg-brand-navy text-white hover:bg-brand-navy/90"
              >
                Start with FlipDesk
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
          <h2 className="text-3xl font-bold">The full reseller pipeline</h2>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Most resellers stitch together a crosslister, a repricer, a comps
            tool, and a spreadsheet. FlipDesk runs the whole pipeline in one
            place — and every step feeds the condition grade that sets you apart.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {PIPELINE.map((step) => (
              <div key={step.title} className="rounded-lg border bg-background p-4">
                <step.icon className="mb-2 h-5 w-5 text-brand-navy dark:text-foreground" />
                <p className="font-semibold">{step.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">
            Why grading changes the reseller math
          </h2>
          <p className="mt-3 text-muted-foreground">
            Condition is one of the biggest levers on what used clothing sells
            for — and the hardest thing for a buyer to trust from a listing photo.
            A standardized grade fixes both sides of that problem:
          </p>
          <ul className="mt-6 space-y-4">
            <li className="rounded-lg border bg-card p-4">
              <span className="font-semibold">Price to the grade, not a guess.</span>{" "}
              FlipDesk comps are condition-aware, so an Excellent (8) item is
              priced against what Excellent items actually sold for — see the{" "}
              <Link
                to="/condition-index"
                className="font-medium text-brand-navy hover:underline dark:text-foreground"
              >
                Condition Index
              </Link>
              .
            </li>
            <li className="rounded-lg border bg-card p-4">
              <span className="font-semibold">Fewer returns and disputes.</span> A
              factor-by-factor grade + photos set accurate expectations, so fewer
              items come back &ldquo;not as described.&rdquo;
            </li>
            <li className="rounded-lg border bg-card p-4">
              <span className="font-semibold">A trust signal buyers can verify.</span>{" "}
              The certificate is public and verifiable — proof your
              &ldquo;Excellent&rdquo; means the same thing every time, on{" "}
              <Link
                to="/condition-grading"
                className="font-medium text-brand-navy hover:underline dark:text-foreground"
              >
                a published standard
              </Link>
              .
            </li>
          </ul>
          <div className="mt-8">
            <Link to="/for-resellers">
              <Button size="lg" variant="outline">
                More for resellers
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">FlipDesk FAQ</h2>
          <dl className="mt-10 space-y-6">
            {FLIPDESK_FAQS.map((faq) => (
              <div key={faq.q} className="border-b pb-6 last:border-b-0">
                <dt className="font-medium">{faq.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <MarketingCTA
        heading="Resell on a standard, not an opinion"
        sub="FlipDesk works with eBay and runs your reselling workflow end-to-end, putting a verifiable condition grade in every listing — the trust signal that sells faster and comes back less."
      />
      <div className="px-6 pb-12 lg:px-12">
        <div className="mx-auto max-w-5xl">
          <HelpCategoryLink category="flipdesk" label="Every pipeline stage, one guide each:" />
        </div>
      </div>

    </MarketingLayout>
  );
}
