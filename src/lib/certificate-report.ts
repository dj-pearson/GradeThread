// US-2550: what a buyer can say is wrong with a certificate.
//
// Mirrors CERTIFICATE_REPORT_REASONS in
// services/edge-functions/src/lib/moderation-queue.ts. The two trees are bundled
// separately and share no module graph, so this is a deliberate second copy —
// `src/test/certificate-report.test.ts` compares them key for key, because a
// reason the client offers and the server rejects is a report button that
// silently does nothing.
//
// The keys are the wire values. The values are what the buyer reads, and they
// are also what an operator sees in the moderation queue, so they are written to
// be legible in both places.
export const CERTIFICATE_REPORT_REASONS = {
  not_my_item: "The photos are not the item I received",
  altered: "The grade or details look altered",
  stolen: "This certificate is being used by someone else",
  other: "Something else",
} as const;

export type CertificateReportReason = keyof typeof CERTIFICATE_REPORT_REASONS;

/** How much free text a reporter may add. Mirrors the server's cap. */
export const CERTIFICATE_REPORT_NOTE_MAX = 500;
