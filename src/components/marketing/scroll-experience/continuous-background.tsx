/**
 * ContinuousBackground (US-1954) — the single fixed field that sits behind the
 * whole landing page so its sections read as transparent panels floating over
 * one continuous surface, instead of stacked, hard-bordered compartments.
 *
 * All visuals live in CSS (`.gt-continuous-bg` in index.css):
 *  - Base / prerender / prefers-reduced-motion: a static soft brand gradient.
 *  - Enhanced (`:root[data-scroll-enhanced]`): the gradient stops drift with the
 *    `--gt-scroll` progress variable that <ScrollExperience> publishes, giving a
 *    subtle parallax "the page is one living field" feel — with zero per-frame
 *    React work.
 *
 * Rendered in the prerendered HTML too; it is purely decorative (aria-hidden)
 * and never blocks paint or captures pointer events.
 */
export function ContinuousBackground() {
  return <div aria-hidden="true" className="gt-continuous-bg" />;
}
