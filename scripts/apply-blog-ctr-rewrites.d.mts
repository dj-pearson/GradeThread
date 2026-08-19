// Types for the US-9017 blog CTR import, so src/test/ctr-rewrite-worklist.test.ts
// can guard the real parser and the real SERP-budget rule rather than keeping a
// second copy of either. A second copy would drift, and the drift would be
// silent: the test would keep passing against its own idea of the budget while
// the script wrote something Google truncates.

/**
 * One row of docs/seo/ctr-rewrite-worklist.csv. The columns are named rather
 * than left as a string index so a consumer under noUncheckedIndexedAccess can
 * read them without a non-null assertion at every use; parseCsv() fills every
 * header the file declares.
 */
export interface WorklistRow {
  url: string;
  impressions_6mo: string;
  clicks_6mo: string;
  ctr_actual_pct: string;
  avg_position: string;
  ctr_expected_pct: string;
  clicks_being_missed_6mo: string;
  section: string;
  current_title: string;
  proposed_title: string;
  proposed_meta_description: string;
  /** "yes" once the copy is live, "pending-db-write" for unwritten blog rows. */
  shipped: string;
}

/** A blog post's drafted SERP copy, resolved from the worklist. */
export interface BlogRewrite {
  /** blog_posts.slug — the /blog/ prefix stripped from the worklist url. */
  slug: string;
  /** The title the worklist captured from the live SERP. */
  currentTitle: string;
  /** Proposed seo_title. */
  title: string;
  /** Proposed seo_description. */
  description: string;
  impressions: number;
  ctr: number;
}

/** RFC4180-enough CSV reader: quoted fields, doubled quotes, embedded commas. */
export function parseCsv(text: string): WorklistRow[];

/** The blog rows of the worklist. */
export function blogRewrites(csvText: string): BlogRewrite[];

/** Reasons a rewrite must not ship. Empty array means it is good to write. */
export function validate(rewrite: BlogRewrite): string[];

/** The live blog_posts columns the clobber guard reads. */
export interface LivePost {
  title: string;
  seo_title: string | null;
}

/**
 * Has this row NOT been edited by a human since the worklist was captured?
 *
 * WARNING: this returned true for an edited row until 2026-08-18. The guard
 * carried a third clause, `post.title === rewrite.currentTitle`, which fired in
 * the commonest case (seo_title NULL at capture, so current_title WAS title)
 * and let the script overwrite an admin's edit while reporting "wrote".
 *
 * It was caught by running --apply against the throwaway local stack with a
 * seeded fixture, and it could not have been caught any other way: the dry run
 * never reads the database. Declared here so the regression test can hold it.
 */
export function isUntouched(
  post: LivePost,
  rewrite: Pick<BlogRewrite, "currentTitle" | "title">,
): boolean;
