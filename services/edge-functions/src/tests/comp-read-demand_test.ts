// US-2845 AC2 + AC3: the queue is fed by demand, and there is no crawler.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  type DemandClient,
  demandCounters,
  recordCompDemand,
  resetDemandCounters,
  toDemandUpsert,
} from "../lib/comp-read-demand.ts";

const NOW_ISO = "2026-08-25T12:00:00.000Z";

Deno.test("a cell with no category never enters the queue", () => {
  // The Browse search needs one, so a row without it could never be served and
  // would sit at the top of the demand list forever.
  assertEquals(toDemandUpsert({ categoryId: "" }, NOW_ISO), null);
  assertEquals(toDemandUpsert({ categoryId: "   " }, NOW_ISO), null);
});

Deno.test("the row carries the cell and nothing about who asked", () => {
  const row = toDemandUpsert(
    { categoryId: "11450", brand: " Patagonia ", q: " Better Sweater " },
    NOW_ISO,
  )!;
  assertEquals(row.cell_key, "patagonia|11450|better sweater");
  assertEquals(row.brand, "Patagonia");
  assertEquals(row.query, "Better Sweater");
  for (const key of Object.keys(row)) {
    for (const leak of ["user", "owner", "tenant", "workspace", "seller", "submission"]) {
      assert(!key.includes(leak), `the demand row carries ${key}`);
    }
  }
});

Deno.test("an empty brand and query become null, not empty strings", () => {
  const row = toDemandUpsert({ categoryId: "11450", brand: "  ", q: "" }, NOW_ISO)!;
  assertEquals(row.brand, null);
  assertEquals(row.query, null);
});

function client(
  onCall: (fn: string, args: Record<string, unknown>) => void = () => {},
  error: { message: string } | null = null,
): DemandClient {
  return {
    rpc: (fn, args) => {
      onCall(fn, args);
      return Promise.resolve({ error });
    },
  };
}

Deno.test("recording goes through the atomic increment, not a read-modify-write", () => {
  // Two replicas serving two sellers in the same second would each read 4 and
  // each write 5, under-counting exactly the cells that are busiest.
  const calls: Array<[string, Record<string, unknown>]> = [];
  return recordCompDemand(
    { categoryId: "11450", brand: "Patagonia", q: "Better Sweater" },
    client((fn, args) => calls.push([fn, args])),
    () => Date.parse(NOW_ISO),
  ).then((ok) => {
    assertEquals(ok, true);
    assertEquals(calls.length, 1);
    assertEquals(calls[0][0], "comp_read_demand_touch");
    assertEquals(calls[0][1].p_cell_key, "patagonia|11450|better sweater");
  });
});

Deno.test("a cell with no category is skipped without touching the database", async () => {
  resetDemandCounters();
  let called = 0;
  const ok = await recordCompDemand({ categoryId: "" }, client(() => called++));
  assertEquals(ok, false);
  assertEquals(called, 0);
  assertEquals(demandCounters().skipped, 1);
});

Deno.test("a write failure is swallowed and counted, never thrown at a seller", async () => {
  resetDemandCounters();
  const ok = await recordCompDemand(
    { categoryId: "11450" },
    client(() => {}, { message: "db down" }),
  );
  assertEquals(ok, false);
  assertEquals(demandCounters().failed, 1);
});

Deno.test("a throw is swallowed and counted too", async () => {
  resetDemandCounters();
  const exploding: DemandClient = {
    rpc: () => {
      throw new Error("boom");
    },
  };
  assertEquals(await recordCompDemand({ categoryId: "11450" }, exploding), false);
  assertEquals(demandCounters().failed, 1);
  resetDemandCounters();
});
