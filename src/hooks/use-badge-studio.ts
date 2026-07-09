import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";

// US-1759: the seller's certificates for the Badge Studio picker. Reads
// grade_reports directly — RLS scopes it to the caller's own submissions — and
// joins each public certificate to its Garment Passport slug (if any) via the
// PII-free public_passport_links view, so the studio can offer a passport-slug
// badge variant that advertises the garment's full history.

export interface BadgeCertificate {
  certificateId: string;
  overallScore: number;
  gradeTier: string;
  finalizedAt: string | null;
  /** The garment passport slug for this certificate, or null when it has none. */
  passportSlug: string | null;
}

interface GradeRow {
  certificate_id: string | null;
  overall_score: number;
  grade_tier: string;
  finalized_at: string | null;
}

export function useMyCertificates() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["badge-studio-certificates", user?.id],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<BadgeCertificate[]> => {
      // Only the active (non-superseded) report per submission, and only those
      // that actually have a public certificate to badge.
      const { data: raw, error } = await supabase
        .from("grade_reports")
        .select("certificate_id, overall_score, grade_tier, finalized_at")
        .not("certificate_id", "is", null)
        .is("superseded_at", null)
        .order("finalized_at", { ascending: false })
        .limit(100);
      if (error) throw error;

      const rows = (raw ?? []) as GradeRow[];
      const certs = rows.filter(
        (r): r is GradeRow & { certificate_id: string } => !!r.certificate_id,
      );
      if (certs.length === 0) return [];

      // Map each certificate to its passport slug (if it has one).
      const slugByCert = new Map<string, string>();
      const { data: linkRaw } = await supabase
        .from("public_passport_links")
        .select("certificate_id, passport_slug")
        .in(
          "certificate_id",
          certs.map((c) => c.certificate_id),
        );
      for (const l of (linkRaw ?? []) as Array<{
        certificate_id: string;
        passport_slug: string;
      }>) {
        slugByCert.set(l.certificate_id, l.passport_slug);
      }

      return certs.map((r) => ({
        certificateId: r.certificate_id,
        overallScore: r.overall_score,
        gradeTier: r.grade_tier,
        finalizedAt: r.finalized_at,
        passportSlug: slugByCert.get(r.certificate_id) ?? null,
      }));
    },
  });
}
