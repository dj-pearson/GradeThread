import type { BulkCrossPushSummary } from "@/hooks/use-cross-listing";
import { QUEUED_NOTICE } from "@/hooks/use-extension-queue";

// US-3456: the one sentence a bulk cross-list reports back, shared by the
// Listings page and the AutoLister drafts library so the two toast the same
// words for the same result.

export interface BulkCrossListReport {
  tone: "success" | "warning" | "error";
  title: string;
  description: string | null;
}

export function describeBulkCrossPush(
  summary: BulkCrossPushSummary,
  batchLabel: string | null,
  ebayPublished: number | null,
): BulkCrossListReport {
  const parts: string[] = [];
  if (ebayPublished != null && ebayPublished > 0) {
    parts.push(`${ebayPublished} published to eBay`);
  }
  if (summary.published > 0) parts.push(`${summary.published} published`);
  if (summary.queued > 0) parts.push(`${summary.queued} queued for your browser`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} already there`);
  if (summary.noSource > 0) parts.push(`${summary.noSource} with no eBay draft to copy`);
  if (summary.notFound > 0) parts.push(`${summary.notFound} not found`);
  if (summary.blocked > 0) parts.push(`${summary.blocked} blocked`);

  const did = summary.published + summary.queued + (ebayPublished ?? 0);
  const failed = summary.noSource + summary.notFound + summary.blocked;
  const tone: BulkCrossListReport["tone"] = did === 0 && failed > 0
    ? "error"
    : failed > 0
    ? "warning"
    : "success";
  const label = batchLabel ? ` "${batchLabel}"` : "";
  const title = parts.length === 0
    ? `Cross-list${label}: nothing to do.`
    : `Cross-list${label}: ${parts.join(", ")}.`;
  const description = summary.queued > 0 ? QUEUED_NOTICE : null;
  return { tone, title, description };
}
