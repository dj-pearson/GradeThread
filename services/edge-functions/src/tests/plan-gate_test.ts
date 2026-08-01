// Unit tests for the FlipDesk plan-gate decision logic (US-208).
//
// requireFlipdesk's data access is injected (PlanGateDeps) so these run with
// no DB — same approach as rate-limit_test.ts. We hand-roll a minimal Hono
// Context exposing just get/json/header (the three members the gate touches).
//
//   deno test src/tests/plan-gate_test.ts
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import type { Context } from "hono";
import {
  featureAllowedForUser,
  type PlanGateDeps,
  type PlanGateUser,
  requireFlipdesk,
  __testing,
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
    past_due_since: null,
    ai_actions_used_this_month: 0,
    // Future boundary by default → no AI rollover either (US-2179).
    ai_actions_reset_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    ai_action_limit: null,
    grades_used_this_month: 0,
    // Future boundary by default → no rollover, used count taken as-is.
    grade_reset_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
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

// ── Team seats (US-388) ──────────────────────────────────────────
Deno.test("Free/Starter/Pro are blocked from inviting team members", async () => {
  for (const plan of ["free", "starter", "pro"] as const) {
    const { ctx } = fakeCtx();
    const resp = await requireFlipdesk(
      ctx,
      { feature: "subAccounts" },
      deps(user({ flipdesk_plan: plan }), 0),
    );
    assert(resp !== null, `${plan} should not have team seats`);
    assertEquals(resp!.status, 402);
    const body = await bodyOf(resp!);
    assertEquals(body.error, "FEATURE_LOCKED");
    assertEquals(body.requiredPlan, "business");
  }
});

Deno.test("Business can invite up to its seat cap, then is blocked", async () => {
  // subAccounts feature is unlocked for Business.
  const featureResp = await requireFlipdesk(
    fakeCtx().ctx,
    { feature: "subAccounts" },
    deps(user({ flipdesk_plan: "business" }), 0),
  );
  assertEquals(featureResp, null, "Business has the subAccounts feature");

  // 9 existing members + 1 new = 10 → within the cap of 10.
  const within = await requireFlipdesk(
    fakeCtx().ctx,
    { capacity: { kind: "teamSeats" } },
    deps(user({ flipdesk_plan: "business" }), 9),
  );
  assertEquals(within, null, "10th seat is allowed");

  // 10 existing members + 1 new = 11 → over the cap.
  const over = await requireFlipdesk(
    fakeCtx().ctx,
    { capacity: { kind: "teamSeats" } },
    deps(user({ flipdesk_plan: "business" }), 10),
  );
  assert(over !== null, "11th seat is blocked");
  assertEquals(over!.status, 402);
  const body = await bodyOf(over!);
  assertEquals(body.error, "CAP_REACHED");
  assertEquals(body.cap, "teamSeats");
  assertEquals(body.limit, 10);
});

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

// ── Free included-grade monthly rollover (US-393) ────────────────
Deno.test("includedGrades usage rolls over once grade_reset_at has passed", async () => {
  const past = new Date(Date.now() - 86_400_000).toISOString(); // boundary elapsed
  const future = new Date(Date.now() + 86_400_000).toISOString();

  // Counter shows 3 used, but the reset boundary passed → reads as 0 (a Free
  // user gets no invoice to reset it, so the read must be clock-based).
  const rolled = await __testing.readCurrentUsage(
    "u1",
    "includedGrades",
    user({ grades_used_this_month: 3, grade_reset_at: past }),
  );
  assertEquals(rolled, 0);

  // Within the current period the used count stands.
  const current = await __testing.readCurrentUsage(
    "u1",
    "includedGrades",
    user({ grades_used_this_month: 3, grade_reset_at: future }),
  );
  assertEquals(current, 3);
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

// ── US-382: server-side enforcement on the real endpoints ────────
// These pin the exact gate calls the route handlers now make, so a Free user
// hits 402 on each gated path (was UI-only before US-382).

Deno.test("US-382: Free user is FEATURE_LOCKED on reconciliation, apiAccess, bulkActions", async () => {
  for (const feature of ["reconciliation", "apiAccess", "bulkActions"] as const) {
    const { ctx } = fakeCtx();
    const resp = await requireFlipdesk(
      ctx,
      { feature },
      deps(user({ flipdesk_plan: "free" }), 0),
    );
    assert(resp !== null, `free should be locked out of ${feature}`);
    assertEquals(resp!.status, 402);
    const body = await bodyOf(resp!);
    assertEquals(body.error, "FEATURE_LOCKED");
    assertEquals(body.feature, feature);
  }
});

Deno.test("US-382: reconciliation/apiAccess require Business; bulkActions requires Pro", async () => {
  // Pro can bulk-extract but NOT reconcile / use the API.
  const proDeps = deps(user({ flipdesk_plan: "pro" }), 0);
  {
    const { ctx } = fakeCtx();
    assertEquals(await requireFlipdesk(ctx, { feature: "bulkActions" }, proDeps), null);
  }
  for (const feature of ["reconciliation", "apiAccess"] as const) {
    const { ctx } = fakeCtx();
    const resp = await requireFlipdesk(ctx, { feature }, proDeps);
    assert(resp !== null, `pro should still be locked out of ${feature}`);
    assertEquals((await bodyOf(resp!)).requiredPlan, "business");
  }
  // Business clears all three.
  const bizDeps = deps(user({ flipdesk_plan: "business" }), 0);
  for (const feature of ["reconciliation", "apiAccess", "bulkActions"] as const) {
    const { ctx } = fakeCtx();
    assertEquals(await requireFlipdesk(ctx, { feature }, bizDeps), null);
  }
});

Deno.test("US-382: Free user hits CAP_REACHED at the active-listing cap on publish", async () => {
  // Free activeListings cap = 25; a new publish (+1) at 25 used is blocked.
  const { ctx } = fakeCtx();
  const resp = await requireFlipdesk(
    ctx,
    { capacity: { kind: "activeListings", delta: 1 } },
    deps(user({ flipdesk_plan: "free" }), 25),
  );
  assert(resp !== null);
  assertEquals(resp!.status, 402);
  assertEquals((await bodyOf(resp!)).error, "CAP_REACHED");

  // A re-publish of an already-listed item (delta 0) at the cap is NOT blocked.
  const { ctx: ctx2 } = fakeCtx();
  const ok = await requireFlipdesk(
    ctx2,
    { capacity: { kind: "activeListings", delta: 0 } },
    deps(user({ flipdesk_plan: "free" }), 25),
  );
  assertEquals(ok, null);
});

Deno.test("US-382: Free user hits CAP_REACHED connecting a 2nd marketplace", async () => {
  // Free marketplaces cap = 1; connecting a new marketplace (+1) at 1 used blocks.
  const { ctx } = fakeCtx();
  const resp = await requireFlipdesk(
    ctx,
    { capacity: { kind: "marketplaces", delta: 1 } },
    deps(user({ flipdesk_plan: "free" }), 1),
  );
  assert(resp !== null);
  assertEquals((await bodyOf(resp!)).error, "CAP_REACHED");

  // Reconnect (delta 0) of the existing connection is allowed.
  const { ctx: ctx2 } = fakeCtx();
  const ok = await requireFlipdesk(
    ctx2,
    { capacity: { kind: "marketplaces", delta: 0 } },
    deps(user({ flipdesk_plan: "free" }), 1),
  );
  assertEquals(ok, null);
});

// ── Super-admin bypass (platform owner) ──────────────────────────
Deno.test("super_admin bypasses a cap that would otherwise block", async () => {
  // Free marketplaces cap = 1, already at 1 → a normal user is blocked, but the
  // super_admin proceeds regardless.
  const { ctx } = fakeCtx();
  const resp = await requireFlipdesk(
    ctx,
    { capacity: { kind: "marketplaces", delta: 1 } },
    deps(user({ flipdesk_plan: "free", role: "super_admin" }), 1),
  );
  assertEquals(resp, null);
});

Deno.test("super_admin bypasses a locked feature gate", async () => {
  const { ctx } = fakeCtx();
  const resp = await requireFlipdesk(
    ctx,
    { feature: "apiAccess" },
    deps(user({ flipdesk_plan: "free", role: "super_admin" }), 0),
  );
  assertEquals(resp, null);
});

Deno.test("super_admin bypasses the includedGrades pre-gate (unlimited grading)", async () => {
  // Free included-grade cap = 3; a normal user at 3 is blocked here, the owner is not.
  const { ctx } = fakeCtx();
  const resp = await requireFlipdesk(
    ctx,
    { capacity: { kind: "includedGrades", delta: 1 } },
    deps(user({ flipdesk_plan: "free", role: "super_admin" }), 3),
  );
  assertEquals(resp, null);
});

Deno.test("regular admin role is still gated (bypass is super_admin only)", async () => {
  const { ctx } = fakeCtx();
  const resp = await requireFlipdesk(
    ctx,
    { feature: "apiAccess" },
    deps(user({ flipdesk_plan: "free", role: "admin" }), 0),
  );
  assert(resp !== null);
  assertEquals(resp!.status, 402);
  assertEquals((await bodyOf(resp!)).error, "FEATURE_LOCKED");
});

// ── featureAllowedForUser (non-HTTP cron gate, US-208 follow-up) ──────
// getPlanMatrix() fails safe to the compiled FALLBACK_MATRIX with no DB, so
// these assert against the compiled gate flags. loadUser is injected.
function loadUserDep(u: PlanGateUser | null): Pick<PlanGateDeps, "loadUser"> {
  return { loadUser: () => Promise.resolve(u) };
}

Deno.test("featureAllowedForUser: Free lacks scheduledActions, Pro has it", async () => {
  assertEquals(
    await featureAllowedForUser("u1", "scheduledActions", loadUserDep(user({ flipdesk_plan: "free" }))),
    false,
  );
  assertEquals(
    await featureAllowedForUser("u1", "scheduledActions", loadUserDep(user({ flipdesk_plan: "pro" }))),
    true,
  );
});

Deno.test("featureAllowedForUser: paused Pro drops to Free (grandfather leak closed)", async () => {
  // A Pro user whose sub is paused resolves to Free caps → the cron must skip.
  assertEquals(
    await featureAllowedForUser(
      "u1",
      "scheduledActions",
      loadUserDep(user({ flipdesk_plan: "pro", subscription_status: "paused" })),
    ),
    false,
  );
});

Deno.test("featureAllowedForUser: super_admin bypasses; unknown user fails closed", async () => {
  assertEquals(
    await featureAllowedForUser(
      "u1",
      "scheduledActions",
      loadUserDep(user({ flipdesk_plan: "free", role: "super_admin" })),
    ),
    true,
  );
  assertEquals(
    await featureAllowedForUser("u1", "scheduledActions", loadUserDep(null)),
    false,
  );
});

// ── AI-action cap: self-cap + monthly rollover (US-2179) ─────────
//
// Both were latent bugs in the aiActions capacity path: getLimit ignored the
// seller's self-cap (users.ai_action_limit) despite a comment claiming the min()
// happened there, and readCurrentUsage returned the raw counter with no rollover.
// Nothing routed aiActions through requireFlipdesk yet, so neither ever fired —
// they were a trap set for the first caller.

Deno.test("getLimit: aiActions honors the seller's self-cap (min of plan and self)", () => {
  const pro = __testing.PLAN_MATRIX.pro;
  // No self-cap → the plan's cap.
  assertEquals(
    __testing.getLimit(pro, "aiActions", { ai_action_limit: null }),
    pro.aiActionsPerMonth,
  );
  // A self-cap BELOW the plan wins.
  assertEquals(__testing.getLimit(pro, "aiActions", { ai_action_limit: 50 }), 50);
  // A self-cap ABOVE the plan cannot buy extra allowance.
  assertEquals(
    __testing.getLimit(pro, "aiActions", { ai_action_limit: 99_999 }),
    pro.aiActionsPerMonth,
  );
  // Plan-shopping call (no user) must ignore self-caps entirely, or we'd
  // recommend an upgrade because the seller throttled themselves.
  assertEquals(__testing.getLimit(pro, "aiActions"), pro.aiActionsPerMonth);
});

Deno.test("getLimit: aiActions self-cap does not apply to other capacities", () => {
  const pro = __testing.PLAN_MATRIX.pro;
  assertEquals(
    __testing.getLimit(pro, "activeListings", { ai_action_limit: 1 }),
    pro.activeListingCap,
  );
});

Deno.test("requireFlipdesk: aiActions at the self-cap returns 402 with the self-cap as the limit", async () => {
  const { ctx } = fakeCtx();
  const u = user({ flipdesk_plan: "pro", ai_action_limit: 10 });
  const resp = await requireFlipdesk(
    ctx,
    { capacity: { kind: "aiActions" } },
    deps(u, 10),
  );
  assert(resp, "expected a 402 at the self-cap, not a pass");
  assertEquals(resp.status, 402);
  const body = await bodyOf(resp);
  assertEquals(body.error, "CAP_REACHED");
  // The reported limit is the SELF-cap, not Pro's 750 — otherwise the upgrade
  // dialog would tell the seller to buy capacity they already have.
  assertEquals(body.limit, 10);
});

Deno.test("readCurrentUsage: aiActions rolls over a counter from a prior month", async () => {
  const priorMonth = new Date(Date.UTC(2000, 0, 15)).toISOString();
  const used = await __testing.readCurrentUsage("u1", "aiActions", {
    flipdesk_plan: "pro",
    ai_actions_used_this_month: 750,
    ai_actions_reset_at: priorMonth,
    ai_action_limit: null,
    grades_used_this_month: 0,
    grade_reset_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  // Last month's 750 must not spend this month's allowance.
  assertEquals(used, 0);
});

Deno.test("readCurrentUsage: aiActions keeps an in-month counter", async () => {
  const used = await __testing.readCurrentUsage("u1", "aiActions", {
    flipdesk_plan: "pro",
    ai_actions_used_this_month: 42,
    ai_actions_reset_at: new Date().toISOString(),
    ai_action_limit: null,
    grades_used_this_month: 0,
    grade_reset_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  assertEquals(used, 42);
});

Deno.test("readCurrentUsage: aiActions with a null reset boundary keeps the counter", async () => {
  // A never-stamped boundary must NOT read as "rolled over" — that would hand
  // out a fresh allowance every request.
  const used = await __testing.readCurrentUsage("u1", "aiActions", {
    flipdesk_plan: "pro",
    ai_actions_used_this_month: 7,
    ai_actions_reset_at: null,
    ai_action_limit: null,
    grades_used_this_month: 0,
    grade_reset_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  assertEquals(used, 7);
});
