import { Link } from "react-router-dom";
import { ArrowRight, BarChart3, Leaf, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarketingLayout, MarketingCTA } from "@/components/marketing/marketing-layout";
import { FOR_BRANDS_META, FOR_BRANDS_PATH } from "@/lib/seo/for-brands";

// US-1788: brand-partner pitch landing. Positions GradeThread as the neutral
// resale-condition + circularity standard for brand resale/trade-in programs,
// and links to the proprietary data assets (durability + resale-condition
// reports) as proof, plus the aggregate ESG impact export.

const PILLARS = [
  {
    icon: ShieldCheck,
    title: "One condition standard buyers trust",
    body: "Every item in your program gets an objective 1.0–10.0 condition grade with a shareable certificate — the same published standard buyers already recognize on the open market. No brand-specific scale to explain, no 'good/very good' ambiguity to dispute.",
  },
  {
    icon: BarChart3,
    title: "Proof, from original data",
    body: "GradeThread publishes original resale data — how condition drives return rate, sell-through, and resale value, and which cohorts hold their condition best. Your program rides a standard backed by evidence, not marketing claims.",
  },
  {
    icon: Leaf,
    title: "Circularity impact for your ESG report",
    body: "An aggregate, PII-safe export of the circularity impact your resale volume represents — CO₂e and water avoided, and material diverted from landfill — estimated from published apparel life-cycle assessments and ready for your ESG reporting.",
  },
];

export function ForBrandsPage() {
  return (
    <MarketingLayout
      title={FOR_BRANDS_META.title}
      description={FOR_BRANDS_META.description}
      canonicalPath={FOR_BRANDS_PATH}
    >
      <section className="px-6 py-16 lg:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            GradeThread for brands
          </p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">
            {FOR_BRANDS_META.h1}
          </h1>
          <p className="mt-6 text-lg text-foreground">{FOR_BRANDS_META.intro}</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <a href="mailto:partnerships@gradethread.com?subject=Brand%20resale%20program">
              <Button size="lg">
                Talk to us <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </a>
            <Link to="/how-it-works">
              <Button size="lg" variant="secondary">
                How grading works
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-5xl grid gap-8 md:grid-cols-3">
          {PILLARS.map((p) => (
            <div key={p.title}>
              <p.icon className="h-8 w-8 text-brand-navy dark:text-foreground" />
              <h2 className="mt-4 text-xl font-bold">{p.title}</h2>
              <p className="mt-2 text-muted-foreground">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">The data behind the standard</h2>
          <p className="mt-4 text-muted-foreground">
            GradeThread's condition standard is backed by original, citable resale data — the kind
            journalists and AI engines quote by name.
          </p>
          <ul className="mt-6 space-y-3">
            <li>
              <Link className="text-brand-navy underline dark:text-foreground" to="/resale-condition-report">
                The State of Resale Condition
              </Link>{" "}
              — how condition grade drives return rate, sell-through, and resale value.
            </li>
            <li>
              <Link className="text-brand-navy underline dark:text-foreground" to="/state-of-durability">
                The State of Secondhand Durability
              </Link>{" "}
              — which brands hold their condition best across regraded garments.
            </li>
            <li>
              <Link className="text-brand-navy underline dark:text-foreground" to="/transparency">
                Grading accuracy & transparency
              </Link>{" "}
              — published accuracy, volume, and the model changelog.
            </li>
          </ul>
          <p className="mt-8 rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
            Impact figures are estimates from published apparel life-cycle assessments — provided for
            ESG reporting as order-of-magnitude values, not precise measurements.
          </p>
        </div>
      </section>

      <MarketingCTA />
    </MarketingLayout>
  );
}
