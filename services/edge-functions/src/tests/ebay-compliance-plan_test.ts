// US-2329: the compliance sync must never record a still-violating listing as
// compliant, not even for the duration of a loop.
//
// The old shape was: one UPDATE zeroing every flagged listing for the owner,
// then a re-flag per violating listing. No transaction, so between those two
// statements every listing with an open eBay policy violation read as clean —
// and if the re-flag updates failed, they stayed that way, because their errors
// were counted away (`if (!upErr) flagged += 1`).
//
// Two halves are asserted here. The PLAN is pure, so its properties are checked
// directly. The ORDERING is a property of the route, and is checked by index —
// a plan that is right and applied in the wrong order fixes nothing.

import { assertEquals } from "@std/assert";
import { planComplianceSync } from "../lib/ebay-compliance-plan.ts";

const violating = (
  entries: Array<[string, number, string[]]>,
): Map<string, { count: number; types: string[] }> =>
  new Map(entries.map(([id, count, types]) => [id, { count, types }]));

Deno.test("a listing that is still violating is never cleared", () => {
  // The whole defect in one case: v1 was flagged before and is STILL violating.
  // The old code zeroed it and then re-flagged it; this plan never clears it.
  const plan = planComplianceSync(
    ["v1", "fixed1"],
    violating([["v1", 3, ["ASPECTS_ADOPTION"]]]),
  );
  assertEquals(plan.toClear, ["fixed1"]);
  assertEquals(plan.toFlag.map((t) => t.platformListingId), ["v1"]);
});

Deno.test("only listings that became clean are cleared", () => {
  const plan = planComplianceSync(
    ["a", "b", "c"],
    violating([["b", 1, ["X"]], ["new", 2, ["Y"]]]),
  );
  assertEquals(plan.toClear, ["a", "c"]);
  // `new` was not previously flagged and still gets written — the flag side is
  // the current violation set, not a delta against what we already knew.
  assertEquals(plan.toFlag.map((t) => t.platformListingId), ["b", "new"]);
});

Deno.test("nothing violating means everything flagged gets cleared", () => {
  const plan = planComplianceSync(["a", "b"], violating([]));
  assertEquals(plan.toClear, ["a", "b"]);
  assertEquals(plan.toFlag, []);
});

Deno.test("a flagged row with no eBay listing id is left alone", () => {
  // It cannot be matched against eBay's violation set at all, so clearing it
  // would be a decision made on a comparison that could never have succeeded.
  const plan = planComplianceSync([null, "a"], violating([]));
  assertEquals(plan.toClear, ["a"]);
});

Deno.test("duplicate flagged ids are cleared once", () => {
  const plan = planComplianceSync(["a", "a", "b"], violating([]));
  assertEquals(plan.toClear, ["a", "b"]);
});

Deno.test("types are deduped and sorted so a plan is comparable", () => {
  const plan = planComplianceSync(
    [],
    violating([["v1", 2, ["PRODUCT_ADOPTION", "ASPECTS_ADOPTION", "ASPECTS_ADOPTION"]]]),
  );
  assertEquals(plan.toFlag[0]?.types, ["ASPECTS_ADOPTION", "PRODUCT_ADOPTION"]);
});

Deno.test("the route writes flags BEFORE it clears anything", () => {
  // The plan can be perfect and the window still exist if the clear runs first.
  // Matched by construct rather than by comment text, and by INDEX rather than
  // by presence — both halves exist either way, so only their order can fail.
  const src = Deno.readTextFileSync(
    new URL("../routes/flipdesk-ebay.ts", import.meta.url),
  );
  const flagAt = src.indexOf("for (const t of plan.toFlag)");
  const clearAt = src.indexOf("plan.toClear.length");
  assertEquals(flagAt > -1, true, "the flag loop is gone");
  assertEquals(clearAt > -1, true, "the clear loop is gone");
  assertEquals(flagAt < clearAt, true, "clears must run AFTER flags");
});

Deno.test("the blanket clear-everything update is gone", () => {
  // The exact statement that opened the window: an UPDATE matching every row
  // with a non-zero count. It survives as a SELECT — that read is what makes
  // the diff possible — so this asserts the UPDATE form specifically.
  const src = Deno.readTextFileSync(
    new URL("../routes/flipdesk-ebay.ts", import.meta.url),
  );
  const blanket =
    /\.update\(\{[\s\S]{0,200}?compliance_violation_count:\s*0[\s\S]{0,200}?\.gt\("compliance_violation_count"/;
  assertEquals(
    blanket.test(src),
    false,
    "an UPDATE gated on gt(compliance_violation_count, 0) clears every " +
      "violator, which is the window this story removed",
  );
});

Deno.test("a failed update fails the sync instead of shrinking a counter", () => {
  const src = Deno.readTextFileSync(
    new URL("../routes/flipdesk-ebay.ts", import.meta.url),
  );
  const section = src.slice(src.indexOf('flipdeskEbayRoutes.post("/compliance/sync"'));
  const raw = section.slice(0, section.indexOf("flipdeskEbayRoutes.post", 40));
  // COMMENTS STRIPPED FIRST, and this is not tidiness. The fix's own comment
  // quotes the defective line verbatim to explain what it replaced, so scanning
  // the raw source finds the defect inside the explanation of its removal. That
  // is the seventh guard here to accuse its own prose; when the construct and
  // the words are genuinely the same string, strip the prose.
  const body = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "");
  assertEquals(
    /if \(!upErr\) flagged \+= 1/.test(body),
    false,
    "an update error must not be counted away",
  );
  assertEquals(body.includes("failed: errors.length"), true);
  assertEquals(body.includes("502"), true);
});
