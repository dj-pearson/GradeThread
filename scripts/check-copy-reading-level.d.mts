// Types for the US-2868 copy audit, so src/test/copy-reading-level.test.ts can
// import the real implementation rather than keeping a second copy of the
// extraction and scoring rules. Two copies of "what counts as user-facing copy"
// would drift, and the drift would be silent: the test would keep passing
// against its own idea of the rule while the script reported something else.

/** Who reads a given file's strings. Only "customer" is scored for grade. */
export type Audience = "customer" | "operator" | "legal" | "marketing";

export interface ExtractedString {
  /** Whitespace-normalised text, as a user would read it. */
  text: string;
  /** 1-indexed line of the node the string came from. */
  line: number;
  /** Where it was found: "jsx", "toast", "prop:title", "key:label", "meta"… */
  kind: string;
  /** True for `<SEO>`-style metadata: recorded, never scored. */
  meta?: boolean;
}

export interface CopyRow extends ExtractedString {
  /** Repo-relative, forward slashes. */
  file: string;
  platform: "web" | "ios";
  audience: Audience;
  /** Words with at least one letter. */
  words: number;
  /** Flesch-Kincaid grade, or null when the string is too short to mean anything. */
  grade: number | null;
  /** Jargon terms present with no plain tag nearby. */
  jargon: JargonTerm[];
}

export interface JargonTerm {
  /** The word as a reader meets it. */
  term: string;
  /** The plain tag to suggest. May not repeat `term`. */
  hint: string;
}

/** The reading level the house style asks for. */
export const TARGET_GRADE: number;

/** Borrowed words that may stay, each with the tag that makes it learnable. */
export const JARGON: readonly JargonTerm[];

/** Syllables by vowel group, with the silent-e correction. A documented guess. */
export function syllables(word: string): number;

/** Flesch-Kincaid grade level; null when the text holds no words. */
export function readingGrade(text: string): number | null;

/** Words with at least one letter. */
export function wordCount(text: string): number;

/** Which audience a repo-relative path serves. */
export function audienceOf(rel: string): Audience;

/** User-facing strings in one .ts/.tsx source, via the TypeScript AST. */
export function extractFromTs(file: string, source: string): ExtractedString[];

/** User-facing strings in one .swift source, by regex. Under-reports by design. */
export function extractFromSwift(source: string): ExtractedString[];

/** Jargon terms in `text` that carry no plain tag. Empty when all are explained. */
export function untaggedJargon(text: string): JargonTerm[];

/** Every extracted string across src/ and ios/, scored and classified. */
export function collect(): CopyRow[];
