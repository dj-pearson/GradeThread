// Pure pieces of the Repricing queue: what a refused Apply says, how a big
// selection is split for the server, and which rows an Undo may touch. Kept out
// of the hook and the page so they can be tested without a network or a DOM.

/** Why the server refused a single-row Apply before anything reached eBay. */
export type ApplyRefusal =
  | "not_pending"
  | "listing_not_active"
  | "price_changed"
  | "below_margin_floor";

const REFUSAL_COPY: Record<ApplyRefusal, string> = {
  not_pending: "This suggestion was already applied or dismissed.",
  listing_not_active: "This listing is no longer live, so its price can't change.",
  price_changed: "Price changed since the scan. Scan this item again.",
  below_margin_floor: "That price is under this item's floor, so it was not applied.",
};

/** A plain sentence for a refusal, or null when the reason is not one we know. */
export function applyRefusalMessage(reason: unknown): string | null {
  return typeof reason === "string" && Object.prototype.hasOwnProperty.call(REFUSAL_COPY, reason)
    ? REFUSAL_COPY[reason as ApplyRefusal]
    : null;
}

/** The server applies at most this many rows per request. */
export const MAX_REPRICE_PER_REQUEST = 50;

/** Split a selection into requests the server will take whole, in order. */
export function chunkRepriceItems<T>(items: T[], size = MAX_REPRICE_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface AppliedRow {
  listing_id: string;
  old_price_cents: number;
  new_price_cents: number;
}

/**
 * The prices an Undo writes back: only rows the server says it changed, at the
 * price it says it replaced. A skipped or failed row never moved, so putting it
 * "back" would be a new price change the seller did not ask for.
 */
export function undoPriors(
  applied: AppliedRow[],
): Array<{ listing_id: string; price_cents: number }> {
  return applied
    .filter((r) => r.old_price_cents !== r.new_price_cents)
    .map((r) => ({ listing_id: r.listing_id, price_cents: r.old_price_cents }));
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The scan toast. Rows the server could not check are said out loud. */
export function scanSummary(r: { scanned?: number; actionable?: number; errors?: number }): string {
  const parts = [
    `Scanned ${plural(r.scanned ?? 0, "listing", "listings")}.`,
    `${plural(r.actionable ?? 0, "repricing nudge", "repricing nudges")}.`,
  ];
  const errors = r.errors ?? 0;
  if (errors > 0) {
    parts.push(`${plural(errors, "listing", "listings")} could not be checked.`);
  }
  return parts.join(" ");
}

export interface ChunkApplyResult {
  applied: number;
  ebay_synced: number;
  skipped: Array<{ listing_id: string; reason: string }>;
  errors: Array<{ listing_id: string; message: string }>;
  applied_rows: AppliedRow[];
  not_processed: string[];
}

/**
 * Send a selection in server-sized requests, one after another, and merge the
 * answers. A request that throws marks its own rows failed and the rest still
 * run, so one bad chunk never hides what the others did.
 */
export async function runChunkedApply<T extends { listing_id: string }>(
  items: T[],
  send: (chunk: T[]) => Promise<Partial<ChunkApplyResult>>,
  onProgress?: (done: number, total: number) => void,
): Promise<ChunkApplyResult> {
  const merged: ChunkApplyResult = {
    applied: 0,
    ebay_synced: 0,
    skipped: [],
    errors: [],
    applied_rows: [],
    not_processed: [],
  };
  let done = 0;
  for (const chunk of chunkRepriceItems(items)) {
    onProgress?.(Math.min(done + chunk.length, items.length), items.length);
    try {
      const r = await send(chunk);
      merged.applied += r.applied ?? 0;
      merged.ebay_synced += r.ebay_synced ?? 0;
      merged.skipped.push(...(r.skipped ?? []));
      merged.errors.push(...(r.errors ?? []));
      merged.applied_rows.push(...(r.applied_rows ?? []));
      merged.not_processed.push(...(r.not_processed ?? []));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      merged.errors.push(...chunk.map((c) => ({ listing_id: c.listing_id, message })));
    }
    done += chunk.length;
  }
  return merged;
}

/** "+12%" or "-8%": the change a nudge suggests, signed. Null with no base. */
export function changeLabel(s: {
  current_price_cents: number;
  suggested_price_cents: number;
}): string | null {
  if (s.current_price_cents <= 0) return null;
  const pct = Math.round(
    ((s.suggested_price_cents - s.current_price_cents) / s.current_price_cents) * 100,
  );
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

/** The three counts at the top of the Repricing queue. */
export function queueCounts(rows: Array<{ reason_code: string }>) {
  let raise = 0;
  let lower = 0;
  for (const s of rows) {
    if (s.reason_code === "UNDERPRICED") raise++;
    else if (s.reason_code === "OVERPRICED" || s.reason_code === "STALE") lower++;
  }
  return { total: rows.length, raise, lower };
}
