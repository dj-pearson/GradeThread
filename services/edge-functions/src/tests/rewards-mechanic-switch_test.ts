import { assert, assertEquals } from "@std/assert";

// US-1915 AC3. The setting is operator-editable jsonb with no schema behind it —
// a super-admin can type anything into it at /admin/ops/settings and it takes
// effect within the cache TTL, with no review and no CI. So the parsing has to
// survive anything, and it must degrade toward "nothing is disabled".
//
// BOTH imports below are DEFERRED behind dummy env — the same pattern
// health_test uses. rewards-engine.ts loads the service-role supabase client at
// module scope, and so does system-settings.ts, which the switch module imports.
// A static import of EITHER fails the whole file before a single test runs.

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { DISABLED_MECHANICS_KEY, normalizeDisabledMechanics } = await import(
  "../lib/rewards-mechanic-switch.ts"
);
const { REWARD_XP_CATALOG } = await import("../lib/rewards-engine.ts");

Deno.test("a well-formed list disables exactly those mechanics", () => {
  const s = normalizeDisabledMechanics(["quest_completed", "verified_share"]);
  assertEquals(s.size, 2);
  assert(s.has("quest_completed"));
  assert(s.has("verified_share"));
  assert(!s.has("coverage_completed"));
});

Deno.test("⚠ malformed settings degrade to NOTHING disabled, never to everything", () => {
  // The dangerous failure is the inverse of the obvious one. If a bad value
  // parsed as "disable everything", one fat-fingered edit would silently switch
  // off the entire progression system with no error raised anywhere — and
  // because grantReward's callers treat a disabled mechanic as a no-op, nothing
  // downstream would complain either.
  for (
    const bad of [
      null,
      undefined,
      "quest_completed", // a bare string, not a list
      { quest_completed: true },
      42,
      true,
    ]
  ) {
    assertEquals(
      normalizeDisabledMechanics(bad).size,
      0,
      `${JSON.stringify(bad)} must disable nothing`,
    );
  }
});

Deno.test("junk entries inside a list are dropped, the good ones still count", () => {
  // A partly-bad list must not throw away the operator's real intent, and must
  // not keep the junk either — a blank string in the set would match nothing
  // while making the list look longer than it is.
  const s = normalizeDisabledMechanics([
    "quest_completed",
    "",
    "   ",
    null,
    7,
    { a: 1 },
    "  verified_share  ",
  ]);
  assertEquals([...s].sort(), ["quest_completed", "verified_share"]);
});

Deno.test("the empty list is the default, and it means everything is on", () => {
  // getSetting returns the fallback for a key never written, and the fallback
  // is []. This is why the feature needs no migration and no seed row: the
  // untouched state is exactly today's behaviour.
  assertEquals(normalizeDisabledMechanics([]).size, 0);
});

Deno.test("every mechanic in the XP catalog is switchable by name", () => {
  // The admin console lists mechanics FROM the catalog, so a mechanic added
  // tomorrow is switchable without anyone remembering to register it. Assert
  // the two agree in fact rather than by intention: a catalog key must round
  // trip through the parser it will be stored with.
  const keys = Object.keys(REWARD_XP_CATALOG);
  assert(keys.length >= 9, `expected the full mechanic set, got ${keys.length}`);
  let checked = 0;
  for (const k of keys) {
    assert(
      normalizeDisabledMechanics([k]).has(k),
      `${k} does not survive the parser and so could never be switched off`,
    );
    checked++;
  }
  assertEquals(checked, keys.length);
});

Deno.test("the settings key is namespaced and stable", () => {
  // It is stored in a shared operator registry, so a generic name would collide
  // with some other feature's list. Pinned because renaming it silently
  // re-enables every mechanic an operator had switched off.
  assertEquals(DISABLED_MECHANICS_KEY, "rewards.disabled_mechanics");
});
