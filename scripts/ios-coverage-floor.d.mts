// Type declarations for the iOS coverage floor, so the Vitest case that
// drives it imports without TS7016.

export const FLOOR: number;
export const APP_TARGET: string;

export interface CoverageTarget {
  name?: string;
  coveredLines?: number;
  executableLines?: number;
}

export interface CoverageReport {
  targets?: CoverageTarget[];
}

export function targetCoverage(
  report: CoverageReport,
  name?: string,
): { covered: number; executable: number; percent: number };

export function checkFloor(
  report: CoverageReport,
  floor?: number,
  name?: string,
): { ok: boolean; percent: number; line: string };
