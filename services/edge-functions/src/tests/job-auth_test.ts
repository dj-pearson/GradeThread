// US-360: internal job-secret auth — constant-time compare, fail-closed, and
// dual-secret overlap rotation.
import { assert, assertEquals } from "@std/assert";
import {
  requireJobSecret,
  timingSafeEqual,
  verifyJobSecret,
} from "../lib/job-auth.ts";

function setEnv(primary?: string, old?: string) {
  if (primary === undefined) Deno.env.delete("FLIPDESK_INTERNAL_JOB_SECRET");
  else Deno.env.set("FLIPDESK_INTERNAL_JOB_SECRET", primary);
  if (old === undefined) Deno.env.delete("FLIPDESK_INTERNAL_JOB_SECRET_OLD");
  else Deno.env.set("FLIPDESK_INTERNAL_JOB_SECRET_OLD", old);
}

Deno.test("timingSafeEqual: correctness", async () => {
  assert(await timingSafeEqual("abc", "abc"));
  assertEquals(await timingSafeEqual("abc", "abd"), false);
  // Differing lengths must not throw and must be unequal.
  assertEquals(await timingSafeEqual("abc", "abcdef"), false);
});

Deno.test("verifyJobSecret: matches the primary env secret", async () => {
  setEnv("super-secret");
  assert(await verifyJobSecret("super-secret"));
});

Deno.test("verifyJobSecret: rejects a wrong secret", async () => {
  setEnv("super-secret");
  assertEquals(await verifyJobSecret("nope"), false);
});

Deno.test("verifyJobSecret: fail-closed when env unset", async () => {
  setEnv(undefined);
  assertEquals(await verifyJobSecret("anything"), false);
});

Deno.test("verifyJobSecret: fail-closed on empty/missing provided", async () => {
  setEnv("super-secret");
  assertEquals(await verifyJobSecret(""), false);
  assertEquals(await verifyJobSecret(null), false);
  assertEquals(await verifyJobSecret(undefined), false);
});

Deno.test("verifyJobSecret: overlap rotation accepts both primary and OLD", async () => {
  setEnv("new-secret", "old-secret");
  assert(await verifyJobSecret("new-secret"));
  assert(await verifyJobSecret("old-secret"));
  assertEquals(await verifyJobSecret("retired-long-ago"), false);
});

Deno.test("verifyJobSecret: explicit expected scopes to that value (no env fallback)", async () => {
  setEnv("flipdesk-secret");
  // Explicit expected (e.g. CONTENT_INTERNAL_JOB_SECRET) must NOT fall back to
  // the FLIPDESK env secret.
  assert(await verifyJobSecret("content-secret", "content-secret"));
  assertEquals(await verifyJobSecret("flipdesk-secret", "content-secret"), false);
  // Empty expected => never matches (falls through to admin JWT in callers).
  assertEquals(await verifyJobSecret("anything", ""), false);
});

Deno.test("requireJobSecret: reads X-Internal-Job-Secret header", async () => {
  setEnv("hdr-secret");
  const c = { req: { header: (n: string) => (n === "X-Internal-Job-Secret" ? "hdr-secret" : undefined) } };
  assert(await requireJobSecret(c));
});

Deno.test("requireJobSecret: bearer mode reads Authorization", async () => {
  setEnv("bear-secret");
  const c = { req: { header: (n: string) => (n === "Authorization" ? "Bearer bear-secret" : undefined) } };
  assert(await requireJobSecret(c, { bearer: true }));
  const bad = { req: { header: (n: string) => (n === "Authorization" ? "Basic xyz" : undefined) } };
  assertEquals(await requireJobSecret(bad, { bearer: true }), false);
});
