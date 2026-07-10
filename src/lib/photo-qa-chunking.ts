import { chunk } from "./chunk";

// US-1911: the AutoLister /photo-qa endpoint caps a single request at 100
// covers/items (MAX_QA_ITEMS in flipdesk-autolister.ts), but a batch can hold
// up to MAX_BATCH_ITEMS=300. Sending everything in one request 400s past 100 —
// cover QA (advisory) silently never scores, and the queue path shows one
// all-or-nothing error toast. This shared orchestrator chunks the work to the
// cap and issues the chunks SEQUENTIALLY (so the server's shared vision rate
// limiter isn't hammered), merging results as each chunk resolves.
export const MAX_QA_ITEMS = 100;

export interface ChunkedQaOutcome<TItem, TResult> {
  /** Results merged, in order, across every chunk whose request succeeded. */
  results: TResult[];
  /** Items belonging to chunks whose request failed — never scored, so a later
   *  pass can retry them. Order preserved. */
  failed: TItem[];
}

/**
 * Run `fetchChunk` over `items` in sequential slices of at most `maxPerRequest`.
 *
 * A chunk whose fetch rejects contributes its items to `failed` but does NOT
 * abort the remaining chunks — one bad chunk never poisons the rest. Partial
 * results are surfaced via `onPartial` as each chunk resolves so callers can
 * merge incrementally.
 */
export async function runChunkedQa<TItem, TResult>(
  items: readonly TItem[],
  fetchChunk: (batch: TItem[]) => Promise<TResult[]>,
  opts: {
    maxPerRequest?: number;
    onPartial?: (chunkResults: TResult[]) => void;
    onChunkError?: (err: unknown, batch: TItem[]) => void;
  } = {},
): Promise<ChunkedQaOutcome<TItem, TResult>> {
  const size = opts.maxPerRequest ?? MAX_QA_ITEMS;
  const results: TResult[] = [];
  const failed: TItem[] = [];
  for (const batch of chunk(items, size)) {
    try {
      const chunkResults = await fetchChunk(batch);
      results.push(...chunkResults);
      opts.onPartial?.(chunkResults);
    } catch (err) {
      failed.push(...batch);
      opts.onChunkError?.(err, batch);
    }
  }
  return { results, failed };
}
