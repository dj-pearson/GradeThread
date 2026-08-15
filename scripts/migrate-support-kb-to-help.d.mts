// Type declarations for the US-2594 corpus migration so the Vitest unit test
// (src/test/support-kb-to-help-migration.test.ts) imports it without TS7016.

export const CATEGORY_MAP: Readonly<Record<string, string>>;
export const HELP_CATEGORY_KEYS: readonly string[];

export function mapCategory(category: string): string;
export function mapVisibility(audience: string): "public" | "members";
export function mapStatus(isPublished: boolean): "published" | "draft";
export function demoteTopHeadings(md: string): string;

export interface SupportKbRow {
  slug?: string;
  title?: string;
  body_md?: string;
  category: string;
  audience: string;
  is_published?: boolean;
  updated_at?: string | null;
}

export interface HelpArticlePayload {
  slug: string;
  title: string;
  summary: string;
  body_markdown: string;
  body_html: string;
  category_key: string;
  visibility: "public" | "members";
  status: "published" | "draft";
  published_at: string | null;
  reviewed_at: string | null;
}

export function toHelpArticle(
  row: SupportKbRow,
  renderer?: (md: string) => string,
): HelpArticlePayload;

export function findCollisions(
  sourceRows: ReadonlyArray<{ slug?: string }>,
  existingSlugs: readonly string[],
): string[];

export function summarise(payloads: readonly HelpArticlePayload[]): {
  total: number;
  byCategory: Record<string, number>;
  byVisibility: Record<string, number>;
  byStatus: Record<string, number>;
};
