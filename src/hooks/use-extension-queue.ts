import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";

// US-2481: extension work queued from one device, run on the desktop.
//
// Extension-mechanism channels can only be acted on from the seller's own
// logged-in browser (vault/60-decisions/adr-no-server-side-marketplace-automation.md).
// The cost of that is real: sourcing at a thrift store with only a phone means
// no cross-listing, and a delist after a sale waits for the laptop.
//
// The queue softens it without paying the price the ADR refuses. The server
// holds an INSTRUCTION — an item id, a platform, a locale key — and the desktop
// extension drains it. It never holds a marketplace credential; that is checked
// in the edge, in lib/extension-queue.ts, and as a CHECK constraint on the table.
//
// The one thing every consumer of this hook must get right is the WORDING. A
// queued job is not a done job, and a screen that says "Listed" for something
// that has not happened is the failure this whole design is trying to avoid —
// especially for a delist, where believing it was handled is what turns into a
// double sale. QUEUED_NOTICE below is the sentence; use it.

export const QUEUED_NOTICE =
  "This runs the next time you open your desktop browser with the GradeThread " +
  "extension installed. Nothing happens on the marketplace until then.";

// `share` was a third kind until US-2497. It is gone because nothing could run
// it: an engagement pass needs a human at the browser to take the tab back when
// Poshmark asks for a check, and a queue drained hours later has nobody there.
export type ExtensionQueueKind = "list" | "delist" | "revise" | "relist";

export interface ExtensionQueueItem {
  id: string;
  kind: ExtensionQueueKind;
  platform: string;
  inventory_item_id: string | null;
  listing_id: string | null;
  payload: Record<string, unknown>;
  status: "queued" | "claimed" | "done" | "failed" | "expired";
  attempts: number;
  source: string;
  claimed_at: string | null;
  completed_at: string | null;
  result: { error?: string | null; manual?: boolean; expired?: boolean } | null;
  expires_at: string;
  created_at: string;
  /**
   * US-3048: the item's own title, joined on by GET / for a human to read.
   * Optional because /claim does not carry it — the drain has no use for a
   * title, and widening its columns to serve a screen it never renders would
   * put the cost on the hot path.
   */
  item_title?: string | null;
}

interface QueueResponse {
  pending: ExtensionQueueItem[];
  /**
   * Expired or failed work. Kept in its own list so a caller cannot render it
   * as "still coming" — silence about work that never ran is the US-2165 rule
   * this queue would otherwise reintroduce.
   */
  needsAttention: ExtensionQueueItem[];
}

export function useExtensionQueue(enabled = true) {
  return useQuery({
    queryKey: ["extension_queue"],
    enabled,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<QueueResponse> => {
      const res = await edgeFetch("/api/flipdesk/extension-queue");
      if (!res.ok) throw new Error("Could not load your queued work.");
      const json = (await res.json()) as Partial<QueueResponse>;
      return {
        pending: json.pending ?? [],
        needsAttention: json.needsAttention ?? [],
      };
    },
  });
}

export interface EnqueueInput {
  kind: ExtensionQueueKind;
  platform: string;
  inventoryItemId?: string | null;
  listingId?: string | null;
  /** The instruction. Never a credential — the edge rejects one by key. */
  payload?: Record<string, unknown>;
}

export function useEnqueueExtensionWork() {
  const qc = useQueryClient();
  return useMutation<ExtensionQueueItem, Error, EnqueueInput>({
    mutationFn: async (input) => {
      const res = await edgeFetch("/api/flipdesk/extension-queue", {
        method: "POST",
        json: {
          kind: input.kind,
          platform: input.platform,
          inventory_item_id: input.inventoryItemId ?? null,
          listing_id: input.listingId ?? null,
          payload: input.payload ?? {},
          source: "web",
        },
      });
      const json = (await res.json().catch(() => ({}))) as {
        queued?: ExtensionQueueItem;
        error?: string;
      };
      if (!res.ok || !json.queued) {
        throw new Error(json.error ?? "Could not queue that work.");
      }
      return json.queued;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["extension_queue"] });
    },
  });
}

export function useCancelExtensionWork() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      const res = await edgeFetch(`/api/flipdesk/extension-queue/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Could not cancel that job.");
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["extension_queue"] });
    },
  });
}
