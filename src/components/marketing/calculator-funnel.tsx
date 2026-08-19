import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { track } from "@/lib/analytics";
import { TOOL_SOURCE_PARAM } from "@/lib/calculator-funnel";
import { calculatorHandoff, type Calculator } from "@/lib/seo/calculators";

// US-9010. The handoff block every calculator renders after its result. The
// hook and the query-parameter constant live in @/lib/calculator-funnel.

/**
 * The handoff block. Rendered AFTER the result, never before: until the
 * visitor has the number they came for, this is an advert in the way of the
 * thing they asked for.
 */
export function CalculatorHandoff({ calc }: { calc: Calculator }) {
  const handoff = calculatorHandoff(calc);
  const to = `/flipdesk/${handoff.surface}?${TOOL_SOURCE_PARAM}=${calc.slug}`;

  return (
    <section className="border-t bg-card px-6 py-16">
      <div className="mx-auto max-w-3xl">
        <h2 className="text-3xl font-bold">{handoff.heading}</h2>
        <p className="mt-4 text-muted-foreground">{handoff.body}</p>
        <div className="mt-5">
          <Link
            to={to}
            onClick={() =>
              track("calculator_cta_clicked", {
                calculator: calc.slug,
                source: calc.slug,
                destination: `flipdesk-${handoff.surface}`,
              })
            }
          >
            <span className="inline-flex items-center text-sm font-medium text-brand-red-text hover:underline">
              {handoff.cta}
              <ArrowRight className="ml-1 h-4 w-4" />
            </span>
          </Link>
        </div>
      </div>
    </section>
  );
}
