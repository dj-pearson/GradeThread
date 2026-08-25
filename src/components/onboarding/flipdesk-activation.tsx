import { useLocation } from "react-router";
import { ActivationChecklist } from "@/components/onboarding/activation-checklist";

// US-2859. What is left of components/flipdesk/flipdesk-onboarding.tsx.
//
// That file was a SECOND checklist — its own three steps (add a source, intake
// an item, send it to grading), its own count queries, its own dismissal
// written to users.flipdesk_onboarded, and its own idea of what a new seller
// should do first. A reseller met it, then met the dashboard's checklist, then
// met the persona first-run card under that one. Three lists, three first
// steps, no shared progress.
//
// It is now a placement, not a list: the same checklist, on the FlipDesk
// surface, filtered to what has not been done. Everything it used to decide is
// decided in src/lib/activation-steps.ts.
export function FlipdeskActivation() {
  const { pathname } = useLocation();
  if (!pathname.startsWith("/dashboard/flipdesk")) return null;
  return (
    <div className="mb-6">
      <ActivationChecklist variant="remaining" />
    </div>
  );
}
