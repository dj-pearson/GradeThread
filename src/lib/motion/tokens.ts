/**
 * Shared motion tokens (US-1961) — one source of truth for the site's easing
 * curves, durations, and stagger so the scroll reveals, the hero entrance, and
 * the cross-page View Transitions all feel like one system rather than a pile
 * of one-off timings.
 *
 * These values are mirrored as CSS custom properties in `src/index.css`
 * (`--gt-ease`, `--gt-dur`, `--gt-dur-slow`), which the reveal / hero /
 * view-transition CSS consumes directly. This module is the JS-side mirror for
 * any script (e.g. a future gsap tween) that needs the same numbers.
 */
export const motion = {
  /** The site's standard ease-out curve (matches --gt-ease in CSS). */
  ease: "cubic-bezier(0.22, 1, 0.36, 1)",
  /** Seconds. */
  durationFast: 0.4,
  duration: 0.7,
  durationSlow: 0.8,
  /** Cross-page view-transition cross-fade, seconds. */
  durationPage: 0.35,
  /** Per-item stagger step, seconds. */
  stagger: 0.08,
} as const;

export type Motion = typeof motion;
