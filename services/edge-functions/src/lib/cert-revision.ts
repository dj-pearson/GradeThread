// US-2569: what a revised certificate says, and how a chain of them resolves.
//
// A regrade retires the old grade_reports row: 00150 sets superseded_at and
// regradeSubmission nulls certificate_id in the same step. Every public read
// filters on `certificate_id IS NOT NULL`, so the retired GT number stopped
// resolving to anything — /cert/<id> 404d and /verify said not found, while a
// buyer stood there holding a hangtag with that number printed on it.
//
// 00600 records the supersede instead. This module owns the two decisions that
// follow, and is PURE so both are testable without a database: which end of a
// chain a lookup lands on, and what the answer should say.

/** One row of public.grade_report_revisions, as the public paths read it. */
export interface RevisionRow {
  superseded_report_id: string;
  superseded_certificate_id: string | null;
  superseded_certificate_number: string | null;
  superseded_overall_score: number | string | null;
  superseded_grade_tier: string | null;
  superseding_report_id: string | null;
  superseding_certificate_id: string | null;
  superseding_certificate_number: string | null;
  superseding_overall_score: number | string | null;
  superseding_grade_tier: string | null;
  reason: string | null;
  superseded_at: string;
}

export type RevisionResolution =
  | {
    /** The retired certificate has a live replacement. */
    status: "revised";
    currentCertificateId: string;
    currentCertificateNumber: string | null;
    revisedAt: string;
    /** Every hop from the requested certificate to the current one. */
    hops: RevisionHop[];
  }
  | {
    /**
     * The grade was retired and its replacement has not landed — a regrade that
     * is still running, or one that failed. Deliberately its own state: telling
     * a buyer "revised, new grade pending" is true, and telling them "not found"
     * is not.
     */
    status: "pending";
    revisedAt: string;
    hops: RevisionHop[];
  };

export interface RevisionHop {
  fromCertificateNumber: string | null;
  fromScore: number | null;
  fromTier: string | null;
  toCertificateNumber: string | null;
  toScore: number | null;
  toTier: string | null;
  at: string;
}

/** PostgREST returns `numeric` as a string; normalize before it reaches a UI. */
function num(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function hopOf(row: RevisionRow): RevisionHop {
  return {
    fromCertificateNumber: row.superseded_certificate_number,
    fromScore: num(row.superseded_overall_score),
    fromTier: row.superseded_grade_tier,
    toCertificateNumber: row.superseding_certificate_number,
    toScore: num(row.superseding_overall_score),
    toTier: row.superseding_grade_tier,
    at: row.superseded_at,
  };
}

/**
 * Walk a revision chain forward from the row a lookup matched.
 *
 * A garment can be regraded more than once, and each regrade retires the
 * previous certificate — so the number printed on a two-year-old hangtag may sit
 * three hops behind the live grade. Following only the first hop would send a
 * buyer to a certificate that is itself retired, which is a worse answer than
 * the 404 it replaced because it looks authoritative.
 *
 * `byRetiredReportId` maps a retired report id to its revision row. The walk is
 * bounded by the map size and guarded by a seen-set, so a cycle written by a bug
 * terminates instead of hanging the public endpoint.
 */
export function resolveRevisionChain(
  start: RevisionRow,
  byRetiredReportId: ReadonlyMap<string, RevisionRow>,
): RevisionResolution {
  const hops: RevisionHop[] = [hopOf(start)];
  const seen = new Set<string>([start.superseded_report_id]);
  let current = start;

  while (current.superseding_report_id) {
    const next = byRetiredReportId.get(current.superseding_report_id);
    // The successor is not itself retired → it is the live grade.
    if (!next) break;
    if (seen.has(next.superseded_report_id)) break; // cycle guard
    seen.add(next.superseded_report_id);
    hops.push(hopOf(next));
    current = next;
  }

  if (!current.superseding_report_id || !current.superseding_certificate_id) {
    return { status: "pending", revisedAt: current.superseded_at, hops };
  }
  return {
    status: "revised",
    currentCertificateId: current.superseding_certificate_id,
    currentCertificateNumber: current.superseding_certificate_number,
    revisedAt: current.superseded_at,
    hops,
  };
}

/**
 * The buyer-facing sentence for a resolution.
 *
 * Written here rather than in the SSR template so the API, the SPA and the
 * Pages Function cannot describe the same state three different ways — which is
 * exactly how a trust surface stops being trusted.
 */
export function revisionMessage(resolution: RevisionResolution): string {
  const when = resolution.revisedAt.slice(0, 10);
  if (resolution.status === "pending") {
    return `This certificate was replaced on ${when}. The updated grade is not ` +
      `published yet — check back shortly.`;
  }
  const number = resolution.currentCertificateNumber;
  return number
    ? `This certificate was replaced on ${when}. The current grade is ${number}.`
    : `This certificate was replaced on ${when}. See the current grade.`;
}
