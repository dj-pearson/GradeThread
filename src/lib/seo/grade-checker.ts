// Free Condition Grade Estimator tool (US-1687): /tools/grade-checker.
//
// A no-signup tool that gives a ROUGH grade from one photo — organic-link and
// Reddit-share bait that converts TOFU visitors. The tool posts to the
// unauthenticated edge endpoint /api/grading/public/grade-check (which reuses
// the real grader via quickGrade, hardens the upload, and rate-limits). The
// output is always framed as a rough estimate with an upsell to a full grade.
//
// PURE DATA: imports only the PublicRoute TYPE. JSON-LD composed in
// src/pages/marketing/marketing-jsonld.ts.

import type { PublicRoute } from "./public-routes";

export const GRADE_CHECKER_PATH = "/tools/grade-checker";

/** The unauthenticated edge endpoint path (joined to edgeApiUrl() at call time). */
export const GRADE_CHECKER_ENDPOINT = "/api/grading/public/grade-check";

export const GRADE_CHECKER_META = {
  path: GRADE_CHECKER_PATH,
  title: "Free Clothing Condition Grade Checker",
  description:
    "Free condition grade estimator: upload one photo of a clothing item and get a rough 1.0–10.0 condition grade in seconds. No signup — try it now.",
  h1: "Free clothing condition grade checker",
  intro:
    "Upload one photo of a pre-owned clothing item and get a rough condition grade on the 1.0–10.0 scale — no account, no cost. It's a fast gut-check before you list; a full certified grade uses more photos and human review for a number buyers can verify.",
  steps: [
    { name: "Upload one photo", text: "Pick a clear, well-lit photo of the whole garment. Front-on works best." },
    { name: "Get a rough grade", text: "The same AI grader that powers certified grades gives a quick 1.0–10.0 estimate across the five condition factors." },
    { name: "List with confidence", text: "Use the estimate as a gut-check, then get a full certified grade and shareable certificate when you're ready to list." },
  ],
  faqs: [
    {
      q: "Is the free grade checker accurate?",
      a: "It's a rough estimate from a single photo, so treat it as a gut-check, not a verdict. A full GradeThread grade uses front, back, label, and detail photos scored across five weighted factors, with human review on low-confidence cases — that's the number buyers can verify on a certificate.",
    },
    {
      q: "Do I need an account to check a grade?",
      a: "No. The free grade checker takes one photo and returns a rough grade with no signup. You only need an account when you want a full certified grade and a shareable certificate.",
    },
    {
      q: "What is a good condition grade for used clothes?",
      a: "On the 1.0–10.0 scale, roughly 7.5+ is Excellent, 6.0–7.0 is Very Good, and 4.5–5.5 is Good. Higher grades sell faster and hold value; the grade checker gives you a rough band so you know where an item sits before you price it.",
    },
  ],
};

export function isGradeCheckerPath(path: string): boolean {
  return path.replace(/\/+$/, "") === GRADE_CHECKER_PATH;
}

export function gradeCheckerRoute(): PublicRoute {
  return {
    path: GRADE_CHECKER_PATH,
    title: GRADE_CHECKER_META.title,
    description: GRADE_CHECKER_META.description,
    changefreq: "monthly",
    priority: 0.7,
    jsonLdType: "WebApplication",
  };
}
