// Type declarations for the operator-queue reporter so the Vitest unit test
// (src/test/prd-operator-queue.test.ts) imports it without TS7016. Mirrors
// scripts/prd-operator.mjs's exports.

export const DECLARED_RE: RegExp;
export const UNDECLARED_PATTERNS: RegExp[];

export function extractSentence(text: string, idx: number, max?: number): string;

export interface OperatorStory {
  id: string;
  passes?: boolean;
  title: string;
  priority?: number;
  notes?: string;
  acceptanceCriteria?: string[];
}

export interface DeclaredEntry {
  id: string;
  priority?: number;
  title: string;
  items: string[];
}

export interface UndeclaredEntry {
  id: string;
  priority?: number;
  title: string;
  titleTagged: boolean;
  evidence: string[];
}

export interface AuditCandidate {
  id: string;
  priority?: number;
  title: string;
  quote: string;
}

export function collect(stories: readonly OperatorStory[]): {
  declared: DeclaredEntry[];
  undeclared: UndeclaredEntry[];
  openCount: number;
};

/** Reading list, not findings — see the note in prd-operator.mjs. */
export function auditCandidates(stories: readonly OperatorStory[]): AuditCandidate[];
