// US-2687 AC6: the connector's kill switches, reported where they can be read.
//
// WHY THIS IS A TEST AND NOT A COMMENT. AC6 asks whether any Pro or Business
// seller was actually turned away while `connectorAccess` was unset on every
// pricing_plans row. The story's own probe could not answer it, and the reason
// is worth more than the answer: main.ts mounts mcpAuthMiddleware BEFORE
// app.route("/mcp", mcpRoutes), while the kill switch's 404 lives inside the
// route handler. Production therefore answers 401 to an unauthenticated probe
// whether the connector is live or dark. The two states are indistinguishable
// from outside.
//
// A stop button nobody can confirm is a bad stop button. During an incident you
// flip `claude_connector`, and the only way to check it took effect is to hold
// credentials for the surface you are trying to stop.
//
//   deno test src/tests/connector-readiness_test.ts
// US-2379: first, before anything that reaches lib/supabase.ts — health.ts does,
// through its static imports, and that module reads env at load.
import "./_env.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { connectorReadiness } from "../routes/health.ts";

Deno.test("env off: says so, and names why the 401 hid it", () => {
  for (const flag of ["on", "off", "unreadable"] as const) {
    const line = connectorReadiness(false, flag);
    assertStringIncludes(line, "off:");
    assertStringIncludes(line, "MCP_ENABLED");
    // The deploy-time switch wins outright — reporting the runtime flag's state
    // next to a disabled deploy would invite flipping the one that does nothing.
    assertStringIncludes(line, "401");
  }
});

Deno.test("flag off: named as the RUNTIME switch, not the deploy default", () => {
  const line = connectorReadiness(true, "off");
  assertStringIncludes(line, "off:");
  assertStringIncludes(line, "claude_connector");
  assertStringIncludes(line, "MCP_ENABLED is on");
});

Deno.test("both on: plain 'live', with nothing to explain", () => {
  assertEquals(connectorReadiness(true, "on"), "live");
});

Deno.test("unreadable flag reports LIVE, and says it is serving on a default", () => {
  // The half that would be easy to get wrong. isFeatureEnabled fails OPEN, so
  // an unreadable rule means the connector really is serving — reporting "off"
  // would be a lie in the dangerous direction. But reporting a bare "live"
  // would hide that the kill switch currently cannot stop anything, which is
  // the same blind spot this function exists to remove, one layer down.
  const line = connectorReadiness(true, "unreadable");
  assertStringIncludes(line, "live:");
  assertStringIncludes(line, "fails OPEN");
  assertStringIncludes(line, "cannot stop it");
});

Deno.test("every verdict starts with live or off, so it can be read at a glance", () => {
  const combos = [
    [true, "on"],
    [true, "off"],
    [true, "unreadable"],
    [false, "on"],
    [false, "off"],
    [false, "unreadable"],
  ] as const;
  for (const [env, flag] of combos) {
    const line = connectorReadiness(env, flag);
    const verdict = line.startsWith("live") || line.startsWith("off");
    assertEquals(verdict, true, `"${line}" leads with neither live nor off`);
  }
});

Deno.test("the two OFF states do not read alike", () => {
  // An operator seeing "off" needs to know which switch to flip. If these two
  // strings were equal, the report would be no better than the 401 it replaces.
  const envOff = connectorReadiness(false, "on");
  const flagOff = connectorReadiness(true, "off");
  assertEquals(envOff === flagOff, false);
});

// ── The three-state read itself ────────────────────────────────────────────
//
// The pure function above is only as good as the `flagState` handed to it, and
// deriving that state is the part that could quietly be wrong. isFeatureEnabled
// fails OPEN: a missing row and an unreachable flag store BOTH return the
// caller's default, so a single read cannot tell "the flag says on" from "there
// was nothing to read". Reporting the second as "live" would rebuild the exact
// blind spot this story is about, one layer down.
//
// health.ts resolves it by reading the flag twice with opposite defaults —
// agreement means a real rule was read, disagreement means both calls returned
// their own default. These cases prove that actually holds against the real
// isFeatureEnabled rather than against my description of it.
import { __testing, isFeatureEnabled } from "../lib/feature-flags.ts";
import { connectorFlagState as readFlagState } from "../routes/health.ts";

const RULE = {
  enabled: true,
  rollout_percentage: 100,
  plan_targets: [] as string[],
  user_allow: [] as string[],
  user_deny: [] as string[],
  starts_at: null,
  ends_at: null,
};

Deno.test("a rule that says ON reads as on, from both defaults", async () => {
  const restore = __testing.setDeps({ loadRule: () => Promise.resolve({ ...RULE }) });
  try {
    assertEquals(await readFlagState(), "on");
  } finally {
    restore();
  }
});

Deno.test("a rule that says OFF reads as off — the kill switch is observable", async () => {
  const restore = __testing.setDeps({
    loadRule: () => Promise.resolve({ ...RULE, enabled: false }),
  });
  try {
    assertEquals(await readFlagState(), "off");
    // And the whole point: the report distinguishes it from a dark deploy.
    assertStringIncludes(connectorReadiness(true, "off"), "runtime stop button");
  } finally {
    restore();
  }
});

Deno.test("NO row reads as unreadable, not as on", async () => {
  // The case a single read gets wrong. `defaultEnabled: true` returns true here
  // and would be reported as a live, stoppable connector — when in fact there
  // is no rule at all and the kill switch has nothing to flip.
  const restore = __testing.setDeps({ loadRule: () => Promise.resolve(null) });
  try {
    assertEquals(await readFlagState(), "unreadable");
    assertEquals(await isFeatureEnabled("claude_connector", { defaultEnabled: true }), true);
  } finally {
    restore();
  }
});

Deno.test("a failing flag store reads as unreadable too", async () => {
  const restore = __testing.setDeps({
    loadRule: () => Promise.reject(new Error("flag store down")),
  });
  try {
    // isFeatureEnabled may surface the rejection rather than swallowing it; the
    // handler wraps this read in a try/catch and reports "unreadable" either
    // way. Both routes must land on the same verdict.
    let state: "on" | "off" | "unreadable";
    try {
      state = await readFlagState();
    } catch {
      state = "unreadable";
    }
    assertEquals(state, "unreadable");
  } finally {
    restore();
  }
});
