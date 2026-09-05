// Types for the US-3063 fixture capture, so
// src/test/selector-fixture-sanitiser.test.ts drives the REAL sanitiser rather
// than a copy of it.
//
// The copy is the specific thing to avoid: this sanitiser is the only thing
// between a marketplace page captured from a signed-in account and a public
// repo, and a test asserting against its own re-implementation would be green
// while the script that actually runs removed something else.

/** A 1x1 transparent GIF, substituted for every image src. */
export const BLANK_IMAGE: string;

/**
 * Strip a captured page of everything that identifies the operator.
 *
 * Structural removals first (scripts, image URLs, form values), then the
 * caller's own strings, which is the only way to catch a handle in an og: tag.
 * A redaction shorter than three characters is IGNORED rather than applied:
 * scrubbing "ab" would rewrite half the document while looking like it worked.
 */
export function sanitiseHtml(html: string, redactions?: readonly string[]): string;

/**
 * The path of a URL, with the query dropped.
 *
 * Returns "" for anything unparseable. The query is dropped because a captured
 * marketplace URL routinely identifies the account that captured it.
 */
export function pathOf(url: string): string;

/** The platform's `version` from the bundled lister selectors, or "". */
export function readSelectorsVersion(platform: string): string;
