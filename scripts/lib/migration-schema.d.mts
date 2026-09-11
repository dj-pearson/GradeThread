// Type declarations for the migration-derived schema reader, so the Vitest
// guards that read it import without TS7016. See migration-schema.mjs for what
// each of these derives and why none of them may be hard-coded.

/** A `CREATE UNIQUE INDEX` as declared in a migration. */
export interface UniqueIndexFact {
  /** Index name, schema stripped, lowercased. */
  name: string;
  /** Bare table name, schema stripped, lowercased. */
  table: string;
  /** Indexed column names, lowercased, in declaration order. */
  columns: string[];
  /** True when the declaration carries a WHERE predicate. */
  partial: boolean;
}

/** Migration file names, in apply order. */
export function migrationFiles(): string[];

export function migrationFileCount(): number;

/** The raw text of one migration, by file name. */
export function readMigration(name: string): string;

/** Strip `--` line comments and block comments from ONE migration file. */
export function stripSqlComments(sql: string): string;

/**
 * Every column a table holds. EMPTY means "cannot resolve", which is not the
 * same as "no columns" and must never be read as "clean".
 */
export function columnsOf(table: string): Set<string>;

/** Every name the migrations declare as a VIEW or MATERIALIZED VIEW. */
export function viewNames(): Set<string>;

/** Every `CREATE UNIQUE INDEX` in one migration body. */
export function parseUniqueIndexes(sql: string): UniqueIndexFact[];

/** Every unique index in the corpus, parsed ONE FILE AT A TIME. */
export function allUniqueIndexes(): UniqueIndexFact[];

/** The newest migration file that defines the users self-service allowlist. */
export function usersGuardMigration(): string;

/** The columns an authenticated session may change on its own users row. */
export function usersSelfServiceAllowlist(): string[];

/** The quoted names inside a `self_service constant text[] := ARRAY[...]`. */
export function parseSelfServiceArray(sql: string, label?: string): string[];
