// US-2714: move rows that were filed under a non-canonical key.
//
// Everything in TypeScript now files a style code under its canonical spelling
// (canonicalStyleCode). One writer cannot: the 00629 trigger runs in plpgsql
// and has no decoder to ask, so a seller correcting a garment whose tag reads
// LW6AMYSP60417 writes the key LW6AMYSP60417 while every reader asks for
// W6AMYS. The correction is not lost — it is filed where nobody looks.
//
// Duplicating the extraction in SQL was the obvious fix and is the wrong one:
// once normalization strips the ".", the three Lululemon patterns collapse into
// an alternation whose style group is 3-5 characters, so the canonical form is
// not a fixed substring of the normalized string. That is a second copy of a
// subtle rule, in the one language CI here cannot execute. So the sweep — which
// already runs hourly and already holds the single canonicalizer — reconciles.
//
// Pure planning, so every case below is a test rather than a hope.

import { canonicalStyleCode } from "./style-code-observations.ts";

/** A style_code_names row, reduced to what re-keying needs. */
export interface RekeyRow {
  id: string;
  brand_key: string;
  style_code_norm: string;
  style_code_raw: string;
  name: string;
  source: string;
  supporting: number;
  confidence: number;
  evidence_url: string | null;
  rejected_at?: string | null;
}

export type RekeyAction =
  /** Nothing at the canonical key for this source — move the row there. */
  | "move"
  /** The canonical key already holds the SAME name from the same source; the
   *  mis-keyed row is a duplicate and can go. */
  | "drop_duplicate"
  /** The canonical key holds a DIFFERENT name from the same source. Merging
   *  would silently pick a winner, so both stay and a human decides — the
   *  admin queue (US-2693) already surfaces exactly this as a conflict. */
  | "conflict";

export interface RekeyStep {
  row: RekeyRow;
  /** The key it should have been filed under. */
  canonical: string;
  action: RekeyAction;
}

export interface RekeyPlan {
  steps: RekeyStep[];
  /** Rows already filed correctly. The overwhelming majority, and worth
   *  reporting so a tick that moved nothing is distinguishable from a tick
   *  that read nothing. */
  correct: number;
}

function key(brandKey: string, norm: string, source: string): string {
  return `${brandKey}|${norm}|${source}`;
}

/**
 * Decide what to do with every row. Pure.
 *
 * Rejected rows are skipped entirely: moving one would resurrect a name an
 * admin removed, under a key where the rejection is not recorded.
 */
export function planRekey(rows: readonly RekeyRow[]): RekeyPlan {
  // What exists today, by (brand, key, source), so a move can tell an empty
  // target from an occupied one without a second query per row.
  const byKey = new Map<string, RekeyRow>();
  for (const r of rows) {
    byKey.set(key(r.brand_key, r.style_code_norm, r.source), r);
  }

  const steps: RekeyStep[] = [];
  let correct = 0;
  for (const row of rows) {
    if (row.rejected_at) continue;
    const canonical = canonicalStyleCode(row.brand_key, row.style_code_raw);
    if (!canonical || canonical === row.style_code_norm) {
      correct++;
      continue;
    }
    const target = byKey.get(key(row.brand_key, canonical, row.source));
    const action: RekeyAction = !target
      ? "move"
      : sameAnswer(target.name, row.name)
      ? "drop_duplicate"
      : "conflict";
    steps.push({ row, canonical, action });
  }
  return { steps, correct };
}

/** Two names are the same answer when they are the same words in the same
 *  order, ignoring case and punctuation — the rule the admin queue uses. */
function sameAnswer(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return norm(a) === norm(b);
}

export interface RekeySummary {
  moved: number;
  dropped: number;
  conflicts: number;
  correct: number;
}

/** Roll a plan up for the cron's response body. Pure. */
export function summarizeRekey(plan: RekeyPlan): RekeySummary {
  const summary: RekeySummary = {
    moved: 0,
    dropped: 0,
    conflicts: 0,
    correct: plan.correct,
  };
  for (const step of plan.steps) {
    if (step.action === "move") summary.moved++;
    else if (step.action === "drop_duplicate") summary.dropped++;
    else summary.conflicts++;
  }
  return summary;
}
