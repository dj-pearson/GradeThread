// Pure array chunking (US-1911). Splits a list into consecutive slices of at
// most `size`, preserving order and never losing or duplicating an element.
// Used to keep client requests under a server per-request cap (e.g. the
// AutoLister /photo-qa endpoint rejects >100 covers/items per call, but a
// batch can hold up to 300) so a large session is scored across several
// sequential requests instead of failing whole.
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunk size must be a positive integer, got ${size}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
