// US-3111 AC3: the bulk stamps must not overflow the PostgREST request line.
//
// THE OUTAGE THIS CLOSES, measured on prod 2026-09-13 from the edge container
// log:
//
//     [flipdesk-ebay] failed to stamp ebay_offer_checked_at: URI too long
//     [flipdesk-ebay] failed to stamp ebay_specifics_checked_at: URI too long
//
// on every catalog pass since US-3362 deployed. The newest
// inventory_items.ebay_offer_checked_at in production was 40 hours old, so the
// 24-hour recheck window US-3111 exists to enforce had reverted to the full
// per-SKU fan-out it replaced - silently, because AC4's fail-open is doing
// exactly what it promised and a console.error is not a page.
//
// The cause is a unit mismatch, and it is the interesting part. US-3111 chunked
// at 400 rows, which was safe for SKUs: `FD-1a2b3c4d` costs 14 characters with
// its separator, so 400 of them is ~5,600 and fits nginx's 8 KB request-line
// buffer. US-3362 then re-keyed the same stamp onto inventory_items.id to fix a
// resolution bug. A uuid costs 39. The row count did not change and the payload
// tripled to ~15,600.
//
// So these cases pin the CHARACTER budget rather than a row count. A count is
// only ever a proxy for the limit that actually exists, and this is what it
// costs when the proxy and the limit come apart.

// US-2379: flipdesk-ebay.ts reaches lib/supabase.ts through its static imports,
// which reads env at module load. This must come first.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  chunkIdsForInFilter,
  IN_FILTER_CHAR_BUDGET,
} from "../routes/flipdesk-ebay.ts";

/** What the ids actually cost once PostgREST puts them in the query string. */
function encodedCost(chunk: readonly string[]): number {
  return chunk.reduce((n, id) => n + encodeURIComponent(id).length + 3, 0);
}

const UUIDS = Array.from(
  { length: 1000 },
  (_, i) => `3f1c9a${String(i).padStart(2, "0")}-5d8e-4467-ae33-2977946042b7`,
);

Deno.test("no chunk exceeds the budget, at the size prod actually sends", () => {
  const chunks = chunkIdsForInFilter(UUIDS.slice(0, 300));
  assert(chunks.length > 1, "300 uuids must not go out as one request");
  for (const c of chunks) {
    assert(
      encodedCost(c) <= IN_FILTER_CHAR_BUDGET,
      `chunk of ${c.length} costs ${encodedCost(c)} > ${IN_FILTER_CHAR_BUDGET}`,
    );
  }
});

Deno.test("the pre-fix payload would have busted the budget", () => {
  // The regression, stated as an assertion rather than as a comment: 400 uuids
  // in one `in.()` is what Kong answered 414 to.
  assert(encodedCost(UUIDS.slice(0, 400)) > 8000);
});

Deno.test("every id survives the split, in order and without duplication", () => {
  const chunks = chunkIdsForInFilter(UUIDS);
  assertEquals(chunks.flat(), UUIDS);
});

Deno.test("short ids pack more densely than uuids", () => {
  // The point of measuring characters: the same code carries far more SKUs per
  // request than uuids, which is why the old 400 was safe before US-3362.
  const skus = UUIDS.map((_, i) => `FD-${i.toString(16)}`);
  const skuChunks = chunkIdsForInFilter(skus);
  const uuidChunks = chunkIdsForInFilter(UUIDS);
  assert(
    skuChunks[0].length > uuidChunks[0].length,
    "the chunker is counting rows, not characters",
  );
  for (const c of skuChunks) {
    assert(encodedCost(c) <= IN_FILTER_CHAR_BUDGET);
  }
});

Deno.test("an empty list produces no requests at all", () => {
  assertEquals(chunkIdsForInFilter([]), []);
});

Deno.test("a list that fits goes out as exactly one request", () => {
  assertEquals(chunkIdsForInFilter(UUIDS.slice(0, 10)), [UUIDS.slice(0, 10)]);
});

Deno.test("an id larger than the whole budget is still sent, never dropped", () => {
  // Dropping it would silently unstamp the row, which is the exact failure this
  // path is built to make loud. One oversized request that fails loudly beats a
  // row that quietly never enters the skip set.
  const huge = "x".repeat(IN_FILTER_CHAR_BUDGET + 100);
  const chunks = chunkIdsForInFilter([UUIDS[0], huge, UUIDS[1]]);
  assertEquals(chunks.flat(), [UUIDS[0], huge, UUIDS[1]]);
  assertEquals(chunks.filter((c) => c.includes(huge)).length, 1);
});

Deno.test("characters needing percent-encoding are costed as encoded", () => {
  // A value with a comma encodes to three characters, so counting `.length`
  // would under-count it by two per character and re-open the same gap.
  const budget = 100;
  const chunks = chunkIdsForInFilter(["a,b,c,d,e", "f,g,h,i,j", "k"], budget);
  for (const c of chunks) assert(encodedCost(c) <= budget);
});

Deno.test("the budget leaves real headroom under nginx's 8 KB request line", () => {
  // Not a tautology: it is the assertion that stops someone raising the
  // constant to 8192 because "that is the limit". The rest of the URL - host,
  // path, `user_id=eq.<uuid>`, `select=` - is paid out of the same buffer.
  assert(IN_FILTER_CHAR_BUDGET <= 6000, "too little headroom for the rest of the URL");
  assert(IN_FILTER_CHAR_BUDGET >= 1000, "so small the stamp fans out pointlessly");
});

// - Wiring -
//
// The arithmetic above says nothing about whether the two stamps USE it. Both
// failed in production, and one of them (`ebay_specifics_checked_at`) was never
// chunked at all - so a guard over the offer stamp alone would have been green
// throughout the outage on the sibling twenty lines below it. That is the
// "a fence for the paths a story NAMED" shape, and the answer is to enumerate
// both columns.

const STAMPED_COLUMNS = [
  "ebay_offer_checked_at",
  "ebay_specifics_checked_at",
] as const;

/**
 * Which stamps send their ids without the character budget.
 *
 * Separated from the file read so the guard can be driven with synthetic
 * source. A source scan that has only ever seen a passing tree is a guard
 * nobody has tested; the cases below feed it the broken shape directly rather
 * than editing the real file to find out, because a sabotage run that restores
 * with `git checkout` takes the uncommitted fix with it.
 */
export function unbudgetedStamps(source: string): string[] {
  // Normalised at the read: git checks this tree out with CRLF on Windows, and
  // a needle containing \n silently fails to match there.
  const src = source.replace(/\r\n/g, "\n");
  const bad: string[] = [];
  for (const column of STAMPED_COLUMNS) {
    const at = src.indexOf(`.update({ ${column}:`);
    if (at < 0) {
      bad.push(`${column}: the stamp write moved or was renamed`);
      continue;
    }
    // Look FORWARD to what the update filters on, not backward for a loop. The
    // backward form is what an earlier draft of this guard did and it is
    // unsound: an unchunked stamp sitting below a chunked one finds the
    // SIBLING's loop and reads as budgeted. The filter argument cannot be
    // borrowed - `chunk` is the name the chunker's loop binds, and an unchunked
    // stamp necessarily names its whole array instead.
    const filter = /\.in\("id",\s*([A-Za-z0-9_.]+)\)/.exec(
      src.slice(at, at + 300),
    );
    if (!filter) {
      bad.push(`${column}: no .in("id", ...) filter follows the update`);
    } else if (filter[1] !== "chunk") {
      bad.push(
        `${column}: filters on \`${filter[1]}\` rather than a budgeted chunk`,
      );
    }
  }
  // Both stamps must have their OWN chunker call. One call site cannot serve
  // two loops, so this is what stops the two checks above being satisfied by a
  // single `chunk` binding reused out of scope.
  const callSites = src.match(/chunkIdsForInFilter\(/g)?.length ?? 0;
  if (callSites < STAMPED_COLUMNS.length) {
    bad.push(
      `only ${callSites} chunkIdsForInFilter call site(s) for ` +
        `${STAMPED_COLUMNS.length} stamps`,
    );
  }
  return bad;
}

Deno.test("both bulk stamps route through the budgeted chunker", async () => {
  const src = await Deno.readTextFile(
    new URL("../routes/flipdesk-ebay.ts", import.meta.url),
  );
  assertEquals(
    unbudgetedStamps(src),
    [],
    "a large seller's pass will get 414 URI too long and silently stop " +
      "stamping, restoring the full fan-out",
  );
});

Deno.test("the guard catches the shape that actually shipped", () => {
  // Verbatim from the pre-fix file: one stamp correctly chunked, the sibling
  // below it passing the whole array. The old guard shape - scan the file for
  // the chunker anywhere - is green on this.
  const broken = `
    for (const chunk of chunkIdsForInFilter(plan.itemIds)) {
      await supabaseAdmin.from("inventory_items")
        .update({ ebay_offer_checked_at: now }).in("id", chunk);
    }
    if (specificsCheckedItemIds.length > 0) {
      const { error } = await supabaseAdmin.from("inventory_items")
        .update({ ebay_specifics_checked_at: now })
        .in("id", specificsCheckedItemIds);
    }
  `;
  const found = unbudgetedStamps(broken);
  assert(
    found.some((f) => f.startsWith("ebay_specifics_checked_at")),
    `the unchunked sibling went unreported; findings: ${found.join("; ")}`,
  );
  assert(
    !found.some((f) => f.startsWith("ebay_offer_checked_at")),
    "the correctly chunked stamp was reported as broken",
  );
});

Deno.test("the guard catches a stamp with no loop at all", () => {
  const broken = `
    await supabaseAdmin.from("x").update({ ebay_offer_checked_at: now });
    await supabaseAdmin.from("x").update({ ebay_specifics_checked_at: now });
  `;
  const found = unbudgetedStamps(broken);
  assert(found.some((f) => f.startsWith("ebay_offer_checked_at")));
  assert(found.some((f) => f.startsWith("ebay_specifics_checked_at")));
});

Deno.test("the guard reports a renamed stamp rather than passing", () => {
  // A scan whose needle stops matching reads exactly like a clean file. This is
  // the failure mode the repo has been bitten by more than once.
  const found = unbudgetedStamps("nothing that looks like a stamp at all");
  assert(
    STAMPED_COLUMNS.every((c) =>
      found.some((f) => f.startsWith(`${c}:`) && f.includes("moved or was renamed"))
    ),
    `findings: ${found.join("; ")}`,
  );
});

Deno.test("the guard passes the shape that is actually correct", () => {
  const fixed = `
    for (const chunk of chunkIdsForInFilter(plan.itemIds)) {
      await supabaseAdmin.from("i").update({ ebay_offer_checked_at: now })
        .in("id", chunk);
    }
    for (const chunk of chunkIdsForInFilter(specificsCheckedItemIds)) {
      await supabaseAdmin.from("i").update({ ebay_specifics_checked_at: now })
        .in("id", chunk);
    }
  `;
  assertEquals(unbudgetedStamps(fixed), []);
});

Deno.test("no fixed-size chunk constant survives beside the stamps", () => {
  // The specific shape that broke: `const CHUNK = 400` counted rows, and the
  // key type changed underneath it. A row count is not a URL length.
  const src = Deno.readTextFileSync(
    new URL("../routes/flipdesk-ebay.ts", import.meta.url),
  ).replace(/\r\n/g, "\n");
  assert(
    !/const\s+CHUNK\s*=\s*\d+/.test(src),
    "a row-count chunk size is back; measure characters, not rows",
  );
});
