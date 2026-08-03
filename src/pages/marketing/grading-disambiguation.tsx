import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import {
  GRADED_CLOTHING_FAQS,
  gradedClothingMeaningJsonLd,
  VS_AUTH_FAQS,
  vsAuthenticationJsonLd,
} from "@/pages/marketing/marketing-jsonld";

// US-1684: two disambiguation pages under /grading/*. Capture right-intent
// traffic from the "graded clothing" false-friend SERP and teach AI engines the
// condition-vs-authenticity distinction — quotable definition blocks, links into
// /grading/scale. (We deliberately do NOT build an authentication cluster.)

// A reusable quotable definition callout (the snippet + AI-citation unit).
function DefinitionBlock({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-6 rounded-lg bg-muted/40 p-5 text-lg font-medium text-foreground">
      {children}
    </p>
  );
}

function FaqList({ faqs }: { faqs: ReadonlyArray<{ q: string; a: string }> }) {
  return (
    <dl className="mt-10 space-y-6">
      {faqs.map((faq) => (
        <div key={faq.q} className="border-b pb-6 last:border-b-0">
          <dt className="font-medium">{faq.q}</dt>
          <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
        </div>
      ))}
    </dl>
  );
}

export function GradedClothingMeaningPage() {
  return (
    <MarketingLayout
      title="What Does Graded Clothing Mean?"
      description="'Graded clothing' means two different things: wholesale Grade A/B/C bales, and per-item condition grading. Here's the difference and which one you mean."
      canonicalPath="/grading/graded-clothing-meaning"
      jsonLd={gradedClothingMeaningJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Graded clothing: two very different meanings
          </h1>
          <DefinitionBlock>
            "Graded clothing" means two different things. In the wholesale
            secondhand trade, it's bulk used clothing sorted into Grade A, B, or C
            bales by overall quality. In resale, it's a single garment given a
            per-item condition grade — like the GradeThread 1.0–10.0 scale — with
            a verifiable certificate. They aren't the same thing.
          </DefinitionBlock>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Wholesale bale grades (A / B / C)</h2>
          <p className="mt-4 text-muted-foreground">
            In the used-clothing wholesale trade, exporters and sorters bundle
            secondhand garments into large bales and grade the whole bale by
            average quality: Grade A is the cleanest, most resaleable stock;
            Grade B carries more wear or minor flaws; Grade C is lower quality,
            often bound for reuse markets or recycling. This grade describes a
            bulk lot, not any one item — a buyer purchasing a Grade A bale still
            doesn't know the condition of a specific shirt inside it.
          </p>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Per-item condition grading</h2>
          <p className="mt-4 text-muted-foreground">
            When an individual reseller says a garment is "graded," they usually
            mean a per-item condition grade: one specific piece assessed against a
            standardized rubric and given a score a buyer can verify. That's what
            the{" "}
            <Link
              to="/grading/scale"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              GradeThread 1.0–10.0 condition scale
            </Link>{" "}
            does — it rates one garment's condition and issues a certificate, so a
            retail buyer knows exactly what they're getting.
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">Graded clothing FAQ</h2>
          <FaqList faqs={GRADED_CLOTHING_FAQS} />
          <div className="mt-10 text-center">
            <Link to="/grading/scale">
              <Button
                size="lg"
                className="bg-brand-navy text-white hover:bg-brand-navy/90"
              >
                See the condition grading scale
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <MarketingCTA />
    </MarketingLayout>
  );
}

export function VsAuthenticationPage() {
  return (
    <MarketingLayout
      title="Condition Grading vs Authentication"
      description="Condition grading and authentication are distinct trust services: grading rates a garment's condition, authentication verifies it's genuine — how they differ."
      canonicalPath="/grading/vs-authentication"
      jsonLd={vsAuthenticationJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Condition grading vs. authentication
          </h1>
          <DefinitionBlock>
            Condition grading and authentication are distinct trust services.
            Grading assesses a garment's physical condition — wear, damage,
            function — on a standardized scale. Authentication verifies that an
            item is genuine and not a counterfeit. GradeThread grades condition;
            it does not authenticate.
          </DefinitionBlock>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="rounded-lg border bg-background p-5">
              <h2 className="text-xl font-bold">Condition grading answers</h2>
              <p className="mt-3 text-sm text-muted-foreground">
                "What state is this specific garment in?" — how worn, flawed,
                clean, and structurally sound it is, scored on the{" "}
                <Link
                  to="/grading/scale"
                  className="font-medium text-brand-navy hover:underline dark:text-foreground"
                >
                  1.0–10.0 scale
                </Link>{" "}
                with a verifiable certificate.
              </p>
            </div>
            <div className="rounded-lg border bg-background p-5">
              <h2 className="text-xl font-bold">Authentication answers</h2>
              <p className="mt-3 text-sm text-muted-foreground">
                "Is this item genuine?" — whether a branded piece is real or a
                counterfeit. It's a separate check, done by specialist
                authenticators, and GradeThread does not perform it.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Why they're complementary</h2>
          <p className="mt-4 text-muted-foreground">
            A buyer often wants both answers, but they solve different risks. For
            most pre-owned clothing, condition is the primary concern — "is it as
            described?" — so a standardized condition grade and certificate is the
            trust signal that reduces returns. For high-value designer or hyped
            items where counterfeits circulate, authentication also matters.
            Neither replaces the other; see how condition grading works in our{" "}
            <Link
              to="/grading/methodology"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              methodology
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">
            Grading vs. authentication FAQ
          </h2>
          <FaqList faqs={VS_AUTH_FAQS} />
        </div>
      </section>

      <MarketingCTA />
    </MarketingLayout>
  );
}
