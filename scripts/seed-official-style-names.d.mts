// Type declarations for the official-name seeder so the Vitest unit test
// (src/test/style-code-scripts.test.ts) imports it without TS7016
// (implicit-any on a JS module). Mirrors scripts/seed-official-style-names.mjs.

/** Uppercased, punctuation-stripped comparable form of a style code. */
export function normalizeStyleCode(raw: string | null | undefined): string;

export interface OfficialNameRow {
  styleCodeNorm: string;
  styleCodeRaw: string;
  name: string;
  colorway: string | null;
  sourceUrl: string;
}

/** Validate one operator-supplied row: `{ row }` or `{ error }`, never both. */
export function validateOfficialRow(
  raw: unknown,
  index: number,
): { row: OfficialNameRow; error?: undefined } | { row?: undefined; error: string };

/** Product URLs whose slug is a TAG style code rather than an internal id. */
export function tagCodeKeyedUrls(locs: string[]): string[];
