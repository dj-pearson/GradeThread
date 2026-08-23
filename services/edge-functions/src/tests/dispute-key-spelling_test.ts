// US-2688 AC4: the dispute route must keep accepting the spelling iOS sends.
//
// THE OUTAGE THIS PINS. Every grade dispute filed from an iPhone failed from
// 2026-08-17 to 2026-08-19, and a dispute is how a seller challenges a grade
// they paid for inside a 7-day window. The route read `body.gradeReportId`;
// iOS encodes every request with JSONEncoder.iso8601, which sets
// .convertToSnakeCase, so the phone sent `grade_report_id`. The route answered
// 400 "gradeReportId is required" and the sheet renders the server's own
// string, so the customer was shown a property name.
//
// ⚠ AC4 IS PINNED IN THE OPPOSITE DIRECTION TO THE ONE IT WAS WRITTEN IN, and
// that is deliberate. The criterion says "a guard fails if the ROUTE is ever
// changed to read a snake_case key", because it assumed the fix would be
// client-side: pin the Swift to camelCase and keep the route as it was. That
// fix does not exist. Explicit CodingKeys do NOT protect a key from the
// encoder's strategy — Swift applies .convertToSnakeCase to the CodingKey's
// stringValue, so `case gradeReportId = "gradeReportId"` still goes out as
// grade_report_id. iOS CI caught that before it shipped.
//
// So the real fix was server-side (6b278bc91): accept BOTH. Which inverts the
// risk. The dangerous edit is no longer "someone makes the route snake_case" —
// it is someone TIDYING the route back to one spelling, because the camelCase
// branch is the one that looks canonical and the `??` reads like defensive
// clutter. Deleting the snake_case branch breaks every iOS filing again, in
// exactly the way that produces no error anywhere except the customer's screen.
//
// ⚠ COMMENTS ARE STRIPPED FIRST, AND HERE THAT IS NOT A FORMALITY. The route
// carries a long comment block ABOUT this bug which names both spellings
// several times. A scan that reads the raw file passes with the whole body
// deleted, satisfied by the explanation of why the body should exist. This repo
// has shipped that exact failure before.

import { assert, assertEquals } from "@std/assert";

const ROUTE = new URL("../routes/grade.ts", import.meta.url);

/** Drop comments so an explanation cannot stand in for the code. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
}

/** The dispute handler's body, so a match elsewhere in a 2000-line file cannot count. */
function disputeHandler(src: string): string {
  const start = src.indexOf('gradeRoutes.post("/dispute"');
  assert(start !== -1, "the dispute route registration is gone");
  const next = src.indexOf("gradeRoutes.", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

Deno.test("the handler slice is real, and it is not the whole file", async () => {
  // Guards the guard. If the slicer returned everything, the assertions below
  // would pass on a match from an unrelated route, and if it returned nothing
  // they would fail for the wrong reason.
  const src = await Deno.readTextFile(ROUTE);
  const body = disputeHandler(src);
  assert(body.length > 500, `dispute handler slice is only ${body.length} chars`);
  assert(
    body.length < src.length * 0.5,
    "the slice is more than half the file — the next-route boundary broke",
  );
  assert(body.includes("DISPUTE_WINDOW_DAYS"), "this is not the dispute handler");
});

Deno.test("the dispute route reads BOTH key spellings", async () => {
  const body = stripComments(disputeHandler(await Deno.readTextFile(ROUTE)));

  assert(
    /body\.grade_report_id/.test(body),
    "the dispute route no longer reads `grade_report_id`. That is the ONLY " +
      "spelling iOS can send: EdgeAPI encodes with .convertToSnakeCase and " +
      "CodingKeys cannot override it. Deleting this branch silently breaks " +
      "every dispute filed from an iPhone, and the seller sees a raw property " +
      "name inside a 7-day window they cannot reopen.",
  );
  assert(
    /body\.gradeReportId/.test(body),
    "the dispute route no longer reads `gradeReportId`. Web " +
      "(submission-detail.tsx) and Android both hand-build camelCase JSON and " +
      "would start failing.",
  );
});

Deno.test("stripping comments does not remove the code, only the explanation", async () => {
  // The point of the stripper, asserted rather than assumed: the raw file and
  // the stripped file must disagree about the PROSE and agree about the READS.
  const raw = disputeHandler(await Deno.readTextFile(ROUTE));
  const stripped = stripComments(raw);
  assert(
    raw.includes("convertToSnakeCase") && !stripped.includes("convertToSnakeCase"),
    "the comment block survived stripping, so an explanation could satisfy the " +
      "assertions above",
  );
  assertEquals(
    /body\.grade_report_id/.test(stripped),
    /body\.grade_report_id/.test(raw),
    "stripping removed a real read",
  );
});
