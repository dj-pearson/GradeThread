// US-3151 AC6/AC7: the report that measures the fix has to be able to see the
// fix failing.
//
// The buckets are pure functions over the free text in
// content_scheduler_runs.error, so they are testable here against literal
// strings. That matters more than usual: nobody in an agent environment can
// read the table those strings come from, so this file is the only place the
// classification is ever exercised before an operator trusts its output.
//
// THE CASE THAT MOTIVATED THE WHOLE FILE is `output_shape_current`. AC7 asks
// for zero errors matching "unparseable JSON" or "invalid JSON" — the wording
// of the code this story DELETED. The replacement guards throw different words,
// so a grep for the AC's two phrases returns zero whether the schema is working
// or the new guard is firing on every single run. A guard that reports success
// after a rename is the repo's most-repeated defect; pin both wordings.

import "./_env.ts";

import { assert, assertEquals } from "@std/assert";
import {
  cadenceEvidence,
  classifyContentRunError,
  type ErrorBucket,
  isOutputShapeFailure,
  publishedPerDay,
  splitProxy,
  summarizeWindow,
} from "../../scripts/content-parse-failure-report.ts";

// The seven messages the story measured on prod, 2026-08-09..2026-09-08, with
// their counts. Copied verbatim from the note so a wording drift is visible
// here rather than as a silent drop to zero.
const MEASURED_BEFORE: Array<[string, ErrorBucket]> = [
  [
    "content-ai-blog / content-ai-social: model returned unparseable JSON",
    "output_shape_retired",
  ],
  ["AI returned invalid JSON for blog article", "output_shape_retired"],
  [
    "social generation failed: AI response contained no text block",
    "output_shape_retired",
  ],
  ["AI returned invalid JSON for social post", "output_shape_retired"],
  ["content-ai-social: response was cut off at max_tokens", "max_tokens"],
  ["content-ai-social: hit max_tokens before emitting", "max_tokens"],
  ["AI returned invalid JSON for blog refresh", "output_shape_retired"],
];

Deno.test("every message the story measured lands in the bucket it was counted under", () => {
  for (const [text, expected] of MEASURED_BEFORE) {
    assertEquals(classifyContentRunError(text), expected, text);
  }
});

Deno.test("the post-fix guards are counted as output-shape failures too", () => {
  // content-ai-blog.ts:121, content-ai-social.ts:199, content-ai-refresh.ts:81
  // and the missing-field guards beside them. None of these contains the string
  // "invalid JSON" or "unparseable JSON", which is exactly the point.
  const current = [
    "AI response was not a JSON object",
    "AI refresh response was not a JSON object",
    "AI response missing title",
    "AI response missing body_html",
    "AI response missing long_body or short_body",
  ];
  for (const text of current) {
    assert(
      !/unparseable JSON|invalid JSON/i.test(text),
      `${text} must NOT match AC7's literal phrases, or this test proves nothing`,
    );
    assertEquals(classifyContentRunError(text), "output_shape_current", text);
    assert(isOutputShapeFailure(classifyContentRunError(text)));
  }
});

Deno.test("a benign skip reason is not an output-shape failure", () => {
  for (
    const text of [
      "cadence met for blog today",
      "scheduler paused",
      "no queued topics in the bank",
      null,
      "",
      "   ",
    ]
  ) {
    const bucket = classifyContentRunError(text);
    assert(!isOutputShapeFailure(bucket), `${text} classified as ${bucket}`);
  }
});

Deno.test("truncation stays its own bucket — a schema does not fix a budget", () => {
  const bucket = classifyContentRunError(
    "content-ai-blog: response was cut off at max_tokens (output_tokens=8192)",
  );
  assertEquals(bucket, "max_tokens");
  assert(!isOutputShapeFailure(bucket));
});

Deno.test("summarizeWindow counts only error rows and ranks the messages", () => {
  const s = summarizeWindow("T", "2026-08-09", "2026-09-08", [
    { outcome: "success", surface: "blog", error: null },
    { outcome: "skip", surface: null, error: "cadence met for blog today" },
    {
      outcome: "error",
      surface: "blog",
      error: "AI returned invalid JSON for blog article",
    },
    {
      outcome: "error",
      surface: "blog",
      error: "AI returned invalid JSON for blog article",
    },
    {
      outcome: "error",
      surface: "social",
      error: "content-ai-social: hit max_tokens",
    },
    {
      outcome: "error",
      surface: "blog",
      error: "AI response was not a JSON object",
    },
  ]);

  assertEquals(s.runs, 6);
  // The skip carries a reason in the same column and must not be counted.
  assertEquals(s.errors, 4);
  assertEquals(s.buckets.output_shape_retired, 2);
  assertEquals(s.buckets.output_shape_current, 1);
  assertEquals(s.buckets.max_tokens, 1);
  assertEquals(s.buckets.other, 0);
  assertEquals(s.messages[0]?.count, 2);
  assertEquals(
    s.messages[0]?.text,
    "AI returned invalid JSON for blog article",
  );
});

/** The real 2026-08-25..09-13 feed, which is what the story's note records. */
const REAL_FEED = new Map<string, number>([
  ["2026-08-25", 2], // oldest, clipped by the feed's 50-item cap
  ["2026-08-26", 3],
  ["2026-08-27", 3],
  ["2026-08-28", 3],
  ["2026-08-29", 1],
  ["2026-08-30", 2],
  ["2026-08-31", 2],
  ["2026-09-01", 2],
  ["2026-09-02", 2],
  ["2026-09-03", 3],
  ["2026-09-04", 1],
  ["2026-09-05", 2],
  ["2026-09-06", 2],
  ["2026-09-07", 2],
  ["2026-09-08", 1], // the cutover: the deploy landed partway through it
  ["2026-09-09", 4],
  ["2026-09-10", 4],
  ["2026-09-11", 4],
  ["2026-09-12", 4],
  ["2026-09-13", 3], // newest, still accruing
]);

Deno.test("splitProxy excludes all three kinds of partial day", () => {
  const perDay = REAL_FEED;
  const split = splitProxy(perDay, "2026-09-08");

  assertEquals(split.oldest, "2026-08-25");
  assertEquals(split.newest, "2026-09-13");
  for (const day of ["2026-08-25", "2026-09-08", "2026-09-13"]) {
    assert(
      split.days.find((d) => d.day === day)?.partial,
      `${day} should be partial`,
    );
  }

  // 13 full days before, and the best of them never reached 4.
  assertEquals(split.before, { days: 13, posts: 28, best: 3 });
  // 4 full days after, every one of them at 4.
  assertEquals(split.after, { days: 4, posts: 16, worst: 4 });

  // The finding the note records: the ranges do not overlap at all.
  assert(split.before.best < split.after.worst);

  // The bug this pins, stated as the arithmetic it produced. The first run of
  // this report counted the cutover day as a full AFTER day, which folded its
  // single post in and reported 3.40/day with a worst day of 1 — a number that
  // reads like the fix half-worked.
  const naiveDays = split.after.days + 1;
  const naivePosts = split.after.posts + perDay.get("2026-09-08")!;
  assertEquals((naivePosts / naiveDays).toFixed(2), "3.40");
  assertEquals((split.after.posts / split.after.days).toFixed(2), "4.00");
});

// The proxy's own caveat used to end at "this is also consistent with the
// operator having raised post_cadence_per_day_blog on the same day". It is not
// fully consistent with that, and the same numbers say so: the cadence is a
// CEILING (content-scheduler.ts:1119 picks blog only while blogToday < cadence),
// so a day of N posts proves N was allowed that day, and raising a cap cannot
// add output to a day that never reached the cap it already had.

Deno.test("cadenceEvidence bounds the raised-the-cadence objection out of the real feed", () => {
  const split = splitProxy(REAL_FEED, "2026-09-08");
  const cadence = cadenceEvidence(split);

  // Four separate before-days reached 3, so the floor is not one stray manual
  // publish — which is the reading the script's remaining caveat warns about.
  assertEquals(cadence.before, { days: 13, floor: 3, atFloor: 4 });
  assertEquals(cadence.after, { days: 4, floor: 4, atFloor: 4 });

  // The load-bearing number: 9 of 13 before-days published fewer than the 3 the
  // same window proves was available to them.
  assertEquals(cadence.belowOwnFloor, 9);
  assert(
    cadence.belowOwnFloor > 0,
    "a raised cap cannot explain a day below its own floor",
  );
});

Deno.test("cadenceEvidence stays silent when the cadence story WOULD explain it", () => {
  // The counterfactual this analysis has to be able to report. Engine equally
  // healthy on both sides, operator raises the cap from 3 to 4 at the cutover:
  // every before-day is pinned at 3, so there is nothing the cap does not
  // account for and belowOwnFloor must be zero. A test that only ever sees the
  // real feed cannot tell "the fix worked" from "this function returns 9".
  const pinned = new Map<string, number>([
    ["2026-09-04", 1], // oldest, partial
    ["2026-09-05", 3],
    ["2026-09-06", 3],
    ["2026-09-07", 3],
    ["2026-09-08", 2], // cutover, partial
    ["2026-09-09", 4],
    ["2026-09-10", 4],
    ["2026-09-11", 1], // newest, partial
  ]);
  const cadence = cadenceEvidence(splitProxy(pinned, "2026-09-08"));

  assertEquals(cadence.before, { days: 3, floor: 3, atFloor: 3 });
  assertEquals(cadence.belowOwnFloor, 0);
});

Deno.test("cadenceEvidence does not divide by an empty window", () => {
  // Run the report before the cutover has any full days and it must return
  // zeroes rather than -Infinity from Math.max of an empty list.
  const early = new Map<string, number>([["2026-09-12", 2], ["2026-09-13", 4]]);
  const cadence = cadenceEvidence(splitProxy(early, "2026-09-08"));
  assertEquals(cadence.before, { days: 0, floor: 0, atFloor: 0 });
  assertEquals(cadence.after, { days: 0, floor: 0, atFloor: 0 });
  assertEquals(cadence.belowOwnFloor, 0);
});

Deno.test("publishedPerDay buckets RSS pubDates by UTC day", () => {
  // Two on one day, one the next, plus an unparseable date that must be skipped
  // rather than folded into an arbitrary bucket.
  const xml = [
    "<item><pubDate>Wed, 09 Sep 2026 06:00:00 GMT</pubDate></item>",
    "<item><pubDate>Wed, 09 Sep 2026 18:30:00 GMT</pubDate></item>",
    "<item><pubDate>Thu, 10 Sep 2026 06:00:00 GMT</pubDate></item>",
    "<item><pubDate>not a date</pubDate></item>",
  ].join("");
  const perDay = publishedPerDay(xml);
  assertEquals(perDay.get("2026-09-09"), 2);
  assertEquals(perDay.get("2026-09-10"), 1);
  assertEquals(perDay.size, 2);
  // Sorted ascending, so the caller can treat first and last as the partial days.
  assertEquals([...perDay.keys()], ["2026-09-09", "2026-09-10"]);
});
