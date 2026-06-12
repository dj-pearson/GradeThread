import { Link } from "react-router-dom";
import { Camera, Cpu, Award, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { GRADE_FACTORS } from "@/lib/constants";
import {
  HOW_IT_WORKS_STEPS,
  howItWorksJsonLd,
} from "@/pages/marketing/marketing-jsonld";

const STEP_ICONS = [Camera, Cpu, Award, Share2];
const STEPS = HOW_IT_WORKS_STEPS.map((s, i) => ({
  ...s,
  icon: STEP_ICONS[i] ?? Camera,
}));

const FACTOR_ROWS = Object.values(GRADE_FACTORS);

export function HowItWorksPage() {
  return (
    <MarketingLayout
      title="How It Works"
      description="How GradeThread's AI grades pre-owned clothing: upload photos, get a 1.0–10.0 condition grade across 5 weighted factors, and share a verified certificate."
      canonicalPath="/how-it-works"
      jsonLd={howItWorksJsonLd()}
    >
      {/* Hero / answer-first intro */}
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            How GradeThread Works
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            GradeThread turns garment photos into a standardized condition
            grade in four steps: you upload front, back, label, and detail
            photos; our Claude Vision AI scores the item across five weighted
            factors; you receive a 1.0–10.0 grade with a detailed report; and
            you share a verified certificate buyers can scan to confirm
            condition. The whole process takes minutes and produces a
            consistent, objective grade you can attach to any listing.
          </p>
        </div>
      </section>

      {/* Steps */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-center text-3xl font-bold">
            Four steps from photos to a verified grade
          </h2>
          <ol className="mt-12 grid gap-8 sm:grid-cols-2">
            {STEPS.map((step, i) => (
              <li key={step.name} className="flex gap-4">
                <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-white">
                  <step.icon className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-semibold">
                    {i + 1}. {step.name}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {step.text}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* The 5 factors */}
      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">The five grading factors</h2>
          <p className="mt-3 text-muted-foreground">
            Every grade is a weighted blend of five factors, so a single flaw
            never sinks an otherwise excellent item — and condition stays
            comparable across sellers.
          </p>
          <div className="mt-8 overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold">Factor</th>
                  <th className="px-4 py-3 text-right font-semibold">Weight</th>
                </tr>
              </thead>
              <tbody>
                {FACTOR_ROWS.map((f) => (
                  <tr key={f.label} className="border-t">
                    <td className="px-4 py-3">{f.label}</td>
                    <td className="px-4 py-3 text-right font-medium">
                      {(f.weight * 100).toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-6 text-sm text-muted-foreground">
            Want the full breakdown of the scale and tiers? Read our{" "}
            <Link
              to="/condition-grading"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              guide to clothing condition grading
            </Link>
            , see{" "}
            <Link
              to="/pricing"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              pricing
            </Link>
            , or learn how it helps{" "}
            <Link
              to="/for-resellers"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              resellers
            </Link>
            .
          </p>
          <div className="mt-8">
            <Link to="/signup">
              <Button
                size="lg"
                className="bg-brand-navy text-white hover:bg-brand-navy/90"
              >
                Grade your first item free
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <MarketingCTA />
    </MarketingLayout>
  );
}
