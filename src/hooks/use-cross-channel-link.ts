import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";

// US-3197: Universal Import's linking half, from the browser.
//
// The seller lists one jacket on eBay and on Poshmark, imports both closets,
// and gets TWO items with nothing joining them. This is the button that finds
// those pairs and the queue for the ones the server would not join on its own.
//
// WHY THE QUEUE MATTERS MORE THAN THE BUTTON. A wrong link merges two
// garments, so the decision layers refuse far more than they accept: an
// ambiguous best match, a one-sided one, anything where the top two candidates
// are close. Each refusal is a question, and a question nobody answers is a
// closet that stays half-joined. The scan is one click; the queue is the work.

export interface LinkScanSummary {
  /** Joined without asking, because the match was above the bar. */
  linked: number;
  /** Held for the seller. Nothing merges here without a confirmation. */
  needsReview: number;
  /** Pairs already on one item or already sharing a group. */
  alreadyLinked: number;
  unmatched: number;
  scanned: number;
  /** Pairs whose rows moved between the plan and the write. */
  failed: number;
}

export interface LinkReview {
  id: string;
  listing_a_id: string;
  listing_b_id: string;
  item_a_id: string;
  item_b_id: string;
  score: number;
  /** Why, in the order a person would check them. Shown as written. */
  reasons: string[];
  status: "pending" | "linked" | "split";
  created_at: string;
}

const BASE = "/api/flipdesk/import/link";

/** The matches waiting on a human. Empty is the good state, not an error. */
export function useLinkReviews(status: LinkReview["status"] = "pending") {
  return useQuery({
    queryKey: ["cross_channel_link_reviews", status],
    queryFn: async (): Promise<LinkReview[]> => {
      const res = await edgeFetch(`${BASE}/reviews?status=${status}`);
      if (!res.ok) throw new Error("Could not load the matches waiting for you.");
      const json = (await res.json()) as { reviews?: LinkReview[] };
      return json.reviews ?? [];
    },
  });
}

export function useLinkScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<LinkScanSummary> => {
      const res = await edgeFetch(`${BASE}/scan`, { method: "POST" });
      if (!res.ok) throw new Error("Could not look for matching listings.");
      return (await res.json()) as LinkScanSummary;
    },
    onSuccess: () => {
      // A scan moves listings between items and archives the emptied ones, so
      // every surface built on either is stale.
      void qc.invalidateQueries({ queryKey: ["cross_channel_link_reviews"] });
      void qc.invalidateQueries({ queryKey: ["items_full"] });
      void qc.invalidateQueries({ queryKey: ["item_listings"] });
    },
  });
}

/**
 * Answer one question.
 *
 * `split` on a pair that was already joined UNDOES the merge -- the writes
 * are replayed backwards from what the row recorded. That is the unmerge
 * button, and it is why the confirm is safe to offer at all.
 */
export function useResolveLinkReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: { id: string; decision: "confirm" | "split" },
    ): Promise<void> => {
      const res = await edgeFetch(`${BASE}/reviews/${input.id}/${input.decision}`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(
          body?.error ??
            (input.decision === "confirm"
              ? "Could not join those listings."
              : "Could not separate those listings."),
        );
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["cross_channel_link_reviews"] });
      void qc.invalidateQueries({ queryKey: ["items_full"] });
      void qc.invalidateQueries({ queryKey: ["item_listings"] });
    },
  });
}

/**
 * What a finished scan did, in one sentence.
 *
 * Says the REVIEW count out loud even when nothing was joined, because that
 * is the number with work behind it. "Nothing to do" and "eleven questions
 * waiting" must never read the same.
 */
export function scanSummarySentence(s: LinkScanSummary): string {
  const bits: string[] = [];
  if (s.linked > 0) {
    bits.push(`joined ${s.linked} ${s.linked === 1 ? "pair" : "pairs"}`);
  }
  if (s.needsReview > 0) {
    bits.push(`${s.needsReview} ${s.needsReview === 1 ? "match needs" : "matches need"} your call`);
  }
  if (s.failed > 0) {
    bits.push(`${s.failed} could not be joined and were left alone`);
  }
  if (bits.length === 0) {
    return s.scanned === 0
      ? "No live listings to compare yet."
      : `Checked ${s.scanned} listings. Nothing new to join.`;
  }
  return `Checked ${s.scanned} listings: ${bits.join(", ")}.`;
}
