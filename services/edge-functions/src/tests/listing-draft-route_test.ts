// US-3088 AC3: the two branches that PROTECT the free listing generator, driven
// through the real Hono handler rather than asserted from the source.
//
// Both are the reason an anonymous, no-account endpoint that spends money on a
// Vision call is safe to expose at all, and both are invisible to a unit test of
// the pure module: the per-IP window and the global daily AI ceiling live in the
// route, which owns the state.
//
// Neither case reaches the model. The rate-limit case sends bodies that fail the
// parser (the window is consumed BEFORE the body is read, which is the point of
// checking it first), and the capacity case is refused at the reservation.
//
// Prime env then dynamic-import, the same shape grade-check_test.ts uses: the
// route pulls in supabase.ts through ai-listing.ts.
import { assert, assertEquals } from "@std/assert";
import { AiCeilingError, reserveGlobalDailyBudget } from "../lib/ai-limiter.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");
Deno.env.set("ANTHROPIC_API_KEY", Deno.env.get("ANTHROPIC_API_KEY") ?? "test-key");

const {
  publicGradingRoutes,
  listingDraftRateLimited,
  LISTING_DRAFT_LIMIT,
  AT_CAPACITY_CODE,
  RATE_LIMITED_CODE,
} = await import("../routes/public-grading.ts");

async function post(ip: string, body: unknown): Promise<Response> {
  return await publicGradingRoutes.request("/listing-draft", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
}

Deno.test("US-3088: the window allows 3 calls per IP per hour and blocks the 4th", () => {
  const ip = "203.0.113.77";
  const t = Date.now();
  for (let i = 0; i < LISTING_DRAFT_LIMIT; i++) {
    assertEquals(listingDraftRateLimited(ip, t + i), false, `call ${i + 1} should pass`);
  }
  assert(listingDraftRateLimited(ip, t + LISTING_DRAFT_LIMIT), "the 4th call should be limited");
  // Tighter than the 5/hour its two siblings allow, because one call here is a
  // multi-photo generation rather than a single-photo read.
  assertEquals(LISTING_DRAFT_LIMIT, 3);
  // A different IP has its own budget…
  assertEquals(listingDraftRateLimited("198.51.100.4", t + 9), false);
  // …and the window slides.
  assertEquals(listingDraftRateLimited(ip, t + 60 * 60 * 1000 + 10), false);
});

Deno.test("US-3088: the 4th request in an hour is a 429 carrying rate_limited", async () => {
  const ip = "203.0.113.90";
  // A bad target fails the parser with a 400. The window is consumed anyway,
  // which is deliberate: a caller who can burn quota on requests that never
  // reach the model still gets a free retry loop against the parser.
  for (let i = 0; i < LISTING_DRAFT_LIMIT; i++) {
    const res = await post(ip, { images: ["data:image/png;base64,iVBORw0KGgo="], target: "nope" });
    assertEquals(res.status, 400, `call ${i + 1} should be a parse rejection`);
    assertEquals((await res.json()).code, "bad_target");
  }
  const limited = await post(ip, { images: [], target: "ebay" });
  assertEquals(limited.status, 429);
  const body = await limited.json();
  assertEquals(body.code, RATE_LIMITED_CODE);
  assertEquals(RATE_LIMITED_CODE, "rate_limited");
  // The message names the limit, never the photo. US-2526: the free tools used
  // to render every non-OK response as "try a clearer, well-lit shot", so a
  // visitor who had simply used the tool three times went and retook a photo
  // that was fine.
  assert(!/photo|shot|lit/i.test(body.error), body.error);
});

Deno.test("US-3088: an unknown target and a fourth image are named, not generic 400s", async () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const four = await post("203.0.113.91", { images: [png, png, png, png], target: "ebay" });
  assertEquals(four.status, 400);
  assertEquals((await four.json()).code, "too_many_images");

  const target = await post("203.0.113.92", { images: [png], target: "grailed" });
  assertEquals(target.status, 400);
  assertEquals((await target.json()).code, "bad_target");
});

Deno.test("US-3088: a spent daily AI ceiling is a 503 at_capacity, not a 500", async () => {
  // Drive the ceiling to zero remaining WITHOUT a database. With the counter
  // store unavailable, reserveGlobalDailyBudget falls back to a degraded
  // per-process count rather than failing open, so one primed call at a ceiling
  // of 1 leaves the next reservation over the line.
  const previous = Deno.env.get("AI_GLOBAL_DAILY_CALL_CEILING");
  Deno.env.set("AI_GLOBAL_DAILY_CALL_CEILING", "1");
  const noStore = () => Promise.reject(new Error("counter store unavailable"));
  try {
    await reserveGlobalDailyBudget(noStore);
    // Prove the fallback is armed before relying on it: the SECOND reservation
    // must be the one that throws, or this test would pass for the wrong reason.
    let threw = false;
    try {
      await reserveGlobalDailyBudget(noStore);
    } catch (err) {
      threw = err instanceof AiCeilingError;
    }
    assert(threw, "the degraded local ceiling did not engage; the 503 below would be a fluke");

    // A canonical 1x1 PNG, so the request is refused at the reservation rather
    // than at the magic-byte sniff.
    const onePx =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const res = await post("203.0.113.93", { images: [onePx], target: "ebay" });
    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body.code, AT_CAPACITY_CODE);
    // Non-retryable: US-1883. A capacity condition reported as the caller's
    // fault invited retries that burned the quota it was protecting.
    assertEquals(body.retryable, false);
  } finally {
    if (previous === undefined) Deno.env.delete("AI_GLOBAL_DAILY_CALL_CEILING");
    else Deno.env.set("AI_GLOBAL_DAILY_CALL_CEILING", previous);
  }
});
