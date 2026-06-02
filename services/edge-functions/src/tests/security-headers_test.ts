// US-263: hardening-header middleware unit tests.
//
// Exercises the securityHeaders() middleware against a hand-built mock Hono
// context so the test has no network/runtime dependencies beyond the
// middleware module itself. Asserts the static headers land on every response
// and that Cache-Control: no-store is scoped to user-bound surfaces (and never
// applied to /health).
import { assert, assertEquals } from "@std/assert";
import { securityHeaders } from "../middleware/security-headers.ts";

type Recorder = { headers: Record<string, string>; path: string };

function mockContext(path: string): { c: unknown; rec: Recorder } {
  const rec: Recorder = { headers: {}, path };
  const c = {
    req: { path },
    header(name: string, value: string) {
      rec.headers[name] = value;
    },
  };
  return { c, rec };
}

async function run(path: string): Promise<Recorder> {
  const { c, rec } = mockContext(path);
  // securityHeaders is a MiddlewareHandler: (c, next) => Promise<void>
  await (securityHeaders as unknown as (
    c: unknown,
    next: () => Promise<void>,
  ) => Promise<void>)(c, async () => {});
  return rec;
}

Deno.test("static hardening headers present on a normal route", async () => {
  const rec = await run("/api/content/public/posts");
  assertEquals(
    rec.headers["Strict-Transport-Security"],
    "max-age=63072000; includeSubDomains; preload",
  );
  assertEquals(rec.headers["X-Content-Type-Options"], "nosniff");
  assertEquals(rec.headers["X-Frame-Options"], "DENY");
  assertEquals(
    rec.headers["Referrer-Policy"],
    "strict-origin-when-cross-origin",
  );
  assertEquals(rec.headers["Cross-Origin-Resource-Policy"], "same-site");
});

Deno.test("no Server / X-Powered-By header is emitted by the middleware", async () => {
  const rec = await run("/api/payments/checkout");
  assert(!("Server" in rec.headers));
  assert(!("X-Powered-By" in rec.headers));
});

Deno.test("Cache-Control: no-store on sensitive user-scoped surfaces", async () => {
  for (
    const p of [
      "/api/payments/checkout",
      "/api/keys",
      "/api/admin/users",
      "/api/workspace/members",
      "/api/v1/grades/123",
      "/api/grade/submit",
      "/api/flipdesk/listings",
      "/api/notifications",
    ]
  ) {
    const rec = await run(p);
    assertEquals(
      rec.headers["Cache-Control"],
      "no-store",
      `expected no-store on ${p}`,
    );
  }
});

Deno.test("/health is exempt from no-store but still hardened", async () => {
  const rec = await run("/health");
  assertEquals(rec.headers["Cache-Control"], undefined);
  assertEquals(rec.headers["X-Content-Type-Options"], "nosniff");
});

Deno.test("public content is cacheable (no no-store)", async () => {
  const rec = await run("/api/content/public/posts/hello");
  assertEquals(rec.headers["Cache-Control"], undefined);
});

Deno.test("prefix match is boundary-safe (no false positive on lookalike path)", async () => {
  // /api/keystone must NOT be treated as the /api/keys surface.
  const rec = await run("/api/keystone/info");
  assertEquals(rec.headers["Cache-Control"], undefined);
});
