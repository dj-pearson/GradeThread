import { useNavigate } from "react-router";
import { Check, Sparkles, X, ArrowRight , Compass } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useActivation } from "@/hooks/use-activation";
import { useGuidedPathStore } from "@/stores/guided-path-store";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";

// US-2859 — THE activation checklist. One component, one step list
// (src/lib/activation-steps.ts), one dismissal (src/hooks/use-activation.ts).
//
// It replaces three cards that a new seller met one after another, each with a
// different idea of what step one was:
//
//   • this file's old self — grade / inventory / eBay / notifications
//   • the dashboard's persona first-run card, rendered directly BELOW it and
//     naming a different single first action
//   • components/flipdesk/flipdesk-onboarding.tsx — source / intake / grading
//
// US-1435 had already noticed two of them collided and SEQUENCED them, so a
// reseller saw the FlipDesk one first and this one afterwards. That made them
// non-simultaneous without making them agree, which is the harder half: three
// lists, three progress queries, three dismissals, and no answer at all to "how
// far through setup am I".
//
// A step is done when the real thing happened — a grade exists, a source row
// exists, eBay is connected — never when a button was clicked.

interface ActivationChecklistProps {
  /**
   * `full` (the dashboard) shows every step with the finished ones struck
   * through, so progress is visible. `remaining` (FlipDesk) shows only what is
   * left, because that page is not where somebody goes to admire a checklist.
   *
   * Same steps, same data, same dismissal — only the filter differs. That is
   * what "a filtered view of the same list" means, as against a second list.
   */
  variant?: "full" | "remaining";
}

export function ActivationChecklist({
  variant = "full",
}: ActivationChecklistProps) {
  const navigate = useNavigate();
  const { steps, state, done, total, firstIncomplete, active, complete, dismiss } =
    useActivation();
  const user = useAuthStore((s) => s.user);
  const guidedActive = useGuidedPathStore((s) => s.active);
  const startGuided = useGuidedPathStore((s) => s.start);

  if (!active) return null;

  const shown =
    variant === "remaining" ? steps.filter((s) => !s.isDone(state)) : steps;
  if (shown.length === 0) return null;

  return (
    <Card className="border-brand-navy/30 bg-brand-navy/5">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy/10">
            <Sparkles className="h-5 w-5 text-brand-navy dark:text-foreground" />
          </div>
          <div>
            <CardTitle>Get set up</CardTitle>
            <CardDescription>
              {done} of {total} done. Each one finishes on its own once you do
              the real thing.
            </CardDescription>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={dismiss}
          aria-label="Dismiss setup checklist"
        >
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {shown.map((step) => {
          const isDone = step.isDone(state);
          // "Next" is decided against the FULL list, not the filtered one, so
          // the two variants highlight the same step.
          const isNext = steps.indexOf(step) === firstIncomplete;
          const Icon = step.icon;
          return (
            <div
              key={step.key}
              className={cn(
                "flex items-center gap-3 rounded-lg border p-3",
                isDone
                  ? "border-transparent bg-background/60"
                  : isNext
                    ? "border-brand-navy/40 bg-background"
                    : "border-transparent bg-background/40 opacity-70",
              )}
            >
              <div
                className={cn(
                  "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full",
                  isDone
                    ? "bg-brand-navy text-white"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {isDone ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Icon className="h-4 w-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-sm font-medium",
                    isDone && "text-muted-foreground line-through",
                  )}
                >
                  {step.title}
                </p>
                {/* The WHY, which none of the three old cards carried. */}
                <p className="text-xs text-muted-foreground">{step.reason}</p>
              </div>
              {!isDone && (
                <Button
                  size="sm"
                  variant={isNext ? "default" : "outline"}
                  onClick={() => complete(step, navigate)}
                  className="flex-shrink-0"
                >
                  {step.cta}
                  <ArrowRight className="ml-1.5 h-3 w-3" />
                </Button>
              )}
            </div>
          );
        })}

        <div className="flex justify-end pt-1">
          <Button variant="ghost" size="sm" onClick={dismiss}>
            Skip for now
          </Button>
        </div>
        {/* US-2873 AC1: the way into the guided path, offered from the
            FIRST step rather than as a fifth list of its own. It walks
            these same steps, one at a time. */}
        {!guidedActive && firstIncomplete !== -1 && (
          <Button
            variant="outline"
            size="sm"
            className="mt-1 w-full sm:w-auto"
            onClick={() => startGuided(user?.id)}
          >
            <Compass className="mr-1.5 h-4 w-4" />
            Walk me through it
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
