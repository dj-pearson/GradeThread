// US-2693: what an admin should look at FIRST in the style-code index.
//
// The index will hold far more codes than anyone will ever review, and almost
// all of them are fine. A list sorted by brand or by date is a list nobody
// opens twice. What earns a human's attention is disagreement and thin
// evidence — everything else is the machine working.
//
// Pure ordering logic, so the rule is a test rather than a claim about a UI.

import {
  type NameSource,
  pickStyleCodeName,
  type ResolvedStyleCodeName,
  type StyleCodeNameRow,
} from "./style-code-names.ts";
import { CONSENSUS_MIN_TITLES } from "./style-code-consensus.ts";

/** Review buckets, most-urgent first. The number IS the sort key. */
export const REVIEW_PRIORITY = {
  /** Two sources name the same code differently. Only a human can pick. */
  conflicting: 0,
  /** One answer, but barely attested — the machine is guessing out loud. */
  thin: 1,
  /** Every usable answer was rejected; the code is back to unnamed. */
  rejected: 2,
  /** Well-attested and unchallenged. Present for completeness, not for review. */
  settled: 3,
} as const;

export type ReviewPriority = typeof REVIEW_PRIORITY[keyof typeof REVIEW_PRIORITY];

/** All the rows 00628 holds for one code, as the route reads them. */
export interface StyleCodeGroup {
  brandKey: string;
  styleCodeNorm: string;
  styleCodeRaw: string;
  rows: StyleCodeNameRow[];
}

export interface ReviewItem {
  brandKey: string;
  styleCodeNorm: string;
  styleCodeRaw: string;
  /** What the read path would use today, or null when nothing usable remains. */
  resolved: ResolvedStyleCodeName | null;
  /** Every name on offer, including the losers — the point of the review. */
  candidates: Array<{
    id?: string;
    name: string;
    source: string;
    supporting: number;
    confidence: number;
    evidenceUrl: string | null;
    rejected: boolean;
  }>;
  /** Two or more UNREJECTED sources with materially different names. */
  conflicting: boolean;
  priority: ReviewPriority;
}

/** Names differ unless they are the same words in the same order, ignoring
 *  case and punctuation. "Commission Short" and "commission short." are the
 *  same answer spelled twice, and flagging that as a conflict would bury the
 *  real ones. */
export function sameName(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return norm(a) === norm(b);
}

/** Build one code's review row. Pure. */
export function reviewItemFor(group: StyleCodeGroup): ReviewItem {
  const live = group.rows.filter((r) => !r.rejected_at && r.name.trim() !== "");
  const resolved = pickStyleCodeName(group.rows);

  const conflicting = live.some((a) =>
    live.some((b) => a !== b && !sameName(a.name, b.name))
  );

  let priority: ReviewPriority;
  if (conflicting) {
    priority = REVIEW_PRIORITY.conflicting;
  } else if (!resolved) {
    // Nothing usable left. Distinct from "never had an answer" — these codes
    // had one and an admin took it away, so the sweep may hand back the same
    // wrong name and someone should notice.
    priority = REVIEW_PRIORITY.rejected;
  } else if (resolved.supporting < CONSENSUS_MIN_TITLES) {
    priority = REVIEW_PRIORITY.thin;
  } else {
    priority = REVIEW_PRIORITY.settled;
  }

  return {
    brandKey: group.brandKey,
    styleCodeNorm: group.styleCodeNorm,
    styleCodeRaw: group.styleCodeRaw,
    resolved,
    candidates: group.rows.map((r) => ({
      id: (r as { id?: string }).id,
      name: r.name,
      source: r.source,
      supporting: r.supporting,
      confidence: r.confidence,
      evidenceUrl: r.evidence_url,
      rejected: Boolean(r.rejected_at),
    })),
    conflicting,
    priority,
  };
}

/**
 * Order a review queue: most-urgent bucket first, then thinnest evidence, then
 * the code itself so the same data always produces the same page.
 */
export function orderReviewQueue(items: readonly ReviewItem[]): ReviewItem[] {
  return [...items].sort((a, b) =>
    a.priority - b.priority ||
    (a.resolved?.supporting ?? 0) - (b.resolved?.supporting ?? 0) ||
    a.styleCodeNorm.localeCompare(b.styleCodeNorm)
  );
}

/** Group the flat 00628 read into one entry per code. Pure. */
export function groupStyleCodeRows(
  rows: readonly (StyleCodeNameRow & {
    id?: string;
    brand_key: string;
    style_code_norm: string;
    style_code_raw: string;
  })[],
): StyleCodeGroup[] {
  const byCode = new Map<string, StyleCodeGroup>();
  for (const row of rows) {
    const key = `${row.brand_key}|${row.style_code_norm}`;
    let group = byCode.get(key);
    if (!group) {
      group = {
        brandKey: row.brand_key,
        styleCodeNorm: row.style_code_norm,
        styleCodeRaw: row.style_code_raw,
        rows: [],
      };
      byCode.set(key, group);
    }
    group.rows.push(row);
  }
  return [...byCode.values()];
}

/**
 * Keywords for a brand_styles row promoted from a code's name (US-2216's
 * convention: a style row is only usable by the extractor if it carries
 * keywords). Lowercased words of the name, longest-first is NOT wanted here —
 * order follows the name so the row reads like the product.
 */
export function keywordsForPromotedStyle(name: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of name.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length < 2 || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/** Sources an admin may promote from. A consensus is market chatter until a
 *  human has looked at it — which is exactly what promoting means. */
export const PROMOTABLE_SOURCES: readonly NameSource[] = [
  "official",
  "admin",
  "seller",
  "consensus",
];

/** The 00628 row a promotion reads, reduced to what the decision needs. */
export interface PromotionCandidate {
  brand_key: string;
  name: string;
  source: string;
  rejected_at: string | null;
}

/**
 * Why this name may NOT become a permanent brand_styles row, or null when it
 * may. Pure, because these refusals are the point at which a bad name becomes
 * permanent knowledge, and "the route checks it" is not a test.
 *
 * `sourceUrl` is the EFFECTIVE one — the admin's, falling back to the learned
 * row's evidence. It is required, and that is the database's rule rather than
 * this module's opinion: brand_styles carries
 * CHECK (brand_fact_is_sourced(source_url, confidence)), so a row without one
 * is rejected by Postgres. Verified by inserting exactly this shape against the
 * real schema, which is how the requirement was found at all — the first
 * version of this route would have 500'd on every seller-sourced promotion,
 * because the correction trigger has no URL to record.
 */
export function promotionRefusal(
  row: PromotionCandidate,
  sourceUrl?: string | null,
): { status: number; error: string } | null {
  if (row.rejected_at) {
    return {
      status: 409,
      error: "That name was rejected; un-reject it first",
    };
  }
  if (!(PROMOTABLE_SOURCES as readonly string[]).includes(row.source)) {
    return { status: 400, error: "Unknown name source" };
  }
  if (!row.brand_key.trim()) {
    // brand_styles is only ever read through a brand pack, so a row with no
    // brand is unreachable. Refuse rather than write knowledge nothing loads.
    return { status: 400, error: "That code has no brand; cannot promote" };
  }
  if (!row.name.trim()) {
    return { status: 400, error: "That name is blank" };
  }
  if (!(sourceUrl ?? "").trim()) {
    return {
      status: 400,
      error:
        "A source is required to promote — add the listing or catalogue URL this name came from",
    };
  }
  return null;
}

/** The source_url a promotion should carry: what the admin typed, else the
 *  evidence the learned row already cites. Pure. */
export function effectivePromotionSource(
  provided: unknown,
  evidenceUrl: string | null,
): string | null {
  const typed = typeof provided === "string" ? provided.trim() : "";
  if (typed) return typed;
  const evidence = (evidenceUrl ?? "").trim();
  return evidence || null;
}
