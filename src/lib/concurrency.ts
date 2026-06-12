// Shared sliding-window concurrency runner (US-539). Unlike the chunked
// `Promise.all` batching used elsewhere, a new task starts the moment a lane
// frees up — one slow item never stalls the rest of the batch, which matters
// for 100-photo uploads where file sizes (and network times) vary wildly.
//
// Rejections from `fn` propagate and abort the whole run; callers that want
// per-item error handling (the upload pipeline does) must catch inside `fn`.

export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next++;
        await fn(items[index] as T, index);
      }
    },
  );
  await Promise.all(lanes);
}
