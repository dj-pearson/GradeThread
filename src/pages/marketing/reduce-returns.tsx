import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { CornerstoneLinks } from "@/components/marketing/cornerstone-links";
import {
  REDUCE_RETURNS_FAQS,
  reduceReturnsJsonLd,
} from "@/pages/marketing/marketing-jsonld";

export function ReduceReturnsPage() {
  return (
    <MarketingLayout
      title="Reduce Returns with Condition Proof"
      description="Most pre-owned clothing returns are 'not as described.' A standardized condition grade and a verifiable certificate close the gap before the buyer pays."
      canonicalPath="/reduce-returns"
      jsonLd={reduceReturnsJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Reduce returns and disputes with condition proof
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            The most expensive words in resale are "not as described." A buyer
            opens the package, decides the jacket you called "great used
            condition" looks more worn than they pictured, and you eat the
            return, the shipping both ways, and a dent in your rating. The fix
            isn't a longer description — it's a shared definition of condition
            the buyer can verify before they pay.
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">
            Why "good used condition" causes returns
          </h2>
          <p className="mt-3 text-muted-foreground">
            Free-text condition is an opinion, and opinions don't travel.
            "Excellent" to a seller who has handled a hundred similar pieces can
            read as "worn out" to a first-time buyer. When the only condition
            signal is your adjective and a few photos, the buyer fills the gap
            with their own expectation — and a return is what happens when that
            expectation misses.
          </p>
          <p className="mt-4 text-muted-foreground">
            A{" "}
            <Link
              to="/condition-grading"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              standardized condition grade
            </Link>{" "}
            removes the ambiguity. An 8/10 Excellent means the same thing on
            your listing as on anyone else's, because it's the same published
            rubric — five weighted factors, half-point precision — applied to
            every item.
          </p>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">
            What proof actually changes the outcome
          </h2>
          <p className="mt-3 text-muted-foreground">
            Disclosure only works if the buyer trusts it. A grade backed by a
            verifiable certificate does three things a description can't:
          </p>
          <ol className="mt-6 space-y-4">
            <li className="rounded-lg border bg-card p-4">
              <span className="font-semibold">It's objective.</span> The grade
              comes from a fixed rubric, not your sales pitch, so the buyer
              isn't asked to trust your judgment of "excellent."
            </li>
            <li className="rounded-lg border bg-card p-4">
              <span className="font-semibold">It's itemized.</span> The
              certificate breaks the score into fabric, structure, cosmetic,
              functional, and odor factors — so a buyer sees exactly where the
              wear is before it surprises them.
            </li>
            <li className="rounded-lg border bg-card p-4">
              <span className="font-semibold">It's verifiable.</span> The buyer
              opens the certificate by link or QR code and GradeThread
              re-derives its integrity signature on load — so they know the
              grade is genuine and unedited.
            </li>
          </ol>
          <p className="mt-6 text-sm text-muted-foreground">
            Every grade carries a confidence score, and low-confidence grades
            are routed to human review before they're finalized — we publish how
            often AI and human reviewers agree on the{" "}
            <Link
              to="/transparency"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              transparency report
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Put the proof where buyers look</h2>
          <p className="mt-3 text-muted-foreground">
            A certificate only prevents a return if the buyer sees it before
            they commit. Add the grade to your title or item specifics, paste
            the certificate link into the description, and include the QR code
            in a photo slot. It works the same on eBay, Poshmark, Mercari,
            Depop, and Grailed — the certificate isn't tied to any one
            marketplace. For the full workflow, see the{" "}
            <Link
              to="/reseller-grading-guide"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              reseller's guide to condition grading
            </Link>
            .
          </p>
        </div>
      </section>

      <CornerstoneLinks />

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">
            Returns &amp; disputes FAQ
          </h2>
          <dl className="mt-10 space-y-6">
            {REDUCE_RETURNS_FAQS.map((faq) => (
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
        heading="Stop eating not-as-described returns"
        sub="Grade one garment, share the certificate, and let buyers confirm the condition before they pay — fewer disputes, faster sales."
      />
    </MarketingLayout>
  );
}
