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
