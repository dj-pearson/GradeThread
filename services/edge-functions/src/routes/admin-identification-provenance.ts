// US-2779: the operator view of whether eBay's visual guess is any good.
//
// identification_provenance has had a writer since US-2774 and never had a
// reader. Every tuning decision about the visual pass — is the role gate too
// tight, is the model rubber-stamping candidates, is the whole provider worth
// its latency — was a guess about a table that already held the answer.
//
// ── The one thing this must not do ───────────────────────────────────────────
// The table was built so that NEVER OFFERED, OFFERED AND IGNORED, and OFFERED
// AND REFUSED stay tellable apart. They have three different fixes:
//
//   never offered      the role gate declined, or eBay had nothing. Fix the
//                      gate, or accept the coverage.
//   offered, ignored   the model was told to report a verdict and did not.
//                      That is a PROMPT defect, and it is invisible if it is
//                      counted as a rejection.
//   offered, refused   the model looked and said no. Working as designed.
//
// A summary that folds the middle one into the last reports a prompt bug as a
// quality signal, and the number looks entirely reasonable while pointing at
// the wrong fix. That is the property the tests pin.
//
// Cross-tenant on purpose, like admin-listing-coverage: "is the visual provider
// any good" is meaningless inside one seller's data. Nothing identifying is
// returned — no item ids, no user ids, no listing ids. Counts only.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { jsonError } from "../lib/http-errors.ts";
import { requireScope } from "../lib/scope-guard.ts";
import { EVIDENCE_PRECEDENCE } from "../lib/visual-candidates.ts";

type AdminEnv = {
  Variables: { userId: string; adminRole: "admin" | "super_admin" };
};

export const adminIdentificationProvenanceRoutes = new Hono<AdminEnv>();

// Same gate as the listing-coverage console: the listing pipeline lives under
// marketplace:write, and there is no marketplace:read scope to use instead.
adminIdentificationProvenanceRoutes.use("*", requireScope("marketplace:write"));

export const DEFAULT_PROVENANCE_WINDOW = 500;
export const MAX_PROVENANCE_WINDOW = 2000;

/** The decline reasons runVisualPass emits, plus a catch-all. */
export const DECLINE_REASONS = [
  "disabled",
  "no_image",
  "role_not_identifying",
  "no_matches",
  "error",
  "other",
] as const;

export type DeclineReason = (typeof DECLINE_REASONS)[number];

export interface ProvenanceRow {
  visual_candidates: unknown;
  visual_rulings: unknown;
  visual_declined: string | null;
}

export interface FieldSummary {
  field: string;
  /** Distinct candidates put to the model for this field. */
  offered: number;
  accepted: number;
  rejected: number;
  /**
   * Offered, and absent from visual_rulings.
   *
   * NOT a rejection. See the header — this is the bucket the whole report
   * exists to keep separate.
   */
  neverRuled: number;
}

export interface ProvenanceReport {
  window: number;
  /** Rows in the window. A run is one generation or one extraction. */
  runs: number;
  /** Runs that put at least one candidate to the model. */
  runsWithCandidates: number;
  byField: FieldSummary[];
  acceptedByEvidence: Record<string, number>;
  declines: Record<DeclineReason, number>;
}

/** Read a jsonb column that should be an array of objects. Anything else is an
 *  empty list: stored json is not a contract, and a malformed row must cost its
 *  own contribution rather than the whole report. */
function rows(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (v): v is Record<string, unknown> => typeof v === "object" && v !== null,
  );
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** field + value, so two candidates for one field stay distinct. */
const key = (field: string, value: string) => `${field}\u0000${value}`;

/**
 * Roll the stored rows up into the operator report. PURE, so the bucketing is
 * testable without a database — which matters more here than in most reports,
 * because the bucketing IS the finding.
 */
export function summarizeIdentification(
  data: ProvenanceRow[],
  window: number,
): ProvenanceReport {
  const byField = new Map<string, FieldSummary>();
  const acceptedByEvidence: Record<string, number> = {};
  for (const kind of EVIDENCE_PRECEDENCE) acceptedByEvidence[kind] = 0;
  const declines = Object.fromEntries(
    DECLINE_REASONS.map((r) => [r, 0]),
  ) as Record<DeclineReason, number>;

  let runsWithCandidates = 0;

  for (const row of data) {
    const candidates = rows(row.visual_candidates);
    const rulings = rows(row.visual_rulings);

    const declined = str(row.visual_declined);
    if (declined) {
      // An unrecognised reason is kept under `other` rather than dropped. A
      // reason this build has never heard of means the pass grew one, and
      // discarding it would make the buckets silently disagree with `runs`.
      const known = (DECLINE_REASONS as readonly string[]).includes(declined);
      declines[(known ? declined : "other") as DeclineReason]++;
    }
    if (candidates.length > 0) runsWithCandidates++;

    // Index this run's rulings by field+value. A ruling on a value that was
    // never offered is not evidence about a candidate — the model answering
    // about something it invented would otherwise inflate the accept rate.
    const ruledHere = new Map<string, Record<string, unknown>>();
    for (const r of rulings) {
      const f = str(r.field);
      const v = str(r.value);
      if (f && v) ruledHere.set(key(f, v), r);
    }

    for (const cand of candidates) {
      const field = str(cand.field);
      const value = str(cand.value);
      if (!field) continue;

      let summary = byField.get(field);
      if (!summary) {
        summary = { field, offered: 0, accepted: 0, rejected: 0, neverRuled: 0 };
        byField.set(field, summary);
      }
      summary.offered++;

      const ruling = ruledHere.get(key(field, value));
      if (!ruling) {
        summary.neverRuled++;
        continue;
      }
      const verdict = str(ruling.verdict);
      if (verdict === "accepted") {
        summary.accepted++;
        const evidence = str(ruling.evidence);
        if (evidence in acceptedByEvidence) acceptedByEvidence[evidence]++;
      } else if (verdict === "rejected") {
        summary.rejected++;
      } else {
        // A verdict string that is neither reads as no answer, because it is
        // not one. Counting it as a rejection would be the same collapse.
        summary.neverRuled++;
      }
    }
  }

  return {
    window,
    runs: data.length,
    runsWithCandidates,
    // Most-offered first: the field with the most traffic is the one whose
    // accept rate is worth acting on.
    byField: [...byField.values()].sort(
      (a, b) => b.offered - a.offered || a.field.localeCompare(b.field),
    ),
    acceptedByEvidence,
    declines,
  };
}

/** Clamp the ?limit= window to something the aggregate can chew through. */
export function parseProvenanceWindow(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PROVENANCE_WINDOW;
  return Math.min(MAX_PROVENANCE_WINDOW, Math.floor(n));
}

// ── GET / ────────────────────────────────────────────────────────────────────
// What the visual pass offered over the last N runs and what the model did
// with it. Read-only; this route writes nothing.
adminIdentificationProvenanceRoutes.get("/", async (c) => {
  const window = parseProvenanceWindow(c.req.query("limit"));
  const { data, error } = await supabaseAdmin
    .from("identification_provenance")
    .select("visual_candidates, visual_rulings, visual_declined")
    .order("created_at", { ascending: false })
    .limit(window);
  if (error) return jsonError(c, 500, "Failed to load identification provenance");
  return c.json(summarizeIdentification((data ?? []) as ProvenanceRow[], window));
});
