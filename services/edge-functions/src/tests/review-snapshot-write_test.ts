// US-3323: every review path must write the AI's factors, and the report it
// writes them from must have been LOADED with those columns.
//
// WHY A SOURCE SCAN AND NOT A TYPE. Both review-writing routes load the report
// and then cast with `as unknown as { ... }`. That cast ASSERTS the shape, it
// does not check it against the `.select()` string above it, so dropping a
// factor column from the select is not a type error anywhere. `reviewSnapshot`
// would then read five `undefined`s and write five NULLs into human_reviews,
// every insert would succeed, and the AI's factors would be silently lost
// again — on exactly the grades a human corrected. Nothing else in the stack
// looks at the select string, so this does.
//
// The fix the scan enforces is that both loaders build their select from
// REPORT_FACTOR_COLUMNS, the same constant the accuracy readers select with.
import { assert, assertEquals } from "@std/assert";
import { REPORT_FACTOR_COLUMNS, REVIEW_FACTOR_KEYS } from "../lib/review-baseline.ts";

// The route file, and the named function in it that loads the report a review
// is written FROM. Only that loader's select matters: other selects in the same
// file (the review-queue list, for one) legitimately spell columns out.
const ROUTES = [
  { path: "src/routes/admin-grading.ts", loader: "loadReportForReview" },
  { path: "src/routes/admin-disputes.ts", loader: "loadDisputeContext" },
];

function read(path: string): string {
  return Deno.readTextFileSync(new URL(`../../${path}`, import.meta.url));
}

/** The body of `async function <name>(...)`, up to the closing brace at col 0. */
function functionBody(src: string, name: string): string | null {
  const start = src.indexOf(`async function ${name}(`);
  if (start === -1) return null;
  const end = src.indexOf("\n}", start);
  if (end === -1) return null;
  return src.slice(start, end);
}

Deno.test("REPORT_FACTOR_COLUMNS names all five factors and nothing else", () => {
  const cols = REPORT_FACTOR_COLUMNS.split(",").map((c) => c.trim()).filter(Boolean);
  assertEquals(cols.length, REVIEW_FACTOR_KEYS.length);
  for (const k of REVIEW_FACTOR_KEYS) {
    assert(
      cols.includes(`${k}_score`),
      `REPORT_FACTOR_COLUMNS is missing ${k}_score — a snapshot written from a ` +
        `report loaded with it would carry a null for that factor`,
    );
  }
});

Deno.test("every reviewSnapshot() caller loads the factor columns by the shared constant", () => {
  let checked = 0;
  for (const { path, loader } of ROUTES) {
    const src = read(path);
    assert(
      src.includes("reviewSnapshot("),
      `${path} no longer calls reviewSnapshot() — the AI factors are not being recorded`,
    );
    const body = functionBody(src, loader);
    // A null body means the extractor stopped matching the file's shape. That
    // must FAIL: a silent null would skip the assertion below and read exactly
    // like a clean result.
    assert(body, `${path}: could not find async function ${loader}()`);
    checked++;
    assert(
      body.includes("REPORT_FACTOR_COLUMNS"),
      `${path}: ${loader}() does not select REPORT_FACTOR_COLUMNS. Spelling the ` +
        `columns out inline is how they get trimmed: the cast below the select ` +
        `is 'as unknown as', so five nulls would be written with no error.`,
    );
    assert(
      /grade_reports/.test(body),
      `${path}: ${loader}() no longer reads grade_reports`,
    );
  }
  // A scan that matched nothing would pass silently, which is the failure mode
  // this whole story is about.
  assertEquals(checked, ROUTES.length, "a route loader went unchecked");
});

Deno.test("every human_reviews insert records which review path wrote it", () => {
  // review_action is what excludes send-backs from accuracy. An insert without
  // one is indistinguishable from a legacy row, i.e. counted as a verdict.
  for (const { path } of ROUTES) {
    const src = read(path);
    const inserts = [...src.matchAll(/from\("human_reviews"\)\s*\.insert\(\{/g)];
    assert(inserts.length > 0, `${path} no longer inserts human_reviews`);
    for (const m of inserts) {
      const body = src.slice(m.index!, m.index! + 1200);
      assert(
        /review_action:\s*"(approve|adjust|send_back|dispute)"/.test(body),
        `${path}: a human_reviews insert near offset ${m.index} has no ` +
          `review_action. Without it a send-back counts as "the AI was right".`,
      );
      assert(
        body.includes("...reviewSnapshot(") || body.includes("review_action: \"send_back\""),
        `${path}: a human_reviews insert near offset ${m.index} does not spread ` +
          `reviewSnapshot(report), so the AI's factors are not recorded.`,
      );
    }
  }
});
