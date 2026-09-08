// US-3136: pooled sold comps — the rules that protect sellers, not the SQL.
//
// The k-anonymity floors live in the pooled_sold_comps() SQL function and are
// proven against the real database in 00762's dry run. What is testable here is
// the TypeScript contract around them: that the wrapper adds no floor of its
// own, that the pool never outranks a seller's own sales, and that its
// confidence is capped below what the same sample size would earn privately.
import "./_env.ts";
import { assertEquals } from "@std/assert";
import {
  POOLED_CONFIDENCE_CAP,
  pooledConfidenceFromCount,
  realizedRangeFromPrices,
  soldConfidenceFromCount,
} from "../lib/sold-comps.ts";

Deno.test("pooled comps are capped below a seller's own sales at equal count", () => {
  // Exercise the SHIPPED function. An earlier version of this test computed
  // Math.min(...) itself and passed with the cap deleted from the code, which
  // made it a test of arithmetic wearing a policy label.
  assertEquals(pooledConfidenceFromCount(10), POOLED_CONFIDENCE_CAP);
  assertEquals(pooledConfidenceFromCount(500), POOLED_CONFIDENCE_CAP);
  assertEquals(
    soldConfidenceFromCount(10) > pooledConfidenceFromCount(10),
    true,
    "ten of the seller's own sales must beat any size of pool",
  );
  // Below the cap the pool tracks the normal curve rather than being flattened.
  assertEquals(pooledConfidenceFromCount(3), soldConfidenceFromCount(3));
  assertEquals(pooledConfidenceFromCount(0), 0);
});

Deno.test("a pooled source is a distinct, labelled provenance", () => {
  // The UI has to be able to say WHERE a price came from. If pooled rows were
  // labelled private_sales, a seller would read other people's numbers as their
  // own track record.
  const r = realizedRangeFromPrices([40, 45, 50], "USD", "pooled_sales");
  assertEquals(r?.source, "pooled_sales");
  const own = realizedRangeFromPrices([40, 45, 50], "USD", "private_sales");
  assertEquals(own?.source, "private_sales");
});

Deno.test("the thin-sample rule still applies to pooled prices", () => {
  // Two prices is not a median, whatever the source.
  assertEquals(realizedRangeFromPrices([40, 50], "USD", "pooled_sales"), null);
  assertEquals(
    realizedRangeFromPrices([40, 45, 50], "USD", "pooled_sales") !== null,
    true,
  );
});

Deno.test("consent is not represented in code — it is read live in SQL", async () => {
  // A regression guard with a specific fear behind it: someone caching the
  // opt-in list, or copying opted-in rows into a pool table. Either would mean
  // a seller who revokes consent keeps contributing. The wrapper must carry no
  // opt-in logic at all; the only mention of consent belongs in the migration.
  const src = await Deno.readTextFile(
    new URL("../lib/sold-comps.ts", import.meta.url),
  );
  const body = src.slice(src.indexOf("export async function getPooledSalesComps"));
  assertEquals(
    /pooled_comps_opt_in/.test(body),
    false,
    "the opt-in flag must not be read or cached in TypeScript",
  );
  assertEquals(
    /\.from\(["']sales["']\)/.test(body),
    false,
    "pooled comps must go through the RPC, never straight at the sales table",
  );
  assertEquals(
    /rpc\(\s*["']pooled_sold_comps["']/.test(body),
    true,
    "pooled comps must call the SQL function that owns the thresholds",
  );
});

Deno.test("the pool is the LAST rung, below the seller's own sales", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/sold-comps.ts", import.meta.url),
  );
  const ladder = src.slice(
    src.indexOf("export async function getRealizedComps"),
  );
  const ebay = ladder.indexOf("searchSoldComps");
  const own = ladder.indexOf("getPrivateSalesComps");
  const pool = ladder.indexOf("getPooledSalesComps");
  assertEquals(ebay < own, true, "eBay sold data comes first");
  assertEquals(
    own < pool,
    true,
    "the seller's own sales must be consulted before other people's",
  );
});
