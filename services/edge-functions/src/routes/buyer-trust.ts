import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { isCertificateWithheld } from "../lib/certificate-visibility.ts";
import { verifyCertIntegrity } from "../lib/cert-integrity.ts";
import {
  hasAnyTrustSignal,
  projectTrustSignals,
  type TrustBadge,
  trustSignalBadges,
} from "../lib/buyer-trust-signals.ts";

// US-1844: buyer-facing trust signals — a batch projection of the coarse public
// verified/trust cues for a set of certificate ids, so every buyer surface
// (extension overlay, alerts, watchlist, portfolio) renders the SAME badges the
// public certificate page shows, deep-linking to /cert/:id.
//
// This is the PUBLIC projection (content-public.ts parity) — it exposes ONLY
// the positive-only booleans, never internal scores/reasons/PII, for ANY cert,
// exactly like the public /certificates/:id page. It is therefore intentionally
// NOT tenant-scoped: a buyer evaluating a stranger's listing must see that
// listing's public badges. Withheld/preliminary certs (US-484) resolve to
// "no signals" — a suspect grade never advertises trust. Mounted under
// /api/buyer/* (authMiddleware), so c.get("userId") is the caller.

type BuyerTrustEnv = { Variables: { userId: string } };

export const buyerTrustRoutes = new Hono<BuyerTrustEnv>();

// Cap the batch so a single request can't fan out unbounded verify work.
const MAX_CERT_IDS = 50;

// Everything cert-integrity + the signal columns need, in ONE row select.
const REPORT_COLUMNS =
  "certificate_id, overall_score, grade_tier, fabric_condition_score, " +
  "structural_integrity_score, cosmetic_appearance_score, functional_elements_score, " +
  "odor_cleanliness_score, ai_summary, buyer_writeup, coverage_pct, covered_zones, " +
  "content_hash, content_signature, integrity_version, submission_id, " +
  "verified_capture, original_photos, live_capture, verified_360";

interface ReportRow {
  certificate_id: string;
  overall_score: number;
  grade_tier: string;
  fabric_condition_score: number;
  structural_integrity_score: number;
  cosmetic_appearance_score: number;
  functional_elements_score: number;
  odor_cleanliness_score: number;
  ai_summary: string | null;
  buyer_writeup: string | null;
  coverage_pct: number | null;
  covered_zones: string[] | null;
  content_hash: string | null;
  content_signature: string | null;
  integrity_version: number | null;
  submission_id: string;
  verified_capture: { verified?: boolean } | null;
  original_photos: { verified?: boolean } | null;
  live_capture: { badge?: string } | null;
  verified_360: { badge?: string } | null;
}

interface SubmissionRow {
  id: string;
  user_id: string;
  flagged: boolean | null;
  moderation_status: string | null;
  status: string | null;
}

export interface CertTrustSignals {
  badges: TrustBadge[];
  hasAny: boolean;
  certUrl: string;
}

/** Clean an incoming cert-id list: strings only, trimmed, deduped, capped. */
function parseCertIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const id = v.trim().slice(0, 100);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_CERT_IDS) break;
  }
  return out;
}

// ── POST /trust-signals ───────────────────────────────────────────
// Body: { certIds: string[] }. Returns { signals: { [certId]: CertTrustSignals } }.
// Only non-withheld, resolvable certs appear; unknown/withheld ids are omitted
// (the client renders no badges for them).
buyerTrustRoutes.post("/trust-signals", async (c) => {
  let body: { certIds?: unknown };
  try {
    body = (await c.req.json()) as { certIds?: unknown };
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const certIds = parseCertIds(body.certIds);
  if (certIds.length === 0) return c.json({ signals: {} });

  const { data: reportRows, error } = await supabaseAdmin
    .from("grade_reports")
    .select(REPORT_COLUMNS)
    .in("certificate_id", certIds)
    .not("certificate_id", "is", null);
  if (error) return c.json({ error: "Couldn't load trust signals." }, 500);
  const reports = (reportRows ?? []) as unknown as ReportRow[];
  if (reports.length === 0) return c.json({ signals: {} });

  // Parent submissions (withheld gate + owning seller) in one batch.
  const submissionIds = [...new Set(reports.map((r) => r.submission_id))];
  const { data: subRows } = await supabaseAdmin
    .from("submissions")
    .select("id, user_id, flagged, moderation_status, status")
    .in("id", submissionIds);
  const subById = new Map<string, SubmissionRow>(
    ((subRows ?? []) as SubmissionRow[]).map((s) => [s.id, s]),
  );

  // Which owning sellers run a public Verified profile (US-1761) — one batch.
  const sellerIds = [...new Set(
    ((subRows ?? []) as SubmissionRow[]).map((s) => s.user_id).filter(Boolean),
  )];
  const verifiedSellerIds = new Set<string>();
  if (sellerIds.length > 0) {
    const { data: sellerRows } = await supabaseAdmin
      .from("users")
      .select("id")
      .in("id", sellerIds)
      .eq("verified_enabled", true);
    for (const s of (sellerRows ?? []) as Array<{ id: string }>) {
      verifiedSellerIds.add(s.id);
    }
  }

  const signals: Record<string, CertTrustSignals> = {};
  for (const rep of reports) {
    const sub = subById.get(rep.submission_id);
    // A suspect / still-preliminary grade never advertises trust.
    if (isCertificateWithheld(sub)) continue;

    // Real integrity check (pure hash recompute — no network), same contract as
    // the public verify endpoint. Unverifiable/legacy rows → not "verified".
    let integrityOk = false;
    if (rep.content_hash) {
      try {
        const res = await verifyCertIntegrity(
          {
            certificate_id: rep.certificate_id,
            overall_score: rep.overall_score,
            grade_tier: rep.grade_tier,
            fabric_condition_score: rep.fabric_condition_score,
            structural_integrity_score: rep.structural_integrity_score,
            cosmetic_appearance_score: rep.cosmetic_appearance_score,
            functional_elements_score: rep.functional_elements_score,
            odor_cleanliness_score: rep.odor_cleanliness_score,
            ai_summary: rep.ai_summary ?? "",
            buyer_writeup: rep.buyer_writeup,
            coverage_pct: rep.coverage_pct,
            covered_zones: rep.covered_zones,
          },
          rep.content_hash,
          rep.content_signature,
          rep.integrity_version,
        );
        integrityOk = res.verified;
      } catch {
        integrityOk = false;
      }
    }

    const sig = projectTrustSignals(rep, {
      verifiedSeller: sub ? verifiedSellerIds.has(sub.user_id) : false,
      certIntegrityOk: integrityOk,
    });
    signals[rep.certificate_id] = {
      badges: trustSignalBadges(sig),
      hasAny: hasAnyTrustSignal(sig),
      // Deep-link to the full certificate; ?s=buyer feeds US-1760 attribution.
      certUrl: `/cert/${rep.certificate_id}?s=buyer`,
    };
  }

  return c.json({ signals });
});
