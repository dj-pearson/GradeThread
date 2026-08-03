import { Link } from "react-router";
import {
  Building2,
  Target,
  ScrollText,
  ShieldCheck,
  LineChart,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { StandardJustifications } from "@/components/marketing/standard-justifications";
import { ABOUT_FAQS, aboutJsonLd } from "@/pages/marketing/marketing-jsonld";

// US-868: the company/about page. An entity-level authority surface (E-E-A-T):
// who runs GradeThread (Pearson Media LLC), the mission, the published grading
// methodology, and links into the standard + transparency report. The title
// prop MUST match the /about PUBLIC_ROUTES title so the runtime breadcrumb and
// the prerendered head-builder breadcrumb stay identical (jsonld-parity test).
export function AboutPage() {
  return (
    <MarketingLayout
      title="About"
      description="GradeThread, built by Pearson Media LLC, is the standard for pre-owned clothing condition grading — our mission, our methodology, and how we keep grades honest."
      canonicalPath="/about"
      jsonLd={aboutJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-brand-navy/20 bg-brand-navy/5 px-4 py-1.5 text-sm font-medium text-brand-navy dark:text-foreground">
            <Building2 className="h-4 w-4" />
            Built by Pearson Media LLC
          </div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            About GradeThread
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            GradeThread is the standard for pre-owned clothing condition grading.
            We replace vague, inconsistent condition descriptions with one
            objective, published, and reproducible 1.0–10.0 grade and a
            certificate buyers can independently verify — so condition means the
            same thing on every item, for every seller and buyer.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/grading-standard">
              <Button
                size="lg"
                className="bg-brand-navy text-white hover:bg-brand-navy/90"
              >
                Read the grading standard
              </Button>
            </Link>
            <Link to="/transparency">
              <Button size="lg" variant="outline">
                See our accuracy report
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-start gap-3">
            <Target className="mt-1 h-6 w-6 shrink-0 text-brand-navy dark:text-foreground" />
            <div>
              <h2 className="text-3xl font-bold">Our mission</h2>
              <p className="mt-3 text-muted-foreground">
                Resale runs on trust, and trust breaks down at one word:{" "}
                <em>condition</em>. &ldquo;Good used condition&rdquo; means
                something different to every seller and every buyer, and that gap
                is where returns, disputes, and lost sales live. Our mission is to
                make condition objective, comparable, and verifiable — a single
                standard that lets a grade carry the same meaning everywhere it
                appears.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* The four justifications behind "the standard" (US-1297) */}
      <section className="border-t px-6 py-16">
        <StandardJustifications
          heading="Why we say GradeThread is the standard"
          intro="A standard has to earn the name. Ours is objective, published, reproducible, and independently verifiable — here is what each of those means."
        />
      </section>

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">A published methodology, not a black box</h2>
          <p className="mt-3 text-muted-foreground">
            Authority on condition comes from showing your work. We publish the
            rubric, measure ourselves against expert reviewers, and keep the
            grade accountable to a certified record.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg border bg-card p-4">
              <ScrollText className="mb-2 h-5 w-5 text-brand-navy dark:text-foreground" />
              <p className="font-semibold">A fixed, published rubric</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Five weighted factors on a 1.0–10.0 scale, mapped to seven named
                tiers — disclosed on the{" "}
                <Link
                  to="/grading-standard"
                  className="font-medium text-brand-navy hover:underline dark:text-foreground"
                >
                  grading standard
                </Link>
                .
              </p>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <LineChart className="mb-2 h-5 w-5 text-brand-navy dark:text-foreground" />
              <p className="font-semibold">Measured accuracy</p>
              <p className="mt-1 text-sm text-muted-foreground">
                We publish AI-vs-human agreement and error against expert
                reviewers on our{" "}
                <Link
                  to="/transparency"
                  className="font-medium text-brand-navy hover:underline dark:text-foreground"
                >
                  transparency report
                </Link>
                .
              </p>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <ShieldCheck className="mb-2 h-5 w-5 text-brand-navy dark:text-foreground" />
              <p className="font-semibold">Accountable grades</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Every grade is a verifiable{" "}
                <Link
                  to="/verify"
                  className="font-medium text-brand-navy hover:underline dark:text-foreground"
                >
                  certificate
                </Link>
                , backed by a{" "}
                <Link
                  to="/buyer-guarantee"
                  className="font-medium text-brand-navy hover:underline dark:text-foreground"
                >
                  buyer guarantee
                </Link>
                .
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">The company</h2>
          <p className="mt-3 text-muted-foreground">
            GradeThread is built and operated by{" "}
            <strong>Pearson Media LLC</strong>, the company behind the platform.
            We bring together AI vision, a published grading rubric grounded in
            how resellers actually assess garments, and an end-to-end reseller
            workflow (FlipDesk) — source, catalog, measure, photograph, grade,
            comp, list, sell, and reconcile — so the same standard that proves
            condition also runs the business around it.
          </p>
          <p className="mt-4 text-muted-foreground">
            We focus on one thing and try to be the authority on it:
            standardized, verifiable condition grading for pre-owned clothing.
            Everything we publish — the{" "}
            <Link
              to="/condition-grading"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              condition-grading guide
            </Link>
            , the{" "}
            <Link
              to="/resale-value-by-condition"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              Condition Index
            </Link>
            , and our accuracy data — exists to make that standard usable and
            trustworthy.
          </p>
        </div>
      </section>

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">About GradeThread FAQ</h2>
          <dl className="mt-10 space-y-6">
            {ABOUT_FAQS.map((faq) => (
              <div key={faq.q} className="border-b pb-6 last:border-b-0">
                <dt className="font-medium">{faq.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <MarketingCTA
        heading="Grade against a real standard"
        sub="Join resellers who use GradeThread to make condition objective, build buyer trust, and sell faster."
      />
    </MarketingLayout>
  );
}
