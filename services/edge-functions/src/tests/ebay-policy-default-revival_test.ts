import "./_env.ts";
import { assert, assertEquals } from "@std/assert";

// US-2855 AC2: a stored default policy that no longer exists on eBay.
//
// THE DEFECT WAS WORSE THAN THE STORY DESCRIBED, and the shape is why.
// syncBusinessPolicies decided `is_default` with
//
//     existingDefault ? existingDefault === id : isFirst
//
// so when the seller DELETED the policy their stored default points at,
// `existingDefault` was still set and matched nothing eBay returned. No row of
// that kind got is_default -- and the stale row kept it, because the upsert
// only writes ids eBay DID return. readCachedDefaults selects on is_default and
// does not check that the policy still exists, so publish sent a dead policy id
// to eBay. The story predicted a "Configure eBay business policies" blocker;
// that only happens when the kind has no policies at all.
//
// WHAT THIS FILE CAN AND CANNOT COVER. The sync itself talks to eBay and to the
// database, so the cases below drive the pure decision -- given the ids eBay
// still has and the stored default, which policy should carry is_default and
// which kinds were replaced -- against a copy of the rule. That is the half
// that was wrong. The write path (clearing the dead row, the upsert) is covered
// by the tenant-isolation and money lanes, which need the full stack.

type Kind = "fulfillment" | "payment" | "return";

/**
 * The rule as ebay-client.ts now applies it. Kept in step with the source by
 * the assertion at the bottom of this file, which reads the real thing.
 */
function decide(
  liveIds: readonly string[],
  storedDefault: string | undefined,
): { defaultId: string | null; replaced: boolean } {
  if (liveIds.length === 0) return { defaultId: null, replaced: false };
  const alive = storedDefault != null && liveIds.includes(storedDefault);
  if (alive) return { defaultId: storedDefault!, replaced: false };
  return {
    defaultId: liveIds[0]!,
    replaced: storedDefault != null,
  };
}

Deno.test("US-2855: a stored default that still exists is kept", () => {
  const r = decide(["A", "B", "C"], "B");
  assertEquals(r.defaultId, "B");
  assertEquals(r.replaced, false, "nothing was replaced, so nobody should be told");
});

Deno.test("US-2855: a deleted default falls back to the account's first policy", () => {
  const r = decide(["A", "B"], "GONE");
  assertEquals(r.defaultId, "A", "the account's first policy of the kind");
  assertEquals(r.replaced, true, "the seller is told once");
});

Deno.test("US-2855: a seller who never chose a default still gets one", () => {
  const r = decide(["A", "B"], undefined);
  assertEquals(r.defaultId, "A");
  assertEquals(
    r.replaced,
    false,
    "never chosen is not the same as replaced -- telling them would be noise",
  );
});

Deno.test("US-2855: a kind with no policies at all reports nothing to replace", () => {
  // This is the case that DOES belong in the missing[] blocker: the seller has
  // no policy of this kind on eBay, and no fallback can invent one.
  const r = decide([], "GONE");
  assertEquals(r.defaultId, null);
  assertEquals(r.replaced, false);
});

Deno.test("US-2855: the source applies this rule, not the old one", () => {
  const src = Deno.readTextFileSync(
    new URL("../lib/ebay-client.ts", import.meta.url),
  );
  // The old rule honoured a stored default without checking it still exists.
  assert(
    src.includes("deadDefaults.has(kind)"),
    "push() must skip a stored default that eBay no longer has",
  );
  assert(
    src.includes("!live.has(stored)"),
    "the liveness test must be present",
  );
  // The dead row has to stop claiming is_default, or it outranks the
  // replacement in readCachedDefaults whatever push() decided.
  assert(
    src.includes('.update({ is_default: false })'),
    "the dead default row must be cleared",
  );
  // US-1552: never a logical operator on a mutation against this PostgREST.
  const clearBlock = src.slice(
    src.indexOf("for (const [kind, deadId] of deadDefaults)"),
    src.indexOf("// Persist the merchant location"),
  );
  assert(clearBlock.length > 0, "the clearing block moved -- repin this");
  assert(!clearBlock.includes(".or("), "US-1552: no .or() on an UPDATE");
  assert(
    clearBlock.includes('.eq("user_id", userId)'),
    "US-268: the clear must be tenant-scoped",
  );
});
