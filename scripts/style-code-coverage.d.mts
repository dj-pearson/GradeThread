// Type declarations for the style-code coverage reporter so the Vitest unit
// test (src/test/style-code-scripts.test.ts) imports it without TS7016
// (implicit-any on a JS module). Mirrors scripts/style-code-coverage.mjs.

/** Source precedence, strongest first. Must match NAME_SOURCE_ORDER in
 *  services/edge-functions/src/lib/style-code-names.ts; the test enforces it. */
export const NAME_SOURCE_ORDER: string[];

/** The strongest source present, or null when none is recognized. */
export function winningSource(sources: string[]): string | null;

/** Uppercased, punctuation-stripped comparable form of a style code. */
export function normalizeStyleCode(raw: string | null | undefined): string;
