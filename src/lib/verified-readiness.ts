// The Verified setup checklist: what a seller still has to do before their
// grades work as proof buyers can check. Pure, so the page and its tests agree
// on what "done" means.

export type ReadinessStepId =
  | "handle"
  | "bio"
  | "public"
  | "grade"
  | "listings"
  | "click";

export interface ReadinessStep {
  id: ReadinessStepId;
  /** Shown when the step is done. */
  doneLabel: string;
  /** Shown on the button when it is not. */
  todoLabel: string;
  done: boolean;
}

export interface ReadinessInput {
  handle: string | null;
  bio: string | null;
  enabled: boolean;
  embedInListings: boolean;
  graded: number;
  /** Badge clicks in the funnel window, or null when not known. */
  badgeClicks: number | null;
}

export function readinessSteps(i: ReadinessInput): ReadinessStep[] {
  const live = i.enabled && !!i.handle;
  return [
    { id: "handle", doneLabel: "Handle claimed", todoLabel: "Claim a handle", done: !!i.handle },
    // The display name is optional: the public page falls back to the handle.
    { id: "bio", doneLabel: "Bio written", todoLabel: "Write a short bio", done: !!i.bio?.trim() },
    { id: "public", doneLabel: "Profile public", todoLabel: "Make profile public", done: live },
    { id: "grade", doneLabel: "First certified grade", todoLabel: "Grade your first item", done: i.graded > 0 },
    {
      id: "listings",
      doneLabel: "Credentials in listings",
      todoLabel: "Add credentials to listings",
      done: live && i.embedInListings,
    },
    {
      id: "click",
      doneLabel: "First badge click",
      todoLabel: "Paste a badge into a listing",
      done: (i.badgeClicks ?? 0) > 0,
    },
  ];
}
