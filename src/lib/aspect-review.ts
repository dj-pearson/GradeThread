import type { AspectReviewEntry } from "@/types/database";

/**
 * US-3474: the review entries a seller must act on. `off_list_value` means a
 * free-text value that is not on eBay's list but still publishes, so it is a
 * hint, never a "to fix" count and never a reason to call a draft broken.
 */
export function blockingAspectReview(
  entries: AspectReviewEntry[] | null | undefined,
): AspectReviewEntry[] {
  return (entries ?? []).filter((e) => e.reason !== "off_list_value");
}
