// A middleware registered twice on the same path prefix runs twice.
//
// hono does not dedupe app.use() — it walks every matching entry in
// registration order. That makes a duplicate registration invisible: the
// request still succeeds, the response is identical, and nothing logs.
//
// It is not free. authMiddleware calls supabaseAdmin.auth.getUser(token), a
// network round-trip to GoTrue. `/api/rewards/*` carried two identical
// registrations from 2026-08-07 to 2026-08-08 — added by two separate US-1851
// commits (79c5a1a8, e8e098de), each with its own explanatory comment, neither
// aware of the other — so every rewards request paid the auth latency twice.
//
// Review could not have caught it by reading either diff: each line was correct
// in isolation and the comments justified each other. What catches it is a scan
// of the assembled table, which is what this is.
//
// The guard is deliberately narrow: it fires on an EXACT (path, middleware)
// repeat. Two different middlewares on one prefix is the normal composition
// pattern (auth then rate-limit then workspace), and the same middleware on two
// different prefixes is just two route groups. Only the exact repeat is
// meaningless.

import { assertEquals } from "@std/assert";

const MAIN = new URL("../main.ts", import.meta.url);

// Native line endings on Windows would break the line split (US-2429).
const src = (await Deno.readTextFile(MAIN)).replace(/\r\n/g, "\n");

Deno.test("no app.use() registration is repeated verbatim in main.ts", () => {
  const seen = new Map<string, number[]>();

  src.split("\n").forEach((line, i) => {
    // Single-line registrations only. A multi-line app.use( … ) is almost
    // always an inline arrow function, which is unique by construction and
    // would need a real parser to compare anyway.
    const m = line.match(/^app\.use\((["'`])([^"'`]+)\1\s*,\s*(.+?)\);$/);
    if (!m) return;
    const key = `${m[2]} -> ${m[3]}`;
    const at = seen.get(key) ?? [];
    at.push(i + 1);
    seen.set(key, at);
  });

  const dupes = [...seen.entries()]
    .filter(([, lines]) => lines.length > 1)
    .map(([key, lines]) => `${key}  (main.ts:${lines.join(", main.ts:")})`);

  assertEquals(
    dupes,
    [],
    "Duplicate app.use() registration(s) in main.ts. hono runs every matching " +
      "entry, so each of these middlewares executes twice per request — and " +
      "authMiddleware in particular makes a GoTrue call each time. Delete the " +
      "later line and fold anything worth keeping from its comment into the " +
      "surviving one:\n  " + dupes.join("\n  "),
  );
});

Deno.test("the scan actually recognises the registration shape it guards", () => {
  // A guard that silently matches nothing passes forever. Pin that the regex
  // above still finds the real table, so a refactor to a different registration
  // style fails here instead of going quiet.
  const matched = src
    .split("\n")
    .filter((l) => /^app\.use\((["'`])([^"'`]+)\1\s*,\s*(.+?)\);$/.test(l));

  // The real count is in the hundreds; 50 is a floor that only trips if the
  // shape changed wholesale.
  assertEquals(
    matched.length > 50,
    true,
    `Only ${matched.length} app.use() lines matched the scan pattern. main.ts ` +
      "registers far more than that, so the pattern has stopped matching the " +
      "code and the duplicate check above is now inert. Fix the pattern.",
  );
});
