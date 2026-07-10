// US-1830: demand-board matching (impure, service-role).
//
// Runs a want against the SAME public-cert universe the alerts engine uses,
// reusing condition-alerts.matchesSearch. Records a want_matches row per matched
// cert (buyer + the cert's grading SELLER), idempotent on (want, cert). Skips the
// buyer's OWN certs (basic anti-self-match; full anti-abuse is US-1832). Emitting
// notifications to either side is US-1832 — this story records the match.

import { supabaseAdmin } from "./supabase.ts";
import { type CandidateCert } from "./condition-alerts.ts";
import { isCertificateWithheld } from "./certificate-visibility.ts";
import { matchesSearch, type WantSearchFields, wantToSearch } from "./demand-board.ts";

const CANDIDATE_POOL = 500;
const MAX_MATCHES_PER_WANT = 50;
const CANDIDATE_WINDOW_DAYS = 180;

interface Candidate extends CandidateCert {
  sellerUserId: string | null;
}

/** Recent public certs (with the grading seller) as the match universe. */
async function loadDemandCandidates(): Promise<Candidate[]> {
  const since = new Date(Date.now() - CANDIDATE_WINDOW_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("grade_reports")
    .select(
      "certificate_id, overall_score, created_at, submissions!inner(user_id, title, brand, garment_category, flagged, moderation_status, status)",
    )
    .not("certificate_id", "is", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(CANDIDATE_POOL);
  if (error) {
    console.error("[demand-board] candidate load failed:", error.message);
    return [];
  }
  const out: Candidate[] = [];
  for (const raw of data ?? []) {
    const r = raw as {
      certificate_id: string | null;
      overall_score: number;
      submissions: unknown;
    };
    if (!r.certificate_id) continue;
    const sub = (Array.isArray(r.submissions) ? r.submissions[0] : r.submissions) as {
      user_id: string;
      title: string | null;
      brand: string | null;
      garment_category: string | null;
      flagged?: boolean;
      moderation_status?: string;
      status?: string;
    } | null;
    if (!sub || isCertificateWithheld(sub)) continue;
    out.push({
      certificateId: r.certificate_id,
      brand: sub.brand,
      title: sub.title ?? "",
      category: sub.garment_category,
      grade: r.overall_score,
      sellerUserId: sub.user_id ?? null,
    });
  }
  return out;
}

export interface NewMatch {
  certificateId: string;
  sellerUserId: string | null;
}

export interface WantMatchResult {
  /** Total matches for the want (new + already recorded). */
  matched: number;
  /** Matches recorded for the FIRST time this run — the ones to notify on. */
  newMatches: NewMatch[];
}

/**
 * Match one want against the public-cert universe and record want_matches rows.
 * Diffs against already-recorded matches so it returns only the NEW ones (the
 * notification trigger for US-1832). Best-effort: a failure logs and returns
 * empty rather than throwing. Scoped by the want owner.
 */
export async function computeWantMatches(want: WantSearchFields): Promise<WantMatchResult> {
  try {
    const candidates = await loadDemandCandidates();
    if (candidates.length === 0) return { matched: 0, newMatches: [] };
    const search = wantToSearch(want);

    // Already-recorded matches for this want (so we only notify on NEW ones).
    const { data: existingRows } = await supabaseAdmin
      .from("want_matches")
      .select("certificate_id")
      .eq("want_id", want.id);
    const existing = new Set((existingRows ?? []).map((r) => (r as { certificate_id: string }).certificate_id));

    const rows: Array<Record<string, unknown>> = [];
    const newMatches: NewMatch[] = [];
    let matched = 0;
    for (const cert of candidates) {
      if (matched >= MAX_MATCHES_PER_WANT) break;
      if (cert.sellerUserId === want.user_id) continue; // never match your own item
      if (!matchesSearch(cert, search)) continue;
      matched++;
      if (existing.has(cert.certificateId)) continue; // already recorded → not new
      rows.push({
        want_id: want.id,
        buyer_user_id: want.user_id,
        seller_user_id: cert.sellerUserId,
        certificate_id: cert.certificateId,
      });
      newMatches.push({ certificateId: cert.certificateId, sellerUserId: cert.sellerUserId });
    }

    if (rows.length > 0) {
      const { error } = await supabaseAdmin
        .from("want_matches")
        .upsert(rows as never, { onConflict: "want_id,certificate_id", ignoreDuplicates: true });
      if (error) {
        console.error("[demand-board] match upsert failed:", error.message);
        return { matched, newMatches: [] };
      }
    }
    return { matched, newMatches };
  } catch (err) {
    console.error("[demand-board] computeWantMatches failed:", err instanceof Error ? err.message : String(err));
    return { matched: 0, newMatches: [] };
  }
}
