// Type declarations for the US-3408 merge-resolution gate, so the Vitest case
// that drives it imports without TS7016.

export interface MergeFinding {
  /** Repo-relative path, forward slashes. */
  file: string;
  /** 1-based. */
  line: number;
  /** A TypeScript diagnostic code, or 0 for a leftover conflict marker. */
  code: number;
  message: string;
}

export interface MergeCheckResult {
  checked: string[];
  skipped: { file: string; reason: string }[];
  findings: MergeFinding[];
}

export interface MergeCheckOptions {
  /** Repo root. Defaults to process.cwd(). */
  root?: string;
  /** Force which tsconfig's compiler options apply, e.g. "tsconfig.app.json". */
  projectName?: string;
  /** Supply a file's text instead of reading it from disk. */
  contents?: Map<string, string>;
}

/** The diagnostics a stubbed single-file program can report honestly. */
export const REPORTED_CODES: Map<number, string>;

export function checkFiles(files: string[], opts?: MergeCheckOptions): MergeCheckResult;

export function formatFindings(findings: MergeFinding[]): string;
