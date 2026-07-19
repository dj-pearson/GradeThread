// A malformed certificate id must 404, not 500.
//
// certificate_id is a uuid COLUMN. Passing a non-UUID straight into `.eq()`
// makes Postgres raise 22P02 ("invalid input syntax for type uuid"), which
// publicError() reports as a 500 AND captures to Sentry — a fresh issue per
// distinct junk value, since the id is in the message. Five such issues were
// open in production from ordinary scanner traffic: EXAMPLE, not-a-uuid-xyz,
// %3Cid%3E, &lt;id&gt;&quot, abcdef01-2345-6789.
//
// The real damage was downstream. functions/cert/[id].ts treats any non-404
// upstream reply as UpstreamUnavailable (US-2044 — deliberately, so a transient
// blip is never reported to a crawler as "gone") and answers 503 + Retry-After.
// So /cert/EXAMPLE returned 503 in production: a permanently invalid URL asking
// search engines to retry it. Verified live before the fix.
//
// These are source guards rather than HTTP tests because the routes need a
// live Supabase; the property is "the guard exists and precedes the query",
// which is checkable statically and is exactly what regressed.
import { assert } from "@std/assert";

const ROUTE_FILE = new URL("../routes/content-public.ts", import.meta.url);

/** Routes whose :id is a certificate_id UUID and must be validated. */
const UUID_ROUTES = [
  '"/certificates/:id"',
  '"/cert-image/:id"',
  '"/certificates/:id/verify"',
];

Deno.test("every certificate-UUID route rejects a malformed id before querying", async () => {
  const src = await Deno.readTextFile(ROUTE_FILE);

  assert(
    src.includes("function isUuid("),
    "the isUuid helper is gone — a malformed certificate id would reach Postgres " +
      "again and surface as a 500 (and a 503 from the cert SSR)",
  );

  for (const route of UUID_ROUTES) {
    const at = src.indexOf(`contentPublicRoutes.get(${route}`);
    assert(at !== -1, `route ${route} not found — update this guard rather than deleting it`);

    // The validation must appear inside the handler's opening lines, BEFORE any
    // supabase call, otherwise the bad value still reaches the database.
    const head = src.slice(at, at + 700);
    const guardAt = head.indexOf("isUuid(");
    assert(
      guardAt !== -1,
      `${route} does not validate its id with isUuid() — a non-UUID reaches ` +
        "Postgres and raises 22P02, which publicError turns into a 500",
    );

    const queryAt = head.search(/supabaseAdmin|loadPublicCertReport|loadCertImage/);
    if (queryAt !== -1) {
      assert(
        guardAt < queryAt,
        `${route} validates its id AFTER it starts querying — the malformed ` +
          "value still reaches the database",
      );
    }
  }
});

Deno.test("the UUID pattern accepts real ids and rejects the observed junk", async () => {
  const src = await Deno.readTextFile(ROUTE_FILE);
  const m = /const UUID_RE\s*=\s*\n?\s*(\/\^.+?\/i);/s.exec(src);
  assert(m, "UUID_RE not found in the expected form");
  const re = new RegExp(m[1]!.slice(1, m[1]!.lastIndexOf("/")), "i");

  // Real certificate ids must still pass.
  for (const good of [
    "550e8400-e29b-41d4-a716-446655440000",
    "3F2504E0-4F89-11D3-9A0C-0305E82C3301",
  ]) {
    assert(re.test(good), `${good} should be accepted`);
  }

  // Every value that actually produced a Sentry issue in production.
  for (const bad of [
    "EXAMPLE",
    "not-a-uuid-xyz",
    "<id>",
    "&lt;id&gt;&quot",
    "abcdef01-2345-6789",
    "",
    "550e8400-e29b-41d4-a716-44665544000",
    "550e8400e29b41d4a716446655440000",
  ]) {
    assert(!re.test(bad), `${bad} should be rejected`);
  }
});
