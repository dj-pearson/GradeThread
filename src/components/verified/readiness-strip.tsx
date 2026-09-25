import { Check } from "lucide-react";
import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ReadinessStep, ReadinessStepId } from "@/lib/verified-readiness";

// What is left to set up on the Verified page, as one compact list. Each step
// still to do is a button that takes the seller to the control that does it.

export function ReadinessStrip({
  steps,
  onStep,
}: {
  steps: ReadinessStep[];
  onStep: (id: ReadinessStepId) => void;
}) {
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          Setup: {done} of {steps.length} done
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {steps.map((s) => (
            <li key={s.id} className="flex items-center gap-1.5">
              {s.done ? (
                <>
                  <Check className="h-4 w-4 text-green-600 dark:text-green-400" aria-hidden="true" />
                  <span className="text-muted-foreground">
                    {s.doneLabel}
                    <span className="sr-only"> (done)</span>
                  </span>
                </>
              ) : s.id === "grade" ? (
                <Link
                  to="/dashboard/submissions/new"
                  className="font-medium text-brand-navy underline-offset-2 hover:underline dark:text-foreground"
                >
                  {s.todoLabel}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => onStep(s.id)}
                  className="font-medium text-brand-navy underline-offset-2 hover:underline dark:text-foreground"
                >
                  {s.todoLabel}
                </button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
