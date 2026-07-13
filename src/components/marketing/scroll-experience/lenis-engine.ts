import Lenis from "lenis";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { initCertificateScene } from "./certificate-scene";

/**
 * Tier-1 scroll engine (US-1953) — Lenis momentum smooth-scroll synced to GSAP's
 * single ticker, with ScrollTrigger registered for the pinned/scrubbed scenes
 * that later phases register (orb→certificate, How-It-Works, FlipDesk pipeline).
 *
 * This module is imported ONLY via dynamic import from <ScrollExperience>, so
 * `gsap` + `lenis` land in their own lazy chunk and never touch the eager landing
 * graph (mirrors how hero-orb lazy-loads `three`). The caller has already gated
 * on capability (desktop / pointer:fine / motion-OK / !save-data) before we run.
 *
 * Returns a disposer that fully tears everything down — critical because the SPA
 * mounts/unmounts the landing route on navigation.
 */
export function initScrollEngine(): () => void {
  gsap.registerPlugin(ScrollTrigger);

  const lenis = new Lenis({
    // We drive rAF from GSAP's ticker below, so Lenis must not run its own loop.
    autoRaf: false,
    smoothWheel: true,
    // Momentum feels good with a pointer; on touch we keep native scrolling.
    // (Lenis defaults to native touch; being explicit for intent.)
  });

  // Keep ScrollTrigger's scroll cache in lockstep with Lenis's virtual position.
  const onScroll = () => ScrollTrigger.update();
  lenis.on("scroll", onScroll);

  // Drive Lenis from GSAP's one rAF (GSAP ticks in seconds, Lenis wants ms), and
  // disable lag smoothing so a dropped frame can't teleport the scroll position
  // (that jump is especially jarring under smooth scroll).
  const raf = (time: number) => lenis.raf(time * 1000);
  gsap.ticker.add(raf);
  gsap.ticker.lagSmoothing(0);

  // Signature scene: the certificate assembles on scroll (US-1957).
  const disposeCertScene = initCertificateScene();

  // Lenis changes the document height/positions; make sure the ScrollTrigger
  // scenes measure against the final layout.
  ScrollTrigger.refresh();

  return () => {
    // Revert scene contexts FIRST (restores their runtime inline styles to the
    // fully-assembled state) before the blanket trigger kill below.
    disposeCertScene();
    lenis.off("scroll", onScroll);
    gsap.ticker.remove(raf);
    gsap.ticker.lagSmoothing(500, 33); // restore GSAP's default
    lenis.destroy();
    for (const trigger of ScrollTrigger.getAll()) trigger.kill();
  };
}
