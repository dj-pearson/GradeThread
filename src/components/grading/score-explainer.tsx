import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// US-2871. Where the number comes from.
//
// THE STORY'S FIRST AC WAS ALREADY DONE. submission-detail.tsx has rendered
// each factor's weight beside its label since before this story
// (`({(factor.weight * 100).toFixed(0)}%)`), so "the weights are not shown" was
// not the defect. What was missing is the step AFTER the weights: a seller can
// see 9.5 and "30%" and still have no idea how five numbers became 8.7. This
// shows the multiplication and the sum, so the arithmetic is checkable rather
// than asserted.
//
// EVERY NUMBER IS DERIVED. The weights are passed in by the caller (from
// GRADE_FACTORS on the seller report, from the grade's own rubric on the
// certificate) and the rounding is the same Math.round(total * 10) / 10 the
// shared helpers use. The vault
// note on this (grading-scale-and-weights.md) is blunt about why: this
// calculation has shipped wrong twice from having N copies, so this component
// computes nothing the app does not already compute -- it only shows the work.

/**
 * One row of the arithmetic.
 *
 * The label and the weight are PASSED IN rather than looked up, because the
 * certificate renders whatever rubric the grade used (US-1997) and a
 * non-clothing rubric has its own factor keys and its own weights. A version
 * of this component that read GRADE_FACTORS itself compiled fine and would
 * have shown clothing weights against furniture scores.
 */
export interface ExplainerFactor {
  key: string;
  label: string;
  weight: number;
  score: number;
}

/** score x weight, to two places, which is what the column actually shows. */
function contribution(score: number, weight: number): number {
  return Math.round(score * weight * 100) / 100;
}

export function ScoreExplainer({
  factors,
  overallScore,
  className,
}: {
  factors: ExplainerFactor[];
  overallScore: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  const rows = factors.map((f) => ({
    ...f,
    contribution: contribution(f.score, f.weight),
  }));
  const total = rows.reduce((sum, r) => sum + r.score * r.weight, 0);
  const rounded = Math.round(total * 10) / 10;

  return (
    <div className={cn("rounded-lg border", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium hover:bg-muted/50"
      >
        How this score was built
        <ChevronDown
          className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="space-y-3 border-t px-4 py-3">
          {/* AC4 asked for four sentences with no link away. The count is
              rows.length, not the literal "five": a non-clothing rubric can
              have a different number of factors. */}
          <p className="text-sm text-muted-foreground">
            Each of the {rows.length} things we check is scored out of 10. Each
            one counts for a fixed share of the total, because a hole in the
            fabric matters more than a missing button. We multiply every score
            by its share and add them up. That total is rounded to one decimal
            place, and that is your grade.
          </p>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="pb-1 font-normal">What we checked</th>
                <th className="pb-1 text-right font-normal">Score</th>
                <th className="pb-1 text-right font-normal">Share</th>
                <th className="pb-1 text-right font-normal">Counts as</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t">
                  <td className="py-1.5">{r.label}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {r.score.toFixed(1)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                    {(r.weight * 100).toFixed(0)}%
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {r.contribution.toFixed(2)}
                  </td>
                </tr>
              ))}
              <tr className="border-t font-medium">
                <td className="py-1.5" colSpan={3}>
                  Added up
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {total.toFixed(2)}
                </td>
              </tr>
              <tr className="border-t font-semibold">
                <td className="py-1.5" colSpan={3}>
                  Rounded to one decimal place
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {rounded.toFixed(1)}
                </td>
              </tr>
            </tbody>
          </table>

          {/* A stored grade can differ from this sum when a reviewer changed a
              factor after the fact. Saying so is better than a seller finding a
              0.1 gap and concluding the maths is broken. */}
          {Math.abs(rounded - overallScore) > 0.001 && (
            <p className="text-xs text-muted-foreground">
              Your saved grade is {overallScore.toFixed(1)}. A reviewer adjusted
              this one after it was first worked out.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
