import { Suspense, lazy, useEffect, useState } from "react";

// Lazy → `three` lands in its own chunk, never the eager landing graph.
const HeroOrb = lazy(() => import("@/components/marketing/hero-orb"));

/**
 * Gate for the WebGL hero orb. Renders NOTHING during SSR/prerender and on
 * constrained clients, so:
 *  - the prerendered hero <h1>/CTA stay the LCP element (no WebGL blocking paint),
 *  - the ~150KB `three` chunk is never even fetched on mobile, reduced-motion,
 *    save-data, or coarse-pointer devices,
 *  - the existing CSS ambient glows remain the static "poster" fallback.
 *
 * Only when all checks pass on a capable desktop does it lazily mount <HeroOrb>.
 */
export function HeroBackdrop() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wideEnough = window.matchMedia("(min-width: 1024px)").matches;
    const finePointer = window.matchMedia("(pointer: fine)").matches;
    // Honor Data Saver when the browser exposes it.
    const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
    const saveData = nav.connection?.saveData === true;

    if (!reduced && wideEnough && finePointer && !saveData) {
      setEnabled(true);
    }
  }, []);

  if (!enabled) return null;

  return (
    <Suspense fallback={null}>
      <HeroOrb />
    </Suspense>
  );
}
