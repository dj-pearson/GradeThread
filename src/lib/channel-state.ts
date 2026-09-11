import type { ItemListingRow } from "@/hooks/use-item-listings";
import type { ExtensionQueueItem } from "@/hooks/use-extension-queue";
import { safeHref } from "@/lib/safe-url";

// US-3367: one answer to "what is this item doing on this marketplace", for
// the kit tab, the kit status row and the item page card. Two inputs the pages
// already read: the item's listing rows and the seller's extension queue.
// Pure, so the precedence below is tested once rather than guessed at three
// render sites.

export type ChannelState =
  | "live"
  | "queued"
  | "delist_queued"
  | "prefilled"
  | "failed"
  | "ended"
  | "sold"
  | "none";

export interface ChannelStatus {
  state: ChannelState;
  row: ItemListingRow | null;
  queueItem: ExtensionQueueItem | null;
  /** The marketplace page, only when the row carries a usable https URL. */
  url: string | null;
  /** ISO time the state started, when known. */
  since: string | null;
}

const PENDING = new Set(["queued", "claimed"]);
const FAILED = new Set(["failed", "expired"]);

function newest<T extends { created_at: string }>(items: T[]): T | null {
  return items.slice().sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

export function deriveChannelState(
  rows: readonly ItemListingRow[],
  queueItems: readonly ExtensionQueueItem[],
  platform: string,
): ChannelStatus {
  const row = rows.find((r) => r.platform === platform) ?? null;
  const mine = queueItems.filter((it) => it.platform === platform);
  const delist = newest(mine.filter((it) => it.kind === "delist" && PENDING.has(it.status)));
  const list = newest(mine.filter((it) => it.kind === "list"));
  const url = safeHref(row?.listing_url);
  const base: ChannelStatus = {
    state: "none",
    row,
    queueItem: null,
    url,
    since: row?.updated_at ?? null,
  };

  // Precedence, most urgent first. A delist in flight means the garment is
  // gone and the listing may still be live, which beats every other reading.
  if (delist) return { ...base, state: "delist_queued", queueItem: delist, since: delist.created_at };
  if (row?.listing_status === "ended" && row.delist_requested_at) {
    return { ...base, state: "delist_queued", since: row.delist_requested_at };
  }
  if (list && PENDING.has(list.status)) {
    return { ...base, state: "queued", queueItem: list, since: list.created_at };
  }
  if (row?.listing_status === "active") return { ...base, state: "live" };
  if (list && FAILED.has(list.status)) {
    return { ...base, state: "failed", queueItem: list, since: list.completed_at ?? list.created_at };
  }
  if (row?.listing_status === "sold") return { ...base, state: "sold" };
  if (row?.listing_status === "ended") return { ...base, state: "ended" };
  if (row?.listing_status === "draft") return { ...base, state: "prefilled" };
  return base;
}

/**
 * The "List on" checklist's defaults. A disabled entry carries the word the
 * label shows in brackets.
 *
 * Prefilled and ended are offered but unchecked: a prefill the seller
 * abandoned may want a second go and an ended listing may want a relist, and
 * both are a decision rather than a default.
 */
export function planListEverywhere(
  platforms: readonly string[],
  statuses: Record<string, ChannelStatus | undefined>,
): { checked: string[]; disabled: Record<string, string> } {
  const checked: string[] = [];
  const disabled: Record<string, string> = {};
  for (const p of platforms) {
    const s = statuses[p]?.state ?? "none";
    if (s === "live") disabled[p] = "live";
    else if (s === "queued") disabled[p] = "queued";
    else if (s === "delist_queued") disabled[p] = "ending";
    else if (s === "none" || s === "failed") checked.push(p);
  }
  return { checked, disabled };
}
