// US-3540: what the certificate page says when its number no longer resolves
// to a live grade but the edge knows why (a regrade replaced it, or a refund
// withdrew it). The sentence itself comes from the edge (cert-revision.ts
// revisionMessage), so the SPA, the SSR page and the API say the same thing;
// this only picks the heading and parses the response defensively.

export interface CertRevisionNotice {
  status: "revised" | "pending" | "revoked";
  message: string;
  currentCertificateId: string | null;
  currentCertificateNumber: string | null;
}

export function parseCertRevision(body: unknown): CertRevisionNotice | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.revised !== true || typeof b.message !== "string") return null;
  const status = b.status === "revoked" || b.status === "pending" ? b.status : "revised";
  return {
    status,
    message: b.message,
    currentCertificateId: typeof b.current_certificate_id === "string" ? b.current_certificate_id : null,
    currentCertificateNumber:
      typeof b.current_certificate_number === "string" ? b.current_certificate_number : null,
  };
}

export function certRevisionHeading(status: CertRevisionNotice["status"]): string {
  return status === "revoked" ? "This certificate was withdrawn" : "This certificate was revised";
}
