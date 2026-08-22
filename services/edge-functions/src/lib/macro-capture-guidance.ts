// US-2137: per-slot capture guidance for macro shots — what to photograph, how
// close, and how to light it.
//
// ⚠️ MIRROR: this file is duplicated VERBATIM at
//   services/edge-functions/src/lib/macro-capture-guidance.ts
// because the Deno edge runtime cannot import from the Vite `src/` tree. The
// two copies MUST stay byte-identical — the guard test
// src/lib/macro-capture-guidance.test.ts fails the build if they drift. Keep
// this module dependency-free (pure data + pure functions) so it type-checks
// under BOTH tsconfig and Deno.
//
// WHY THE EDGE HAS A COPY AT ALL: it is SERVED, not read by edge logic.
// photo-profiles.ts is the server-authoritative slot table precisely so "new
// categories or label tweaks ship without an App Store release", and this is
// exactly that kind of copy — per-slot capture wording with no behaviour
// attached. Web reads its own bundled copy today; iOS and Android have NO
// guidance of any kind (US-2137 AC1), so serving it means they can render it
// the moment they have somewhere to put it, without a release to change a
// sentence.
//
// The existing photo-profiles hints say WHAT ("Serial + reference numbers",
// "Hallmarks, engravings, brand etching"). They say nothing about distance or
// light, which is where macro shots actually fail: authentication tells are
// only legible at consistent framing and lighting, and inconsistent capture is
// itself a source of false positives — a soft, flatly-lit stamp reads as a
// wrong stamp.
//
// This is DELIBERATELY a separate module from macro-photo-quality.ts. That one
// judges a photo after the fact; this one tells a seller what to do before they
// take it. They share the slot vocabulary and nothing else, and a test pins
// that every gated slot has guidance — the pairing that matters is "if we will
// reject it, we must first have said how to get it right".

/** How tightly the subject should fill the frame. Drives the capture overlay. */
export type FramingTightness = "tight" | "standard";

export interface MacroCaptureGuidance {
  /** One line on distance/framing. Imperative — an instruction, not a label. */
  distance: string;
  /** One line on lighting. The failure mode differs by material. */
  lighting: string;
  /** How much of the frame the subject should occupy. */
  framing: FramingTightness;
}

/**
 * Guidance per macro slot.
 *
 * The lighting lines differ on purpose rather than repeating "use good light":
 * a printed care tag fails to GLARE, a struck serial fails to have no relief,
 * and a card surface needs raking light precisely because even illumination
 * hides the thing being inspected. Generic advice would be easier to write and
 * would not change a single photo.
 */
export const MACRO_CAPTURE_GUIDANCE: Readonly<
  Record<string, MacroCaptureGuidance>
> = {
  // ── Printed text: legibility is the whole job ──────────────────────
  tag: {
    distance: "Fill the frame with the tag — close enough to read the smallest line.",
    lighting: "Even, indirect light. Angle away from overhead bulbs so the print doesn't blow out.",
    framing: "tight",
  },
  tag_2: {
    distance: "Fill the frame with the second tag, same as the first.",
    lighting: "Even, indirect light — avoid glare on glossy labels.",
    framing: "tight",
  },
  label: {
    distance: "Fill the frame with the label — close enough to read the smallest line.",
    lighting: "Even, indirect light. Angle away from overhead bulbs so the print doesn't blow out.",
    framing: "tight",
  },
  label_2: {
    distance: "Fill the frame with the second label, same as the first.",
    lighting: "Even, indirect light — avoid glare on glossy labels.",
    framing: "tight",
  },
  certificate: {
    distance: "Fill the frame with the certificate — all text legible, edges included.",
    lighting: "Flat, even light. Tilt slightly to kill reflections off any laminate.",
    framing: "tight",
  },

  // ── Struck / engraved detail: relief needs a shadow to be visible ──
  serial: {
    distance: "As close as your camera will focus. The number should span most of the frame.",
    lighting: "Light from ONE side at a low angle — a stamped number is only visible by its shadow.",
    framing: "tight",
  },
  marking: {
    distance: "As close as your camera will focus, square to the mark.",
    lighting: "Single-side, low-angle light. Flat lighting erases engraving entirely.",
    framing: "tight",
  },

  // ── Construction / condition: texture at a readable scale ──────────
  surface: {
    distance: "Close, with the surface flat and parallel to the lens.",
    lighting: "Raking light across the surface — it reveals texture, print wear and centering.",
    framing: "tight",
  },
  corner: {
    distance: "One corner filling the frame, held square to the lens.",
    lighting: "Even light, plain background behind the corner so the edge reads clean.",
    framing: "tight",
  },
  sole: {
    distance: "The whole sole in frame, lens parallel to it — not shot at an angle.",
    lighting: "Bright, even light. Tread depth disappears in shadow.",
    framing: "standard",
  },
  interior: {
    distance: "Close on the inside surface — seams, lining or footbed, not the whole item.",
    lighting: "Bright light INTO the opening; interiors are the most commonly underexposed shot.",
    framing: "standard",
  },

  // ── Fabric and flaws: the grader is reading these for severity ─────
  detail: {
    distance: "Close enough to see the weave or knit, not the whole garment.",
    lighting: "Side light to bring out texture; flat light makes every fabric look the same.",
    framing: "tight",
  },
  detail_2: {
    distance: "Close enough to see the weave or knit, not the whole garment.",
    lighting: "Side light to bring out texture.",
    framing: "tight",
  },
  detail_3: {
    distance: "Close enough to see the weave or knit, not the whole garment.",
    lighting: "Side light to bring out texture.",
    framing: "tight",
  },
  detail_4: {
    distance: "Close enough to see the weave or knit, not the whole garment.",
    lighting: "Side light to bring out texture.",
    framing: "tight",
  },
  defect: {
    distance: "Tight crop on the flaw itself, with a little surrounding fabric for scale.",
    lighting: "Even light, no harsh shadow — a shadow reads as a bigger flaw than it is.",
    framing: "tight",
  },
};

/** Guidance for a slot, or null when the slot needs no macro framing. */
export function captureGuidanceFor(
  photoType: string | null | undefined,
): MacroCaptureGuidance | null {
  if (!photoType) return null;
  return MACRO_CAPTURE_GUIDANCE[photoType] ?? null;
}

/**
 * The fraction of the frame's shorter side the overlay box should span.
 *
 * A guide box is only useful if filling it produces a photo that PASSES the
 * quality gate, so these are chosen against it rather than for looks: at the
 * 3000-3600px caps of US-2135, a subject filling 70% of the frame lands far
 * above every long-edge floor in MACRO_MIN_LONG_EDGE_PX.
 */
export function overlayFillFraction(framing: FramingTightness): number {
  return framing === "tight" ? 0.7 : 0.85;
}
