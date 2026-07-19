// US-2146: authenticity accuracy + drift. Pure logic, no supabase load.

import { assert, assertEquals } from "@std/assert";
import {
  computeAuthenticityAccuracy,
  detectAuthenticityDrift,
  MIN_DRIFT_SAMPLE,
  modelVerdictAsLabel,
  splitByCutoff,
  type AuthenticityObservation,
} from "../lib/authenticity-accuracy.ts";

const o = (
  model: string | null,
  reviewer: string,
  extra: Partial<AuthenticityObservation> = {},
): AuthenticityObservation => ({
  prompt_version: "authenticity_v1+tells",
  brand_key: "gucci",
  model_verdict: model,
  reviewer_verdict: reviewer,
  reviewed_at: "2026-07-01T00:00:00Z",
  ...extra,
});

const many = (n: number, obs: AuthenticityObservation) => Array.from({ length: n }, () => obs);

Deno.test("the two vocabularies are mapped before comparing", () => {
  assertEquals(modelVerdictAsLabel("likely_authentic"), "authentic");
  assertEquals(modelVerdictAsLabel("red_flags"), "counterfeit");
  assertEquals(modelVerdictAsLabel("inconclusive"), "inconclusive");
  assertEquals(modelVerdictAsLabel(null), null);
});

Deno.test("the two error directions are counted separately", () => {
  const r = computeAuthenticityAccuracy([
    // Buyer harmed: we vouched for a fake.
    o("likely_authentic", "counterfeit"),
    // Seller harmed: we flagged a genuine item.
    o("red_flags", "authentic"),
    o("likely_authentic", "authentic"),
    o("red_flags", "counterfeit"),
  ]).overall;

  assertEquals(r.reviewed, 4);
  assertEquals(r.agreed, 2);
  assertEquals(r.agreement_rate, 0.5);
  assertEquals(r.false_negatives, 1);
  assertEquals(r.false_positives, 1);
});

Deno.test("a review of an item the pass never assessed is excluded", () => {
  // It says nothing about the pass, and counting it would drag every rate.
  const r = computeAuthenticityAccuracy([
    o(null, "counterfeit"),
    o("likely_authentic", "authentic"),
  ]).overall;
  assertEquals(r.reviewed, 1);
  assertEquals(r.agreement_rate, 1);
});

Deno.test("accuracy is attributed per prompt version and per brand", () => {
  const rep = computeAuthenticityAccuracy([
    o("likely_authentic", "counterfeit", { prompt_version: "v2", brand_key: "coach" }),
    o("likely_authentic", "authentic", { prompt_version: "v1", brand_key: "gucci" }),
  ]);
  // A regression introduced by one version is invisible in a pooled number.
  assertEquals(rep.by_prompt_version["v2"]?.false_negatives, 1);
  assertEquals(rep.by_prompt_version["v1"]?.false_negatives, 0);
  assertEquals(rep.by_brand["coach"]?.false_negatives, 1);
  assertEquals(rep.by_brand["gucci"]?.agreement_rate, 1);
});

Deno.test("unattributed observations are bucketed, not dropped", () => {
  const rep = computeAuthenticityAccuracy([
    o("red_flags", "counterfeit", { prompt_version: null }),
  ]);
  assertEquals(rep.by_prompt_version["(unattributed)"]?.reviewed, 1);
});

// ── drift ───────────────────────────────────────────────────────────────────

Deno.test("drift fires when an ERROR rate climbs materially", () => {
  const baseline = many(MIN_DRIFT_SAMPLE, o("likely_authentic", "authentic"));
  const recent = [
    ...many(MIN_DRIFT_SAMPLE - 4, o("likely_authentic", "authentic")),
    ...many(4, o("likely_authentic", "counterfeit")),
  ];
  const d = detectAuthenticityDrift(recent, baseline);
  assert(d.drifting);
  assert(d.reasons.some((r) => r.includes("false negatives")));
});

Deno.test("drift catches errors TRADING PLACES at flat agreement", () => {
  // The case a single accuracy number misses entirely: agreement is identical in
  // both windows, but the version stopped missing fakes and started flagging
  // genuine items — much worse for sellers, invisible in an agreement rate.
  const baseline = [
    ...many(MIN_DRIFT_SAMPLE - 5, o("likely_authentic", "authentic")),
    ...many(5, o("likely_authentic", "counterfeit")),
  ];
  const recent = [
    ...many(MIN_DRIFT_SAMPLE - 5, o("likely_authentic", "authentic")),
    ...many(5, o("red_flags", "authentic")),
  ];
  const b = computeAuthenticityAccuracy(baseline).overall;
  const r = computeAuthenticityAccuracy(recent).overall;
  assertEquals(r.agreement_rate, b.agreement_rate, "agreement is unchanged…");

  const d = detectAuthenticityDrift(recent, baseline);
  assert(d.drifting, "…but the error profile changed and must be caught");
  assert(d.reasons.some((x) => x.includes("false positives")));
});

Deno.test("drift refuses to fire on a thin sample", () => {
  // A gate declared stale on four reviews is noise, and a monitor that cries
  // wolf gets muted.
  const d = detectAuthenticityDrift(
    many(4, o("likely_authentic", "counterfeit")),
    many(4, o("likely_authentic", "authentic")),
  );
  assertEquals(d.drifting, false);
  assertEquals(d.reasons, ["insufficient sample"]);
});

Deno.test("stable error rates do not drift", () => {
  const same = many(MIN_DRIFT_SAMPLE, o("likely_authentic", "authentic"));
  assertEquals(detectAuthenticityDrift(same, same).drifting, false);
});

Deno.test("splitByCutoff partitions on the timestamp", () => {
  const { recent, baseline } = splitByCutoff(
    [
      o("red_flags", "counterfeit", { reviewed_at: "2026-07-10T00:00:00Z" }),
      o("red_flags", "counterfeit", { reviewed_at: "2026-06-01T00:00:00Z" }),
    ],
    "2026-07-01T00:00:00Z",
  );
  assertEquals(recent.length, 1);
  assertEquals(baseline.length, 1);
});
