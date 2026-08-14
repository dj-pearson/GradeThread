// US-2567: the provenance stamp burned into every asset in a condition-evidence
// pack — the certificate number, the grade, and where to check it.
//
// DUPLICATED FROM services/edge-functions/src/lib/evidence-pack.ts ON PURPOSE.
// The two renderers share no module: one runs in Deno against ImageScript, the
// other in the browser against Canvas2D. A drift test
// (src/test/annotated-photo-stamp.test.ts) pins the format from both sides,
// because the failure mode otherwise is invisible — both images render, they
// just stop matching, and the seller approves one image and ships another.

/** The certificate facts stamped onto an image. A null number → no stamp. */
export interface EvidenceStamp {
  certificateNumber: string | null;
  overallScore: number;
  gradeTier: string;
}

/**
 * The one-line stamp, or null when there is no certificate to cite.
 *
 * An evidence image that cannot name its own certificate is just a picture: the
 * whole argument in a dispute is "this flaw was documented and published under a
 * verifiable grade before you bought it", and that argument needs the number on
 * the image itself, because the image is what gets pasted into a claim form.
 */
export function stampLine(stamp: EvidenceStamp | null | undefined): string | null {
  if (!stamp?.certificateNumber) return null;
  const score = Number.isFinite(stamp.overallScore) ? stamp.overallScore.toFixed(1) : "—";
  const tier = (stamp.gradeTier ?? "").trim();
  const parts = [stamp.certificateNumber, `${score} / 10`];
  if (tier) parts.push(tier);
  return `${parts.join("  ·  ")}  ·  gradethread.com/verify`;
}
