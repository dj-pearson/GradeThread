// US-2779: reading identification_provenance back.
//
// The table has had a writer since US-2774 and no reader at all. Its whole
// design premise is that three states stay tellable apart — never offered,
// offered and ignored, offered and refused — so the thing under test here is
// that the AGGREGATE preserves that, not that it counts.
//
// A summary that folds "the model never answered" into "the model said no" is
// worse than no summary: it reports a prompt bug as a quality signal, and the
// number looks entirely reasonable while pointing at the wrong fix.

import "./_env.ts";
import { assertEquals } from "@std/assert";
import {
  parseProvenanceWindow,
  type ProvenanceRow,
  summarizeIdentification,
} from "../routes/admin-identification-provenance.ts";

const offered = (field: string, value: string) => ({
  field,
  value,
  support: 3,
  out_of: 5,
});

const ruled = (
  field: string,
  value: string,
  verdict: string,
  evidence: string | null = null,
) => ({ field, value, verdict, evidence });

function row(over: Partial<ProvenanceRow> = {}): ProvenanceRow {
  return {
    visual_candidates: [],
    visual_rulings: [],
    visual_declined: null,
    ...over,
  };
}

// ── The three states ─────────────────────────────────────────────────────────

Deno.test("offered-and-ignored is its own bucket, not a rejection", () => {
  const report = summarizeIdentification([
    row({
      visual_candidates: [offered("brand", "Lululemon"), offered("style", "Align")],
      // The model ruled on the brand and said nothing at all about the style.
      visual_rulings: [ruled("brand", "Lululemon", "accepted", "tag_wordmark")],
    }),
  ], 100);

  const brand = report.byField.find((f) => f.field === "brand")!;
  assertEquals(brand.accepted, 1);
  assertEquals(brand.rejected, 0);
  assertEquals(brand.neverRuled, 0);

  const style = report.byField.find((f) => f.field === "style")!;
  assertEquals(style.offered, 1);
  assertEquals(style.accepted, 0);
  // NOT a rejection. The model was told to report a verdict per candidate and
  // did not, which is a prompt defect and is fixed by editing the prompt.
  assertEquals(style.rejected, 0);
  assertEquals(style.neverRuled, 1);
});

Deno.test("a rejection is counted as a rejection", () => {
  const report = summarizeIdentification([
    row({
      visual_candidates: [offered("brand", "Lululemon")],
      visual_rulings: [ruled("brand", "Lululemon", "rejected")],
    }),
  ], 100);
  const brand = report.byField.find((f) => f.field === "brand")!;
  assertEquals(brand.rejected, 1);
  assertEquals(brand.neverRuled, 0);
});

Deno.test("a ruling on a value that was never offered is ignored", () => {
  // The model answering about something it invented is not evidence about the
  // candidate; counting it would inflate the accept rate with a value nobody
  // proposed.
  const report = summarizeIdentification([
    row({
      visual_candidates: [offered("brand", "Lululemon")],
      visual_rulings: [ruled("brand", "Athleta", "accepted", "visual_consensus")],
    }),
  ], 100);
  const brand = report.byField.find((f) => f.field === "brand")!;
  assertEquals(brand.offered, 1);
  assertEquals(brand.accepted, 0);
  assertEquals(brand.neverRuled, 1);
});

// ── What accepted it ─────────────────────────────────────────────────────────

Deno.test("acceptances are split by the evidence the model named", () => {
  const report = summarizeIdentification([
    row({
      visual_candidates: [offered("brand", "A"), offered("type", "B")],
      visual_rulings: [
        ruled("brand", "A", "accepted", "tag_wordmark"),
        ruled("type", "B", "accepted", "visual_consensus"),
      ],
    }),
  ], 100);

  // The split is the point. A candidate a TAG accepted tells you the tag was
  // legible; one accepted on visual_consensus alone is the visual provider
  // being believed on its own word, which is the number worth watching.
  assertEquals(report.acceptedByEvidence.tag_wordmark, 1);
  assertEquals(report.acceptedByEvidence.visual_consensus, 1);
  assertEquals(report.acceptedByEvidence.style_code, 0);
  assertEquals(report.acceptedByEvidence.model_knowledge, 0);
});

// ── Runs that offered nothing ────────────────────────────────────────────────

Deno.test("declines are reported by reason, not as one silence", () => {
  const report = summarizeIdentification([
    row({ visual_declined: "role_not_identifying" }),
    row({ visual_declined: "role_not_identifying" }),
    row({ visual_declined: "no_matches" }),
    row({ visual_candidates: [offered("brand", "A")] }),
  ], 100);

  // A gate refusing a ruler shot and eBay having no matching inventory are
  // different findings with different fixes. One silence would hide both.
  assertEquals(report.declines.role_not_identifying, 2);
  assertEquals(report.declines.no_matches, 1);
  assertEquals(report.runs, 4);
  assertEquals(report.runsWithCandidates, 1);
});

Deno.test("an unrecognised decline reason is kept, not dropped", () => {
  // A reason this build does not know about is a signal that the pass grew one.
  // Discarding it would make the totals silently disagree with `runs`.
  const report = summarizeIdentification([
    row({ visual_declined: "something_new" }),
  ], 100);
  assertEquals(report.declines.other, 1);
});

Deno.test("malformed stored json degrades to zero, never throws", () => {
  const report = summarizeIdentification([
    // deno-lint-ignore no-explicit-any
    { visual_candidates: "not an array" as any, visual_rulings: null as any, visual_declined: null },
  ], 100);
  assertEquals(report.runs, 1);
  assertEquals(report.byField.length, 0);
});

// ── The window ───────────────────────────────────────────────────────────────

Deno.test("the window clamps to something the aggregate can chew through", () => {
  assertEquals(parseProvenanceWindow(undefined), 500);
  assertEquals(parseProvenanceWindow("abc"), 500);
  assertEquals(parseProvenanceWindow("0"), 500);
  assertEquals(parseProvenanceWindow("50"), 50);
  assertEquals(parseProvenanceWindow("99999"), 2000);
});
