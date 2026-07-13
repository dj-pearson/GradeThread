import { gsap } from "gsap";

/**
 * US-1957 — the signature scene. As you scroll through the "See the actual
 * product" section, the certificate ASSEMBLES itself: the score ring pops in,
 * the overall grade counts up 0→final, and the five weighted factor bars fill
 * in sequence — all scrubbed to scroll so the grade feels composed in front of
 * you rather than pre-baked.
 *
 * Progressive enhancement: every FROM-state (empty bars, 0.0 score, hidden ring)
 * is applied at RUNTIME by GSAP inside a gsap.context, so without this engine
 * (mobile / reduced-motion / no-JS / bots) the certificate simply renders fully
 * assembled from the React markup. The returned disposer reverts the context —
 * restoring the assembled state — and must run BEFORE the engine's blanket
 * ScrollTrigger.kill(), or the bars would be left empty.
 */
export function initCertificateScene(): () => void {
  const scene = document.querySelector<HTMLElement>("[data-cert-scene]");
  if (!scene) return () => {};

  const ring = scene.querySelector<HTMLElement>("[data-cert-ring]");
  const scoreEl = scene.querySelector<HTMLElement>("[data-cert-score]");
  const bars = gsap.utils.toArray<HTMLElement>("[data-cert-bar]", scene);
  const finalScore = scoreEl ? parseFloat(scoreEl.textContent || "0") || 0 : 0;

  const ctx = gsap.context(() => {
    // Runtime-only FROM-state (never in CSS/markup).
    if (bars.length) gsap.set(bars, { scaleX: 0 });
    if (ring) gsap.set(ring, { scale: 0.7, opacity: 0 });
    if (scoreEl) scoreEl.textContent = "0.0";

    const counter = { v: 0 };
    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: scene,
        start: "top 78%",
        end: "center 52%",
        scrub: 0.6,
      },
    });

    if (ring) {
      tl.to(ring, { scale: 1, opacity: 1, ease: "back.out(1.6)", duration: 0.4 }, 0);
    }
    if (scoreEl) {
      tl.to(
        counter,
        {
          v: finalScore,
          duration: 0.55,
          ease: "none",
          onUpdate: () => {
            scoreEl.textContent = counter.v.toFixed(1);
          },
        },
        0,
      );
    }
    if (bars.length) {
      tl.to(
        bars,
        { scaleX: 1, ease: "power2.out", duration: 0.5, stagger: 0.12 },
        0.15,
      );
    }
  }, scene);

  return () => {
    ctx.revert(); // reverts animations + clears runtime inline styles → assembled
    if (scoreEl) scoreEl.textContent = finalScore.toFixed(1);
  };
}
