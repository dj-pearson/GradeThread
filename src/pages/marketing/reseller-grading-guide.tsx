import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { CornerstoneLinks } from "@/components/marketing/cornerstone-links";
import {
  RESELLER_GUIDE_FAQS,
  resellerGuideJsonLd,
} from "@/pages/marketing/marketing-jsonld";

const STEPS = [
  {
    title: "1. Decide what's worth grading",
    body: "Grade the items where condition moves the price — brand-name, vintage, higher-value, or anything a buyer might dispute. A verified grade on a $120 jacket pays for itself; on a $6 fast-fashion tee it rarely does.",
  },
  {
    title: "2. Shoot the right photos",
    body: "Front, back, and the label on a plain, well-lit background, plus a detail shot of any wear. Add close-ups of specific flaws so the grader sees what you see. Sharp, honest photos earn a higher-confidence grade.",
  },
  {
    title: "3. Read the report, not just the number",
    body: "The factor-by-factor breakdown tells you where the wear is. Use it to write an honest listing and to decide whether a quick clean, de-pill, or repair would bump the grade before you list.",
  },
  {
    title: "4. Price to the grade",
    body: "Look up the brand-and-item combination in the Condition Index, find your grade, and price to what that grade actually sells for — instead of guessing high and stalling, or guessing low and leaving money behind.",
  },
  {
    title: "5. Show the proof in the listing",
    body: "Put the grade in your title or item specifics and the certificate link or QR code where buyers see it before they commit. The same proof works across eBay, Poshmark, Mercari, Depop, and Grailed.",
  },
];

export function ResellerGradingGuidePage() {
  return (
    <MarketingLayout
      title="A Reseller's Guide to Condition Grading"
      description="What to grade, how to shoot it, and how to turn a standardized condition grade into faster sales and fewer disputes across eBay, Poshmark, Mercari, and Depop."
      canonicalPath="/reseller-grading-guide"
      jsonLd={resellerGuideJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            A reseller's guide to condition grading
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            You already list, photograph, and ship. Condition grading slots into
            that workflow to fix three things that quietly cost you money: slow
            sell-through on your best pieces, haggling over what "excellent"
            means, and not-as-described returns. This is how to fold a
            standardized grade into your process without slowing it down.
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">The grading workflow, step by step</h2>
          <div className="mt-8 space-y-4">
            {STEPS.map((s) => (
              <div key={s.title} className="rounded-lg border bg-background p-5">
                <h3 className="font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{s.body}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 text-sm text-muted-foreground">
            New to the mechanics? Walk through{" "}
            <Link
              to="/how-it-works"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              how grading works
            </Link>{" "}
            end to end first.
          </p>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">
            What graders actually score
          </h2>
          <p className="mt-3 text-muted-foreground">
            A grade isn't one impression — it's a weighted blend of five
            factors. Knowing them tells you which flaws to clean up before
            listing and which to disclose:
          </p>
          <ul className="mt-6 space-y-3 text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">
                Fabric condition (30%)
              </span>{" "}
              — pilling, fading, thinning, stains.
            </li>
            <li>
              <span className="font-medium text-foreground">
                Structural integrity (25%)
              </span>{" "}
              — seams, holes, shape retention.
            </li>
            <li>
              <span className="font-medium text-foreground">
                Cosmetic appearance (20%)
              </span>{" "}
              — marks, wrinkling, print condition.
            </li>
            <li>
              <span className="font-medium text-foreground">
                Functional elements (15%)
              </span>{" "}
              — zippers, buttons, snaps, hardware.
            </li>
            <li>
              <span className="font-medium text-foreground">
                Odor &amp; cleanliness (10%)
              </span>{" "}
              — smoke, mildew, freshness.
            </li>
          </ul>
          <p className="mt-6 text-sm text-muted-foreground">
            Each factor and each grade tier has its own deep-dive page in the
            glossary below. Wear shows up differently by garment type — see{" "}
            <Link
              to="/grading-by-category"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              condition grading by category
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">
            Turn the grade into faster sales
          </h2>
          <p className="mt-3 text-muted-foreground">
            A grade is only worth the time if it earns trust and a price. Pair
            it with a certificate buyers can verify to{" "}
            <Link
              to="/reduce-returns"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              cut not-as-described returns
            </Link>
            , and price against real sold comparables to capture the{" "}
            <Link
              to="/resale-value-by-condition"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              resale value your condition earns
            </Link>
            . The grade is the lever; the certificate and the price are how you
            pull it.
          </p>
        </div>
      </section>

      <CornerstoneLinks />

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">Reseller grading FAQ</h2>
          <dl className="mt-10 space-y-6">
            {RESELLER_GUIDE_FAQS.map((faq) => (
              <div key={faq.q} className="border-b pb-6 last:border-b-0">
                <dt className="font-medium">{faq.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-10 text-center">
            <Link to="/signup">
              <Button
                size="lg"
                className="bg-brand-navy text-white hover:bg-brand-navy/90"
              >
                Grade an item free
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <MarketingCTA
        heading="Add grading to your reselling workflow"
        sub="Grade your best pieces, price them to real comparables, and back them with a certificate buyers trust."
      />
    </MarketingLayout>
  );
}
