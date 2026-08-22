// US-2705: the three verdicts, and the two ways this can lie.
//
// The interesting failures here are not crashes. They are:
//
//   1. Calling a stretch `contradicted`, which hands eBay a signed argument the
//      grade report does not support.
//   2. Assembling a pack when the report agrees with the buyer, which hands
//      eBay proof against our own user under our signature.
//
// Both produce a confident, well-formatted, entirely wrong document. So the
// labelled fixture set is the gate, and the sabotage that matters is anything
// that moves a case toward `contradicted`.

import { assert, assertEquals } from "@std/assert";
import {
  matchComplaint,
  MATCH_MIN_CONFIDENCE,
  type ReportedDefect,
} from "../lib/complaint-match.ts";
import {
  buildEvidencePlan,
  findDisclosure,
  type PublicationSnapshot,
} from "../lib/dispute-evidence.ts";

interface FixtureCase {
  name: string;
  complaint: string;
  defects: ReportedDefect[];
  snapshot: { description: string | null; aspects: Record<string, string[]> | null } | null;
  expect: "contradicted" | "supported" | "not_covered";
}

const FIXTURES: { cases: FixtureCase[] } = JSON.parse(
  Deno.readTextFileSync(
    new URL("./fixtures/dispute-verdicts.json", import.meta.url),
  ),
);

function snapshotOf(c: FixtureCase): PublicationSnapshot | null {
  if (!c.snapshot) return null;
  return {
    description: c.snapshot.description,
    aspects: c.snapshot.aspects,
    publishedAt: "2026-08-01T00:00:00.000Z",
    lastConfirmedAt: "2026-08-10T00:00:00.000Z",
  };
}

function verdictFor(c: FixtureCase) {
  const match = matchComplaint(c.complaint, c.defects);
  return buildEvidencePlan({
    defects: c.defects,
    snapshot: snapshotOf(c),
    matches: match.matches,
  });
}

// ── AC7: the labelled set is the gate ──────────────────────────────────────

Deno.test("US-2705 AC7: the fixture set is loaded and covers all three verdicts", () => {
  // Without this a renamed file or a bad parse leaves zero cases and the loop
  // below passes against nothing.
  assert(FIXTURES.cases.length >= 8, `only ${FIXTURES.cases.length} fixture cases`);
  for (const want of ["contradicted", "supported", "not_covered"]) {
    assert(
      FIXTURES.cases.some((c) => c.expect === want),
      `no fixture case expects ${want}`,
    );
  }
});

Deno.test("US-2705 AC7: every labelled case produces its verdict", () => {
  const wrong: string[] = [];
  for (const c of FIXTURES.cases) {
    const got = verdictFor(c).verdict;
    if (got !== c.expect) wrong.push(`${c.name}: expected ${c.expect}, got ${got}`);
  }
  assertEquals(
    wrong,
    [],
    "the matcher's verdicts moved. If a case now reads 'contradicted' that did " +
      "not, that is a change to what GradeThread is willing to assert to a " +
      "marketplace, not a test that needs updating.",
  );
});

// ── AC4: ambiguity resolves DOWN ───────────────────────────────────────────

Deno.test("US-2705 AC4: a weak match never produces contradicted", () => {
  const defects: ReportedDefect[] = [{
    issue: "Small stain near the left cuff",
    defect_type: "stain",
    severity: "minor",
    location: "left cuff",
    is_intentional: false,
  }];
  const snapshot: PublicationSnapshot = {
    description: "Small stain on the left cuff.",
    aspects: null,
    publishedAt: "2026-08-01T00:00:00.000Z",
    lastConfirmedAt: "2026-08-01T00:00:00.000Z",
  };
  // A match the matcher itself is unsure about. Everything else about this case
  // is perfect - the flaw is real and the listing disclosed it - so the ONLY
  // thing keeping it out of `contradicted` is the confidence bar.
  const plan = buildEvidencePlan({
    defects,
    snapshot,
    matches: [{ defectIndex: 0, confidence: MATCH_MIN_CONFIDENCE - 0.01 }],
  });
  assertEquals(plan.verdict, "not_covered");
  assertEquals(plan.mayAutoAssemble, false);
});

Deno.test("US-2705 AC4: a partial match on the wrong part of the garment stays down", () => {
  const defects: ReportedDefect[] = [{
    issue: "Small stain near the left cuff",
    defect_type: "stain",
    severity: "minor",
    location: "left cuff",
    is_intentional: false,
  }];
  const result = matchComplaint("Large stain across the chest", defects);
  assertEquals(
    result.matched,
    false,
    "same defect type in a different place is not the same defect",
  );
});

// ── AC5: an invented defect is dropped, not softened ───────────────────────

Deno.test("US-2705 AC5: a citation naming a defect absent from the report is dropped", () => {
  // The matcher stub invents one. A model asked to find a match will do exactly
  // this, and the deterministic layer is the only thing between it and eBay.
  const defects: ReportedDefect[] = [{
    issue: "Light pilling across the back",
    defect_type: "pilling",
    severity: "minor",
    location: "back",
    is_intentional: false,
  }];
  const snapshot: PublicationSnapshot = {
    description: "Some pilling on the back. Also a stain on the cuff.",
    aspects: null,
    publishedAt: "2026-08-01T00:00:00.000Z",
    lastConfirmedAt: "2026-08-01T00:00:00.000Z",
  };
  const plan = buildEvidencePlan({
    defects,
    snapshot,
    // Index 7 does not exist. The listing text WOULD support a stain citation,
    // so a layer that clamped the index instead of dropping it would produce a
    // clean, confident, fabricated argument.
    matches: [{ defectIndex: 7, confidence: 0.99, reason: "invented" }],
  });
  assertEquals(plan.citations.length, 0);
  assertEquals(plan.verdict, "not_covered");
});

Deno.test("US-2705 AC5: an out-of-range index is not clamped to a real defect", () => {
  const defects: ReportedDefect[] = [
    { issue: "Pilling", defect_type: "pilling", severity: "minor", location: "back", is_intentional: false },
    { issue: "Stain", defect_type: "stain", severity: "major", location: "cuff", is_intentional: false },
  ];
  for (const bad of [-1, 2, 99, 1.5, Number.NaN]) {
    const plan = buildEvidencePlan({
      defects,
      snapshot: null,
      matches: [{ defectIndex: bad, confidence: 1 }],
    });
    assertEquals(
      plan.verdict,
      "not_covered",
      `defectIndex ${bad} survived and produced ${plan.verdict}`,
    );
  }
});

Deno.test("US-2705: manufactured distressing can never become a citation", () => {
  // Ripped knees on distressed denim are the product, not a flaw. Citing them
  // as a documented defect is arguing that we sold damaged goods - and the
  // listing text WOULD support the citation, so nothing downstream would catch
  // it.
  //
  // Two separate guards refuse this: matchComplaint never proposes an
  // intentional defect, and surviveMatches drops one that arrives from an AI
  // matcher anyway. This drives the SECOND, with a confidence no keyword pass
  // would ever produce - sabotage showed the fixture set was only exercising
  // the first, so removing the other guard changed nothing.
  const defects: ReportedDefect[] = [{
    issue: "Factory distressing at both knees",
    defect_type: "rip_tear",
    severity: "minor",
    location: "knee",
    is_intentional: true,
  }];
  const plan = buildEvidencePlan({
    defects,
    snapshot: {
      description: "Distressed denim, ripped knees as designed.",
      aspects: null,
      publishedAt: "2026-08-01T00:00:00.000Z",
      lastConfirmedAt: "2026-08-01T00:00:00.000Z",
    },
    matches: [{ defectIndex: 0, confidence: 0.99, reason: "buyer says ripped" }],
  });
  assertEquals(plan.verdict, "not_covered");
  assertEquals(plan.citations.length, 0);
});

Deno.test("US-2705: the matcher does not propose an intentional defect either", () => {
  // The first of the two guards, driven directly. A report with ONE intentional
  // rip and nothing else must produce no matches at all - not a low-confidence
  // one that a future threshold change could promote.
  const result = matchComplaint("The knees are ripped and there is a rip at the seat", [{
    issue: "Factory distressing at both knees",
    defect_type: "rip_tear",
    severity: "minor",
    location: "knee",
    is_intentional: true,
  }]);
  assertEquals(result.matches.length, 0);
  assertEquals(result.matched, false);
});

// ── AC6: the refusal ───────────────────────────────────────────────────────

Deno.test("US-2705 AC6: supported refuses to assemble and says why in plain words", () => {
  const defects: ReportedDefect[] = [{
    issue: "Hole at the right elbow",
    defect_type: "hole_puncture",
    severity: "moderate",
    location: "right elbow",
    is_intentional: false,
  }];
  const plan = buildEvidencePlan({
    defects,
    snapshot: {
      description: "Excellent used condition, no flaws to note.",
      aspects: null,
      publishedAt: "2026-08-01T00:00:00.000Z",
      lastConfirmedAt: "2026-08-01T00:00:00.000Z",
    },
    matches: [{ defectIndex: 0, confidence: 0.95 }],
  });
  assertEquals(plan.verdict, "supported");
  assertEquals(plan.mayAutoAssemble, false);
  assertEquals(plan.citations.length, 0, "a refusal must not still ship citations");
  assert(/refund/i.test(plan.reason), "the refusal must name the action");
});

Deno.test("US-2705: a mixed dispute is a refusal, not a selective defence", () => {
  // One flaw disclosed, one not. Assembling the half that suits us is selecting
  // evidence, which is the same failure as inventing it, one step along.
  const defects: ReportedDefect[] = [
    { issue: "Small stain near the cuff", defect_type: "stain", severity: "minor", location: "cuff", is_intentional: false },
    { issue: "Hole at the elbow", defect_type: "hole_puncture", severity: "moderate", location: "elbow", is_intentional: false },
  ];
  const plan = buildEvidencePlan({
    defects,
    snapshot: {
      description: "Small stain on the cuff, shown in the photos.",
      aspects: null,
      publishedAt: "2026-08-01T00:00:00.000Z",
      lastConfirmedAt: "2026-08-01T00:00:00.000Z",
    },
    matches: [
      { defectIndex: 0, confidence: 0.95 },
      { defectIndex: 1, confidence: 0.95 },
    ],
  });
  assertEquals(plan.verdict, "supported");
  assertEquals(plan.citations.length, 0);
});

// ── The contradicted plan itself ───────────────────────────────────────────

Deno.test("US-2705: a contradicted plan quotes the report and the listing", () => {
  const defects: ReportedDefect[] = [{
    issue: "Small stain near the left cuff",
    defect_type: "stain",
    severity: "minor",
    location: "left cuff",
    is_intentional: false,
  }];
  const plan = buildEvidencePlan({
    defects,
    snapshot: {
      description: "Great shape. There is a small stain on the left cuff, pictured.",
      aspects: null,
      publishedAt: "2026-08-01T00:00:00.000Z",
      lastConfirmedAt: "2026-08-10T00:00:00.000Z",
    },
    matches: [{ defectIndex: 0, confidence: 0.95 }],
  });
  assertEquals(plan.verdict, "contradicted");
  assertEquals(plan.mayAutoAssemble, true);
  const citation = plan.citations[0]!;
  // The report's own sentence, not a paraphrase of it.
  assertEquals(citation.reportText, "Small stain near the left cuff");
  assert(citation.disclosureQuote.includes("small stain on the left cuff"));
  assertEquals(citation.disclosedIn, "description");
  assertEquals(plan.photoDefectIndexes, [0]);
});

Deno.test("US-2705: the plan never claims the case is won", () => {
  // The epic's standing honesty constraint. eBay decides; we submit.
  const defects: ReportedDefect[] = [{
    issue: "Small stain near the cuff",
    defect_type: "stain",
    severity: "minor",
    location: "cuff",
    is_intentional: false,
  }];
  const plan = buildEvidencePlan({
    defects,
    snapshot: {
      description: "Small stain on the cuff.",
      aspects: null,
      publishedAt: "2026-08-01T00:00:00.000Z",
      lastConfirmedAt: "2026-08-01T00:00:00.000Z",
    },
    matches: [{ defectIndex: 0, confidence: 0.95 }],
  });
  for (const claim of [/\bwin\b/i, /\bwins\b/i, /guarantee/i, /you will win/i]) {
    assertEquals(
      claim.test(plan.reason),
      false,
      `the plan asserts an outcome we do not control: ${plan.reason}`,
    );
  }
});

// ── The disclosure reader ──────────────────────────────────────────────────

Deno.test("US-2705: a negation is not a disclosure", () => {
  // "No stains" contains the word. A reader that matched on the defect type
  // alone would read the denial as the admission.
  const defect: ReportedDefect = {
    issue: "Small stain near the cuff",
    defect_type: "stain",
    severity: "minor",
    location: "cuff",
    is_intentional: false,
  };
  const found = findDisclosure(defect, {
    description: "No stains, no holes. Cuff to shoulder measures 24 inches.",
    aspects: null,
    publishedAt: "2026-08-01T00:00:00.000Z",
    lastConfirmedAt: "2026-08-01T00:00:00.000Z",
  });
  assertEquals(found, null);
});

Deno.test("US-2705: no snapshot means no disclosure, so the seller is told the truth", () => {
  // Listings published before US-2704 have no snapshot. That is not a licence to
  // assume the disclosure was there - it is the weaker case, and the seller has
  // to know that before they decide to fight.
  const defect: ReportedDefect = {
    issue: "Small stain near the cuff",
    defect_type: "stain",
    severity: "minor",
    location: "cuff",
    is_intentional: false,
  };
  assertEquals(findDisclosure(defect, null), null);
});

// ── AC8: both modules are pure ─────────────────────────────────────────────

Deno.test("US-2705 AC8: neither module imports the supabase client", () => {
  for (const file of ["complaint-match.ts", "dispute-evidence.ts"]) {
    const src = Deno.readTextFileSync(new URL(`../lib/${file}`, import.meta.url));
    const code = src
      .replace(/\r\n/g, "\n")
      .replace(/\r\n?/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    for (const banned of ["supabase", "fetch(", "Date.now(", "new Date("]) {
      assertEquals(
        code.includes(banned),
        false,
        `${file} references ${banned}. These decide; the route acts. A clock or ` +
          "a client in here makes the fixture set untestable and the verdict " +
          "dependent on when it ran.",
      );
    }
  }
});
