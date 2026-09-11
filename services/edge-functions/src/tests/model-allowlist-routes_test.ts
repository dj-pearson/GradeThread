// US-3305 AC3/AC4: the routes that take a model NAME out of a request body.
//
// admin-ads POST /generate passed body.model straight into generateAdCopy with
// no check at all, so an admin could name any string as a model: at best the
// call 400s at Anthropic, at worst it bills a model nobody chose. The same hole
// existed on the three content routes, which is why they are exercised here too.
//
// ⚠ WHY THIS DRIVES THE REAL HANDLER. An allowlist that is never exercised is
// the shape of guard this repo has been bitten by before (memory:
// guards-that-do-not-guard) - a helper unit test proves the predicate works,
// not that the route calls it. So each case goes through Hono, through the same
// middleware stack the router declares, and asserts on the response.
//
// None of these cases reach the database or the model: every request is refused
// (or passed on to the NEXT shallow body check) before any query runs, which is
// also the second thing being asserted - validation happens before the work.

// US-2379: first, before anything that reaches lib/supabase.ts at import time.
import "./_env.ts";

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";

const { adminAdsRoutes } = await import("../routes/admin-ads.ts");
const { contentBlogRoutes } = await import("../routes/content-blog.ts");
const { contentSocialRoutes } = await import("../routes/content-social.ts");
const { contentTopicsRoutes } = await import("../routes/content-topics.ts");

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const POST_ID = "22222222-2222-4222-8222-222222222222";
const BAD_MODEL = "gpt-9-turbo-ultra";

type AdminEnv = {
  Variables: { userId: string; adminRole: "admin" | "super_admin" };
};

/**
 * Mount a router behind the admin context its middleware expects.
 *
 * super_admin because requireScope short-circuits on it without a DB read -
 * the scope gate is not what is under test here, and faking a role_scopes row
 * would only test the fake.
 */
// deno-lint-ignore no-explicit-any
function mount(prefix: string, routes: any): Hono<AdminEnv> {
  const parent = new Hono<AdminEnv>();
  parent.use("*", async (c, next) => {
    c.set("userId", ADMIN_ID);
    c.set("adminRole", "super_admin");
    await next();
  });
  parent.route(prefix, routes);
  return parent;
}

async function post(
  app: Hono<AdminEnv>,
  path: string,
  body: unknown,
): Promise<Response> {
  return await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("US-3305: /admin/ads/generate refuses a model that is not on the allowlist", async () => {
  const res = await post(mount("/ads", adminAdsRoutes), "/ads/generate", {
    platform: "google_ads",
    model: BAD_MODEL,
  });
  assertEquals(res.status, 400);
  const body = await res.json();

  // The message names the offending value AND what is allowed. "Invalid model"
  // sends an operator back to the source to find out what the set is.
  assertStringIncludes(body.error, BAD_MODEL);
  assertStringIncludes(body.error, "claude-sonnet-5");

  // THE FAILS-BEFORE ASSERTION. Without the guard the unknown model sails past
  // here and the request is refused for the NEXT missing field instead, so the
  // response reads as a normal validation error and the model was accepted.
  assert(
    !String(body.error).includes("theme_ids"),
    `the model was not validated - the request got as far as the theme_ids ` +
      `check with model="${BAD_MODEL}" still in hand: ${body.error}`,
  );
});

Deno.test("US-3305: a non-string model is refused the same way", async () => {
  const res = await post(mount("/ads", adminAdsRoutes), "/ads/generate", {
    platform: "google_ads",
    model: 42,
  });
  assertEquals(res.status, 400);
  assertStringIncludes((await res.json()).error, "claude-sonnet-5");
});

Deno.test("US-3305: an allowlisted model passes the guard and the request moves on", async () => {
  // The pass-through half of the guard. Opus 5 is allowed, so the request is
  // refused by the NEXT check (theme_ids) instead - proving the allowlist gates
  // rather than blocks, and that it runs before any database work.
  const res = await post(mount("/ads", adminAdsRoutes), "/ads/generate", {
    platform: "google_ads",
    model: "claude-opus-5",
  });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "theme_ids[] is required");
});

Deno.test("US-3305: omitting model is still fine (the admin UI never sends one)", async () => {
  const res = await post(mount("/ads", adminAdsRoutes), "/ads/generate", {
    platform: "google_ads",
  });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "theme_ids[] is required");
});

Deno.test("US-3305: the three content routes refuse an unknown model too", async () => {
  const cases: Array<[string, Hono<AdminEnv>, string, unknown]> = [
    [
      "blog",
      mount("/blog", contentBlogRoutes),
      `/blog/${POST_ID}/generate`,
      { model: BAD_MODEL },
    ],
    [
      "social",
      mount("/social", contentSocialRoutes),
      `/social/${POST_ID}/generate`,
      { model: BAD_MODEL },
    ],
    [
      "topics",
      mount("/topics", contentTopicsRoutes),
      "/topics/research",
      { surface: "blog", product_focus: "gradethread", model: BAD_MODEL },
    ],
  ];

  for (const [name, app, path, body] of cases) {
    const res = await post(app, path, body);
    assertEquals(res.status, 400, `${name} should refuse the model`);
    const json = await res.json();
    assertStringIncludes(json.error, BAD_MODEL);
    assertStringIncludes(json.error, "claude-sonnet-5");
  }
});
