import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { orbFocus } from "./orb-bus";

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
      // Emerald grade-halo that blooms in as the orb docks behind the ring.
      tl.to(
        ring,
        {
          boxShadow: "0 0 44px 6px rgba(16,185,129,0.5)",
          duration: 0.5,
          ease: "power2.out",
        },
        0.1,
      );
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

    // Halo: over a wider range than the assembly, command the orb (US-1955) to
    // converge on the grade ring, hold as a halo through the section's center,
    // then release so it resumes travelling down the page. strength bells 0→1→0.
    if (ring) {
      ScrollTrigger.create({
        trigger: scene,
        start: "top 68%",
        end: "bottom 38%",
        onEnter: () => {
          orbFocus.active = true;
          orbFocus.targetEl = ring;
        },
        onEnterBack: () => {
          orbFocus.active = true;
          orbFocus.targetEl = ring;
        },
        onLeave: () => {
          orbFocus.active = false;
          orbFocus.strength = 0;
        },
        onLeaveBack: () => {
          orbFocus.active = false;
          orbFocus.strength = 0;
        },
        onUpdate: (self) => {
          orbFocus.strength = Math.sin(self.progress * Math.PI);
        },
      });
    }
  }, scene);

  return () => {
    // Release the orb before tearing down the scene.
    orbFocus.active = false;
    orbFocus.strength = 0;
    orbFocus.targetEl = null;
    ctx.revert(); // reverts animations + clears runtime inline styles → assembled
    if (scoreEl) scoreEl.textContent = finalScore.toFixed(1);
  };
}
