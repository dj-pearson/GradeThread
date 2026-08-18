// US-2557: the badge-count route's own contract, source-scanned.
//
// The route talks to the database, so what is testable here without one is the
// set of decisions ABOUT it — and each of them is a decision that compiles
// cleanly when wrong.

import { assert, assertStringIncludes } from "@std/assert";

const ROUTE = await Deno.readTextFile("src/routes/notifications.ts");
const MAIN = await Deno.readTextFile("src/main.ts");

/** Comments stripped, so a header describing a rule the code drops cannot pass. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const ROUTE_CODE = code(ROUTE);

/** The unread-count handler body. */
function handler(): string {
  const start = ROUTE_CODE.indexOf('notificationRoutes.get("/unread-count"');
  assert(start > -1, "the unread-count route is gone");
  const end = ROUTE_CODE.indexOf("\n});", start);
  assert(end > -1, "could not find the end of the handler");
  return ROUTE_CODE.slice(start, end);
}

Deno.test("US-2557: the count comes from the SESSION, never from a parameter", () => {
  // An id accepted here would turn a self-scoped counter into a cross-tenant
  // oracle — "does this account have unread mail?" — while the rest of the
  // handler looked identical.
  const h = handler();
  assertStringIncludes(h, 'c.get("userId")');
  assert(
    !/c\.req\.query\(/.test(h),
    "the handler reads a query parameter; the user id must come from the session alone",
  );
  assert(
    !/c\.req\.param\(/.test(h),
    "the handler reads a path parameter; the user id must come from the session alone",
  );
});

Deno.test("US-2557: it refuses without a session rather than counting nothing", () => {
  assertStringIncludes(handler(), "401");
});

Deno.test("US-2557: an unreadable count is 503, NOT zero", () => {
  // The whole absent-vs-zero distinction the push payload is built around. A
  // null means "could not read"; passing it through as 0 tells the client to
  // CLEAR a badge showing five unread because the database hiccupped.
  const h = handler();
  assertStringIncludes(h, "count === null");
  assertStringIncludes(h, "503");
  assert(
    !/count\s*\?\?\s*0/.test(h),
    "a nullish-coalesce to 0 turns 'unknown' into 'none', which is the bug this route exists to avoid",
  );
});

Deno.test("US-2557: it reuses the counter the push payload uses", () => {
  // Two counters would disagree eventually, and the badge a push carries and
  // the badge a client asks for have to be the same number.
  assertStringIncludes(ROUTE_CODE, "unreadNotificationCount");
  assertStringIncludes(ROUTE, "notification-badge.ts");
});

Deno.test("US-2557: the route is mounted behind authMiddleware", () => {
  // notificationRoutes carries public paths too (the unsubscribe page), so the
  // guard is per-path in main.ts rather than router-wide. A route added without
  // its line is reachable by anyone.
  // Line-precise rather than a substring over a stripped copy: main.ts is ~1700
  // lines and a non-greedy block-comment strip across a file that size can eat a
  // span containing real code. Find the LINE, and require it to be a statement
  // rather than prose mentioning one.
    const NL = String.fromCharCode(10);
  const line = MAIN.split(NL).find(
    (l) => l.trim().startsWith("app.use(") && l.includes("/api/notifications/unread-count"),
  );
  assert(line !== undefined, "the unread-count route is not mounted behind authMiddleware");
  assertStringIncludes(line, "authMiddleware");
});
