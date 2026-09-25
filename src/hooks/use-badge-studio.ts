import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";

// US-1759: the seller's certificates for the Badge Studio picker. Reads
// grade_reports directly and joins each public certificate to its Garment
// Passport slug (if any) via the PII-free public_passport_links view, so the
// studio can offer a passport-slug badge variant that advertises the garment's
// full history.
//
// RLS is NOT enough to scope this list. An admin can read every grade report
// on the platform, and a workspace member can read the owner's, so a bare
// select offered other people's certificates as the caller's own. The query
// filters on the caller's user id explicitly (the same id the Verified profile
// and its stats are keyed on), and then keeps only the rows the public
// certificate view would actually show, so a pasted badge never 404s.

export interface BadgeCertificate {
  certificateId: string;
  overallScore: number;
  gradeTier: string;
  finalizedAt: string | null;
  /** The graded item's title, so the seller can tell two grades apart. */
  title: string | null;
  brand: string | null;
  /** The garment passport slug for this certificate, or null when it has none. */
  passportSlug: string | null;
}

interface SubmissionEmbed {
  user_id: string;
  title: string | null;
  brand: string | null;
  status: string | null;
  flagged: boolean | null;
  moderation_status: string | null;
}

export interface BadgeCertRow {
  certificate_id: string | null;
  overall_score: number;
  grade_tier: string;
  finalized_at: string | null;
  review_status: string | null;
  submissions: SubmissionEmbed | SubmissionEmbed[] | null;
}

export const BADGE_CERT_SELECT =
  "certificate_id, overall_score, grade_tier, finalized_at, review_status, " +
  "submissions!inner(user_id, title, brand, status, flagged, moderation_status)";

function embedOf(row: BadgeCertRow): SubmissionEmbed | null {
  const s = row.submissions;
  return Array.isArray(s) ? (s[0] ?? null) : s;
}

/**
 * Would public_grade_reports show this certificate? Mirrors the view's WHERE
 * clause (latest definition: migration 00788), pinned by
 * use-badge-studio.test.ts so the two cannot drift apart silently:
 *
 *   gr.certificate_id IS NOT NULL
 *   AND gr.review_status IN ('approved', 'modified')
 *   AND s.status IS DISTINCT FROM 'pending_review'
 *   AND (s.flagged IS NOT TRUE OR s.moderation_status = 'approved')
 */
export function isPubliclyShownCert(row: BadgeCertRow): boolean {
  if (!row.certificate_id) return false;
  if (row.review_status !== "approved" && row.review_status !== "modified") return false;
  const s = embedOf(row);
  if (s?.status === "pending_review") return false;
  if (s?.flagged === true && s.moderation_status !== "approved") return false;
  return true;
}

function toCert(row: BadgeCertRow & { certificate_id: string }, slug: string | null): BadgeCertificate {
  const s = embedOf(row);
  return {
    certificateId: row.certificate_id,
    overallScore: row.overall_score,
    gradeTier: row.grade_tier,
    finalizedAt: row.finalized_at,
    title: s?.title ?? null,
    brand: s?.brand ?? null,
    passportSlug: slug,
  };
}

async function passportSlugs(certIds: string[]): Promise<Map<string, string>> {
  const slugByCert = new Map<string, string>();
  if (certIds.length === 0) return slugByCert;
  const { data: linkRaw, error } = await supabase
    .from("public_passport_links")
    .select("certificate_id, passport_slug")
    .in("certificate_id", certIds);
  if (error) throw error;
  for (const l of (linkRaw ?? []) as Array<{
    certificate_id: string;
    passport_slug: string;
  }>) {
    slugByCert.set(l.certificate_id, l.passport_slug);
  }
  return slugByCert;
}

/** The caller's own badgeable certificates, newest first. */
export async function fetchMyCertificates(userId: string): Promise<BadgeCertificate[]> {
  // Only the active (non-superseded) report per submission, and only those
  // that actually have a public certificate to badge.
  const { data: raw, error } = await supabase
    .from("grade_reports")
    .select(BADGE_CERT_SELECT)
    .eq("submissions.user_id", userId)
    .not("certificate_id", "is", null)
    .is("superseded_at", null)
    .in("review_status", ["approved", "modified"])
    .neq("submissions.status", "pending_review")
    .order("finalized_at", { ascending: false, nullsFirst: false })
    .limit(100);
  if (error) throw error;

  // The flagged rule is an OR across two columns of the embed, so it is
  // applied here rather than in the query.
  const certs = ((raw ?? []) as unknown as BadgeCertRow[]).filter(
    (r): r is BadgeCertRow & { certificate_id: string } => isPubliclyShownCert(r),
  );
  if (certs.length === 0) return [];

  const slugByCert = await passportSlugs(certs.map((c) => c.certificate_id));
  return certs.map((r) => toCert(r, slugByCert.get(r.certificate_id) ?? null));
}

export type OwnedCertLookup =
  | { state: "owned"; cert: BadgeCertificate }
  | { state: "not_public" }
  | { state: "not_owned" };

/**
 * A pasted certificate id, looked up among the CALLER's own certificates only.
 * Any public certificate id would otherwise produce "GradeThread Verified"
 * snippets, which would help badge a listing with someone else's grade.
 */
export async function lookupOwnedCertificate(
  userId: string,
  certId: string,
): Promise<OwnedCertLookup> {
  const { data, error } = await supabase
    .from("grade_reports")
    .select(BADGE_CERT_SELECT)
    .eq("submissions.user_id", userId)
    .eq("certificate_id", certId)
    .is("superseded_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { state: "not_owned" };
  const row = data as unknown as BadgeCertRow & { certificate_id: string };
  if (!isPubliclyShownCert(row)) return { state: "not_public" };
  const slugs = await passportSlugs([row.certificate_id]);
  return { state: "owned", cert: toCert(row, slugs.get(row.certificate_id) ?? null) };
}

export function useMyCertificates() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["badge-studio-certificates", user?.id],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchMyCertificates(user!.id),
  });
}

/** Owner-scoped lookup for a pasted certificate id that is not in the list. */
export function useOwnedCertificate(certId: string | null) {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["badge-studio-owned-cert", user?.id, certId],
    enabled: !!user && !!certId,
    staleTime: 5 * 60 * 1000,
    queryFn: () => lookupOwnedCertificate(user!.id, certId!),
  });
}
