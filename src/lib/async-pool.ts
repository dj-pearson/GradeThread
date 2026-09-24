/**
 * Run `fn` over `items` with at most `limit` calls in flight, and return the
 * results in INPUT order whatever order they finish in.
 *
 * The photo board used to read capture times, compress and upload one photo
 * at a time, so a 200-photo haul sat behind one spinner for minutes. Four at
 * once is enough to overlap the network with the canvas work without flooding
 * a phone's memory with decoded images.
 *
 * A rejection from `fn` rejects the pool, like Promise.all; callers that want
 * per-item failures catch inside `fn`.
 */
export async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
