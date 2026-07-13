/**
 * Shared, dependency-free channel between the certificate scene (US-1957) and
 * the WebGL orb (US-1955). The scene commands the orb to converge on the grade
 * ring as a halo; the orb reads this object every frame and blends toward it,
 * then releases and resumes its downward travel.
 *
 * Kept in its own tiny module (no three / no gsap) so BOTH the eager scene code
 * and the lazy orb chunk import the SAME singleton without pulling in each
 * other's heavy deps. It is a mutable singleton on purpose — a 1-slot event bus.
 */
export interface OrbFocus {
  /** A scene is currently commanding the orb. */
  active: boolean;
  /** DOM element the orb should center on (read live each frame). */
  targetEl: HTMLElement | null;
  /** Target mesh scale while focused (forms the halo size). */
  scale: number;
  /** Extra red heat while focused (0..1). */
  heat: number;
  /** How strongly to blend toward the target (0..1) — ramps up then down. */
  strength: number;
}

export const orbFocus: OrbFocus = {
  active: false,
  targetEl: null,
  scale: 0.4,
  heat: 0.7,
  strength: 0,
};
