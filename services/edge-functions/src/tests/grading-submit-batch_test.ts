// US-2024 — the bulk-grading submit loop must not re-query per item.
//
// The loop previously issued an inventory_items SELECT and an item_photos
// SELECT for EVERY item in the batch — a straight N+1, and a regression against
// buildValidation() in the same file, which already loads photo coverage for the
// whole batch in one `.in(itemIds)`. At the schema cap of 200 items that is ~400
// avoidable sequential round trips on top of the writes.
//
// Why it is more than a latency concern: the loop CHARGES CREDITS partway
// through each item (`charged = true`) and the catch-block compensation only
// handles a THROWN error. A killed isolate throws nothing, so a timeout leaves a
// partially-charged batch that nothing reverses. Avoidable I/O directly widens
// that window.
//
// Two things are pinned here: that the batching exists at all, and — more
// subtly — that grouping preserves the per-item sort_order the submission
// depends on. A single ordered query grouped into a map keeps order only
// because insertion order is preserved; that is easy to break with a
// well-meaning refactor to a different grouping helper.

import { assert } from "@std/assert";

// US-9129: the submit loop moved to lib/grading-submit.ts. The scan follows
// it, because a negative assertion here ("the loop must NOT re-query per item")
// passes trivially against a file that no longer contains the loop.
const SRC = await Deno.readTextFile(
  new URL("../lib/grading-submit.ts", import.meta.url),
);
// The batch cap lives with the request schema, which stayed in the route.
const ROUTE_SRC = await Deno.readTextFile(
  new URL("../routes/flipdesk-grading.ts", import.meta.url),
);

// The submit handler, isolated so buildValidation's (correct) batch queries
// can't satisfy assertions about the submit loop.
const SUBMIT = SRC.slice(SRC.indexOf("const results: SubmitResult[] = []"));

Deno.test("submit batch-loads items and photos before the loop", () => {
  const preLoop = SUBMIT.slice(0, SUBMIT.indexOf("for (const item of validation.result.items)"));
  assert(
    /\.from\("inventory_items"\)[\s\S]{0,400}?\.in\("id", batchItemIds\)/.test(preLoop),
    "inventory_items must be loaded for the whole batch with .in() BEFORE the loop",
  );
  assert(
    /\.from\("item_photos"\)[\s\S]{0,400}?\.in\("inventory_item_id", batchItemIds\)/.test(preLoop),
    "item_photos must be loaded for the whole batch with .in() BEFORE the loop",
  );
  assert(
    /Promise\.all\(\[/.test(preLoop),
    "the two batch loads are independent and should run concurrently",
  );
});

Deno.test("the submit LOOP issues no per-item SELECT on those tables", () => {
  const loop = SUBMIT.slice(SUBMIT.indexOf("for (const item of validation.result.items)"));
  assert(
    !/\.from\("inventory_items"\)[\s\S]{0,300}?\.eq\("id", item\.inventory_item_id\)/.test(loop),
    "the loop must read the item from the batch map, not re-query per item",
  );
  assert(
    !/\.from\("item_photos"\)[\s\S]{0,300}?\.eq\("inventory_item_id"/.test(loop),
    "the loop must read photos from the batch map, not re-query per item",
  );
});

Deno.test("the batch item query is tenant-scoped (US-268)", () => {
  const preLoop = SUBMIT.slice(0, SUBMIT.indexOf("for (const item of"));
  assert(
    /\.in\("id", batchItemIds\)[\s\S]{0,300}?\.eq\("user_id", ownerId\)/.test(preLoop),
    "the batch load takes ids from the REQUEST BODY, so it must filter by owner " +
      "server-side — a foreign id must never enter the map in the first place",
  );
  // The per-item assertion is defence in depth and must survive.
  assert(
    /it\.user_id !== ownerId/.test(SUBMIT),
    "keep the per-item ownership assertion as well",
  );
});

Deno.test("photo grouping preserves sort_order (insertion order)", () => {
  // ⚠ THIS TEST WAS SELF-REFERENTIAL AND HAS BEEN CORRECTED (US-2040 review).
  //
  // The first version built its own grouping Map inline and asserted on THAT.
  // It never touched flipdesk-grading.ts, so it was a test of the test: the
  // stated risk — "easy to break with a well-meaning refactor to a different
  // grouping helper" — was precisely the regression it could not detect.
  //
  // It cannot become a behavioural test without exporting the loop, which is a
  // larger change. So it is now an honest SOURCE GUARD on the two properties
  // the ordering actually depends on, which is at least a claim about the real
  // code rather than about a copy of it.
  const preLoop = SUBMIT.slice(0, SUBMIT.indexOf("for (const item of validation.result.items)"));

  // 1. The query must be ORDERED — grouping cannot restore an order the query
  //    never established.
  assert(
    /\.from\("item_photos"\)[\s\S]{0,400}?\.order\("sort_order", \{ ascending: true \}\)/
      .test(preLoop),
    "the batched item_photos query must be ordered by sort_order — without it, " +
      "per-item order is whatever Postgres returns and detail_1/2/3 can land " +
      "out of order, giving the grader the wrong lead image",
  );

  // 2. Grouping must PUSH in iteration order (append), not insert positionally
  //    or re-sort. `arr.push(row)` over an ordered result set is what preserves
  //    it; a switch to a keyed/sorted helper silently would not.
  assert(
    /photosByItem\.get\([\s\S]{0,60}?\?\? \[\][\s\S]{0,80}?\.push\(row\)/.test(preLoop),
    "grouping must append rows in query order (arr.push) so the ordered result " +
      "set's sequence survives into each item's photo list",
  );
});

Deno.test("the batch size cap still exists", () => {
  // The audit that produced this story claimed the batch was UNBOUNDED. It was
  // not — this cap has been here all along, and the story was corrected. Pin it
  // so the claim can't drift in either direction.
  assert(
    /\.max\(200,/.test(ROUTE_SRC),
    "submitBodySchema must cap the batch; without it the N+1 fix only reduces " +
      "a constant factor on an unbounded loop",
  );
});
