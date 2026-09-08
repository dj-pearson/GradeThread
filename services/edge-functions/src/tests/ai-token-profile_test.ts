// US-3145: the token profile's arithmetic, against fixtures rather than prod.
//
// The report exists to be quoted in a story note and compared against a later
// run, so the properties that matter are: the medians are medians, two runs of
// the same rows agree, grading's two phases stay apart, and a control row is
// marked as one. Each test below sabotages exactly one of those.

import { assert, assertEquals } from "@std/assert";
import {
  classifyPhase,
  EFFORT_TUNED_PHASES,
  isLightweightModel,
  isRecognisedPhase,
  median,
  profileByPhase,
  renderProfile,
  resolveWindow,
  type TokenProfileRow,
  utcDayStart,
} from "../lib/ai-token-profile.ts";

function row(
  phase: string,
  out: number,
  extra: Partial<TokenProfileRow> = {},
): TokenProfileRow {
  return {
    phase,
    model: "claude-sonnet-5",
    input_tokens: 1000,
    output_tokens: out,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: 0.01,
    ...extra,
  };
}

Deno.test("median: odd, even, and empty", () => {
  assertEquals(median([3, 1, 2]), 2);
  assertEquals(median([1, 2, 3, 4]), 2.5);
  assertEquals(median([]), null);
  // No rounding here - rounding is the renderer's job, once, so a sub-cent
  // median survives instead of coming back as 0. (Asserted as a bound rather
  // than an equality: the exact value is 0.00015000000000000001 in binary
  // floating point, and pinning that would test IEEE 754, not this function.)
  const m = median([0.00014, 0.00016])!;
  assert(m > 0.0001 && m < 0.0002, `sub-cent median collapsed to ${m}`);
});

Deno.test("median is not the mean: one outlier does not move it", () => {
  const rows = [row("tag_ocr", 100), row("tag_ocr", 110), row("tag_ocr", 9000)];
  const [p] = profileByPhase(rows);
  assertEquals(p.medianOutputTokens, 110);
  // The mean would be 3,070. A window of cheap calls plus one long article is
  // the exact shape this report is read over.
  assert(p.medianOutputTokens! < 200);
});

Deno.test("grading's two phases stay apart", () => {
  // Both rows carry feature='grading' in the real ledger; only `phase`
  // separates the vision call from the text synthesis. Grouping by feature
  // would report one median that describes neither.
  const rows = [
    row("per_image", 800),
    row("per_image", 820),
    row("composite", 2400),
  ];
  const profiles = profileByPhase(rows);
  assertEquals(profiles.length, 2);
  const perImage = profiles.find((p) => p.phase === "per_image")!;
  const composite = profiles.find((p) => p.phase === "composite")!;
  assertEquals(perImage.medianOutputTokens, 810);
  assertEquals(composite.medianOutputTokens, 2400);
  assertEquals(perImage.bucket, "grading");
  assertEquals(composite.bucket, "grading");
});

Deno.test("controls are marked, candidates are not", () => {
  const profiles = profileByPhase([
    row("per_image", 800),
    row("catalog_extract", 900),
  ]);
  assertEquals(profiles.find((p) => p.phase === "per_image")!.effortTuned, true);
  assertEquals(
    profiles.find((p) => p.phase === "catalog_extract")!.effortTuned,
    false,
  );
  // The set is the story's claim about the code. If a call site is converted
  // and this is not updated, a converted phase reads as a candidate forever.
  assert(EFFORT_TUNED_PHASES.has("composite"));
  assert(EFFORT_TUNED_PHASES.has("content_social"));
  assert(!EFFORT_TUNED_PHASES.has("autolister"));
});

Deno.test("buckets: agent fleet and named operator phases are not user actions", () => {
  assertEquals(classifyPhase("agent:content-scheduler"), "operator");
  assertEquals(classifyPhase("content"), "operator");
  assertEquals(classifyPhase("newsletter_editor"), "operator");
  assertEquals(classifyPhase("per_image"), "grading");
  assertEquals(classifyPhase("autolister"), "action");
  // An unheard-of phase lands in `action`, the conservative side: it inflates
  // per-action cost and so cannot make a plan look safer than it is.
  assertEquals(classifyPhase("brand_new_thing"), "action");
  assertEquals(isRecognisedPhase("brand_new_thing"), false);
  assertEquals(isRecognisedPhase("tag_ocr"), true);
});

Deno.test("cacheHitShare separates 'no breakpoint' from 'breakpoint ignored'", () => {
  // US-3047: below the per-model cache minimum a breakpoint is ignored with no
  // error, and the ledger shows exactly what a missing breakpoint shows. The
  // share is what makes 'some calls hit' distinguishable from 'none ever do'.
  const none = profileByPhase([
    row("autolister", 500),
    row("autolister", 500),
  ])[0];
  assertEquals(none.cacheHitShare, 0);

  const some = profileByPhase([
    row("autolister_refine", 500, { cache_read_tokens: 4200 }),
    row("autolister_refine", 500, { cache_read_tokens: 0 }),
  ])[0];
  assertEquals(some.cacheHitShare, 0.5);
  assertEquals(some.medianCacheReadTokens, 2100);
});

Deno.test("rows with no phase are dropped, not bucketed under empty string", () => {
  const profiles = profileByPhase([
    row("tag_ocr", 100),
    { phase: null, output_tokens: 5, cost_usd: 1 },
    { phase: "  ", output_tokens: 5, cost_usd: 1 },
  ]);
  assertEquals(profiles.length, 1);
  assertEquals(profiles[0].phase, "tag_ocr");
  // A nameless row is a ledger defect. Inventing a bucket for it would hide
  // the defect AND move the totals.
  assertEquals(profiles[0].totalCostUsd, 0.01);
});

Deno.test("two runs of the same rows print the same thing", () => {
  // AC3. Ties on total cost break by phase name, so a quiet window where three
  // phases each cost $0 does not shuffle between runs.
  const rows = [
    row("a_phase", 10, { cost_usd: 0 }),
    row("b_phase", 20, { cost_usd: 0 }),
    row("c_phase", 30, { cost_usd: 0 }),
  ];
  const w = { since: "2026-08-01T00:00:00.000Z", until: "2026-09-01T00:00:00.000Z" };
  const first = renderProfile(profileByPhase(rows), w);
  const second = renderProfile(profileByPhase([...rows].reverse()), w);
  assertEquals(first, second);
});

Deno.test("the report names the default-effort phases in spend order", () => {
  const rows = [
    // A control: high output, but already chosen. Must not head the work order.
    row("composite", 3000, { cost_usd: 0.05 }),
    row("catalog_extract", 1400, { cost_usd: 0.02 }),
    row("tag_ocr", 200, { cost_usd: 0.002 }),
  ];
  const text = renderProfile(
    profileByPhase(rows),
    { since: "2026-08-01T00:00:00.000Z", until: "2026-09-01T00:00:00.000Z" },
  );
  const order = text.slice(text.indexOf("work order:"));
  assert(order.includes("catalog_extract"), "candidate must appear");
  assert(order.includes("tag_ocr"), "candidate must appear");
  assert(
    !order.includes("composite"),
    "a control must not be listed as work to do",
  );
  assert(
    order.indexOf("catalog_extract") < order.indexOf("tag_ocr"),
    "ordered by median output tokens, highest first",
  );
});

Deno.test("the window is day-aligned, so two runs hours apart read the same rows", () => {
  // This is US-3145 AC3 as arithmetic. A now-anchored window would drop its
  // oldest hour and gain a new one between these two calls, and two operators
  // quoting "the last 30 days" would disagree without knowing why.
  const morning = resolveWindow({ days: 30, now: new Date("2026-09-08T06:12:33Z") });
  const evening = resolveWindow({ days: 30, now: new Date("2026-09-08T23:59:59Z") });
  assertEquals(morning, evening);
  assertEquals(morning.until, "2026-09-08T00:00:00.000Z");
  assertEquals(morning.since, "2026-08-09T00:00:00.000Z");
});

Deno.test("explicit bounds win over --days, unaligned", () => {
  const w = resolveWindow({
    days: 30,
    since: "2026-08-01T09:30:00Z",
    until: "2026-08-02T09:30:00Z",
    now: new Date("2026-09-08T06:12:33Z"),
  });
  assertEquals(w.since, "2026-08-01T09:30:00.000Z");
  assertEquals(w.until, "2026-08-02T09:30:00.000Z");
});

Deno.test("a window that cannot hold rows is refused, not silently empty", () => {
  // An inverted or zero-width window returns zero rows, which reads exactly
  // like "$0 spend". Throwing is the difference between no data and no bill.
  let threw = false;
  try {
    resolveWindow({ since: "2026-09-02T00:00:00Z", until: "2026-09-01T00:00:00Z" });
  } catch {
    threw = true;
  }
  assert(threw, "inverted window must throw");

  threw = false;
  try {
    resolveWindow({ since: "not a date" });
  } catch {
    threw = true;
  }
  assert(threw, "unparseable bound must throw");
});

Deno.test("utcDayStart ignores local time zone", () => {
  const d = utcDayStart(new Date("2026-09-08T23:45:00Z"));
  assertEquals(d.toISOString(), "2026-09-08T00:00:00.000Z");
});

Deno.test("a lightweight-tier phase served by a full model is reported", () => {
  // The finding the first prod run produced (2026-09-08): ai-config.ts routes
  // size_estimate and photo_qa to getLightweightModel(), and both were billing
  // at Sonnet rates because no deploy ever set LIGHTWEIGHT_AI_MODEL. A fallback
  // chain that ends in the right default is indistinguishable, in code, from one
  // that is reaching it - so the check is made against the ledger.
  const w = { since: "2026-08-01T00:00:00.000Z", until: "2026-09-01T00:00:00.000Z" };
  const wrong = renderProfile(
    profileByPhase([
      row("size_estimate", 200, { model: "claude-sonnet-5", cost_usd: 0.0676 }),
    ]),
    w,
  );
  assert(
    wrong.includes("routed to the lightweight tier"),
    "a mis-routed lightweight phase must be called out",
  );
  assert(wrong.includes("size_estimate"));

  const right = renderProfile(
    profileByPhase([
      row("size_estimate", 200, {
        model: "claude-haiku-4-5-20251001",
        cost_usd: 0.0227,
      }),
    ]),
    w,
  );
  assert(
    !right.includes("routed to the lightweight tier"),
    "a correctly routed phase must not be reported",
  );

  // A phase that is SUPPOSED to run on the full model is never flagged, however
  // expensive it is.
  const fine = renderProfile(
    profileByPhase([row("autolister", 781, { model: "claude-sonnet-5" })]),
    w,
  );
  assert(!fine.includes("routed to the lightweight tier"));
});

Deno.test("isLightweightModel matches the tier by prefix, dated ids included", () => {
  assert(isLightweightModel("claude-haiku-4-5"));
  assert(isLightweightModel("claude-haiku-4-5-20251001"));
  assert(!isLightweightModel("claude-sonnet-5"));
  assert(!isLightweightModel("claude-opus-4-8"));
});

Deno.test("a window that straddles a model change reports the mix, not just a blend", () => {
  // Five phases on the 2026-09-08 prod run were served by two models each. The
  // per-phase medians blend two price sheets, so quoting one as a baseline is
  // wrong in a way nothing on the row would reveal.
  const text = renderProfile(
    profileByPhase([
      row("catalog_extract", 400, { model: "claude-haiku-4-5-20251001", cost_usd: 0.005 }),
      row("catalog_extract", 500, { model: "claude-sonnet-5", cost_usd: 0.02 }),
      row("catalog_extract", 500, { model: "claude-sonnet-5", cost_usd: 0.02 }),
    ]),
    { since: "2026-08-01T00:00:00.000Z", until: "2026-09-01T00:00:00.000Z" },
  );
  assert(text.includes("served by more than one model"));
  assert(text.includes("claude-sonnet-5 x2"));
  assert(text.includes("claude-haiku-4-5-20251001 x1"));

  const single = renderProfile(
    profileByPhase([row("catalog_extract", 400, { model: "claude-sonnet-5" })]),
    { since: "2026-08-01T00:00:00.000Z", until: "2026-09-01T00:00:00.000Z" },
  );
  assert(!single.includes("served by more than one model"));
});

Deno.test("the tier warning counts only the calls that ran on the wrong model", () => {
  // A partial count is the signal that the window straddles the fix, rather
  // than that the variable is still unset. Reporting the phase total there
  // would overstate what is left to save.
  const text = renderProfile(
    profileByPhase([
      row("photo_qa", 300, { model: "claude-haiku-4-5-20251001", cost_usd: 0.008 }),
      row("photo_qa", 300, { model: "claude-sonnet-5", cost_usd: 0.023 }),
      row("photo_qa", 300, { model: "claude-sonnet-5", cost_usd: 0.023 }),
    ]),
    { since: "2026-08-01T00:00:00.000Z", until: "2026-09-01T00:00:00.000Z" },
  );
  assert(text.includes("2/3   "), `expected a 2-of-3 count, got:\n${text}`);
  assert(text.includes("$0.05 on"), "only the wrong-model cost is counted");
});
