// Unit tests for the FlipDesk plan-gate decision logic (US-208).
//
// requireFlipdesk's data access is injected (PlanGateDeps) so these run with
// no DB — same approach as rate-limit_test.ts. We hand-roll a minimal Hono
// Context exposing just get/json/header (the three members the gate touches).
//
//   deno test src/tests/plan-gate_test.ts
import { assert, assertEquals } from "@std/assert";
import type { Context } from "hono";
import {
  type PlanGateDeps,
  type PlanGateUser,
  requireFlipdesk,
} from "../lib/plan-gate.ts";

// ── Fake Context ─────────────────────────────────────────────────
function fakeCtx(userId = "u1") {
  const headers = new Map<string, string>();
  const ctx = {
    get: (k: string) => (k === "userId" ? userId : undefined),
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    header: (k: string, v: string) => headers.set(k, v),
  } as unknown as Context;
  return { ctx, headers };
}

function user(overrides: Partial<PlanGateUser> = {}): PlanGateUser {
  return {
    flipdesk_plan: "free",
    subscription_status: "active",
    trial_ends_at: null,
    ai_actions_used_this_month: 0,
    ai_action_limit: null,
    grades_used_this_month: 0,
    ...overrides,
  };
}

// deps that return a fixed user + a fixed usage count.
function deps(u: PlanGateUser, usage: number): PlanGateDeps {
  return {
    loadUser: () => Promise.resolve(u),
    readUsage: () => Promise.resolve(usage),
  };
}

async function bodyOf(resp: Response): Promise<Record<string, unknown>> {
  return await resp.json();
}

// ── Capacity: at the cap → 402 ───────────────────────────────────
Deno.test("at-the-cap returns 402 CAP_REACHED", async () => {
  const { ctx } = fakeCtx();
  // Free activeListings cap = 25; used 25, +1 → 26 > 25.
  const resp = await requireFlipdesk(
    ctx,
    { capacity: { kind: "activeListings" } },
    deps(user(), 25),
  );
  assert(resp !== null, "should block at the cap");
  assertEquals(resp!.status, 402);
  const body = await bodyOf(resp!);
  assertEquals(body.error, "CAP_REACHED");
  assertEquals(body.cap, "activeListings");
  assertEquals(body.limit, 25);
  assertEquals(body.requiredPlan, "starter"); // starter cap = 250
});

// ── Capacity: one below the cap → proceed (null) ─────────────────
Deno.test("one-below-cap returns 200 (proceeds)", async () => {
  const { ctx } = fakeCtx();
  // used 10, +1 → 11 ≤ 25, and 11/25 = 0.44 < 0.8 → no warning header either.
  const resp = await requireFlipdesk(
    ctx,
    { capacity: { kind: "activeListings" } },
    deps(user(), 10),
  );
  assertEquals(resp, null);
});

// ── Capacity: one below cap but delta=2 → 402 ────────────────────
Deno.test("one-below-cap with delta=2 returns 402", async () => {
  const { ctx } = fakeCtx();
  // used 24, +2 → 26 > 25.
  const resp = await requireFlipdesk(
    ctx,
    { capacity: { kind: "activeListings", delta: 2 } },
    deps(user(), 24),
  );
  assert(resp !== null);
  assertEquals(resp!.status, 402);
  assertEquals((await bodyOf(resp!)).error, "CAP_REACHED");
});

// ── Capacity: crossing 80% → header, still proceeds ──────────────
Deno.test("80% threshold sets X-Plan-Warning header and proceeds", async () => {
  const { ctx, headers } = fakeCtx();
  // used 19, +1 → 20 / 25 = 0.80 exactly → warn but allow.
  const resp = await requireFlipdesk(
    ctx,
    { capacity: { kind: "activeListings" } },
    deps(user(), 19),
  );
  assertEquals(resp, null, "80% should not block");
  const warn = headers.get("X-Plan-Warning");
  assert(warn !== undefined, "expected X-Plan-Warning header");
  assert(warn!.startsWith("CAP_80"), `unexpected warning: ${warn}`);
  assert(warn!.includes("kind=activeListings"));
  assert(warn!.includes("limit=25"));
});

// ── Paused subscription → Free caps (no counter reset) ───────────
Deno.test("paused subscription is treated as Free caps", async () => {
  const { ctx } = fakeCtx();
  // Pro normally allows 1000 listings, but paused → Free cap 25.
  const u = user({ flipdesk_plan: "pro", subscription_status: "paused" });
  const usage = 25; // counters untouched by the gate
  const resp = await requireFlipdesk(
    ctx,
    { capacity: { kind: "activeListings" } },
    deps(u, usage),
  );
  assert(resp !== null, "paused Pro user should hit the Free cap of 25");
  assertEquals(resp!.status, 402);
  const body = await bodyOf(resp!);
  assertEquals(body.plan, "free"); // effective plan is free while paused
  assertEquals(body.limit, 25);
  // The gate never mutated the usage value it was handed (no reset).
  assertEquals(usage, 25);
});

// ── Expired trial → Free caps (US-383) ──────────────────────────
Deno.test("expired Pro trial is capped at Free", async () => {
  const { ctx } = fakeCtx();
  // Trialing Pro whose 14-day window lapsed → Free cap 25, even before the
  // downgrade job flips the stored row.
  const u = user({
    flipdesk_plan: "pro",
    subscription_status: "trialing",
    trial_ends_at: new Date(Date.now() - 86_400_000).toISOString(), // yesterday
  });
  const resp = await requireFlipdesk(
    ctx,
    { capacity: { kind: "activeListings" } },
    deps(u, 25),
  );
  assert(resp !== null, "expired-trial Pro user should hit the Free cap of 25");
  assertEquals(resp!.status, 402);
  const body = await bodyOf(resp!);
  assertEquals(body.plan, "free");
  assertEquals(body.limit, 25);
});

Deno.test("live Pro trial keeps Pro caps", async () => {
  const { ctx } = fakeCtx();
  const u = user({
    flipdesk_plan: "pro",
    subscription_status: "trialing",
    trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), // next week
  });
  // 200 listings is well within Pro's 1000 cap but far over Free's 25.
  const resp = await requireFlipdesk(
    ctx,
    { capacity: { kind: "activeListings" } },
    deps(u, 200),
  );
  assertEquals(resp, null, "an in-window trial should still get Pro caps");
});

Deno.test("paused Pro user below Free cap still proceeds", async () => {
  const { ctx } = fakeCtx();
  const u = user({ flipdesk_plan: "pro", subscription_status: "paused" });
  const resp = await requireFlipdesk(
    ctx,
    { capacity: { kind: "activeListings" } },
    deps(u, 5),
  );
  assertEquals(resp, null);
});

// ── Unlimited cap (-1) → always proceeds ─────────────────────────
Deno.test("unlimited cap (-1) never blocks", async () => {
  const { ctx } = fakeCtx();
  // Business activeListings = -1 (unlimited).
  const u = user({ flipdesk_plan: "business" });
  const resp = await requireFlipdesk(
    ctx,
    { capacity: { kind: "activeListings", delta: 100000 } },
    deps(u, 999999),
  );
  assertEquals(resp, null);
});

// ── Feature gate: locked → 402 FEATURE_LOCKED with requiredPlan ──
Deno.test("locked feature returns 402 FEATURE_LOCKED (apiAccess → business)", async () => {
  const { ctx } = fakeCtx();
  const resp = await requireFlipdesk(
    ctx,
    { feature: "apiAccess" },
    deps(user({ flipdesk_plan: "pro" }), 0),
  );
  assert(resp !== null);
  assertEquals(resp!.status, 402);
  const body = await bodyOf(resp!);
  assertEquals(body.error, "FEATURE_LOCKED");
  assertEquals(body.feature, "apiAccess");
  assertEquals(body.requiredPlan, "business");
});

Deno.test("bulkActions locked on starter, unlocked on pro", async () => {
  const { ctx: c1 } = fakeCtx();
  const locked = await requireFlipdesk(
    c1,
    { feature: "bulkActions" },
    deps(user({ flipdesk_plan: "starter" }), 0),
  );
  assert(locked !== null);
  assertEquals((await bodyOf(locked!)).requiredPlan, "pro");

  const { ctx: c2 } = fakeCtx();
  const unlocked = await requireFlipdesk(
    c2,
    { feature: "bulkActions" },
    deps(user({ flipdesk_plan: "pro" }), 0),
  );
  assertEquals(unlocked, null);
});

// ── Free → 2nd marketplace is blocked (cap=1, requiredPlan=starter) ──
Deno.test("free plan blocks a 2nd marketplace (requiredPlan=starter)", async () => {
  const { ctx } = fakeCtx();
  // 1 marketplace connected, attempting a 2nd: used 1, +1 → 2 > 1.
  const resp = await requireFlipdesk(
    ctx,
    { capacity: { kind: "marketplaces" } },
    deps(user(), 1),
  );
  assert(resp !== null);
  assertEquals(resp!.status, 402);
  const body = await bodyOf(resp!);
  assertEquals(body.cap, "marketplaces");
  assertEquals(body.requiredPlan, "starter");
});

// ── Missing user → 404 ───────────────────────────────────────────
Deno.test("unknown user returns 404", async () => {
  const { ctx } = fakeCtx();
  const resp = await requireFlipdesk(
    ctx,
    { capacity: { kind: "activeListings" } },
    { loadUser: () => Promise.resolve(null), readUsage: () => Promise.resolve(0) },
  );
  assert(resp !== null);
  assertEquals(resp!.status, 404);
});
