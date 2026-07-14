import { useEffect, useRef, type ReactNode } from "react";
import { ContinuousBackground } from "./continuous-background";
import { motion } from "@/lib/motion/tokens";

/**
 * <ScrollExperience> (US-1953 foundation) — progressive-enhancement wrapper that
 * turns the landing page into one continuous "film" (epic US-1952) layered over
 * the already-prerendered HTML. It is INERT under SSR/prerender, no-JS, and
 * prefers-reduced-motion: the static background gradient and current layout stand
 * unchanged.
 *
 * Two tiers, so the cheap cohesion win doesn't drag in the heavy engine:
 *
 *  • Tier 0 (cheap, always-on unless reduced-motion): publishes page scroll
 *    progress to the `--gt-scroll` CSS variable (0..1) via a passive, rAF-
 *    throttled listener. This alone powers the continuous-background morph — no
 *    gsap/lenis required.
 *
 *  • Tier 1 (gated + lazy): on a capable desktop it dynamically imports the
 *    Lenis + GSAP engine (its own chunk) for momentum smooth-scroll and the
 *    ScrollTrigger context future scenes register into. Gated exactly like the
 *    hero orb (desktop width + fine pointer + motion-OK + !save-data).
 *
 * StrictMode-safe: the effect fully reverses itself (listeners, CSS var, engine
 * disposer) on cleanup, so the dev double-invoke and SPA route changes never
 * leak a Lenis instance or a GSAP ticker callback.
 */
export function ScrollExperience({ children }: { children: ReactNode }) {
  const disposeRef = useRef<null | (() => void)>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;

    const root = document.documentElement;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    // ── Tier 0: scroll progress → `--gt-scroll` (skipped under reduced-motion) ──
    let rafId = 0;
    let ticking = false;
    const publishProgress = () => {
      ticking = false;
      const max = root.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(Math.max(window.scrollY / max, 0), 1) : 0;
      root.style.setProperty("--gt-scroll", p.toFixed(4));
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      rafId = window.requestAnimationFrame(publishProgress);
    };

    // ── Tier 0b: scroll-reveal via IntersectionObserver ───────────────────────
    // Bulletproof + engine-independent: fires on real viewport intersection, so
    // wheel, trackpad, anchor-jumps, and programmatic scroll all reveal content
    // (and it works on mobile, not just the desktop engine). The hidden FROM-
    // state lives on a class we add HERE in JS, so no-JS / bots / reduced-motion
    // never hide anything.
    let revealObserver: IntersectionObserver | null = null;
    const revealEls: HTMLElement[] = [];
    let countObserver: IntersectionObserver | null = null;
    const countEls: { el: HTMLElement; final: string }[] = [];

    if (!reduced) {
      root.setAttribute("data-scroll-enhanced", "");
      publishProgress();
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll, { passive: true });

      const els = Array.from(
        document.querySelectorAll<HTMLElement>("[data-gt-reveal]"),
      );
      if (els.length > 0 && "IntersectionObserver" in window) {
        revealObserver = new IntersectionObserver(
          (entries, obs) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const el = entry.target as HTMLElement;
              el.classList.add("gt-reveal-in");
              obs.unobserve(el);
            }
          },
          { rootMargin: "0px 0px -12% 0px", threshold: 0.05 },
        );
        for (const el of els) {
          // Stagger siblings within the same grid/row by DOM order.
          const siblings = el.parentElement
            ? Array.from(
                el.parentElement.querySelectorAll<HTMLElement>(
                  ":scope > [data-gt-reveal]",
                ),
              )
            : [el];
          const i = Math.max(0, siblings.indexOf(el));
          el.style.transitionDelay = `${Math.min(i, 5) * 80}ms`;
          el.classList.add("gt-reveal-init");
          revealObserver.observe(el);
          revealEls.push(el);
        }
      }

      // ── Tier 0c: count-up for [data-countup] on first enter (US-1960) ────────
      // Numbers ease from 0 to their prerendered value. JS-driven, so no-JS /
      // bots keep the final value; we restore it exactly on complete + teardown.
      const nums = Array.from(
        document.querySelectorAll<HTMLElement>("[data-countup]"),
      );
      if (nums.length > 0 && "IntersectionObserver" in window) {
        countObserver = new IntersectionObserver(
          (entries, obs) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const el = entry.target as HTMLElement;
              obs.unobserve(el);
              const final = (el.textContent ?? "").trim();
              const m = final.match(/^(\d+)(\D*)$/);
              if (!m) continue;
              const target = parseInt(m[1]!, 10);
              const suffix = m[2] ?? "";
              // Shared motion token (US-1961) so the count-up matches the
              // reveal/hero timing feel.
              const duration = motion.durationSlow * 1000;
              let start = 0;
              const step = (ts: number) => {
                if (!start) start = ts;
                const t = Math.min((ts - start) / duration, 1);
                const eased = 1 - Math.pow(1 - t, 3);
                el.textContent = Math.round(eased * target) + suffix;
                if (t < 1) window.requestAnimationFrame(step);
                else el.textContent = final;
              };
              window.requestAnimationFrame(step);
            }
          },
          { threshold: 0.5 },
        );
        for (const el of nums) {
          countEls.push({ el, final: (el.textContent ?? "").trim() });
          countObserver.observe(el);
        }
      }
    }

    // ── Tier 1: momentum smooth-scroll + ScrollTrigger (gated + lazy) ──────────
    const wideEnough = window.matchMedia("(min-width: 1024px)").matches;
    const finePointer = window.matchMedia("(pointer: fine)").matches;
    const nav = navigator as Navigator & {
      connection?: { saveData?: boolean };
    };
    const saveData = nav.connection?.saveData === true;

    let cancelled = false;
    if (!reduced && wideEnough && finePointer && !saveData) {
      import("./lenis-engine")
        .then(({ initScrollEngine }) => {
          if (cancelled) return;
          disposeRef.current = initScrollEngine();
        })
        .catch(() => {
          /* the engine is enhancement-only — ignore load/init failures */
        });
    }

    return () => {
      cancelled = true;
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafId) window.cancelAnimationFrame(rafId);
      revealObserver?.disconnect();
      for (const el of revealEls) {
        el.classList.remove("gt-reveal-init", "gt-reveal-in");
        el.style.removeProperty("transition-delay");
      }
      countObserver?.disconnect();
      for (const { el, final } of countEls) el.textContent = final;
      root.removeAttribute("data-scroll-enhanced");
      root.style.removeProperty("--gt-scroll");
      disposeRef.current?.();
      disposeRef.current = null;
    };
  }, []);

  return (
    <>
      <ContinuousBackground />
      {children}
    </>
  );
}
