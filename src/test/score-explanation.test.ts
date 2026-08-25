import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GRADE_FACTORS,
  GRADE_TIERS,
  GRADE_TIER_BANDS,
  GRADING_REVIEW_CONFIDENCE_THRESHOLD,
  tierBandForScore,
  tierBandRange,
} from "@/lib/constants";
import { tierLabelForGrade } from "@/lib/condition-value-curve";
import { confidenceExplanation } from "@/lib/grading-journey";

// US-2871.
//
// AC1 WAS ALREADY DONE and the story did not know it. Both report surfaces have
// rendered each factor's weight beside its label for a long time
// (`({(factor.weight * 100).toFixed(0)}%)`). "The weights are not shown" was
// not the defect. What was actually missing is the step AFTER the weights: a
// seller can read 9.5 and "30%" and still not know how five numbers became 8.7.
//
// What was genuinely absent: the arithmetic, the meaning of confidence, the
// band a tier stands for, and any parity guard on the iOS copy of the weights.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const SWIFT = "ios/GradeThread/Grading/GradeFactors.swift";

describe("the tier bands have ONE definition (US-2871 AC3)", () => {
  it("every published tier has a band", () => {
    expect(GRADE_TIER_BANDS.map((b) => b.tier)).toEqual([...GRADE_TIERS]);
  });

  it("the bands are contiguous and cover the whole scale", () => {
    // Descending, each band starting exactly where the one below ends. A gap
    // means some score renders no tier; an overlap means two claim it.
    const mins = GRADE_TIER_BANDS.map((b) => b.min);
    expect(mins).toEqual([...mins].sort((a, b) => b - a));
    expect(mins[0]).toBe(10);
    expect(mins[mins.length - 1]).toBe(1);
    for (let g = 1; g <= 10; g += 0.1) {
      const score = Math.round(g * 10) / 10;
      expect(tierBandForScore(score), `no band for ${score}`).toBeDefined();
    }
  });

  it("tierLabelForGrade delegates instead of keeping its own copy", () => {
    // It carried the bands inline, in a function whose own comment says it
    // exists so two surfaces cannot drift. A second copy for the RANGE would
    // have been exactly that mistake.
    const src = read("src/lib/condition-value-curve.ts");
    expect(src).toContain("tierBandForScore(grade).label");
    const body = src.slice(src.indexOf("export function tierLabelForGrade"));
    expect(
      /if \(g >= 9\) return/.test(body.slice(0, 400)),
      "tierLabelForGrade has its own band ladder again",
    ).toBe(false);
  });

  it("the labels it returns are unchanged", () => {
    // The refactor must be behaviour-preserving. These are the exact strings
    // the old ladder returned.
    const CASES: Array<[number, string]> = [
      [10, "New with Tags (NWT)"],
      [9.9, "New without Tags (NWOT)"],
      [9, "New without Tags (NWOT)"],
      [8.5, "Excellent"],
      [8, "Excellent"],
      [7.9, "Very Good"],
      [6, "Good"],
      [5, "Fair"],
      [4.9, "Poor"],
      [1, "Poor"],
    ];
    for (const [score, label] of CASES) {
      expect(tierLabelForGrade(score), `grade ${score}`).toBe(label);
    }
  });

  it("the ranges read as a band, and the top one is a single value", () => {
    expect(tierBandRange("NWT")).toBe("10.0");
    expect(tierBandRange("NWOT")).toBe("9.0 to 9.9");
    expect(tierBandRange("Excellent")).toBe("8.0 to 8.9");
    expect(tierBandRange("Poor")).toBe("1.0 to 4.9");
    // No en dash: CLAUDE.md bans look-alike punctuation from code, and "to"
    // reads at a lower grade level than a dash anyway.
    for (const t of GRADE_TIERS) {
      expect(/[‐-―−]/.test(tierBandRange(t)), `${t}`).toBe(false);
    }
  });

  it("both report surfaces show the band, not the tier alone", () => {
    for (const rel of ["src/pages/submission-detail.tsx", "src/pages/certificate.tsx"]) {
      const src = read(rel);
      expect(src, `${rel} does not show a tier band`).toContain("tierBandRange(");
      // The caption it replaced said nothing at all.
      expect(
        src.includes("Overall Condition Grade\n"),
        `${rel} still captions the tier with a phrase that explains nothing`,
      ).toBe(false);
    }
  });
});

describe("the arithmetic is visible (US-2871 AC1 + AC4)", () => {
  const src = read("src/components/grading/score-explainer.tsx");

  it("the explainer is mounted on both report surfaces", () => {
    for (const rel of ["src/pages/submission-detail.tsx", "src/pages/certificate.tsx"]) {
      expect(read(rel), `${rel} has no score explainer`).toContain("<ScoreExplainer");
    }
  });

  it("it shows score, share and contribution per factor, then the sum", () => {
    expect(src).toContain("r.score.toFixed(1)");
    expect(src).toContain("(r.weight * 100).toFixed(0)");
    expect(src).toContain("r.contribution.toFixed(2)");
    expect(src).toContain("total.toFixed(2)");
    expect(src).toContain("rounded.toFixed(1)");
  });

  it("it rounds the way every other site rounds", () => {
    // The vault note on this is blunt: the weighted overall has shipped wrong
    // TWICE from divergent rounding (US-1557, US-2041), once to 0.5.
    expect(src).toContain("Math.round(total * 10) / 10");
    expect(
      /Math\.round\(total \* 2\) \/ 2/.test(src),
      "the explainer rounds to 0.5, which is the exact bug US-2041 found",
    ).toBe(false);
  });

  it("it does NOT look the weights up itself", () => {
    // The certificate renders whatever rubric the grade used (US-1997), and a
    // non-clothing rubric has its own keys and weights. A version that read
    // GRADE_FACTORS compiled fine and would have shown clothing weights
    // against furniture scores.
    // Comments stripped first. The header of that file EXPLAINS why it does
    // not read GRADE_FACTORS, and an unstripped scan fires on the
    // explanation -- which has now happened five times on this epic.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(
      code.includes("GRADE_FACTORS"),
      "score-explainer reads GRADE_FACTORS; weights must be passed in so a " +
        "non-clothing rubric renders its own",
    ).toBe(false);
  });

  it("the explanation is four sentences and links nowhere", () => {
    const para = src.slice(
      src.indexOf("Each of the {rows.length}"),
      src.indexOf("</p>", src.indexOf("Each of the {rows.length}")),
    );
    expect(para.length).toBeGreaterThan(100);
    // Drop the JSX expressions first: {rows.length} carries a dot and split
    // on "." counted it as a sentence boundary.
    const sentences = para
      .replace(/\{[^}]*\}/g, "N")
      .split(".")
      .filter((x) => x.trim().length > 4);
    expect(sentences.length, "AC4 asked for four sentences").toBe(4);
    // "without linking away" is the AC's own words.
    const block = src.slice(src.indexOf("{open &&"));
    expect(/<a\s|<Link\b|href=/.test(block), "the disclosure links away").toBe(false);
  });

  it("it does not hardcode the number of factors", () => {
    expect(
      /Each of the five things/.test(src),
      "a non-clothing rubric may not have five factors",
    ).toBe(false);
    expect(src).toContain("{rows.length} things");
  });
});

describe("confidence is explained, once, with the right number (US-2871 AC2)", () => {
  it("it says what confidence is and what happens below the gate", () => {
    const c = confidenceExplanation();
    expect(c.length).toBeGreaterThan(80);
    expect(c).toMatch(/how sure/i);
    expect(c).toMatch(/person/i);
  });

  it("the threshold is read from the constant, never written out", () => {
    const src = read("src/lib/grading-journey.ts");
    // The FUNCTION BODY, not the file. Checking the file passed with the
    // body hardcoded to 75, because the constant name still appeared in the
    // import line and in the comment explaining why it is used -- a sabotage
    // survived exactly that way on the first run of this guard.
    const fn = src.slice(src.indexOf("export function confidenceExplanation"));
    const body = fn
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(
      body,
      "confidenceExplanation does not derive the threshold from the constant",
    ).toContain("GRADING_REVIEW_CONFIDENCE_THRESHOLD");
    expect(/const pct = \d+/.test(body), "the threshold is hardcoded").toBe(false);
    expect(confidenceExplanation()).toContain(
      `${Math.round(GRADING_REVIEW_CONFIDENCE_THRESHOLD * 100)}%`,
    );
    // The literal must not appear beside the constant that produces it.
    const whole = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(/`Under 75%|"Under 75%|\b75 %/.test(whole)).toBe(false);
  });

  it("it names the 0.75 gate and claims NOTHING about the 0.9 one", () => {
    // vault/20-domain/grading-scale-and-weights.md settles this. Two gates:
    // below 0.75 is mandatory review (the published, client-owned claim, true
    // and conservative), while GRADE_AUTO_APPROVE_CONFIDENCE (0.9, env-tunable
    // and disable-able) decides auto-finalization server-side. A CLIENT MUST
    // NOT RE-DERIVE THE SECOND NUMBER -- iOS claimed a 0.80 grade was "high
    // enough to certify automatically" until US-2309, and it was wrong.
    const c = confidenceExplanation();
    expect(c).toContain("75%");
    expect(/\b90%|\b0\.9\b/.test(c), "the client re-derived the server gate").toBe(
      false,
    );
    expect(
      /certif(y|ied) automatically|auto-approve/i.test(c),
      "the client claims something about auto-finalization, which is the " +
        "US-2309 mistake",
    ).toBe(false);
  });

  it("it is rendered next to the confidence value", () => {
    const src = read("src/pages/submission-detail.tsx");
    const at = src.indexOf("confidenceExplanation()");
    expect(at).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, at - 400), at);
    expect(
      before,
      "the explanation is not beside the confidence percentage",
    ).toContain("confidence_score");
  });
});

describe("iOS reads the same weights (US-2871 AC5)", () => {
  const swift = read(SWIFT);

  it("the Swift file still has a weight table to check", () => {
    // Guards the guard: a rename empties every match below and reads as pass.
    expect(swift).toContain("var weight: Double");
    expect(swift).toContain("var label: String");
  });

  it("every weight matches GRADE_FACTORS exactly", () => {
    // The Swift file has CLAIMED "Weights sum to 1.0 and match GRADE_FACTORS
    // exactly" in a comment, with nothing checking it. The vault note is
    // explicit: every UI surface reads GRADE_FACTORS rather than restating the
    // numbers. iOS restates them, so this is the only thing standing between a
    // weight change and two clients disagreeing about a published spec.
    const block = swift.slice(
      swift.indexOf("var weight: Double"),
      swift.indexOf("func score(in report"),
    );
    const CASE_TO_KEY: Record<string, keyof typeof GRADE_FACTORS> = {
      fabricCondition: "fabric_condition",
      structuralIntegrity: "structural_integrity",
      cosmeticAppearance: "cosmetic_appearance",
      functionalElements: "functional_elements",
      odorCleanliness: "odor_cleanliness",
    };
    const found = [...block.matchAll(/case \.(\w+):\s*return ([\d.]+)/g)];
    expect(found.length, "no weights parsed out of the Swift").toBe(5);
    for (const [, caseName, value] of found) {
      const key = CASE_TO_KEY[caseName!];
      expect(key, `unknown Swift case ${caseName}`).toBeDefined();
      expect(
        Number(value),
        `iOS weight for ${caseName} is ${value}, GRADE_FACTORS says ${GRADE_FACTORS[key!].weight}`,
      ).toBeCloseTo(GRADE_FACTORS[key!].weight, 10);
    }
  });

  it("the iOS weights sum to 1.0, as its own comment claims", () => {
    const block = swift.slice(
      swift.indexOf("var weight: Double"),
      swift.indexOf("func score(in report"),
    );
    const sum = [...block.matchAll(/return ([\d.]+)/g)].reduce(
      (t, m) => t + Number(m[1]),
      0,
    );
    expect(sum).toBeCloseTo(1, 10);
  });

  it("every label matches too", () => {
    const block = swift.slice(
      swift.indexOf("var label: String"),
      swift.indexOf("var weight: Double"),
    );
    const labels = [...block.matchAll(/return "([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(
      Object.values(GRADE_FACTORS).map((f) => f.label),
    );
  });
});
