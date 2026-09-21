// Worth My Time, R1 01/12 (US-3166): the settings rules, driven.
//
// Run alone:
//   deno test --allow-net --allow-env --allow-read src/tests/work-preferences_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  applyWorkPreferencesPatch,
  defaultWorkPreferences,
  MAX_SESSION_MINUTES,
  MIN_SESSION_MINUTES,
  parseWorkPreferencesPatch,
  rowToWorkPreferences,
  SETTINGS_VERSION,
  workPreferencesResponse,
  WORK_TOOLS,
} from "../lib/work-preferences.ts";

// ── First use (AC6) ─────────────────────────────────────────────────

Deno.test("a seller who has never saved gets working defaults", () => {
  const p = defaultWorkPreferences();
  assertEquals(p.defaultSessionMinutes, 30);
  assertEquals(p.workContext, "home");
  // Every phone is a camera. Assuming a tape measure or a steamer would put
  // tasks in a plan the seller cannot actually do.
  assertEquals(p.availableTools, ["camera"]);
  assertEquals(p.hourlyTargetAmount, null);
  assertEquals(p.hourlyTargetCurrency, "USD");
  assertEquals(p.settingsVersion, SETTINGS_VERSION);
});

Deno.test("an absent row is defaults, not an error and not zeroes", () => {
  assertEquals(rowToWorkPreferences(null), defaultWorkPreferences());
});

// ── Partial updates (AC6) ───────────────────────────────────────────

Deno.test("a patch changes only what it names", () => {
  const before = defaultWorkPreferences();
  const parsed = parseWorkPreferencesPatch({ work_context: "phone_only" });
  assert(parsed.ok);
  const after = applyWorkPreferencesPatch(before, parsed.patch);
  assertEquals(after.workContext, "phone_only");
  assertEquals(after.defaultSessionMinutes, before.defaultSessionMinutes);
  assertEquals(after.availableTools, before.availableTools);
  assertEquals(after.hourlyTargetAmount, before.hourlyTargetAmount);
});

Deno.test("AC3: an unset target stays unset, and zero is not the same thing", () => {
  // The bug this exists to stop: a planner reading 0 ranks every task as
  // infinitely worth doing, and a screen using a falsy check shows a
  // deliberate $0.00 target as "not set". Null and zero are different answers
  // to different questions and both are legal.
  const unset = defaultWorkPreferences();
  assertEquals(unset.hourlyTargetAmount, null);
  assertEquals(workPreferencesResponse(unset).hourly_target_set, false);

  const zeroPatch = parseWorkPreferencesPatch({ hourly_target_amount: 0 });
  assert(zeroPatch.ok);
  const zero = applyWorkPreferencesPatch(unset, zeroPatch.patch);
  assertEquals(zero.hourlyTargetAmount, 0);
  assertEquals(
    workPreferencesResponse(zero).hourly_target_set,
    true,
    "a target of exactly 0 is a choice the seller made, not an absence",
  );
});

Deno.test("AC3: an explicit null CLEARS the target; an absent key does not", () => {
  const set = applyWorkPreferencesPatch(defaultWorkPreferences(), {
    hourlyTargetAmount: 24.5,
  });
  assertEquals(set.hourlyTargetAmount, 24.5);

  // Absent: leave it alone. This is what every save of any other control does,
  // and treating it as a clear would wipe the target on every settings save.
  const other = parseWorkPreferencesPatch({ default_session_minutes: 60 });
  assert(other.ok);
  assertEquals(applyWorkPreferencesPatch(set, other.patch).hourlyTargetAmount, 24.5);

  // Explicit null: clear it. Without this there is no way back to "not set"
  // once a seller has typed a number.
  const cleared = parseWorkPreferencesPatch({ hourly_target_amount: null });
  assert(cleared.ok);
  assertEquals(applyWorkPreferencesPatch(set, cleared.patch).hourlyTargetAmount, null);
});

// ── Validation (AC6) ────────────────────────────────────────────────

Deno.test("session minutes: presets, the whole custom range, and its edges", () => {
  for (const good of [MIN_SESSION_MINUTES, 15, 30, 60, 137, MAX_SESSION_MINUTES]) {
    const r = parseWorkPreferencesPatch({ default_session_minutes: good });
    assert(r.ok, `${good} should be accepted`);
    assertEquals(r.patch.defaultSessionMinutes, good);
  }
  for (
    const bad of [
      MIN_SESSION_MINUTES - 1,
      MAX_SESSION_MINUTES + 1,
      0,
      -30,
      // Whole minutes only: a half-minute is not a thing a seller means, and
      // it would reach the CHECK as a rounding argument rather than a refusal.
      30.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "30",
      null,
    ]
  ) {
    const r = parseWorkPreferencesPatch({ default_session_minutes: bad });
    assert(!r.ok, `${String(bad)} should be refused`);
    assertEquals(r.errors[0]!.field, "default_session_minutes");
  }
});

Deno.test("tools: unknown ones are refused, known ones are deduped and ordered", () => {
  const bad = parseWorkPreferencesPatch({
    available_tools: ["camera", "sewing_machine"],
  });
  assert(!bad.ok);
  assertEquals(bad.errors[0]!.field, "available_tools");
  assert(bad.errors[0]!.message.includes("sewing_machine"));

  // Two sellers who ticked the same boxes in a different order must store the
  // same row, or a later diff of the two is about the clicks.
  const a = parseWorkPreferencesPatch({
    available_tools: ["steamer", "camera", "camera"],
  });
  const b = parseWorkPreferencesPatch({ available_tools: ["camera", "steamer"] });
  assert(a.ok && b.ok);
  assertEquals(a.patch.availableTools, b.patch.availableTools);
  assertEquals(a.patch.availableTools, ["camera", "steamer"]);

  // An empty list is legal: a seller with nothing to hand still gets a plan,
  // made only of the tasks that need no tools.
  const none = parseWorkPreferencesPatch({ available_tools: [] });
  assert(none.ok);
  assertEquals(none.patch.availableTools, []);

  const notAList = parseWorkPreferencesPatch({ available_tools: "camera" });
  assert(!notAList.ok);
});

Deno.test("work context: only the two that have tasks to run in them", () => {
  for (const good of ["home", "phone_only"]) {
    assert(parseWorkPreferencesPatch({ work_context: good }).ok);
  }
  // sourcing_trip is the obvious third and is deliberately absent: no task in
  // R1 can run in a thrift store aisle, and a mode with nothing to do in it
  // teaches a seller the feature is empty.
  for (const bad of ["sourcing_trip", "", "HOME", 1, null]) {
    const r = parseWorkPreferencesPatch({ work_context: bad });
    assert(!r.ok, `${String(bad)} should be refused`);
  }
});

Deno.test("money: finite, nonnegative, at most two decimal places, USD only", () => {
  for (const good of [0, 5, 18.25, 999.99]) {
    const r = parseWorkPreferencesPatch({ hourly_target_amount: good });
    assert(r.ok, `${good} should be accepted`);
  }
  for (const bad of [-1, -0.01, Number.NaN, Number.POSITIVE_INFINITY, "20", 12.345]) {
    const r = parseWorkPreferencesPatch({ hourly_target_amount: bad });
    assert(!r.ok, `${String(bad)} should be refused`);
    assertEquals(r.errors[0]!.field, "hourly_target_amount");
  }
  assert(parseWorkPreferencesPatch({ hourly_target_currency: "USD" }).ok);
  // AC1: USD only until conversion exists. Storing EUR would produce a plan
  // whose numbers are wrong by an exchange rate nobody applied.
  const eur = parseWorkPreferencesPatch({ hourly_target_currency: "EUR" });
  assert(!eur.ok);
  assertEquals(eur.errors[0]!.field, "hourly_target_currency");
});

Deno.test("every mistake is reported, not just the first", () => {
  // A screen saving four controls should be told about all four rather than
  // discovering them one round trip at a time.
  const r = parseWorkPreferencesPatch({
    default_session_minutes: 3,
    work_context: "sourcing_trip",
    available_tools: ["anvil"],
    hourly_target_amount: -5,
  });
  assert(!r.ok);
  assertEquals(r.errors.length, 4);
  assertEquals(
    r.errors.map((e) => e.field).sort(),
    [
      "available_tools",
      "default_session_minutes",
      "hourly_target_amount",
      "work_context",
    ],
  );
});

Deno.test("a body that is not an object is refused rather than coerced", () => {
  for (const bad of [null, "settings", 42, ["camera"]]) {
    const r = parseWorkPreferencesPatch(bad);
    assert(!r.ok, `${String(bad)} should be refused`);
  }
  // An empty object is a legal no-op patch: the route re-saves the current
  // values, which is what a screen with nothing changed sends.
  assert(parseWorkPreferencesPatch({}).ok);
});

// ── Reading a stored row ────────────────────────────────────────────

Deno.test("a numeric column arriving as a STRING is still a number", () => {
  // PostgREST returns numeric(10,2) as a string. Reading it without the parse
  // gives NaN, which is neither null nor a target -- it renders as "not set"
  // on one screen and breaks arithmetic on another.
  const p = rowToWorkPreferences({
    default_session_minutes: 45,
    work_context: "phone_only",
    available_tools: ["camera", "steamer"],
    hourly_target_amount: "18.25",
    hourly_target_currency: "USD",
    settings_version: 1,
  });
  assertEquals(p.hourlyTargetAmount, 18.25);
  assertEquals(p.defaultSessionMinutes, 45);
  assertEquals(p.workContext, "phone_only");
  assertEquals(p.availableTools, ["camera", "steamer"]);
});

Deno.test("a corrupt row falls back per field, and does NOT invent a target", () => {
  const base = defaultWorkPreferences();
  const p = rowToWorkPreferences({
    default_session_minutes: 9999,
    work_context: "sourcing_trip",
    available_tools: ["anvil", "camera"],
    hourly_target_amount: "not a number",
    hourly_target_currency: "EUR",
    settings_version: null,
  });
  assertEquals(p.defaultSessionMinutes, base.defaultSessionMinutes);
  assertEquals(p.workContext, base.workContext);
  // The unknown tool is dropped and the known one kept, rather than the whole
  // list falling back -- a seller who owns a steamer keeps their steamer.
  assertEquals(p.availableTools, ["camera"]);
  assertEquals(
    p.hourlyTargetAmount,
    null,
    "an unreadable target is UNSET, never a number we made up",
  );
  assertEquals(p.hourlyTargetCurrency, "USD");
});

// ── Two sellers (AC6) ───────────────────────────────────────────────

Deno.test("two sellers' settings do not touch each other", () => {
  // The pure half of the isolation claim. The route half is the case in
  // tenant-isolation_test.ts; this one proves the merge cannot leak, so a
  // failure there is about the query rather than about this.
  const a = applyWorkPreferencesPatch(defaultWorkPreferences(), {
    defaultSessionMinutes: 15,
    workContext: "phone_only",
    hourlyTargetAmount: 40,
  });
  const b = applyWorkPreferencesPatch(defaultWorkPreferences(), {
    defaultSessionMinutes: 120,
    availableTools: ["camera", "steamer", "packing_supplies"],
  });
  assertEquals(a.defaultSessionMinutes, 15);
  assertEquals(b.defaultSessionMinutes, 120);
  assertEquals(a.hourlyTargetAmount, 40);
  assertEquals(b.hourlyTargetAmount, null);
  assertEquals(a.availableTools, ["camera"]);
  assertEquals(b.availableTools, ["camera", "steamer", "packing_supplies"]);
});

// ── The response shape the screen reads ─────────────────────────────

Deno.test("the response carries the choices the screen has to render", () => {
  const body = workPreferencesResponse(defaultWorkPreferences());
  assertEquals(body.session_minute_presets, [15, 30, 60]);
  assertEquals(body.min_session_minutes, MIN_SESSION_MINUTES);
  assertEquals(body.max_session_minutes, MAX_SESSION_MINUTES);
  assertEquals(body.work_tools, WORK_TOOLS);
  assertEquals(body.work_contexts, ["home", "phone_only"]);
  assertEquals(body.settings_version, SETTINGS_VERSION);
});

// ── AC1's contract, where a scan is the right tool ──────────────────

Deno.test("AC1: the planner inputs need no model call", async () => {
  // Rule-based planning, no new model calls -- a limit on the whole feature,
  // asserted at its first file because that is where the pattern gets set.
  const src = await Deno.readTextFile(
    new URL("../lib/work-preferences.ts", import.meta.url),
  );
  const code = src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .join("\n");
  for (const banned of ["anthropic", "messages.create", "messages.stream", "fetch("]) {
    assert(
      !code.includes(banned),
      `work-preferences.ts names "${banned}": R1 planning is rule-based with no model calls`,
    );
  }
});
