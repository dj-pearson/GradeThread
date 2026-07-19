// A rejected scheduler request must produce a RESPONSE, not an unfinalized
// context.
//
// Found in production via Sentry: "Context is not finalized. You may forget
// returning Response object or `await next()`" thrown from hono-base.ts:358 on
// POST /api/newsletter/scheduler/tick — 168 times, hourly, every run since
// 2026-07-01.
//
// Cause: schedulerAuth's JWT fallback ran the auth middlewares but DISCARDED
// their return value:
//
//     await authMiddleware(c, async () => { await adminAuthMiddleware(c, next) })
//     // middleware ends -> returns undefined
//
// Hono finalizes a context from the middleware's RETURN VALUE. authMiddleware
// built its 401, the wrapper dropped it, nothing finalized, and Hono threw —
// so onError turned a clean 401 into a 500. The framework error carried no
// stack, which hid the real cause (a job secret that no longer verifies) for
// 18 days while the newsletter kickoff never ran.
//
// The same wrapper is copy-pasted in content-scheduler.ts and drip.ts, so all
// three are asserted here.
import { assert, assertEquals } from "@std/assert";

const FILES = [
  "newsletter-scheduler",
  "content-scheduler",
  "drip",
] as const;

async function source(name: string): Promise<string> {
  const url = new URL(`../routes/${name}.ts`, import.meta.url);
  return await Deno.readTextFile(url);
}

Deno.test("scheduler auth fallbacks propagate the rejection response", async () => {
  for (const name of FILES) {
    const text = await source(name);

    // The fallback must exist — if the wrapper is renamed or removed, this test
    // should fail loudly rather than pass over a file it no longer understands.
    assert(
      text.includes("authMiddleware("),
      `${name}.ts no longer calls authMiddleware — update this guard rather than deleting it`,
    );

    // The bare, value-discarding form is what shipped the bug.
    const discards = /(?<!return\s)(?<!=\s)await authMiddleware\(/.test(text) &&
      !/return innerResponse \?\? outerResponse/.test(text);
    assert(
      !discards,
      `${name}.ts discards the auth middleware's response. Hono finalizes from ` +
        "the RETURN value, so a rejected request produces no response at all and " +
        'Hono throws "Context is not finalized" (surfacing as a 500, not a 401).',
    );
  }
});

// Behavioural half: a middleware shaped like the old one leaves the context
// unfinalized, and the fixed shape does not. This pins the FRAMEWORK behaviour
// the fix depends on, so a Hono upgrade that changed it would fail here rather
// than silently reintroduce 500s.
Deno.test("Hono finalizes from the middleware return value", async () => {
  const { Hono } = await import("hono");

  const rejecting = (_c: unknown, _next: () => Promise<void>) =>
    Promise.resolve(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }));

  // BROKEN shape: awaits the inner middleware, returns nothing.
  const broken = new Hono();
  broken.use("/*", async (c, next) => {
    await rejecting(c, next);
  });
  broken.post("/tick", (c) => c.json({ ok: true }));
  broken.onError((_err, c) => c.json({ error: "Internal server error" }, 500));

  const brokenRes = await broken.request("/tick", { method: "POST" });
  assertEquals(
    brokenRes.status,
    500,
    "the discarding shape should collapse into a 500 — if this ever returns 401, " +
      "Hono changed and the guard above can be relaxed",
  );

  // FIXED shape: returns the response.
  const fixed = new Hono();
  fixed.use("/*", async (c, next) => {
    return await rejecting(c, next);
  });
  fixed.post("/tick", (c) => c.json({ ok: true }));
  fixed.onError((_err, c) => c.json({ error: "Internal server error" }, 500));

  const fixedRes = await fixed.request("/tick", { method: "POST" });
  assertEquals(fixedRes.status, 401, "returning the response must yield a clean 401");
});
