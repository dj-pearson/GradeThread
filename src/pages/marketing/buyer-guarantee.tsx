import { Link } from "react-router-dom";
import { ShieldCheck, FileCheck2, Scale, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import {
  BUYER_GUARANTEE_FAQS,
  buyerGuaranteeJsonLd,
} from "@/pages/marketing/marketing-jsonld";

// US-867: public policy page for the condition-backed buyer trust guarantee +
// mediation policy. Defines the promise, eligibility, and "materially not as
// graded" using the certified disclosure as the reference, and routes buyers to
// the claim intake form (/buyer-guarantee/claim).
export function BuyerGuaranteePage() {
  return (
    <MarketingLayout
      title="Buyer Trust Guarantee"
      description="The GradeThread condition-backed buyer guarantee: what 'materially not as graded' means, eligibility, and how to file a mediation claim against a certified grade."
      canonicalPath="/buyer-guarantee"
      jsonLd={buyerGuaranteeJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-brand-navy/20 bg-brand-navy/5 px-4 py-1.5 text-sm font-medium text-brand-navy dark:text-foreground">
            <ShieldCheck className="h-4 w-4" />
            GradeThread-Verified Trust Promise
          </div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            The buyer trust guarantee
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            A GradeThread grade is only as valuable as it is trustworthy. Our
            condition-backed guarantee makes the grade financially meaningful:
            if a graded item arrives <strong>materially not as graded</strong>,
            you can file a mediation claim, and we review it against the exact,
            certified condition report the item was sold with.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/buyer-guarantee/claim">
              <Button
                size="lg"
                className="bg-brand-navy text-white hover:bg-brand-navy/90"
              >
                File a claim
              </Button>
            </Link>
            <Link to="/verify">
              <Button size="lg" variant="outline">
                Verify a certificate first
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">What the guarantee covers</h2>
          <p className="mt-3 text-muted-foreground">
            The guarantee applies to a graded item — one sold with a GradeThread
            certificate — that arrives in a condition meaningfully worse than the
            certificate represents. The certificate is the reference: it carries
            an objective 1.0–10.0 grade across five weighted factors and a{" "}
            <Link
              to="/condition-grading"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              structured disclosure of documented flaws
            </Link>
            . A claim succeeds when the item differs from that record in a way
            that materially affects the deal.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg border bg-background p-4">
              <FileCheck2 className="mb-2 h-5 w-5 text-brand-navy dark:text-foreground" />
              <p className="font-semibold">Anchored to the certificate</p>
              <p className="mt-1 text-sm text-muted-foreground">
                We judge every claim against the certified grade and its
                disclosed defects — not against opinion.
              </p>
            </div>
            <div className="rounded-lg border bg-background p-4">
              <Scale className="mb-2 h-5 w-5 text-brand-navy dark:text-foreground" />
              <p className="font-semibold">Independent mediation</p>
              <p className="mt-1 text-sm text-muted-foreground">
                A reviewer compares your evidence to the disclosure and records a
                decision with a written rationale.
              </p>
            </div>
            <div className="rounded-lg border bg-background p-4">
              <ShieldCheck className="mb-2 h-5 w-5 text-brand-navy dark:text-foreground" />
              <p className="font-semibold">Accountable grades</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Confirmed misgrades feed grade review and our published accuracy
                reporting.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">
            What &ldquo;materially not as graded&rdquo; means
          </h2>
          <p className="mt-3 text-muted-foreground">
            &ldquo;Material&rdquo; means a difference large enough to change the
            deal — not a trivial discrepancy. In practice, a covered claim
            usually involves one of these:
          </p>
          <ul className="mt-6 space-y-4">
            <li className="rounded-lg border bg-card p-4">
              <span className="font-semibold">An undisclosed defect.</span> A
              significant flaw — a hole, stain, broken zipper, or structural
              damage — that does not appear in the certificate&rsquo;s disclosed
              defects.
            </li>
            <li className="rounded-lg border bg-card p-4">
              <span className="font-semibold">Condition well below the grade.</span>{" "}
              Wear materially heavier than the assigned tier and factor scores
              represent.
            </li>
            <li className="rounded-lg border bg-card p-4">
              <span className="font-semibold">A different item.</span> The item
              received is not the item the certificate was issued for.
            </li>
          </ul>

          <div className="mt-8 rounded-lg border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-800 dark:bg-amber-950/40">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div>
                <p className="font-semibold text-amber-900 dark:text-amber-200">
                  Not covered
                </p>
                <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
                  Flaws already disclosed on the certificate, and intentional{" "}
                  <Link to="/design-vs-damage" className="font-medium underline">
                    design features
                  </Link>{" "}
                  (factory distressing, raw hems, acid washes) graded as styling
                  — these are documented before you buy. Buyer&rsquo;s remorse,
                  fit, and changes that happen after delivery are also outside
                  the guarantee.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">How mediation works</h2>
          <ol className="mt-6 space-y-4">
            <li className="rounded-lg border bg-card p-4">
              <span className="font-semibold">1. File a claim.</span> Open the
              item&rsquo;s certificate, note its certificate number, and submit
              the claim form with your contact email, a description of the
              difference, and any supporting photo links. No account needed.
            </li>
            <li className="rounded-lg border bg-card p-4">
              <span className="font-semibold">2. We review.</span> A reviewer
              compares your claim against the certified disclosure — the grade,
              the factor breakdown, and the documented defects — and may follow
              up for more detail.
            </li>
            <li className="rounded-lg border bg-card p-4">
              <span className="font-semibold">3. Decision.</span> We record an
              approved or rejected decision with a written rationale. Approved
              claims confirm a misgrade and feed our grade-review process.
            </li>
          </ol>

          <div className="mt-8 rounded-lg border bg-muted/40 p-4">
            <p className="text-sm text-muted-foreground">
              <strong>Scope of this version.</strong> The guarantee currently
              provides <strong>mediation and a documented decision</strong> — it
              does not issue automated refunds or payouts. Any refund or remedy
              is resolved between you and the seller and through the marketplace
              you purchased on. GradeThread&rsquo;s role is to hold the grade
              accountable to its certified disclosure. This complements, and does
              not replace, marketplace buyer protections.
            </p>
          </div>

          <div className="mt-8">
            <Link to="/buyer-guarantee/claim">
              <Button
                size="lg"
                className="bg-brand-navy text-white hover:bg-brand-navy/90"
              >
                File a guarantee claim
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">
            Buyer guarantee FAQ
          </h2>
          <dl className="mt-10 space-y-6">
            {BUYER_GUARANTEE_FAQS.map((faq) => (
              <div key={faq.q} className="border-b pb-6 last:border-b-0">
                <dt className="font-medium">{faq.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <MarketingCTA
        heading="A grade you can stand behind"
        sub="Sell with a verifiable certificate and a condition-backed guarantee — the strongest trust signal in resale."
      />
    </MarketingLayout>
  );
}
