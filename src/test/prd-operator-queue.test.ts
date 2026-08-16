// The operator queue must under-report rather than over-report.
//
// scripts/prd-operator.mjs pulls "a person has to do this" out of 115 open
// stories. Its whole value is that an owner can trust the list, and the way a
// list like this dies is by quoting the wrong sentence: the first draft matched
// the substring "operator read" inside "an operator reading that at 3am", and
// "operator-only" inside "customer-readable vs operator-only" — both on stories
// that DO have operator work, both quoted a sentence that was about something
// else. Wrong evidence is the same failure as no evidence, and it is worse,
// because it looks like it was checked.
//
// So these cases pin the two directions separately: real remaining-work
// phrasings are caught, and prose ABOUT operators is not.
import { describe, expect, it } from "vitest";
import {
  auditCandidates,
  collect,
  DECLARED_RE,
  extractSentence,
  UNDECLARED_PATTERNS,
} from "../../scripts/prd-operator.mjs";

type Story = {
  id: string;
  passes: boolean;
  title: string;
  priority?: number;
  notes?: string;
  acceptanceCriteria?: string[];
};

const story = (over: Partial<Story> & { id: string }): Story => ({
  passes: false,
  title: "t",
  ...over,
});

describe("declared operator criteria", () => {
  it("matches the OPERATOR: prefix in the forms stories actually use", () => {
    expect(DECLARED_RE.test("OPERATOR: confirm SES is out of sandbox")).toBe(true);
    expect(DECLARED_RE.test("[OPERATOR] apply the migration")).toBe(true);
    expect(DECLARED_RE.test("OWNER - rotate the key")).toBe(true);
  });

  it("does not match a criterion that merely mentions an operator", () => {
    expect(DECLARED_RE.test("The operator sees the failure reason on screen")).toBe(false);
    expect(DECLARED_RE.test("Never use .or() on an UPDATE — the operator is rejected")).toBe(false);
  });

  it("a declared story is listed once, at the declared fidelity", () => {
    // Even when the note ALSO says it in prose. One row per story: a hand-pulled
    // sentence must never sit beside the exact criterion as if equally good.
    const { declared, undeclared } = collect([
      story({
        id: "US-1",
        acceptanceCriteria: ["OPERATOR: run the census against prod"],
        notes: "AC5 is an operator action.",
      }),
    ]);
    expect(declared).toHaveLength(1);
    expect(declared[0]!.items).toEqual(["OPERATOR: run the census against prod"]);
    expect(undeclared).toHaveLength(0);
  });
});

describe("undeclared detection", () => {
  it("catches the phrasings the backlog really uses for remaining work", () => {
    const real = [
      "REMAINING FOR THE OWNER: (1) rotate the Chrome Web Store signing key.",
      "[P1][SEO/Diagnosis] USER ACTION REQUIRED (console access + DNS).",
      "AC5 is an operator action.",
      "AC1, AC2 and AC4 all need someone on the prod host and are genuinely operator work.",
      "AC5 is operator-only.",
      "Rotation is a human action, not a code change.",
      "the enable itself needs a logged-in human against the live sell form.",
      "AC4 is an operator read of crash/analytics and cannot be done from here.",
      "Core deliverable is NOT automatable from this host.",
      // The second wave: eight stories were saying a person was needed in words
      // the first pattern set could not see, because it was tuned on notes that
      // used the word "operator" and these do not.
      "That is a PROD query this host cannot run, and it should gate AC2.",
      "AC4 REMAINS and is not agent work: a prod audit for rows that already drifted.",
      "OPEN AC4: needs a prod query I cannot run — did anyone purchase Pro on iOS?",
      "AC4 needs a partner answer and AC5 needs prod; both are named below.",
      "That is a human with the product open, not a code change.",
      "Whether Cancel subscription is enabled there is a Stripe Dashboard setting.",
      "a live end-to-end pass that cannot be run from here: buy one label.",
      // Third wave, and the last: after the second set, exactly two stories were
      // still invisible and both used this phrase.
      "BLOCKED ON A HUMAN for the enable: live Vinted sell form, logged in.",
    ];
    for (const notes of real) {
      const { undeclared } = collect([story({ id: "US-1", notes })]);
      expect(undeclared, `should have matched: ${notes}`).toHaveLength(1);
    }
  });

  it("ignores prose ABOUT operators — the exact false positives that shipped first", () => {
    const notThis = [
      "An operator reading that at 3am is told something is missing.",
      "gated was doing two jobs (customer-readable vs operator-only) and one flag would have published operator runbooks to every customer.",
      "The message names the remedy because an operator under pressure will fabricate cases.",
      "So an operator working this checklist will not set a name nothing reads.",
      // The second wave's own near-misses. Each of these is a sentence about
      // work that WAS done, or about a host, and each would have been matched by
      // the obvious loose version of a pattern above ("prod query", "cannot
      // run", "human", "Stripe Dashboard").
      "Verified by running the prod query against a local stack with ON_ERROR_STOP=1.",
      "The container cannot run migrations, which is why the gate exists.",
      "A human reading that alert at 3am learns nothing from it.",
      "The Stripe Dashboard shows the same figure, so the two agree.",
    ];
    for (const notes of notThis) {
      const { undeclared } = collect([story({ id: "US-1", notes })]);
      expect(undeclared, `should NOT have matched: ${notes}`).toHaveLength(0);
    }
  });

  it("a title tag alone is enough to list, and says it has nothing to quote", () => {
    const { undeclared } = collect([
      story({ id: "US-1", title: "[OPERATOR] Depop go-live", notes: "no phrase here" }),
    ]);
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]!.evidence).toEqual([]);
  });

  it("closed stories are never queued", () => {
    const { declared, undeclared } = collect([
      story({ id: "US-1", passes: true, notes: "REMAINING FOR THE OWNER: rotate the key." }),
      story({
        id: "US-2",
        passes: true,
        acceptanceCriteria: ["OPERATOR: confirm SES is out of sandbox"],
      }),
    ]);
    expect(declared).toHaveLength(0);
    expect(undeclared).toHaveLength(0);
  });

  it("the audit is a reading list, not a finding: over-wide and never in the default report", () => {
    // It exists because three rounds of phrase-guessing each ended in a
    // confident zero and the third one was wrong (US-2444, "ALL OWNER WORK").
    // So it must catch a story the PATTERNS do not — that is its whole job.
    const missedByPatterns = story({
      id: "US-1",
      notes: "STILL OPEN AND ALL OWNER WORK: read the objects out of prod.",
    });
    const { undeclared } = collect([missedByPatterns]);
    expect(undeclared, "the patterns should NOT match this — that is the point").toHaveLength(0);
    expect(auditCandidates([missedByPatterns]).map((s) => s.id)).toEqual(["US-1"]);

    // A story already in either list is not repeated as a candidate.
    const alreadyDeclared = story({
      id: "US-2",
      acceptanceCriteria: ["OPERATOR: run the census against prod"],
      notes: "the owner runs this in prod",
    });
    expect(auditCandidates([alreadyDeclared])).toHaveLength(0);

    // Only the LAST segment is read: notes are append-only, so an early segment
    // describing work already finished is not evidence of what is left.
    const resolved = story({
      id: "US-3",
      notes: "the owner had to run this in prod | DONE, ran and recorded.",
    });
    expect(auditCandidates([resolved])).toHaveLength(0);
  });

  it("every pattern is anchored to a predicate, never a bare mention", () => {
    // The structural version of the two cases above: a pattern that matches the
    // word "operator" with nothing asserted about it will match prose forever.
    for (const p of UNDECLARED_PATTERNS) {
      expect(p.test("the operator"), `too loose: ${p}`).toBe(false);
      expect(p.test("an operator reading the log"), `too loose: ${p}`).toBe(false);
    }
  });
});

describe("evidence extraction", () => {
  it("quotes the sentence the match is in, not the note", () => {
    const notes = "First thing done. AC5 is an operator action. Third thing done.";
    const out = extractSentence(notes, notes.indexOf("AC5"));
    expect(out).toBe("AC5 is an operator action.");
  });

  it("starts at the append-only segment boundary, so a quote cannot cross dates", () => {
    // Notes are append-only and joined with " | ". A quote that reached back
    // across that separator would attribute an old segment's claim to a new one,
    // which is the exact way a stale HELD note misleads (see prd-lint).
    const notes = "2026-08-01 all clear | 2026-08-09 AC5 is an operator action";
    const out = extractSentence(notes, notes.indexOf("AC5"));
    expect(out.startsWith("2026-08-09")).toBe(true);
    expect(out).not.toContain("all clear");
  });

  it("truncates rather than printing a 4000-character note", () => {
    const notes = `${"x".repeat(50)}. AC5 is an operator action ${"y".repeat(900)}`;
    const out = extractSentence(notes, notes.indexOf("AC5"));
    expect(out.length).toBeLessThanOrEqual(260);
  });
});
