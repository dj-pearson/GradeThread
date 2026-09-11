// US-3327: super admins can release a held grade early, one or a batch.
//
//   deno test --allow-net --allow-env --allow-read src/tests/held-grade-release_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { Hono } = await import("hono");
const { adminGradingRoutes, heldReleaseRefusal, HELD_RELEASE_BATCH_MAX } = await import(
  "../routes/admin-grading.ts"
);

Deno.test("only super_admin may release early", () => {
  assertEquals(heldReleaseRefusal("super_admin"), null);
  assert(heldReleaseRefusal("admin"));
  assert(heldReleaseRefusal(undefined));
  assert(heldReleaseRefusal("SUPER_ADMIN"), "role match is exact");
});

// A plain admin is refused before anything touches the database: the route
// answers 403 from the role alone, so no DB is needed to prove it.
function appAs(role: string) {
  // deno-lint-ignore no-explicit-any
  const app = new Hono<any>();
  app.use("*", async (c, next) => {
    c.set("userId", "00000000-0000-0000-0000-000000000001");
    c.set("adminRole", role);
    await next();
  });
  app.route("/", adminGradingRoutes);
  return app;
}

Deno.test("a non-super-admin is refused on both release routes", async () => {
  const app = appAs("admin");
  const one = await app.request("/held-grades/abc/release", { method: "POST" });
  assertEquals(one.status, 403);
  assertEquals((await one.json()).code, "SUPER_ADMIN_REQUIRED");
  const batch = await app.request("/held-grades/release-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: ["a", "b"] }),
  });
  assertEquals(batch.status, 403);
});

// ── source guards ───────────────────────────────────────────────────────────

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const routes = stripComments(
  Deno.readTextFileSync(new URL("../routes/admin-grading.ts", import.meta.url))
    .replace(/\r\n/g, "\n"),
);

function routeBody(path: string): string {
  const start = routes.indexOf(`adminGradingRoutes.post("${path}"`);
  assert(start >= 0, `${path} route missing`);
  const next = routes.indexOf("\nadminGradingRoutes.", start + 10);
  return routes.slice(start, next);
}

Deno.test("both routes refuse, then step up, then release through the shared function", () => {
  for (const path of ["/held-grades/:id/release", "/held-grades/release-batch"]) {
    const body = routeBody(path);
    const refusal = body.indexOf("heldReleaseRefusal(");
    const stepUp = body.indexOf("requireStepUp(c)");
    const release = body.indexOf("releaseHeldGrade(");
    assert(refusal >= 0 && stepUp > refusal && release > stepUp, `${path}: order is role, step-up, release`);
    assert(body.includes("{ early: true }"), `${path}: releases early`);
    assert(!body.includes("finalizeGradeReview("), `${path}: must not finalize around releaseHeldGrade`);
    assert(body.includes("auditLog("), `${path}: audited`);
  }
});

Deno.test("a batch releases each id once and is capped", () => {
  const body = routeBody("/held-grades/release-batch");
  assert(body.includes("[...new Set("), "duplicate ids in one batch would double-release");
  assert(body.includes("HELD_RELEASE_BATCH_MAX"));
  assertEquals(HELD_RELEASE_BATCH_MAX, 100);
});

Deno.test("a second release of the same grade is a no-op, not a second notice", () => {
  const pipeline = stripComments(
    Deno.readTextFileSync(new URL("../lib/grading-pipeline.ts", import.meta.url))
      .replace(/\r\n/g, "\n"),
  );
  const start = pipeline.indexOf("export async function releaseHeldGrade(");
  const body = pipeline.slice(start, pipeline.indexOf("\nexport ", start + 10));
  // Already final, or no longer held: return before finalize, so no go-live
  // and no email. And finalize itself flips finalized_at atomically.
  const finalCheck = body.indexOf('if (g.finalized_at) return { released: false, reason: "already_final" }');
  const heldCheck = body.indexOf('if (g.review_status !== "held") return');
  const finalize = body.indexOf("finalizeGradeReview(");
  assert(finalCheck > 0 && heldCheck > 0 && finalize > heldCheck && finalize > finalCheck);
  assert(body.includes('if (result.alreadyFinal) return { released: false, reason: "already_final" }'));
});
