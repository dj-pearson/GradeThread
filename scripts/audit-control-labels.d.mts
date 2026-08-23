// Types for the US-2335 label audit, so src/test/control-labels.test.ts can
// import the real implementation instead of keeping a second copy of the
// detection logic. Two copies of "what counts as labelled" would drift, and the
// drift would be invisible: the test would keep passing against its own idea of
// the rule while the script reported something else.

export interface UnlabelledControl {
  /** The JSX tag name, e.g. "Input" or "SelectTrigger". */
  tag: string;
  /** 1-indexed line of the opening tag. */
  line: number;
}

/** Recursively collect .tsx files under `dir`. */
export function walk(dir: string, out?: string[]): string[];

/** The attribute text of the tag starting at `from`, up to its closing `>`. */
export function tagAttrs(src: string, from: number): string;

/** True when the control carries a resolvable accessible name. */
export function isLabelled(attrs: string, htmlForIds: Set<string>): boolean;

/** Every control in `src` with no resolvable accessible name. */
export function auditFile(src: string): UnlabelledControl[];

/** One control that will announce the same words on every row of a list. */
export interface RepeatedName {
  tag: string;
  /** The constant aria-label value, as written. */
  name: string;
  line: number;
}

/** Start/end offsets of every `.map(` callback, paren-matched. */
export function mapBodies(src: string): Array<[number, number]>;

/**
 * US-2834: controls inside a `.map()` whose aria-label is a constant literal.
 *
 * The second floor under `auditFile`: that one asks whether a name EXISTS,
 * this one whether it DISTINGUISHES. Interpolated labels are correct by
 * construction and never reported.
 */
export function auditDistinctness(src: string): RepeatedName[];
