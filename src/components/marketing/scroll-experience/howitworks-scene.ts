import { gsap } from "gsap";

/**
 * US-1958 — "How It Works" as a connected sequence. A progress rail threading
 * the four step icons fills left→right, scrubbed to scroll, so the steps read
 * as one advancing pipeline instead of four separate cards. (Non-pinned on
 * purpose — a ScrollTrigger pin fights Lenis; the scrubbed fill is smoother.)
 *
 * Progressive enhancement: the FROM-state (empty rail) is applied at runtime,
 * so without the engine the rail simply shows full — and it's desktop-only
 * (hidden on the stacked mobile layout) anyway. Returns a disposer.
 */
export function initHowItWorksScene(): () => void {
  const scene = document.querySelector<HTMLElement>("[data-hiw-scene]");
  const fill = scene?.querySelector<HTMLElement>("[data-hiw-fill]");
  if (!scene || !fill) return () => {};

  const ctx = gsap.context(() => {
    gsap.set(fill, { scaleX: 0 });
    gsap.to(fill, {
      scaleX: 1,
      ease: "none",
      scrollTrigger: {
        trigger: scene,
        start: "top 72%",
        end: "center 52%",
        scrub: 1,
      },
    });
  }, scene);

  return () => {
    ctx.revert();
  };
}
