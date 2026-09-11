// US-3334: the admin reference gallery. Who may be awarded is decided on the
// server from the database, award and revoke need step-up and are audited, and
// images leave only as signed URLs of 900 seconds or less.
//
//   deno test --allow-net --allow-env --allow-read src/tests/reference-photos_test.ts

import { assert, assertEquals, assertMatch } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { Hono } = await import("hono");
const { adminGradingRoutes } = await import("../routes/admin-grading.ts");
const {
  loadAwardContext,
  ownerQualifies,
  parseAwardBody,
  REFERENCE_IMAGE_TTL,
  referenceAwardRefusal,
} = await import("../lib/reference-photos.ts");

// ── the award rule ──────────────────────────────────────────────────────────

const OK = { imageFound: true, finalized: true, ownerRole: "user", ownerConsent: true };

Deno.test("a customer photo qualifies only with the model-refinement opt-in", () => {
  assertEquals(referenceAwardRefusal(OK), null);
  assertMatch(referenceAwardRefusal({ ...OK, ownerConsent: false })!, /opted into model refinement/);
});

Deno.test("staff photos qualify without the opt-in", () => {
  assertEquals(referenceAwardRefusal({ ...OK, ownerRole: "admin", ownerConsent: false }), null);
  assertEquals(referenceAwardRefusal({ ...OK, ownerRole: "super_admin", ownerConsent: false }), null);
  // Role match is exact: a look-alike is a customer.
  assert(!ownerQualifies("Admin", false));
  assert(!ownerQualifies(null, null));
});

Deno.test("only a finalized grade's photos, and only photos that exist", () => {
  assertMatch(referenceAwardRefusal({ ...OK, finalized: false })!, /finalized/);
  assertMatch(referenceAwardRefusal({ ...OK, imageFound: false })!, /not found/);
  // Staff ownership does not skip the finalized rule.
  assert(referenceAwardRefusal({ ...OK, ownerRole: "admin", finalized: false }));
});

Deno.test("the award body is validated and rounded to the scale", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  assert("error" in parseAwardBody({ submission_image_id: "nope", awarded_score: 7 }));
  assert("error" in parseAwardBody({ submission_image_id: id, awarded_score: 0.5 }));
  assert("error" in parseAwardBody({ submission_image_id: id, awarded_score: 10.5 }));
  assert("error" in parseAwardBody({ submission_image_id: id, awarded_score: null }));
  assert("error" in parseAwardBody({ submission_image_id: id, awarded_score: 7, factor: "odor" }));
  // A factor is half steps; the whole grade is tenths.
  assertEquals(parseAwardBody({ submission_image_id: id, awarded_score: 7.3, factor: "fabric_condition" }), {
    submissionImageId: id, factor: "fabric_condition", awardedScore: 7.5, note: null,
  });
  assertEquals(parseAwardBody({ submission_image_id: id, awarded_score: "7.34" }), {
    submissionImageId: id, factor: null, awardedScore: 7.3, note: null,
  });
  const long = parseAwardBody({ submission_image_id: id, awarded_score: 7, note: `  ${"x".repeat(900)}  ` });
  assert(!("error" in long) && long.note!.length === 500);
});

// ── the loader reads the owner from the database, not the request ───────────

type Tables = Record<string, unknown[]>;
const calls: Array<{ method: string; table: string; body: unknown }> = [];
let tables: Tables = {};
const realFetch = globalThis.fetch;

function stubDb(t: Tables) {
  tables = t;
  calls.length = 0;
  // The real fetch returns a Promise, so this stub must too; it resolves from
  // an in-memory table with nothing to await. Dropping `async` would change
  // the return type the callers rely on.
  // deno-lint-ignore require-await
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const table = url.pathname.replace(/^\/rest\/v1\//, "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, table, body });
    const accept = new Headers(init?.headers).get("Accept") ?? "";
    if (method === "POST") {
      const row = { id: "99999999-0000-4000-8000-000000000001" };
      return new Response(JSON.stringify(accept.includes("object") ? row : [row]), {
        status: 201, headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "PATCH") {
      return new Response(JSON.stringify(tables[`${table}:patch`] ?? []), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    const rows = tables[table] ?? [];
    return new Response(JSON.stringify(accept.includes("object") ? rows[0] ?? null : rows), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

const IMAGE = "11111111-2222-4333-8444-555555555555";
function world(owner: { role: string; share_sale_outcomes: boolean }, finalized = true): Tables {
  return {
    submission_images: [{ id: IMAGE, submission_id: "sub-1" }],
    submissions: [{ id: "sub-1", user_id: "owner-1", garment_category: "bottoms" }],
    grade_reports: finalized ? [{ id: "rep-1", finalized_at: "2026-09-01T00:00:00Z" }] : [],
    users: [{ role: owner.role, share_sale_outcomes: owner.share_sale_outcomes }],
  };
}

Deno.test("loadAwardContext takes category, grade and consent from the rows", async () => {
  stubDb(world({ role: "user", share_sale_outcomes: false }));
  try {
    const ctx = await loadAwardContext(IMAGE);
    assertEquals(ctx.garmentCategory, "bottoms");
    assertEquals(ctx.gradeReportId, "rep-1");
    assertEquals(ctx.eligibility, { imageFound: true, finalized: true, ownerRole: "user", ownerConsent: false });
  } finally {
    restoreFetch();
  }
});

// ── the routes ──────────────────────────────────────────────────────────────

const FRESH = { aal: "aal2", amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }] };

function app(opts: { stepUp: boolean }) {
  // deno-lint-ignore no-explicit-any
  const a = new Hono<any>();
  a.use("*", async (c, next) => {
    c.set("userId", "00000000-0000-0000-0000-000000000001");
    c.set("adminRole", "super_admin");
    c.set("authClaims", opts.stepUp ? FRESH : { aal: "aal1", amr: [] });
    await next();
  });
  a.route("/", adminGradingRoutes);
  return a;
}
const post = (_path: string, body?: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const awardBody = { submission_image_id: IMAGE, awarded_score: 7, garment_category: "outerwear" };

Deno.test("award and revoke both require step-up, before any database work", async () => {
  stubDb(world({ role: "user", share_sale_outcomes: true }));
  try {
    const a = app({ stepUp: false });
    const award = await a.request("/reference-photos", post("", awardBody));
    assertEquals(award.status, 403);
    assertEquals((await award.json()).code, "STEP_UP_REQUIRED");
    const revoke = await a.request("/reference-photos/abc/revoke", post(""));
    assertEquals(revoke.status, 403);
    assertEquals(calls.length, 0, "nothing may be read or written without step-up");
  } finally {
    restoreFetch();
  }
});

Deno.test("a customer who did not opt in is refused, the refusal is audited, nothing is awarded", async () => {
  stubDb(world({ role: "user", share_sale_outcomes: false }));
  try {
    const res = await app({ stepUp: true }).request("/reference-photos", post("", awardBody));
    assertEquals(res.status, 403);
    assertEquals((await res.json()).code, "NOT_AWARDABLE");
    assert(!calls.some((c) => c.method === "POST" && c.table === "grading_reference_photos"));
    assert(calls.some((c) => c.method === "POST" && c.table !== "grading_reference_photos"), "refusal audited");
  } finally {
    restoreFetch();
  }
});

Deno.test("an unfinalized grade's photo is refused", async () => {
  stubDb(world({ role: "admin", share_sale_outcomes: false }, false));
  try {
    const res = await app({ stepUp: true }).request("/reference-photos", post("", awardBody));
    assertEquals(res.status, 403);
    assert(!calls.some((c) => c.method === "POST" && c.table === "grading_reference_photos"));
  } finally {
    restoreFetch();
  }
});

Deno.test("a qualifying award stores the category from the database, not the body, and is audited", async () => {
  stubDb(world({ role: "user", share_sale_outcomes: true }));
  try {
    const res = await app({ stepUp: true }).request("/reference-photos", post("", awardBody));
    assertEquals(res.status, 201);
    const insert = calls.find((c) => c.method === "POST" && c.table === "grading_reference_photos");
    assert(insert, "award inserted");
    const row = insert.body as Record<string, unknown>;
    assertEquals(row.garment_category, "bottoms", "the body said outerwear; the submission says bottoms");
    assertEquals(row.grade_report_id, "rep-1");
    assertEquals(row.awarded_by, "00000000-0000-0000-0000-000000000001");
    assert(
      calls.some((c) => c.method === "POST" && c.table !== "grading_reference_photos"),
      "award audited",
    );
  } finally {
    restoreFetch();
  }
});

Deno.test("revoking a missing or already revoked award is a 404", async () => {
  stubDb({ "grading_reference_photos:patch": [] });
  try {
    const res = await app({ stepUp: true }).request("/reference-photos/abc/revoke", post(""));
    assertEquals(res.status, 404);
  } finally {
    restoreFetch();
  }
});

// ── signed URLs only, and short ─────────────────────────────────────────────

Deno.test("reference images leave only as signed URLs of 900 seconds or less", () => {
  assert(REFERENCE_IMAGE_TTL > 0 && REFERENCE_IMAGE_TTL <= 900);
  const lib = Deno.readTextFileSync(new URL("../lib/reference-photos.ts", import.meta.url));
  assert(!/getPublicUrl/.test(lib), "the private bucket is never public");
  const signs = [...lib.matchAll(/createSignedUrls?\(([^;]*?)\)\s*;/g)];
  assert(signs.length > 0, "the lib signs its images");
  for (const m of signs) assertMatch(m[1], /REFERENCE_IMAGE_TTL\s*$/, "every signature uses the capped TTL");
});
