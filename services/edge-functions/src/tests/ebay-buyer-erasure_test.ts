// US-3042: the eBay buyer erasure, and the guard that keeps it complete.
//
// The decay this file exists to prevent: somebody adds a fifth table with a
// buyer_username column, ships it, and the account-deletion handler goes on
// returning a clean acknowledgement while leaving that person's data behind.
// Nothing about that failure is visible — the handler still succeeds, the
// compliance log still fills in, and only an eBay audit would find it.
//
// So the coverage test does not read a hand-maintained list. It reads the
// MIGRATIONS, finds every table that declares a buyer identity column, and
// fails if one is not covered by BUYER_ERASURE_TARGETS.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  applicableMatches,
  BUYER_ERASURE_TARGETS,
  type BuyerErasureTarget,
  erasurePatch,
  redactionMarker,
} from "../lib/ebay-buyer-erasure.ts";

const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);

function target(name: string): BuyerErasureTarget {
  const t = BUYER_ERASURE_TARGETS.find((x) => x.table === name);
  assert(t, `no erasure target for ${name}`);
  return t;
}

Deno.test("coverage: every table with an eBay buyer column is erased", async () => {
  // Find `CREATE TABLE public.x (...)` blocks declaring buyer_username, plus
  // ALTER TABLE ... ADD COLUMN buyer_username / buyer_id.
  const found = new Set<string>();
  for await (const entry of Deno.readDir(MIGRATIONS)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const sql = await Deno.readTextFile(new URL(entry.name, MIGRATIONS));
    // Strip line comments so prose about buyer_username does not count as a
    // column declaration. Several migrations discuss it at length.
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

    for (const m of code.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.(\w+)\s*\(([\s\S]*?)\n\);/gi,
    )) {
      const [, table, body] = m;
      if (/\bbuyer_username\b/i.test(body ?? "")) found.add(table!);
    }
    for (const m of code.matchAll(
      /ALTER\s+TABLE\s+public\.(\w+)([\s\S]*?);/gi,
    )) {
      const [, table, body] = m;
      if (/ADD\s+COLUMN[\s\S]*?\bbuyer_username\b/i.test(body ?? "")) {
        found.add(table!);
      }
    }
  }

  assert(found.size > 0, "the migration scan found nothing — the regex has rotted");

  const covered = new Set(BUYER_ERASURE_TARGETS.map((t) => t.table));
  const missing = [...found].filter((t) => !covered.has(t)).sort();
  assertEquals(
    missing,
    [],
    `these tables hold eBay buyer identity and are NOT erased on account ` +
      `deletion: ${missing.join(", ")}. Add them to BUYER_ERASURE_TARGETS in ` +
      `lib/ebay-buyer-erasure.ts.`,
  );
});

Deno.test("coverage: raw eBay payloads are redacted, not left naming the person", () => {
  // Nulling buyer_username while leaving eBay's own order/case/offer payload in
  // place is an erasure that reads as done and is not. Every target carrying a
  // `raw` column must redact it.
  for (const t of BUYER_ERASURE_TARGETS) {
    if (t.table === "sales") continue; // sales has no raw payload column
    assert(
      t.redactJsonColumns.includes("raw"),
      `${t.table} keeps its raw eBay payload after erasure`,
    );
  }
});

Deno.test("every buyer match is a username, because that is all eBay gives us", () => {
  // THE TRAP THIS PINS. The seller side matches on a stable external_account_id
  // and keeps the handle as a legacy fallback, so the obvious move here is to
  // treat `sales.buyer_id` the same way. It is not an id: it is written with
  // `order.buyerUsername` (flipdesk-ebay.ts, orphan-sale-match.ts), because
  // eBay's order payload carries no durable buyer identifier. Declaring it as a
  // `userId` match compares a username against a user id, so it never fires and
  // the rows are never erased — with no error anywhere.
  for (const t of BUYER_ERASURE_TARGETS) {
    for (const m of t.matchColumns) {
      assertEquals(
        m.source,
        "username",
        `${t.table}.${m.column} claims to match on a stable eBay user id. ` +
          `Order payloads carry no such id; check what actually writes that ` +
          `column before changing this.`,
      );
    }
  }
  // And both of the sales columns are covered, not just the obvious one.
  assertEquals(
    target("sales").matchColumns.map((m) => m.column).sort(),
    ["buyer_id", "buyer_username"],
  );
});

Deno.test("the seller's own note about the buyer is erased too", () => {
  // buyer_notes is written by the seller, but it is a note about this person
  // and keyed to them. Leaving it is leaving a profile of a deleted account.
  assert(target("sales").nullColumns.includes("buyer_notes"));
  assert(target("sales").nullColumns.includes("buyer_id"));
});

Deno.test("applicableMatches: a username erases both of the sales columns", () => {
  // `sales` records the same handle twice, in `buyer_username` and in the
  // misnamed `buyer_id`. Both clauses have to run: nulling one and leaving the
  // other is an erasure that still names the person.
  const sales = target("sales");
  assertEquals(applicableMatches(sales, { username: "shopper_99" }), [
    { column: "buyer_username", value: "shopper_99" },
    { column: "buyer_id", value: "shopper_99" },
  ]);

  // A userId in the payload changes nothing here, because no column holds one.
  assertEquals(
    applicableMatches(sales, { userId: "u-1", username: "shopper_99" }).length,
    2,
  );
  assertEquals(applicableMatches(sales, { userId: "u-1" }), []);
});

Deno.test("applicableMatches: nothing usable means no update is attempted", () => {
  // An UPDATE with an empty match value would match every row with an empty
  // string in that column, which on a nullable text column is a mass erasure.
  const sales = target("sales");
  assertEquals(applicableMatches(sales, {}), []);
  assertEquals(applicableMatches(sales, { username: "" }), []);
  assertEquals(applicableMatches(sales, { username: "   " }), []);
  assertEquals(applicableMatches(sales, { userId: null, username: null }), []);
});

Deno.test("applicableMatches: identifiers are trimmed before they reach a query", () => {
  assertEquals(
    applicableMatches(target("marketplace_offers"), { username: "  shopper_99  " }),
    [{ column: "buyer_username", value: "shopper_99" }],
  );
});

Deno.test("erasurePatch: nulls the identity columns and marks the payload", () => {
  const now = new Date("2026-09-01T12:00:00Z");
  const patch = erasurePatch(target("marketplace_offers"), now);
  assertEquals(patch.buyer_username, null);
  assertEquals(patch.raw, {
    redacted: true,
    reason: "ebay_marketplace_account_deletion",
    redacted_at: "2026-09-01T12:00:00.000Z",
  });
});

Deno.test("the redaction marker is distinguishable from an empty payload", () => {
  // `{}` would be indistinguishable from a row whose sync never populated raw,
  // so an erasure would be unprovable six months later — which is exactly what
  // a compliance audit asks us to prove.
  const marker = redactionMarker();
  assertEquals(marker.redacted, true);
  assertEquals(marker.reason, "ebay_marketplace_account_deletion");
  assert(typeof marker.redacted_at === "string");
});

Deno.test("the sale row itself survives the erasure", () => {
  // We remove the person, not the transaction. Deleting the sale would destroy
  // a third party's accounting record to satisfy a request about someone else.
  for (const t of BUYER_ERASURE_TARGETS) {
    const patch = erasurePatch(t);
    for (const money of ["sale_price", "amount_cents", "platform_fees", "sale_date"]) {
      assert(!(money in patch), `${t.table} erasure touches ${money}`);
    }
  }
});
