// Type declarations for the UI anti-pattern gate so the Vitest unit test
// (src/test/ui-check-scope.test.ts) imports it without TS7016. Mirrors
// scripts/check-ui-antipatterns.mjs's exports.

export const ENFORCED: Set<string>;

/** A finding as impeccable reports it. Only the fields the gate reads. */
export interface Finding {
  file?: string;
  line?: number;
  antipattern?: string;
  snippet?: string;
  description?: string;
}

/** One allowed non-enforced finding, named rather than merely counted. */
export interface NoiseEntry {
  /** Repo-relative path; matched as a suffix so absolute paths work. */
  file: string;
  /** Substring of the reported snippet. */
  snippet: string;
  /** Why the tool is wrong here. An entry without one is a suppression. */
  why: string;
}

export interface Root {
  path: string;
  knownNoise: NoiseEntry[];
}

export const ROOTS: Root[];

export function partition(findings: readonly Finding[]): {
  enforced: Finding[];
  other: Finding[];
};

export function matchesNoise(finding: Finding, entry: NoiseEntry): boolean;

export function reconcileNoise(
  other: readonly Finding[],
  knownNoise: readonly NoiseEntry[],
): { unexpected: Finding[]; stale: NoiseEntry[] };
