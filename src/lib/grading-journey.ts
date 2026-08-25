import {
  GRADETHREAD_TIERS,
  GRADING_REVIEW_CONFIDENCE_THRESHOLD,
  type GradeTierKey,
} from "@/lib/constants";
import type { SubmissionStatus } from "@/types/database";

// US-2870. What happens after you press submit.
//
// A first grade is the product's core promise and its longest wait. The screen
// the seller lands on said what state the row was in and almost nothing else:
// not what arrives at the end, not what "pending review" means, not whether it
// costs more, and not that we email them. Every one of those is a support
// ticket or a quiet abandonment.
//
// ─── TWO THINGS THIS FILE GETS RIGHT THAT THE OBVIOUS VERSION GETS WRONG ───
//
// 1. THE SLA IS A CEILING, NOT AN EXPECTATION. GRADETHREAD_TIERS.slaHours is
//    48 / 12 / 1, and a first draft of this file printed "usually about 48
//    hours" for Standard. That is false and unkind: grades finish in minutes.
//    The repo already reconciles the two in marketing-jsonld.ts -- "Most
//    grades complete within minutes", with the tier SLA as the guaranteed
//    outer bound -- and in-app copy has to say the same thing or the product
//    contradicts its own schema.org answers.
//
// 2. NO NUMBER FOR THE REVIEW GATE. There are TWO thresholds and they are
//    easy to confuse:
//      • GRADING_REVIEW_CONFIDENCE_THRESHOLD (0.75) sets the
//        `needs_human_review` FLAG, alongside several caps that force review
//        for their own reasons (partial image set, peer-norm outlier, no
//        fabric close-up, tamper hits).
//      • GRADE_AUTO_APPROVE_CONFIDENCE (default 0.9) is the gate that decides
//        whether a clean grade may SKIP the queue -- and it can be set to
//        "off", in which case every grade is reviewed by a person.
//    A first draft of this file said "below 75% a person checks it". That is
//    the wrong threshold for that claim. The copy below names the CONDITION
//    instead, which stays true whichever number an operator sets and which is
//    also the plainer sentence. The grading-engine skill's own rule: two
//    copies of a number is how this repo grew contradictory procedures.
//
// THIS FILE IS THE "SAME SOURCE STRINGS" AC4 ASKS FOR. No JSX, no hooks, one
// constants import. The iOS twin is hand-written Swift fenced with a parity
// test, which is how this repo already does BuyerEntitlements.swift -- there
// is no TypeScript-to-Swift generator today and US-2876 is building one.

/**
 * What actually happens, for the overwhelming majority of grades.
 *
 * Deliberately not a promise with a number in it. "A few minutes" matches the
 * observed latency and every public claim the product already makes.
 */
export const TYPICAL_TURNAROUND = "Most grades come back in a few minutes.";

/**
 * The guaranteed outer bound for a tier: "48 hours", "12 hours", "1 hour".
 *
 * Read from GRADETHREAD_TIERS so it cannot drift from pricing. Phrased by the
 * caller as a ceiling ("guaranteed within"), never as an expectation.
 */
export function slaCeilingFor(tier: GradeTierKey): string {
  const hours = GRADETHREAD_TIERS[tier].slaHours;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** The full turnaround sentence: what usually happens, then the guarantee. */
export function turnaroundCopy(tier: GradeTierKey | null): string {
  if (!tier) return TYPICAL_TURNAROUND;
  return `${TYPICAL_TURNAROUND} Your ${GRADETHREAD_TIERS[tier].label} grade is guaranteed within ${slaCeilingFor(tier)}.`;
}

/** The four things a finished grade actually produces. */
export const WHAT_YOU_GET: ReadonlyArray<{ title: string; detail: string }> = [
  {
    title: "A grade from 1.0 to 10.0",
    detail: "One number for how worn the garment is.",
  },
  {
    title: "Five factor scores",
    detail:
      "Fabric, stitching, looks, zips and buttons, and smell. Each one scored and explained.",
  },
  {
    title: "A condition report",
    detail: "Plain sentences saying what we found, including every flaw.",
  },
  {
    title: "A certificate you can share",
    detail:
      "Its own page with its own number. A buyer can look it up, so they do not have to take your word for it.",
  },
];

/**
 * Human review, in plain words.
 *
 * `what` names the CONDITION rather than a confidence percentage, for the
 * reason in the header. It is also the true shape of the rule: a grade skips
 * the queue only when it is confident AND unflagged AND not force-reviewed,
 * and an operator can turn skipping off entirely.
 */
export const HUMAN_REVIEW = {
  what:
    "A person checks the grade unless the AI is sure and nothing about the photos looks unusual.",
  cost: "It costs nothing extra. You are never charged twice for one garment.",
  wait: "It takes longer than an automatic grade, so this one may run past a few minutes.",
  certificate:
    "Your certificate goes live once it is official, and the score can move slightly.",
} as const;

/**
 * Where the answer turns up. The app never said we email, and we do: the edge
 * sends both a preliminary and a finalized email unless the seller turned the
 * grade_complete preference off.
 */
export const WHERE_IT_APPEARS =
  "It appears on this page and in Submissions. We also email you, so you do not have to sit here.";

/**
 * What each status MEANS, which the app has never said.
 *
 * SUBMISSION_STATUS_TONE gives every status a colour and nothing else, and
 * both the detail page and the list render the label through a generic
 * underscore-splitter -- so a seller sees an amber pill reading "Pending
 * Review" and has to guess. Each entry answers what state it is in, what that
 * means, and whether they have to do anything.
 *
 * `needsYou` is the one that earns its place: three of these eight statuses
 * are waiting on the SELLER and not one of them said so.
 */
export interface StageCopy {
  /** Short label for the pill. Plain words, no underscores. */
  label: string;
  /** What is happening, in one sentence. */
  meaning: string;
  /** What the seller should do. Empty when the honest answer is "nothing". */
  whatNow: string;
  /** True when the submission is blocked until the seller acts. */
  needsYou: boolean;
}

export const SUBMISSION_STAGE_COPY: Record<SubmissionStatus, StageCopy> = {
  pending: {
    label: "Finishing checkout",
    meaning: "We are confirming your payment. Grading starts on its own once it clears.",
    whatNow: "",
    needsYou: false,
  },
  processing: {
    label: "Being graded",
    meaning: "The AI is reading your photos now.",
    whatNow: "",
    needsYou: false,
  },
  pending_review: {
    label: "A person is checking it",
    meaning: HUMAN_REVIEW.what,
    whatNow: "",
    needsYou: false,
  },
  completed: {
    label: "Graded",
    meaning: "Your grade and certificate are ready.",
    whatNow: "Read the report, or send the certificate to a buyer.",
    needsYou: false,
  },
  needs_photos: {
    label: "We need clearer photos",
    meaning:
      "The photos were not clear enough to grade fairly, so we stopped instead of guessing.",
    whatNow: "Add sharper photos and send it again. You have not been charged.",
    needsYou: true,
  },
  failed: {
    label: "It did not finish",
    meaning: "Something went wrong on our side.",
    whatNow: "Try again, or contact support. You are only charged for a finished grade.",
    needsYou: true,
  },
  disputed: {
    label: "You questioned this grade",
    meaning: "You told us this grade looks wrong and we are looking at it.",
    whatNow: "",
    needsYou: false,
  },
  expired: {
    label: "Never paid for",
    meaning: "This was started but never paid for, so we closed it.",
    whatNow: "Start a new one when you are ready.",
    needsYou: true,
  },
};

/** Statuses where the grade is still coming. Drives the reassurance panel. */
export const IN_FLIGHT_STATUSES: readonly SubmissionStatus[] = [
  "pending",
  "processing",
  "pending_review",
];

export function isInFlight(status: SubmissionStatus): boolean {
  return IN_FLIGHT_STATUSES.includes(status);
}

/**
 * The one-line explanation that sits beside the confidence number (AC2).
 *
 * IT NAMES 0.75 AND THAT IS DELIBERATE. There are two gates and only one of
 * them belongs to the client: below 0.75 a grade is flagged for mandatory
 * review, while GRADE_AUTO_APPROVE_CONFIDENCE (0.9, env-tunable, disable-able)
 * decides auto-finalization server-side. vault/20-domain/grading-scale-and-
 * weights.md settles it: the public claim "anything under 0.75 gets a human"
 * is TRUE and conservative, because in practice everything under 0.9 does, and
 * A CLIENT MUST NOT RE-DERIVE THE SECOND NUMBER. So this states the threshold
 * the client owns, reads it from the constant, and claims nothing about the
 * other one.
 */
export function confidenceExplanation(): string {
  const pct = Math.round(GRADING_REVIEW_CONFIDENCE_THRESHOLD * 100);
  return (
    `How sure the AI was, based on how clearly your photos showed the garment. ` +
    `Under ${pct}% a person always checks the grade before it becomes official.`
  );
}
