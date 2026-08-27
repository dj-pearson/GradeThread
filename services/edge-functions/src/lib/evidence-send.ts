// US-2935: the two rules every grade-evidence send shares.
//
// There are three eBay surfaces a pack can go to — a return, a payment dispute,
// and now an escalated case — and each has its own upload API. What must NOT be
// per-surface is the decision about whether to send at all, or the image
// hygiene applied on the way out. Before this, each route carried its own copy
// of both, and the copies were already drifting: the return route capped the
// file count and the dispute route took exactly one file.
//
// ── THE REFUSAL ─────────────────────────────────────────────────────────────
//
// US-2703 AC5, restated because it is the rule most likely to be lost in a
// refactor: when the grade report AGREES with the buyer, we do not send. The
// pack is assembled from the item's own report and the listing text GradeThread
// published, so a `supported` verdict means handing eBay a signed document
// proving our own user sold an undisclosed flaw. That is evidence for the other
// side.
//
// Keyed on a verdict we actually computed. A plan that could not be built is
// NOT a refusal — a lookup failure must never silently become one, and it must
// never become an assembly either.

import { stripImageMetadata } from "./image-metadata.ts";
import { validateImageUpload } from "./upload-validation.ts";

export interface EvidenceRefusal {
  verdict: string;
  reason: string;
}

/**
 * Should this send be refused? Pure, and the single arbiter for all three
 * surfaces. Returns null when there is nothing to refuse — including when no
 * plan could be built.
 */
export function evidenceRefusalFor(
  plan: { verdict?: string | null; reason?: string | null } | null | undefined,
): EvidenceRefusal | null {
  if (!plan) return null;
  if (plan.verdict !== "supported") return null;
  return {
    verdict: "supported",
    reason: plan.reason ??
      "Your own grade report documents this flaw, so sending it would argue for the buyer.",
  };
}

export interface CleanedEvidenceFile {
  bytes: Uint8Array;
  filename: string;
  /** The sniffed content type, for the surfaces whose upload API wants one. */
  contentType: string;
}

export type CleanEvidenceResult =
  | { ok: true; files: CleanedEvidenceFile[] }
  | { ok: false; status: 400; error: string };

/**
 * Validate and de-identify a set of evidence images.
 *
 * Magic-byte sniff rather than the client MIME, then EXIF/GPS stripped, in that
 * order — these images go to a buyer-facing surface at eBay, and an unstripped
 * one carries the seller's home coordinates into a dispute file.
 *
 * A cap, because eBay bounds what a case will carry and because a pack that is
 * mostly filler argues worse than a pack that is only the flaw.
 */
export async function cleanEvidenceFiles(
  files: File[],
  maxFiles: number,
): Promise<CleanEvidenceResult> {
  if (files.length === 0) {
    return { ok: false, status: 400, error: "Missing evidence file." };
  }
  if (files.length > maxFiles) {
    return {
      ok: false,
      status: 400,
      error: `Too many files — ${maxFiles} is the limit.`,
    };
  }
  const out: CleanedEvidenceFile[] = [];
  for (const [i, file] of files.entries()) {
    const rawBytes = new Uint8Array(await file.arrayBuffer());
    const verdict = validateImageUpload(rawBytes, { allow: ["jpeg", "png"] });
    if (!verdict.ok) {
      return { ok: false, status: 400, error: `Invalid image: ${verdict.reason}` };
    }
    const { bytes } = stripImageMetadata(rawBytes, verdict.format);
    out.push({
      bytes,
      filename: file.name || `evidence-${i + 1}.${verdict.ext}`,
      contentType: verdict.contentType,
    });
  }
  return { ok: true, files: out };
}
