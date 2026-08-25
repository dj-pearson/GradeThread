import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  HUMAN_REVIEW,
  SUBMISSION_STAGE_COPY,
  TYPICAL_TURNAROUND,
  WHAT_YOU_GET,
  WHERE_IT_APPEARS,
  isInFlight,
  slaCeilingFor,
  turnaroundCopy,
} from "@/lib/grading-journey";
import { GRADETHREAD_TIERS } from "@/lib/constants";

// US-2870.
//
// WHAT THE SURVEY ACTUALLY FOUND, because the story was half right and the
// half it got wrong matters more than the half it got right.
//
// Right: nothing after submit says what you receive, that review is free, or
// that we email you. Those were absent from the web entirely.
//
// WRONG: "the user presses submit and gets a status". The post-submit screen
// DID make a duration claim -- "This usually takes a few moments" -- and the
// problem was that the product already carried TWO contradictory families of
// turnaround claim:
//   the SLA numbers  48h / 12h / 1h  (landing, pricing, billing, the form)
//   "in minutes"     (how-it-works, for-resellers, the schema.org FAQ, help)
// A naive fix that printed slaHours after submit would have told a seller
// their grade takes about 48 hours when it takes about four minutes.
// marketing-jsonld.ts had already reconciled them -- most grades finish in
// minutes, the SLA is the guaranteed ceiling -- and this pins that reading.
//
// The other trap, and the one worth reading twice: THERE ARE TWO CONFIDENCE
// THRESHOLDS. GRADING_REVIEW_CONFIDENCE_THRESHOLD (0.75) sets the
// needs_human_review FLAG; GRADE_AUTO_APPROVE_CONFIDENCE (default 0.9)
// decides whether a clean grade may SKIP the queue, and it can be set to
// "off". A first draft of this copy said "below 75% a person checks it",
// which is the wrong threshold for that sentence. The copy names the
// condition instead.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const SWIFT_PATH = "ios/GradeThread/Grading/GradingJourneyCopy.swift";

describe("the turnaround claim is a ceiling, not a promise (US-2870)", () => {
  it("the typical case is minutes, and says so without a number", () => {
    expect(TYPICAL_TURNAROUND).toMatch(/minutes/i);
    expect(
      /\b\d+\s*(hour|hr)/i.test(TYPICAL_TURNAROUND),
      "the typical-turnaround line names an hour figure. slaHours is the " +
        "guaranteed ceiling; a Standard grade finishes in minutes, and " +
        "printing 48 hours here contradicts the product's own schema.org " +
        "answers as well as the seller's experience.",
    ).toBe(false);
  });

  it("the ceiling is read from the tier table, never restated", () => {
    for (const [key, cfg] of Object.entries(GRADETHREAD_TIERS)) {
      const ceiling = slaCeilingFor(key as keyof typeof GRADETHREAD_TIERS);
      expect(ceiling).toContain(String(cfg.slaHours));
    }
    expect(slaCeilingFor("express")).toBe("1 hour");
    expect(slaCeilingFor("standard")).toBe("48 hours");
  });

  it("the full sentence says usually-minutes THEN guaranteed-within", () => {
    const copy = turnaroundCopy("standard");
    expect(copy).toContain(TYPICAL_TURNAROUND);
    expect(copy).toMatch(/guaranteed within 48 hours/);
    // Order matters: the expectation first, the ceiling second. Reversed, it
    // reads as "this takes two days (but sometimes less)".
    expect(copy.indexOf("minutes")).toBeLessThan(copy.indexOf("guaranteed"));
  });

  it("no tier means no guarantee sentence, not a made-up one", () => {
    expect(turnaroundCopy(null)).toBe(TYPICAL_TURNAROUND);
  });

  it("the source file does not hardcode a tier's hours", () => {
    const src = read("src/lib/grading-journey.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const hours of [48, 12]) {
      expect(
        new RegExp(`\\b${hours}\\s*hour`, "i").test(src),
        `grading-journey.ts writes "${hours} hours" as a literal instead of ` +
          "reading GRADETHREAD_TIERS",
      ).toBe(false);
    }
  });
});

describe("human review is explained without a threshold number (US-2870 AC2)", () => {
  it("it says what happens, in one sentence", () => {
    expect(HUMAN_REVIEW.what.length).toBeGreaterThan(40);
    expect(HUMAN_REVIEW.what).toMatch(/person/i);
  });

  it("it says it costs nothing extra", () => {
    expect(HUMAN_REVIEW.cost).toMatch(/nothing extra|no extra|free/i);
    expect(HUMAN_REVIEW.cost).toMatch(/never charged twice|not charged twice/i);
  });

  it("NO confidence percentage appears in any of the review copy", () => {
    // The reason is in this file's header: two thresholds, one of them
    // tunable to "off", and the obvious one to quote is the wrong one.
    const all = Object.values(HUMAN_REVIEW).join(" ");
    expect(
      /\d+\s*%/.test(all),
      "the human-review copy names a percentage. There are TWO thresholds " +
        "(needs_human_review at 0.75, auto-approve at 0.9 and disable-able), " +
        "so any single number here is wrong for at least one of them.",
    ).toBe(false);
    expect(/0\.\d+/.test(all)).toBe(false);
  });

  it("no web surface states a review threshold percentage either", () => {
    // The certificate had this removed by US-2399 and submission-detail kept
    // its own version until this story.
    for (const rel of [
      "src/pages/submission-detail.tsx",
      "src/pages/example.tsx",
      "src/components/submission/what-happens-next.tsx",
    ]) {
      const body = read(rel)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(
        /below\s+\{?\s*(Math\.round\(GRADING_REVIEW|75%)/.test(body),
        `${rel} states a review-threshold percentage`,
      ).toBe(false);
    }
  });

  it("submission-detail no longer says review is the low-confidence exception", () => {
    const body = read("src/pages/submission-detail.tsx")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(
      /lower-confidence grades\s+are routed to a human reviewer/.test(
        body.replace(/\s+/g, " "),
      ),
      "this is the exact sentence US-2399 removed from certificate.tsx for " +
        "implying review is the EXCEPTION. submission-detail kept it.",
    ).toBe(false);
  });
});

describe("the post-submit screen answers all four questions (US-2870 AC1)", () => {
  const panel = read("src/components/submission/what-happens-next.tsx");
  const page = read("src/pages/submission-detail.tsx");

  it("the panel is mounted on every in-flight branch", () => {
    // Two branches render a spinner: processing (AI running) and pending
    // (checkout clearing). A seller waiting on either has the same questions.
    const mounts = (page.match(/<WhatHappensNext/g) ?? []).length;
    expect(
      mounts,
      "the reassurance panel should render on BOTH in-flight branches",
    ).toBe(2);
  });

  it("it lists what you receive, all four things", () => {
    expect(WHAT_YOU_GET).toHaveLength(4);
    const titles = WHAT_YOU_GET.map((w) => w.title.toLowerCase()).join(" | ");
    expect(titles).toMatch(/1\.0 to 10\.0/);
    expect(titles).toMatch(/five factor/);
    expect(titles).toMatch(/condition report/);
    expect(titles).toMatch(/certificate/);
    for (const w of WHAT_YOU_GET) {
      expect(w.detail.length, `${w.title} has no explanation`).toBeGreaterThan(25);
    }
    expect(panel).toContain("WHAT_YOU_GET");
  });

  it("it says where the result appears AND that we email", () => {
    // The edge sends a preliminary and a finalized email and the app never
    // mentioned either, so a seller had no reason not to sit and watch.
    expect(WHERE_IT_APPEARS).toMatch(/submissions/i);
    expect(WHERE_IT_APPEARS).toMatch(/email/i);
    expect(panel).toContain("WHERE_IT_APPEARS");
  });

  it("the panel writes no copy of its own", () => {
    // Every sentence has to come from grading-journey.ts, or the iOS parity
    // test below is checking a file that is no longer the source.
    const jsxText = panel
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .match(/>[^<>{}]{25,}</g);
    expect(
      jsxText,
      `the panel hardcodes copy instead of importing it: ${jsxText?.join(" / ")}`,
    ).toBeNull();
  });
});

describe("every submission status says what it means (US-2870)", () => {
  it("all eight are covered", () => {
    const STATUSES = [
      "pending", "processing", "pending_review", "completed",
      "failed", "disputed", "needs_photos", "expired",
    ] as const;
    for (const s of STATUSES) {
      const copy = SUBMISSION_STAGE_COPY[s];
      expect(copy, `${s} has no copy`).toBeDefined();
      expect(copy.label.length, `${s} label`).toBeGreaterThan(4);
      expect(copy.meaning.length, `${s} meaning`).toBeGreaterThan(20);
      // The label is what replaces a mechanical underscore-split, so it must
      // not be one.
      expect(copy.label.includes("_"), `${s} label is still a raw status`).toBe(false);
    }
  });

  it("the statuses waiting on the SELLER say so and say what to do", () => {
    // Three of eight are blocked on the user and not one of them said so.
    const blocked = Object.entries(SUBMISSION_STAGE_COPY)
      .filter(([, c]) => c.needsYou)
      .map(([k]) => k);
    expect(blocked.sort()).toEqual(["expired", "failed", "needs_photos"]);
    for (const k of blocked) {
      expect(
        SUBMISSION_STAGE_COPY[k as keyof typeof SUBMISSION_STAGE_COPY].whatNow.length,
        `${k} needs the seller to act and does not say what to do`,
      ).toBeGreaterThan(20);
    }
  });

  it("in-flight is exactly the three that are still coming", () => {
    expect(isInFlight("processing")).toBe(true);
    expect(isInFlight("pending")).toBe(true);
    expect(isInFlight("pending_review")).toBe(true);
    expect(isInFlight("completed")).toBe(false);
    expect(isInFlight("needs_photos")).toBe(false);
  });
});

describe("iOS says the same words (US-2870 AC4)", () => {
  const swift = read(SWIFT_PATH);
  const fenced = swift.slice(
    swift.indexOf("// BEGIN GENERATED TABLE"),
    swift.indexOf("// END GENERATED TABLE"),
  );

  it("the fenced table exists", () => {
    // Guards the guard: without the fence every assertion below searches an
    // empty string and passes.
    expect(swift).toContain("// BEGIN GENERATED TABLE");
    expect(swift).toContain("// END GENERATED TABLE");
    expect(fenced.length).toBeGreaterThan(500);
  });

  it("carries the same turnaround and where-it-appears lines", () => {
    expect(fenced).toContain(TYPICAL_TURNAROUND);
    expect(fenced).toContain(WHERE_IT_APPEARS);
  });

  it("carries the same human-review sentences", () => {
    for (const [key, value] of Object.entries(HUMAN_REVIEW)) {
      expect(fenced, `humanReview.${key} differs on iOS`).toContain(value);
    }
  });

  it("carries the same four deliverables, in the same order", () => {
    const titles = [...fenced.matchAll(/title:\s*"([^"]+)"/g)].map((m) => m[1]);
    const details = [...fenced.matchAll(/detail:\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(titles).toEqual(WHAT_YOU_GET.map((w) => w.title));
    expect(details).toEqual(WHAT_YOU_GET.map((w) => w.detail));
  });

  it("the iOS views actually use it", () => {
    // A copy file nothing references is dead weight that drifts quietly.
    for (const rel of [
      "ios/GradeThread/Grading/GradeReportView.swift",
      "ios/GradeThread/Grading/GradeRequestSheet.swift",
    ]) {
      expect(read(rel), `${rel} does not reference the shared copy`).toContain(
        "GradingJourneyCopy.",
      );
    }
  });

  it("iOS no longer names a certify threshold either", () => {
    const body = read("ios/GradeThread/Grading/GradeReportView.swift")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/^\s*\/\/\/.*$/gm, "");
    expect(
      /confidence is below our certify threshold/.test(body),
      "GradeReportView still frames review as a low-confidence exception",
    ).toBe(false);
  });
});
