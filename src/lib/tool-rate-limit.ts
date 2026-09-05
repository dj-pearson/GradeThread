// US-2526: telling a rate limit apart from a failure, on the free public tools.
//
// Every non-OK response used to render through the same red line as a grading
// failure — "Couldn't grade that photo. Try a clearer, well-lit shot." — so a
// visitor who had simply used the tool three times went and retook a photo that
// was fine, hit the limit again, and left. That is the worst possible moment to
// blame someone's photography: they were mid-conversion.
//
// The status is enough on its own; the code is the belt-and-braces half, and it
// matches RATE_LIMITED_CODE in services/edge-functions/src/routes/
// public-grading.ts. A guard test pins the two strings together.

export const RATE_LIMITED_CODE = "rate_limited";

export function isRateLimited(status: number, body: unknown): boolean {
  if (status === 429) return true;
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { code?: unknown }).code === RATE_LIMITED_CODE
  );
}

// US-3089: the OTHER thing a free tool can be told, and the one nobody had
// wired on this side.
//
// The edge has answered 503 with `at_capacity` since US-1883 — it means the
// platform-wide daily AI ceiling is spent, so the call was refused before it
// cost anything. That is not the visitor's limit and it is not their photo: it
// is us, and it clears on its own. Rendering it through the rate-limit notice
// would tell someone on their FIRST use that they had used up their free
// allowance, and rendering it through the generic error would send them off to
// retake a photo that was fine. Both are the US-2526 mistake in a new costume.
//
// Matches AT_CAPACITY_CODE in services/edge-functions/src/routes/
// public-grading.ts; src/test/tools-limit-not-blame.test.ts pins the pair.
export const AT_CAPACITY_CODE = "at_capacity";

export function isAtCapacity(status: number, body: unknown): boolean {
  if (
    typeof body === "object" &&
    body !== null &&
    (body as { code?: unknown }).code === AT_CAPACITY_CODE
  ) {
    return true;
  }
  // A 503 with no body we could parse is the same condition seen from further
  // away — a proxy answering for an edge that never got the request. Treating
  // it as capacity is right either way: nothing the visitor can fix, and
  // nothing about their photo.
  return status === 503;
}
