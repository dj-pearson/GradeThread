import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";

// US-3452: what a sale ended, where, when and by whom, for one item.
// Mirrors services/edge-functions/src/lib/delist-log.ts; the words for each
// event live in src/lib/delist-log-words.ts so the item page and the Record
// Sale confirmation read one sentence.

export type DelistLogEventKind =
  | "sold"
  | "ended_api"
  | "ended_extension"
  | "ended_by_hand"
  | "queued"
  | "waiting"
  | "unresolved";

export interface DelistLogEvent {
  at: string;
  platform: string;
  listing_id: string | null;
  event: DelistLogEventKind;
  actor: "server" | "browser" | "seller";
  url: string | null;
  note: string | null;
}

export const delistLogKey = (itemId: string) => ["delist_log", itemId] as const;

export function useDelistLog(itemId: string | undefined) {
  return useQuery({
    queryKey: delistLogKey(itemId ?? ""),
    enabled: Boolean(itemId),
    staleTime: 30 * 1000,
    queryFn: async (): Promise<DelistLogEvent[]> => {
      const res = await edgeFetch(
        `/api/flipdesk/listings/delist-log/${encodeURIComponent(itemId!)}`,
      );
      if (!res.ok) throw new Error("Could not load what happened after the sale.");
      const json = (await res.json()) as { events?: DelistLogEvent[] };
      return json.events ?? [];
    },
  });
}
