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
  /** Read by namedByCount along with notes and the acceptance criteria. */
  description?: string;
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

export interface ActionableEntry {
  id: string;
  priority?: number;
  title: string;
  noteLength: number;
}

/**
 * Open stories that declare no operator step AND are not blocked, transitively
 * via dependsOn, behind one that does. The inverse of the operator queue.
 */
export function actionable(
  stories: readonly (OperatorStory & { dependsOn?: readonly string[] })[],
): ActionableEntry[];

/**
 * How many OTHER open stories name each open story, keyed by the named id.
 *
 * Counted from description + notes + acceptance criteria, because this backlog
 * records dependencies in prose rather than in a field. Self-references and
 * mentions of closed or non-existent ids are excluded.
 */
export function namedByCount(
  stories: readonly OperatorStory[],
): Map<string, Set<string>>;
