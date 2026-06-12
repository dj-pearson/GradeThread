// US-360: internal job-secret auth — constant-time compare, fail-closed, and
// dual-secret overlap rotation.
// US-487: array-of-candidates rotation + signed timestamped requests with
// replay rejection.
import { assert, assertEquals } from "@std/assert";
import {
  clearJobReplayCacheForTests,
  requireJobSecret,
  signJobRequest,
  timingSafeEqual,
  verifyJobSecret,
  verifySignedJobRequest,
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

Deno.test("verifyJobSecret: array expected supports content-secret overlap rotation", async () => {
  const candidates = ["new-content-secret", "old-content-secret"];
  assert(await verifyJobSecret("new-content-secret", candidates));
  assert(await verifyJobSecret("old-content-secret", candidates));
  assertEquals(await verifyJobSecret("retired", candidates), false);
  // Fail-closed: no usable candidates never matches.
  assertEquals(await verifyJobSecret("anything", []), false);
  assertEquals(await verifyJobSecret("anything", ["", null, undefined]), false);
});

// ── Signed timestamped requests (US-487) ───────────────────────────

function signedCtx(
  headers: Record<string, string>,
  method = "POST",
  path = "/api/content/scheduler/tick",
) {
  return {
    req: { header: (n: string) => headers[n], method, path },
  };
}

async function makeSignedCtx(
  secret: string,
  opts: { tsOffsetSeconds?: number; method?: string; path?: string; signPath?: string } = {},
) {
  const method = opts.method ?? "POST";
  const path = opts.path ?? "/api/content/scheduler/tick";
  const ts = Math.floor(Date.now() / 1000) + (opts.tsOffsetSeconds ?? 0);
  const sig = await signJobRequest(secret, {
    timestamp: ts,
    method,
    path: opts.signPath ?? path,
  });
  return signedCtx(
    { "X-Internal-Job-Signature": sig, "X-Internal-Job-Timestamp": String(ts) },
    method,
    path,
  );
}

Deno.test("verifySignedJobRequest: accepts a fresh, correctly signed request", async () => {
  clearJobReplayCacheForTests();
  const c = await makeSignedCtx("job-secret");
  assert(await verifySignedJobRequest(c, ["job-secret"]));
});

Deno.test("verifySignedJobRequest: accepts a signature made with the OLD secret during rotation", async () => {
  clearJobReplayCacheForTests();
  const c = await makeSignedCtx("old-secret");
  assert(await verifySignedJobRequest(c, ["new-secret", "old-secret"]));
});

Deno.test("verifySignedJobRequest: rejects a wrong-secret signature", async () => {
  clearJobReplayCacheForTests();
  const c = await makeSignedCtx("attacker-secret");
  assertEquals(await verifySignedJobRequest(c, ["job-secret"]), false);
});

Deno.test("verifySignedJobRequest: rejects a stale timestamp (outside skew window)", async () => {
  clearJobReplayCacheForTests();
  const c = await makeSignedCtx("job-secret", { tsOffsetSeconds: -3600 });
  assertEquals(await verifySignedJobRequest(c, ["job-secret"]), false);
});

Deno.test("verifySignedJobRequest: rejects a far-future timestamp", async () => {
  clearJobReplayCacheForTests();
  const c = await makeSignedCtx("job-secret", { tsOffsetSeconds: 3600 });
  assertEquals(await verifySignedJobRequest(c, ["job-secret"]), false);
});

Deno.test("verifySignedJobRequest: signature is bound to method + path", async () => {
  clearJobReplayCacheForTests();
  // Signed for /tick, presented against /summary.
  const c = await makeSignedCtx("job-secret", {
    signPath: "/api/content/scheduler/tick",
    path: "/api/content/scheduler/summary",
  });
  assertEquals(await verifySignedJobRequest(c, ["job-secret"]), false);
});

Deno.test("verifySignedJobRequest: REPLAYED signature is rejected", async () => {
  clearJobReplayCacheForTests();
  const c = await makeSignedCtx("job-secret");
  assert(await verifySignedJobRequest(c, ["job-secret"]));
  // Same request again (e.g. a captured + replayed call) must fail.
  assertEquals(await verifySignedJobRequest(c, ["job-secret"]), false);
});

Deno.test("verifySignedJobRequest: fail-closed on missing/malformed headers", async () => {
  clearJobReplayCacheForTests();
  assertEquals(await verifySignedJobRequest(signedCtx({}), ["s"]), false);
  assertEquals(
    await verifySignedJobRequest(
      signedCtx({ "X-Internal-Job-Signature": "abc" }),
      ["s"],
    ),
    false,
  );
  assertEquals(
    await verifySignedJobRequest(
      signedCtx({
        "X-Internal-Job-Signature": "abc",
        "X-Internal-Job-Timestamp": "not-a-number",
      }),
      ["s"],
    ),
    false,
  );
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
