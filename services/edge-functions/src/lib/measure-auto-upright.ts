// US-2890: turn a sideways intake photo upright, server-side, once.
//
// US-2888 made this one press per item: "Turn upright" in the measurements
// panel, derived from the calibration homography rather than guessed from the
// garment, because the MeasureCard's four fiducials carry different ids in a
// known clockwise order. A seller shooting a rail of thirty items still presses
// it thirty times, and every one of those presses is a round trip they only
// make because the server declined to act on something it already knew.
//
// The intake measure pass (measure-autofill.ts) finds and calibrates the card
// already. What it does not do is rewrite the stored image. This module is that
// rewrite, and almost all of it is about the conditions under which it must
// REFUSE to happen:
//
//   - Grading evidence is never touched. A photo that fed a grade keeps the
//     framing it was graded from, full stop. A certificate that points at a
//     picture nobody can reproduce is worse than a sideways picture.
//   - Off unless a setting says otherwise. Silently rewriting a seller's
//     uploaded photos is not something to ship on by default, and US-2888
//     deliberately did not.
//   - Nothing happens without a preserved original. The revert path is not a
//     nicety here; it is the only thing that makes an automatic rewrite
//     defensible, so a failure to copy the original aborts the rotation rather
//     than proceeding without it.
//
// The preserved original uses the SAME two columns the browser editor uses -
// original_storage_path and edit_recipe - which is what makes "Revert to
// original" in the photo editor undo this with no new UI and no second code
// path. That is the whole reason not to invent a bespoke undo.

import { Image } from "imagescript";
import {
  type Quarter,
  quarterLabel,
  rotateCalibrationQuarter,
  rotatedDims,
} from "./measure-quarter-turn.ts";

/** The setting that arms this. Absent means false: off until measured on a real batch. */
export const AUTO_UPRIGHT_SETTING_KEY = "measure.auto_upright_enabled";

/** The photo row this pass needs, and nothing more. */
export interface UprightPhotoRow {
  id: string;
  storage_path: string | null;
  photo_type: string | null;
  used_for_grading: boolean | null;
  original_storage_path?: string | null;
  edit_recipe?: unknown;
  width?: number | null;
  height?: number | null;
}

/** Why a photo was left alone. Every one of these is a decision, not a failure. */
export type UprightSkipReason =
  | "disabled"
  | "already_upright"
  | "grading_evidence"
  | "no_storage_path"
  | "no_calibration";

export interface UprightDecision {
  rotate: boolean;
  turns: Quarter;
  reason: UprightSkipReason | null;
}

/**
 * Should this photo be rotated, and by how much?
 *
 * Split out from the doing so the policy can be tested without an image
 * decoder or a bucket. Every branch here is a refusal, and refusals are the
 * part of this feature worth testing hardest.
 */
export function decideUpright(
  photo: UprightPhotoRow,
  uprightTurns: number | null | undefined,
  enabled: boolean,
): UprightDecision {
  if (!enabled) return { rotate: false, turns: 0, reason: "disabled" };
  // AC4. Checked BEFORE the turn is even looked at, so the answer does not
  // depend on how sideways the photo happens to be.
  if (photo.used_for_grading) {
    return { rotate: false, turns: 0, reason: "grading_evidence" };
  }
  if (!photo.storage_path) return { rotate: false, turns: 0, reason: "no_storage_path" };
  if (uprightTurns === null || uprightTurns === undefined) {
    return { rotate: false, turns: 0, reason: "no_calibration" };
  }
  const turns = (((Math.trunc(uprightTurns) % 4) + 4) % 4) as Quarter;
  if (turns === 0) return { rotate: false, turns: 0, reason: "already_upright" };
  return { rotate: true, turns, reason: null };
}

/**
 * The `edit_recipe` an auto-rotation leaves behind.
 *
 * Recipes are ABSOLUTE against the preserved original, not relative to the last
 * save - US-2888 learned that the hard way, where a photo already at 270 saved
 * at 0 has turned one quarter, not three. So this composes the new turn onto
 * whatever rotation the recipe already carried rather than replacing it.
 */
export function uprightRecipe(prev: unknown, turns: Quarter, at: string): Record<string, unknown> {
  const base = (prev && typeof prev === "object" ? prev : {}) as Record<string, unknown>;
  const prevRotation = typeof base.rotation === "number" ? base.rotation : 0;
  const rotation = (((prevRotation + turns * 90) % 360) + 360) % 360;
  return {
    v: 1,
    fine: 0,
    crop: null,
    aspect: null,
    adjustments: {},
    bgRemoved: false,
    ...base,
    rotation,
    editedAt: at,
    // Marked so a later reader can tell an automatic turn from one the seller
    // made. Without this, "why did my photo move" has no answer in the data.
    autoUpright: true,
  };
}

/** Rotate raw image bytes by `turns` clockwise quarters, returning PNG bytes. */
export async function rotateImageBytes(
  bytes: Uint8Array,
  turns: Quarter,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const img = await Image.decode(bytes);
  // CAPTURE THE SOURCE DIMENSIONS FIRST. imagescript's rotate() mutates the
  // instance and returns it, so reading img.width after the call gives the
  // ROTATED width and the check below compares a number against itself. The
  // first run of this function failed on exactly that, which is the argument
  // for asserting the dimensions rather than assuming them.
  const sw = img.width;
  const sh = img.height;
  // NEGATED, and this is the whole bug this function exists to get right.
  // imagescript's rotate() takes a COUNTER-clockwise angle: rotate(90) on an
  // 8x4 image with a mark at (6,1) puts the mark at (1,1), which is the
  // counter-clockwise answer; the clockwise answer is (2,6) and comes back
  // from rotate(270). Every `turns` in this codebase is CLOCKWISE, matching
  // the editor's rotate button, so the angle has to be negated on the way in.
  //
  // Note what the dimension check below CANNOT catch: 90 and 270 produce
  // identical dimensions, so a wrong direction passes it and mirrors every
  // measurement silently. Only the pixel-level test in
  // measure-auto-upright_test.ts catches that, and it is the reason that test
  // decodes a real image instead of trusting this comment.
  const rotated = img.rotate(((4 - turns) % 4) * 90);
  const [ew, eh] = rotatedDims(sw, sh, turns);
  if (rotated.width !== ew || rotated.height !== eh) {
    throw new Error(
      `rotate produced ${rotated.width}x${rotated.height}, expected ${ew}x${eh} — ` +
        "the decoder's rotation direction does not match the calibration math",
    );
  }
  const out = await rotated.encode();
  return { bytes: out, width: rotated.width, height: rotated.height };
}

/**
 * Carry a stored calibration across the same turn (AC3).
 *
 * Never re-detects. `w`/`h` are the pre-rotation dimensions, which is what the
 * stored geometry is expressed in.
 */
export function uprightCalibration<T extends { homography: number[] }>(
  calibration: T,
  turns: Quarter,
  w: number,
  h: number,
): T {
  const carried = rotateCalibrationQuarter(
    calibration as T & { homography: number[]; lines?: Record<string, never> },
    turns,
    w,
    h,
  );
  // The photo is upright now, so the recorded turn is spent. Leaving the old
  // value would have a second pass rotate it again.
  return { ...carried, uprightTurns: 0 } as T;
}

/** What the caller tells the seller (AC5). */
export interface UprightOutcome {
  rotated: boolean;
  turns: Quarter;
  /** Plain sentence for a toast. Null when nothing happened. */
  message: string | null;
  /** Set once the original is safely aside, so the caller can offer an undo. */
  originalPreserved: boolean;
  skipped: UprightSkipReason | null;
}

export function uprightMessage(turns: Quarter): string {
  return `This photo arrived ${quarterLabel(turns)}, so it was turned upright. ` +
    "Revert to original in the photo editor puts it back.";
}
