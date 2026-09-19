// Type declarations for the US-3421 held-branch guard, so the Vitest case that
// drives it imports without TS7016.

export interface HeldBranchRegistry {
  file: string;
  why: string;
  /** "table-rows" reads only markdown table rows; "whole-file" reads everything. */
  scope: "table-rows" | "whole-file";
}

export const REGISTRIES: HeldBranchRegistry[];

/** Branch name -> why it is parked. Shrink-only baseline of today's absences. */
export const KNOWN_ABSENT: Map<string, string>;

/**
 * Branch name -> why it is parked, for branches carrying NO migration.
 *
 * Separate from KNOWN_ABSENT because it is found by a different rule: a
 * migration-less branch has no merge-order row and no KNOWN_GAPS entry, so it
 * can only be named in prose.
 */
export const KNOWN_ABSENT_UNNUMBERED: Map<string, string>;

/** Branch name -> the registry files that name it. Table rows only. */
export function namedBranches(root?: string): Map<string, string[]>;

/**
 * The same, read UNSCOPED and filtered to names carrying no five-digit
 * migration number. Prose is in scope here precisely because a migration-less
 * branch has nowhere else to be named.
 */
export function unnumberedBranches(root?: string): Map<string, string[]>;

/** Null when the remote could not be asked at all — NOT the same as "has none". */
export function remoteBranches(remote?: string, root?: string): Set<string> | null;

export function missingBranches(
  named: Map<string, string[]>,
  onRemote: Set<string>,
): { branch: string; files: string[] }[];
