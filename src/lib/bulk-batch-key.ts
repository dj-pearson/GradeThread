// US-2564: a stable, bounded charge token for a bulk grading submit.
//
// Grading is billed per garment, so a retried batch must charge once per
// garment, not once per attempt. The edge derives its idempotency key from
// `batch_key` plus the item id (lib/grade-billing.ts bulkChargeKey), which means
// `batch_key` has to be:
//
//   • STABLE across retries of the same submit — a fresh `crypto.randomUUID()`
//     per attempt is the defect, not the fix. A failed submit is the thing a
//     seller retries hardest.
//   • DIFFERENT for a different selection or tier, or a legitimate second batch
//     would be silently suppressed as a duplicate.
//   • UNDER 255 CHARACTERS. The obvious version — join the sorted item ids —
//     is ~37 bytes per item and 7.4 KB at the 200-item cap, which the request
//     schema rejects outright. So the id set is DIGESTED, not carried.
//
// Digested synchronously, because this runs inside a `useMemo` during render and
// `crypto.subtle.digest` is async. FNV-1a is not a cryptographic hash and does
// not need to be — nothing here is a secret and nothing is adversarial. What it
// does need is a collision rate low enough that two different selections by the
// same seller never share a token, because that would suppress a real charge and
// silently drop a garment from a batch.
//
// Two independently-seeded 32-bit passes plus the item COUNT give ~64 bits of
// discrimination against selections that already differ in content. One 32-bit
// pass alone would put a seller with a few thousand distinct batches inside
// birthday range, which is the wrong side of "never" for money.

const FNV_PRIME = 0x01000193;

function fnv1a(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

function hex(n: number): string {
  return n.toString(16).padStart(8, "0");
}

/**
 * A deterministic token for (item set, tier). Order-insensitive: the same
 * garments selected in a different order are the same batch and must not be
 * charged twice.
 *
 * Returns null for an empty selection — there is nothing to charge, and a token
 * for "no items" would be shared by every empty batch.
 */
export function bulkBatchKey(
  inventoryItemIds: readonly string[],
  tier: string,
): string | null {
  if (inventoryItemIds.length === 0) return null;
  // Sort a COPY. Sorting the caller's array in place would reorder the list the
  // UI is rendering from.
  const canonical = `${tier}|${[...inventoryItemIds].sort().join(",")}`;
  return [
    "fdbulk",
    inventoryItemIds.length,
    hex(fnv1a(canonical, 0x811c9dc5)),
    hex(fnv1a(canonical, 0x9e3779b9)),
  ].join("-");
}
