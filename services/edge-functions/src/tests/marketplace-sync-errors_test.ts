// US-2324: the Etsy and Depop syncs must not report success over failures.
//
// Both loops were three lines: call the handler, add its counters, move on. The
// handler NEVER throws — it collects per-record failures into `res.errors` —
// and nothing read that field, so a receipt that failed to write was
// indistinguishable from one that succeeded and the endpoint still answered
// `ok: true`. A seller reconciling their books had no way to know a sale was
// missing.
//
// The second defect only shows up under load: no per-record try/catch, so one
// unexpected throw at record 200 abandoned 201-500. Neither sync keeps a
// cursor — every run restarts from the beginning — so the next attempt reaches
// the same poison record and dies in the same place. Permanently stuck, while
// reporting a 502 that looks transient.
//
// A SOURCE SCAN is the right shape here and it is worth saying why, since a
// behavioural test would normally be better. Both connectors are gated behind
// env kill-switches that default to FALSE (`isEtsyEnabled` / `isDepopEnabled`),
// so there is no way to drive these handlers end-to-end in CI — and the story
// exists precisely so this is fixed BEFORE anyone turns them on. What can be
// checked without a live connector is the shape of the loop, and the shape is
// where both defects lived.

import { assert } from "@std/assert";

const ROUTES = new URL("../routes/", import.meta.url);

async function source(file: string): Promise<string> {
  return await Deno.readTextFile(new URL(file, ROUTES));
}

interface SyncCase {
  file: string;
  /** The handler whose per-record errors were being dropped. */
  handler: string;
  marketplace: string;
}

const SYNCS: readonly SyncCase[] = [
  {
    file: "flipdesk-etsy.ts",
    handler: "handleEtsyReceiptEvent",
    marketplace: "etsy",
  },
  {
    file: "flipdesk-depop.ts",
    handler: "handleDepopOrderEvent",
    marketplace: "depop",
  },
];

/** The sync loop plus everything up to its response. */
function syncBlock(src: string, handler: string): string {
  // Anchor on the CALL, not the name: the handler is imported at the top of
  // the file, so indexOf(handler) lands in the import statement, where there is
  // no enclosing try and the bounds come out nonsense.
  const at = src.indexOf(`await ${handler}(`);
  assert(at > -1, `${handler} is never called — was the sync renamed?`);
  // Bound by the LOOP and its response, not by try/catch. The fix added a
  // per-record try INSIDE the loop, so "the nearest enclosing try" now finds
  // that one and yields a block containing neither the loop header nor the
  // response — the bounds have to survive the change they are checking.
  const start = src.lastIndexOf("for (const", at);
  assert(start > -1, `no loop found around ${handler}`);
  const respAt = src.indexOf("return c.json(", at);
  assert(respAt > start, `no response found after ${handler}`);
  const end = src.indexOf("});", respAt);
  assert(end > respAt, `could not find the end of the ${handler} response`);
  return src.slice(start, end + 3);
}

for (const s of SYNCS) {
  Deno.test(`US-2324: ${s.marketplace} sync READS the handler's per-record errors`, async () => {
    const block = syncBlock(await source(s.file), s.handler);
    // The exact defect: res.errors existed and was never consumed.
    assert(
      /res\.errors/.test(block),
      `${s.file} ignores res.errors again — failed records become invisible`,
    );
  });

  Deno.test(`US-2324: ${s.marketplace} sync isolates each record`, async () => {
    const block = syncBlock(await source(s.file), s.handler);
    // The try must be INSIDE the loop. An outer-only try means one bad record
    // costs every record behind it, and with no cursor that repeats forever.
    const loopAt = block.indexOf("for (const");
    const tryAt = block.indexOf("try {", loopAt);
    assert(loopAt > -1, "the per-record loop is gone");
    assert(
      tryAt > loopAt && tryAt < block.indexOf(`await ${s.handler}(`, loopAt),
      `${s.file} no longer wraps each record — one failure abandons the tail`,
    );
  });

  Deno.test(`US-2324: ${s.marketplace} sync does not claim ok over failures`, async () => {
    const block = syncBlock(await source(s.file), s.handler);
    assert(
      /ok:\s*failures\.length === 0/.test(block),
      `${s.file} reports ok:true regardless of per-record failures`,
    );
    assert(
      /failed:\s*failures\.length/.test(block) && /errors:\s*failures/.test(block),
      `${s.file} no longer surfaces the failures to the caller`,
    );
  });

  Deno.test(`US-2324: ${s.marketplace} watermark only advances on a clean pass`, async () => {
    // Whole file: the stamp sits between the loop and the response, so the
    // loop-bounded block above would clip it either way.
    const block = await source(s.file);
    // Same rule US-2320 established for eBay orders: stamping last_synced_at
    // after partial failures converts "some records did not land" into "they
    // never will", because the next incremental pull starts after them.
    const guardAt = block.indexOf("if (failures.length === 0)");
    const stampAt = block.indexOf("last_synced_at");
    assert(guardAt > -1, `${s.file} stamps the watermark unconditionally again`);
    assert(
      stampAt > guardAt,
      `${s.file} stamps last_synced_at outside the clean-pass guard`,
    );
  });
}

Deno.test("US-2324: both syncs are covered, so this file cannot rot to one", () => {
  assert(SYNCS.length === 2, "a sync was dropped from the case list");
});
