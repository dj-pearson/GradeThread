// Type declarations for the browser-scoped UI gate, so src/test/ui-browser-gate.test.ts
// imports it without TS7016. Mirrors scripts/check-ui-browser.mjs exports.
//
// ⚠ tsc believes THIS file, not the .mjs. A declaration that drifts from the
// implementation type-checks perfectly while the runtime disagrees, so treat an
// edit here as an edit to the script.

/**
 * The four browser-scoped tells CLAUDE.md's craft floor bans, under the names
 * impeccable actually uses. Must stay equal to the keys of the source gate's
 * NOT_SOURCE_CHECKABLE — src/test/ui-browser-gate.test.ts fails otherwise, so a
 * tell cannot fall between the two gates and be checked by neither.
 */
export const ENFORCED_BROWSER_RULES: string[];

/** The representative pages scanned, as site-relative paths. */
export const PAGES: string[];

/**
 * Permitted `"<path>::<rule>"` pairs, each mapped to a written reason.
 *
 * Not a count. The tool gives browser findings no selector, line or DOM path,
 * so a pair is the finest grain available and instance counts are not pinned.
 */
export const ALLOWED: Record<string, string>;

/** A finding as impeccable reports it from a URL scan. */
export interface BrowserFinding {
  antipattern: string;
  file?: string;
  severity?: string;
  category?: string;
  snippet?: string;
}

/** One enforced rule seen on one page, with how many times. */
export interface RuleRow {
  path: string;
  rule: string;
  count: number;
}

export function countByRule(
  findings: readonly BrowserFinding[],
): Record<string, number>;

/** Rows whose `path::rule` key no ALLOWED entry names. */
export function unlistedPairs(
  rows: readonly RuleRow[],
  allowed?: Record<string, string>,
): RuleRow[];
