// US-1913 AC2: what a seller's two public status marks are BASED ON.
//
// A verified profile and a certificate both show a reward LEVEL and a Grade
// Integrity TIER, side by side. They look alike and mean opposite things: a
// level is how much a seller does, a tier is how right they have been proven.
// Without a tooltip a buyer reads whichever they saw first as "how good this
// seller is", which is exactly the conflation the integrity ladder exists to
// prevent — so the explanation travels WITH each mark, on every surface.
//
// These two sentences are the SSR half of a deliberate duplicate. The SPA half
// lives in src/lib/verified.ts (INTEGRITY_TIER_BASIS / LEVEL_FLAIR_BASIS);
// Pages Functions cannot import from src/, so the copies are held together by
// src/test/badge-status-parity.test.ts rather than by a shared module. Change
// one and that test fails.

export const INTEGRITY_TIER_BASIS =
  "Earned from buyers confirming, after delivery, that the grade matched. It only appears once enough buyers have confirmed.";

export const LEVEL_FLAIR_BASIS =
  "Earned from grading and selling activity on GradeThread. It measures how much a seller does, not how accurate their grades are.";
