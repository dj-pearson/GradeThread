import { Link } from "react-router";
import {
  ArrowRight,
  Camera,
  DollarSign,
  Package,
  Shield,
  Tag,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { GRADE_FACTORS } from "@/lib/constants";
import {
  EXAMPLE_BADGE,
  EXAMPLE_COMP,
  EXAMPLE_DISCLAIMER,
  EXAMPLE_FACTORS,
  EXAMPLE_GRADE,
  EXAMPLE_ITEM,
  EXAMPLE_PHOTOS,
  EXAMPLE_SALE,
  exampleNetCents,
  exampleProfitCents,
} from "@/lib/example-account";

// US-2865. One worked example, read-only, for an account that has nothing of
// its own yet. It runs the whole arc in the order the seller will live it:
// the garment, the four photos, the grade with every factor explained, what
// comps said it was worth, and what was actually left after it sold.
//
// READ-ONLY IS STRUCTURAL, NOT A RULE SOMEBODY HAS TO REMEMBER. Nothing on this
// page has a mutation, a form or a query. It renders constants from
// src/lib/example-account.ts. There is no way for it to write to the user's
// tables because it has nothing to write with.

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** The badge that goes on every block. Never render example data without it. */
function ExampleTag() {
  return (
    <Badge variant="secondary" className="shrink-0">
      {EXAMPLE_BADGE}
    </Badge>
  );
}

function StepCard({
  step,
  title,
  icon: Icon,
  children,
}: {
  step: number;
  title: string;
  icon: typeof Package;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-3 text-base">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-navy text-xs font-semibold text-white">
            {step}
          </span>
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="flex-1">{title}</span>
          <ExampleTag />
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function ExamplePage() {
  const feeTotal = EXAMPLE_SALE.fees.reduce((sum, f) => sum + f.cents, 0);

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-12">
      <PageHeader
        title="An example, start to finish"
        subtitle={`One real garment through every step: photos, grade, price, sale. ${EXAMPLE_DISCLAIMER}`}
        actions={
          // AC4's "one click clears it". There is nothing to delete, so
          // clearing it is leaving it.
          <Button variant="outline" asChild>
            <Link to="/dashboard">
              <X className="mr-2 h-4 w-4" />
              Close example
            </Link>
          </Button>
        }
      />

      <StepCard step={1} title="The item" icon={Package}>
        <p className="text-base font-medium">{EXAMPLE_ITEM.title}</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          {[
            ["Brand", EXAMPLE_ITEM.brand],
            ["Size", EXAMPLE_ITEM.size],
            ["Colour", EXAMPLE_ITEM.colorway],
            ["Category", EXAMPLE_ITEM.category],
            ["Found at", EXAMPLE_ITEM.source],
            ["Paid", money(EXAMPLE_ITEM.acquiredPriceCents)],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      </StepCard>

      <StepCard step={2} title="The four photos a grade needs" icon={Camera}>
        {/* Drawn frames, not photographs. What a new seller needs is which four
            shots and what each one is for; a stock image of a branded garment
            would answer neither and raise a licensing question besides. */}
        <ul className="grid gap-3 sm:grid-cols-2">
          {EXAMPLE_PHOTOS.map((photo) => (
            <li
              key={photo.type}
              className="rounded-xl border border-dashed border-border p-4"
            >
              <div className="flex items-center gap-2">
                <Camera className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{photo.label}</span>
              </div>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {photo.teaches}
              </p>
            </li>
          ))}
        </ul>
      </StepCard>

      <StepCard step={3} title="The grade, and why" icon={Shield}>
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full border-4 border-emerald-500">
            <span className="text-2xl font-bold text-emerald-500">
              {EXAMPLE_GRADE.overallScore.toFixed(1)}
            </span>
          </div>
          <div className="text-center sm:text-left">
            <Badge
              variant="outline"
              className="border-emerald-200 bg-emerald-100 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
            >
              {EXAMPLE_GRADE.tier}
            </Badge>
            <p className="mt-2 text-sm text-muted-foreground">
              {EXAMPLE_GRADE.summary}
            </p>
          </div>
        </div>

        <ul className="mt-5 space-y-4">
          {EXAMPLE_FACTORS.map((f) => {
            const factor = GRADE_FACTORS[f.key];
            return (
              <li key={f.key} className="space-y-1.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {factor.label}{" "}
                    <span className="text-muted-foreground">
                      ({(factor.weight * 100).toFixed(0)}% of the grade)
                    </span>
                  </span>
                  <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                    {f.score.toFixed(1)}
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-valuenow={f.score * 10}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${factor.label}: ${f.score.toFixed(1)} out of 10`}
                  className="h-1.5 w-full overflow-hidden rounded-full bg-emerald-500/15"
                >
                  <div
                    className="h-full rounded-full bg-emerald-500"
                    style={{ width: `${f.score * 10}%` }}
                  />
                </div>
                <p className="text-sm text-muted-foreground">{f.note}</p>
              </li>
            );
          })}
        </ul>

        <p className="mt-5 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
          Each factor is scored out of 10, multiplied by its share above, and
          added up. That is where {EXAMPLE_GRADE.overallScore.toFixed(1)} comes
          from. The AI was{" "}
          {Math.round(EXAMPLE_GRADE.confidence * 100)}% confident, so this one
          graded straight through. Below 75% a person checks it before you see
          it.
        </p>
      </StepCard>

      <StepCard step={4} title="What it was worth" icon={Tag}>
        <div className="grid grid-cols-3 gap-3 text-center">
          {[
            ["Low", EXAMPLE_COMP.lowCents],
            ["Typical", EXAMPLE_COMP.medianCents],
            ["High", EXAMPLE_COMP.highCents],
          ].map(([label, cents]) => (
            <div key={label as string} className="rounded-xl bg-muted/50 p-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="text-lg font-semibold">
                {money(cents as number)}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          From {EXAMPLE_COMP.soldCount} {EXAMPLE_COMP.source} in the last{" "}
          {EXAMPLE_COMP.windowDays} days. {EXAMPLE_COMP.note}
        </p>
      </StepCard>

      <StepCard step={5} title="What was left after it sold" icon={DollarSign}>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt>Sold on {EXAMPLE_SALE.soldOn}</dt>
            <dd className="font-medium">
              {money(EXAMPLE_SALE.soldPriceCents)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt>Shipping the buyer paid</dt>
            <dd className="font-medium">
              {money(EXAMPLE_SALE.shippingChargedCents)}
            </dd>
          </div>
          {EXAMPLE_SALE.fees.map((f) => (
            <div key={f.label} className="flex justify-between text-destructive">
              <dt>{f.label}</dt>
              <dd className="font-medium">-{money(f.cents)}</dd>
            </div>
          ))}
          <div className="flex justify-between text-destructive">
            <dt>Postage you actually paid</dt>
            <dd className="font-medium">
              -{money(EXAMPLE_SALE.shippingCostCents)}
            </dd>
          </div>
          <div className="flex justify-between border-t pt-2">
            <dt className="font-medium">Money in your pocket</dt>
            <dd className="font-semibold">{money(exampleNetCents())}</dd>
          </div>
          <div className="flex justify-between text-destructive">
            <dt>What you paid for it</dt>
            <dd className="font-medium">
              -{money(EXAMPLE_ITEM.acquiredPriceCents)}
            </dd>
          </div>
          <div className="flex justify-between border-t pt-2 text-base">
            <dt className="font-semibold">Profit</dt>
            <dd className="font-bold text-emerald-600 dark:text-emerald-400">
              {money(exampleProfitCents())}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-sm text-muted-foreground">
          It sold in {EXAMPLE_SALE.daysToSell} days. {money(feeTotal)} of the{" "}
          {money(EXAMPLE_SALE.soldPriceCents)} went to fees, which is the number
          most sellers forget until they do this sum.
        </p>
      </StepCard>

      <Card className="bg-muted/40">
        <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
          <p className="text-sm text-muted-foreground">
            That is the whole loop. Yours starts with four photos.
          </p>
          <Button asChild>
            <Link to="/dashboard/submissions/new">
              Grade your first item
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
