// US-2406: plan targeting must actually be applied at runtime.
//
// The v2 targeting suite (feature-flags_test.ts) covered resolveFlagRule, the
// PURE helper, and it passed the whole time the feature was broken — because
// the helper was correct and production never fed it a plan. So every case here
// goes through isFeatureEnabled, the real entry point, with the DB readers
// swapped out. A test that can only see the helper cannot see this defect.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  isFeatureEnabled,
  isPlanTargetable,
  PLAN_TARGETABLE_FLAGS,
  resolveFlagRule,
  __testing,
} = await import("../lib/feature-flags.ts");

type Rule = import("../lib/feature-flags.ts").FeatureFlagRule;

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    enabled: true,
    rollout_percentage: 100,
    plan_targets: [],
    user_allow: [],
    user_deny: [],
    starts_at: null,
    ends_at: null,
    ...overrides,
  };
}

/**
 * Install a fixed rule + a plan table. Returns the restore fn plus a record of
 * which users had their plan looked up, so a test can assert the LOOKUP itself
 * happened (or did not) rather than only its effect.
 */
function withFlagWorld(fixed: Rule, plans: Record<string, string | null>) {
  const lookups: string[] = [];
  const restore = __testing.setDeps({
    loadRule: () => Promise.resolve(fixed),
    loadEffectivePlan: (userId: string) => {
      lookups.push(userId);
      return Promise.resolve(userId in plans ? plans[userId] ?? null : null);
    },
  });
  return { lookups, restore };
}

// ── AC4: the property, through the real entry point ──

Deno.test("US-2406: a plan-targeted rule EXCLUDES a non-matching user via isFeatureEnabled", async () => {
  const { restore } = withFlagWorld(rule({ plan_targets: ["pro"] }), {
    "free-user": "free",
    "pro-user": "pro",
  });
  try {
    // This is the assertion the whole story exists for. Before the fix both
    // returned true: opts.plan was undefined, so the plan check was skipped and
    // the rule fell through to a 100% rollout.
    assertEquals(await isFeatureEnabled("grading", { userId: "free-user" }), false);
    assertEquals(await isFeatureEnabled("grading", { userId: "pro-user" }), true);
  } finally {
    restore();
  }
});

Deno.test("US-2406: the resolved plan is the EFFECTIVE one, not the raw column", async () => {
  // loadEffectivePlan runs users.flipdesk_plan through effectivePlanFor, so a
  // lapsed Pro reads as Free here. Modelled by the fixture returning what that
  // resolution yields — the point being that the rule is judged against
  // entitlement, which is what every other gate in the system reads.
  const { restore } = withFlagWorld(rule({ plan_targets: ["pro"] }), {
    "lapsed-pro": "free",
    "comped-pro": "pro",
  });
  try {
    assertEquals(await isFeatureEnabled("grading", { userId: "lapsed-pro" }), false);
    assertEquals(await isFeatureEnabled("grading", { userId: "comped-pro" }), true);
  } finally {
    restore();
  }
});

// ── AC2: unresolvable plan fails CLOSED ──

Deno.test("US-2406: a plan-targeted rule with NO userId fails closed", async () => {
  const { lookups, restore } = withFlagWorld(rule({ plan_targets: ["pro"] }), {});
  try {
    assertEquals(await isFeatureEnabled("grading"), false);
    // Nothing to look up — it must not invent a user, and it must not fall
    // through to the rollout percentage as it did before.
    assertEquals(lookups.length, 0);
  } finally {
    restore();
  }
});

Deno.test("US-2406: a failed plan lookup fails closed, it does not fall through", async () => {
  const { restore } = withFlagWorld(rule({ plan_targets: ["pro"] }), {
    "unknown-user": null, // missing row / read error
  });
  try {
    assertEquals(await isFeatureEnabled("grading", { userId: "unknown-user" }), false);
  } finally {
    restore();
  }
});

Deno.test("US-2406: fail-closed does not leak into the fail-OPEN missing-row default", async () => {
  // No flag row at all is still ENABLED (US-507 availability contract). The new
  // strictness applies to a rule that exists and names plans, nothing else.
  const restore = __testing.setDeps({
    loadRule: () => Promise.resolve(null),
    loadEffectivePlan: () => Promise.resolve("free"),
  });
  try {
    assertEquals(await isFeatureEnabled("grading", { userId: "anyone" }), true);
    assertEquals(await isFeatureEnabled("grading"), true);
  } finally {
    restore();
  }
});

// ── The untargeted path must not get more expensive ──

Deno.test("US-2406: an untargeted rule never looks a plan up", async () => {
  const { lookups, restore } = withFlagWorld(rule(), { u: "pro" });
  try {
    assertEquals(await isFeatureEnabled("grading", { userId: "u" }), true);
    assertEquals(await isFeatureEnabled("autolister", { userId: "u" }), true);
    // Every flag in the system is untargeted today; one extra users read per
    // call would be a real cost for a feature nobody is using.
    assertEquals(lookups.length, 0);
  } finally {
    restore();
  }
});

Deno.test("US-2406: an explicitly supplied plan wins over a lookup", async () => {
  const { lookups, restore } = withFlagWorld(rule({ plan_targets: ["pro"] }), {
    u: "free",
  });
  try {
    // The admin preview supplies plans for a whole sample; it must not trigger
    // a per-user query, and its answer must be the one used.
    assertEquals(await isFeatureEnabled("grading", { userId: "u", plan: "pro" }), true);
    assertEquals(lookups.length, 0);
  } finally {
    restore();
  }
});

Deno.test("US-2406: user_allow still overrides plan targeting", async () => {
  const { restore } = withFlagWorld(
    rule({ plan_targets: ["pro"], user_allow: ["vip"] }),
    { vip: "free" },
  );
  try {
    // Precedence is unchanged: the allow list sits ABOVE the plan check, so it
    // remains the escape hatch for a specific account.
    assertEquals(await isFeatureEnabled("grading", { userId: "vip" }), true);
  } finally {
    restore();
  }
});

Deno.test("US-2406: a global kill still beats a matching plan", async () => {
  const { restore } = withFlagWorld(
    rule({ enabled: false, plan_targets: ["pro"] }),
    { "pro-user": "pro" },
  );
  try {
    assertEquals(await isFeatureEnabled("grading", { userId: "pro-user" }), false);
  } finally {
    restore();
  }
});

// ── AC3: the preview and the runtime resolve identically ──

Deno.test("US-2406: preview (resolveFlagRule + plan) agrees with runtime for the same user", async () => {
  const r = rule({ plan_targets: ["pro"], rollout_percentage: 40 });
  const plans: Record<string, string> = {};
  for (let i = 0; i < 60; i++) plans[`u${i}`] = i % 3 === 0 ? "pro" : "free";
  const { restore } = withFlagWorld(r, plans);
  try {
    for (const [userId, plan] of Object.entries(plans)) {
      // The admin preview scores a sample this way (resolveFlagRule with the
      // effective plan). Runtime resolves the plan itself. A disagreement is
      // exactly what hid the original defect, so it is pinned per user.
      const previewed = resolveFlagRule("grading", r, { userId, plan });
      const runtime = await isFeatureEnabled("grading", { userId });
      assertEquals(runtime, previewed, `disagreement for ${userId} (${plan})`);
    }
  } finally {
    restore();
  }
});

// ── AC1: "do not fix half" — pinned against the real call sites ──

Deno.test("US-2406: every call site of a plan-targetable flag passes a userId", async () => {
  // A flag listed as plan-targetable promises that all of its callers can name
  // a user. If someone adds a call site that cannot, targeting silently starts
  // failing closed there instead of working — half-fixed, which the AC forbids.
  // So the promise is checked against the source rather than trusted.
  const roots = ["src/routes", "src/lib", "src/middleware"];
  const offenders: string[] = [];
  const base = new URL("../../", import.meta.url); // services/edge-functions/

  async function* walk(dir: URL): AsyncGenerator<URL> {
    for await (const entry of Deno.readDir(dir)) {
      const child = new URL(`${entry.name}${entry.isDirectory ? "/" : ""}`, dir);
      if (entry.isDirectory) yield* walk(child);
      else if (entry.name.endsWith(".ts")) yield child;
    }
  }

  for (const root of roots) {
    for await (const file of walk(new URL(`${root}/`, base))) {
      const text = await Deno.readTextFile(file);
      for (const key of PLAN_TARGETABLE_FLAGS) {
        // Matches the call and whatever follows up to the closing paren of the
        // first argument list — enough to see whether a second argument exists.
        const re = new RegExp(`isFeatureEnabled\\(\\s*"${key}"\\s*([,)])`, "g");
        for (const m of text.matchAll(re)) {
          if (m[1] === ")") {
            offenders.push(`${file.pathname.split("/").slice(-2).join("/")} → "${key}"`);
          }
        }
      }
    }
  }

  assertEquals(
    offenders,
    [],
    `plan-targetable flags checked with no userId:\n  ${offenders.join("\n  ")}\n` +
      "Either pass a userId, or drop the key from PLAN_TARGETABLE_FLAGS.",
  );
});

Deno.test("US-2406: the targetable set is a subset of the declared flag keys", () => {
  // Guards a typo'd key, which would read as "not targetable" and silently
  // disable the admin control for a flag that should have it.
  assert(PLAN_TARGETABLE_FLAGS.size > 0);
  assert(isPlanTargetable("grading"));
  // Platform-wide callers (crons) must stay out — see the comment on the set.
  for (const key of ["newsletter", "lifecycle_journeys", "trial_conversion_drip", "repricing", "inventory_equity", "support_assistant"]) {
    assertEquals(isPlanTargetable(key), false, `${key} must not be plan-targetable`);
  }
  assertEquals(isPlanTargetable("not_a_flag"), false);
});
