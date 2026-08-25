import { useNavigate } from "react-router";
import { ArrowRight, Compass, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";
import { useActivation } from "@/hooks/use-activation";
import { useAuth } from "@/hooks/use-auth";
import {
  nextGuidedStep,
  setGuidedPathOptOut,
} from "@/lib/guided-path";
import { useGuidedPathStore } from "@/stores/guided-path-store";

// US-2873. The guided path, as one bar.
//
// WHY A BAR AND NOT A WIZARD. "One instruction per screen" is a promise about
// what the seller READS, not about who owns the screen. A wizard that wraps
// intake, grading and the composer would need its own copy of each of those
// surfaces, or an iframe, and the first time one of them changed the wizard
// would quietly show the old one. This renders the single next instruction
// ABOVE whatever real screen the seller is on, and the real screen keeps doing
// its own job.
//
// It shows exactly ONE step -- never a list -- which is the difference between
// this and the checklist that renders on the dashboard.

export function GuidedPathBar() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const user = useAuthStore((s) => s.user);
  const { state, complete } = useActivation();
  const active = useGuidedPathStore((s) => s.active);
  const stop = useGuidedPathStore((s) => s.stop);

  if (!active) return null;

  const position = nextGuidedStep(profile?.use_case ?? null, state);
  // Finished: the path stops offering itself because its steps are DONE, not
  // because a flag says so. Nothing to store, nothing to reset.
  if (!position) return null;

  const { step, index, total } = position;

  return (
    <div className="mb-4 rounded-lg border border-brand-navy/30 bg-brand-navy/5 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Compass className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand-navy dark:text-foreground" />
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              Step {index} of {total}
            </p>
            {/* ONE instruction. */}
            <p className="mt-0.5 font-medium">{step.title}</p>
            {/* AC2's "why this matters", already written once in
                activation-steps.ts and not rewritten here. */}
            <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">
              {step.reason}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => complete(step, navigate)}>
            {step.cta}
            <ArrowRight className="ml-1.5 h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Leave the walkthrough"
            title="Leave the walkthrough"
            onClick={() => {
              // AC3: leaving keeps whatever progress the item has, because the
              // progress IS the data. There is no cursor to throw away.
              setGuidedPathOptOut(user?.id, true);
              stop();
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
