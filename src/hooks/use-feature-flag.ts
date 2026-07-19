// US-2109: React binding for PostHog client-side experiments.
//
// The logic lives in src/lib/client-experiments.ts (and is tested there without
// React); this file is only the subscription + re-render plumbing.

import { useEffect, useState } from "react";
import {
  CONTROL,
  getAssignment,
  onFlagsReady,
  trackExposure,
  type ExperimentAssignment,
} from "@/lib/client-experiments";

/**
 * Resolve an experiment variant.
 *
 * @param key      PostHog feature-flag key.
 * @param exposed  Whether the variant is actually being SHOWN right now.
 *                 Defaults to true (the common case: the hook is called by the
 *                 component that renders the thing). Pass a condition for a
 *                 surface that mounts before it is visible — a modal, a
 *                 below-the-fold section — so the exposure event describes what
 *                 the visitor saw rather than what React mounted.
 *
 * Returns `{ variant, ready }`. Branch on `variant`; use `ready` to avoid
 * rendering control copy and then swapping it. Before analytics consent, and in
 * DEV where capturing is opted out, this stays `{ control, false }` forever,
 * which is the correct degraded behaviour: everyone sees the control.
 */
export function useFeatureFlag(key: string, exposed = true): ExperimentAssignment {
  const [assignment, setAssignment] = useState<ExperimentAssignment>(() =>
    getAssignment(key),
  );

  useEffect(() => {
    // Re-read on mount: consent may have been granted, or flags delivered,
    // between the initial render and here.
    setAssignment(getAssignment(key));
    return onFlagsReady(() => setAssignment(getAssignment(key)));
  }, [key]);

  useEffect(() => {
    if (!assignment.ready || !exposed) return;
    trackExposure(key, assignment.variant);
  }, [key, exposed, assignment.ready, assignment.variant]);

  return assignment;
}

export { CONTROL };
