import { useRef } from "react";
import { createRunOwner, type RunOwner } from "@/lib/latest-run";

// US-3223. One RunOwner per component instance, created once and stable across
// renders. A ref rather than useMemo on purpose: this is identity that must
// never be recomputed, and useMemo is allowed to drop its cache.
export function useLatestRun(): RunOwner {
  const ref = useRef<RunOwner | null>(null);
  if (ref.current === null) ref.current = createRunOwner();
  return ref.current;
}
