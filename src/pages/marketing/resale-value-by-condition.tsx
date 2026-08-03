import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { CornerstoneLinks } from "@/components/marketing/cornerstone-links";
import {
  RESALE_VALUE_FAQS,
  resaleValueJsonLd,
} from "@/pages/marketing/marketing-jsonld";

export function ResaleValueByConditionPage() {
  return (
    <MarketingLayout
      title="Resale Value by Condition Grade"
      description="Condition is one of the biggest levers on what used clothing sells for. See how resale value moves with each grade, from real eBay comps in the Condition Index."
      canonicalPath="/resale-value-by-condition"
      jsonLd={resaleValueJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Resale value by condition grade
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            Two identical jackets, same brand, same size — one sells for $90, the
            other for $45. The usual difference is condition. Brand and item set
            the ceiling; condition decides where on the curve you land. This is
            how resale value moves with the grade, and how to price to it instead
            of guessing.
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">The value-by-condition curve</h2>
          <p className="mt-3 text-muted-foreground">
            The relationship isn't a straight line. The step from New With Tags
            to Excellent is usually small — buyers pay nearly the same for
            "basically new." But each step down toward Fair tends to take a
            bigger bite, and a single documented flaw can cut what an otherwise
            desirable piece fetches by a third or more. The drops get steeper as
            condition falls.
          </p>
          <p className="mt-4 text-muted-foreground">
            That shape is why precision pays. The difference between a{" "}
            <Link
              to="/grading/very-good"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              Very Good (7)
            </Link>{" "}
            and an{" "}
            <Link
              to="/grading/excellent"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              Excellent (8)
            </Link>{" "}
            call can be real money on a sought-after item — and half-point
            grading exists precisely to place a piece on the right rung.
          </p>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">
            The Condition Index: the curve, from real comps
          </h2>
          <p className="mt-3 text-muted-foreground">
            Rather than guess the shape, GradeThread publishes it. The{" "}
            <a
              href="/condition-index"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              Condition Index
            </a>{" "}
            tracks sold comparables for popular brand-and-item combinations and
            fits a value-versus-grade curve. For each one it shows the typical
            resale value at every grade, the number of comparables behind it, and
            when it was last refreshed. Combinations without enough recent data
            aren't shown — we won't print a number we can't stand behind.
          </p>
          <p className="mt-4 text-muted-foreground">
            Want a quick read on a single item? The{" "}
            <Link
              to="/whats-it-worth"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              What's It Worth tool
            </Link>{" "}
            takes a brand, item, and grade and returns the typical resale value
            at that condition straight from the Index.
          </p>
        </div>
      </section>

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Price to the grade, then hold it</h2>
          <p className="mt-3 text-muted-foreground">
            Pricing in three steps: grade the item, look up the curve for that
            brand-and-item combination, and price to the median value at your
            grade. A proven grade also lets you <em>hold</em> that price — the
            biggest reason a pre-owned sale stalls is the buyer's uncertainty
            about condition, and a verifiable certificate removes it, so you get
            fewer lowball offers and{" "}
            <Link
              to="/reduce-returns"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              fewer not-as-described returns
            </Link>
            . Condition isn't just a discount you take — it's value you can prove
            and keep.
          </p>
        </div>
      </section>

      <CornerstoneLinks />

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">
            Resale value FAQ
          </h2>
          <dl className="mt-10 space-y-6">
            {RESALE_VALUE_FAQS.map((faq) => (
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
        heading="Capture the value your condition earns"
        sub="Get an objective grade, price it against real sold comparables, and back it with a certificate buyers trust."
      />
    </MarketingLayout>
  );
}
