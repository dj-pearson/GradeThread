// US-3413: the payout-link pass.
//
// The pure half is payoutIdsByOrder, and it carries the rule that matters: a
// transaction whose payout has not settled must never produce an entry. The
// whole defect this story fixes is a null payout id being written over nothing
// and never revisited, so a map that carries nulls is the same bug one layer up.

// US-2379: first import. cron-runs.ts reaches lib/supabase.ts, which reads its
// env at module load, so without this the file only passes when some other test
// happened to run before it.
import "./_env.ts";
import { assertEquals } from "@std/assert";
import { payoutIdsByOrder } from "../lib/ebay-payout-link.ts";
import { CRON_REGISTRY } from "../lib/cron-runs.ts";

Deno.test("payoutIdsByOrder keeps only settled transactions", () => {
  const map = payoutIdsByOrder([
    { orderId: "order-1", payoutId: "P1" },
    { orderId: "order-2", payoutId: null },
    { orderId: null, payoutId: "P2" },
  ]);
  assertEquals(map.size, 1);
  assertEquals(map.get("order-1"), "P1");
  assertEquals(map.has("order-2"), false);
});

Deno.test("payoutIdsByOrder trims whitespace on both sides", () => {
  const map = payoutIdsByOrder([{ orderId: "  order-1 ", payoutId: " P1 " }]);
  assertEquals(map.get("order-1"), "P1");
});

Deno.test("payoutIdsByOrder treats an empty string as unsettled", () => {
  // eBay returns "" rather than null in some responses. An empty payout id is
  // not an id, and writing it would make the sale look settled against nothing.
  const map = payoutIdsByOrder([
    { orderId: "order-1", payoutId: "" },
    { orderId: "", payoutId: "P1" },
  ]);
  assertEquals(map.size, 0);
});

Deno.test("payoutIdsByOrder keeps the first settled id for a split order", () => {
  // A multi-line order settles in one payout in practice. If eBay ever splits
  // one, the first is still a true answer; overwriting on each pass would make
  // the report flicker between two ids for the same sale.
  const map = payoutIdsByOrder([
    { orderId: "order-1", payoutId: "P1" },
    { orderId: "order-1", payoutId: "P2" },
  ]);
  assertEquals(map.get("order-1"), "P1");
});

Deno.test("ebay-payout-link is registered and recorded", () => {
  const job = CRON_REGISTRY.find((j) => j.name === "ebay-payout-link");
  if (!job) throw new Error("ebay-payout-link missing from CRON_REGISTRY");
  assertEquals(job.endpoint, "/api/jobs/ebay-payout-link");
  assertEquals(job.recorded, true);
  // A job with no healthy-response description is one nobody can tell is
  // broken; the fleet alert reads this field.
  if (!job.healthy) throw new Error("ebay-payout-link needs a healthy: description");
});

Deno.test("ebay-payout-link runs after reconciliation-sweep", () => {
  // Both touch sales rows for the same owners. Ordering them apart is
  // deliberate, so a change to either schedule has to notice the other.
  const link = CRON_REGISTRY.find((j) => j.name === "ebay-payout-link")!;
  const sweep = CRON_REGISTRY.find((j) => j.name === "reconciliation-sweep")!;
  const minuteOf = (schedule: string) => {
    const [m, h] = schedule.split(" ");
    return Number(h) * 60 + Number(m);
  };
  if (minuteOf(link.schedule) <= minuteOf(sweep.schedule)) {
    throw new Error(
      `ebay-payout-link (${link.schedule}) must run after reconciliation-sweep (${sweep.schedule})`,
    );
  }
});
