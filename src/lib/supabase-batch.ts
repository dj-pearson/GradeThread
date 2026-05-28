// Batched `.in(column, ids)` fetches.
//
// PostgREST encodes `.in(col, [...])` as a query string. With a few hundred
// UUIDs the URL exceeds the server/proxy length limit and the whole request
// fails (net::ERR_FAILED / 414) — so any "fetch rows for all of a user's
// items" query silently breaks once inventory grows. Splitting the id list
// into chunks keeps each URL well under the limit; results are concatenated.

const DEFAULT_CHUNK_SIZE = 100;

export async function fetchInChunks<Row>(
  ids: readonly string[],
  fetchChunk: (
    chunk: string[],
  ) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const { data, error } = await fetchChunk(ids.slice(i, i + chunkSize));
    if (error) throw new Error(error.message);
    if (data) out.push(...(data as Row[]));
  }
  return out;
}
