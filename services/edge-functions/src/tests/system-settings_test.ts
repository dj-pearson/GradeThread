// US-884: settings registry value coercion/validation is pure + unit-tested.
// system-settings.ts imports the service-role supabase client at init; set dummy
// env BEFORE the dynamic import so the module loads in a DB-less test run.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { coerceSettingValue, isSettingValueType, getSettingSync } = await import(
  "../lib/system-settings.ts"
);

// ── coerceSettingValue ───────────────────────────────────────────

Deno.test("number: accepts finite numbers and numeric strings", () => {
  assertEquals(coerceSettingValue("number", 0.75), { ok: true, value: 0.75 });
  assertEquals(coerceSettingValue("number", "60"), { ok: true, value: 60 });
});

Deno.test("number: rejects NaN, booleans and non-numeric strings", () => {
  assert(!coerceSettingValue("number", "abc").ok);
  assert(!coerceSettingValue("number", true).ok);
  assert(!coerceSettingValue("number", Infinity).ok);
});

Deno.test("bool: accepts booleans and the canonical strings", () => {
  assertEquals(coerceSettingValue("bool", true), { ok: true, value: true });
  assertEquals(coerceSettingValue("bool", "false"), { ok: true, value: false });
  assert(!coerceSettingValue("bool", "yes").ok);
  assert(!coerceSettingValue("bool", 1).ok);
});

Deno.test("string: requires a string", () => {
  assertEquals(coerceSettingValue("string", "hi"), { ok: true, value: "hi" });
  assert(!coerceSettingValue("string", 5).ok);
});

Deno.test("json: parses strings and passes through objects", () => {
  assertEquals(coerceSettingValue("json", '{"a":1}'), { ok: true, value: { a: 1 } });
  const obj = { amber: 1, red: 25 };
  assertEquals(coerceSettingValue("json", obj), { ok: true, value: obj });
  assert(!coerceSettingValue("json", "{not json").ok);
});

// ── isSettingValueType ───────────────────────────────────────────

Deno.test("isSettingValueType: only the four declared types", () => {
  assert(isSettingValueType("number"));
  assert(isSettingValueType("json"));
  assert(!isSettingValueType("int"));
  assert(!isSettingValueType(42));
});

// ── getSettingSync ───────────────────────────────────────────────

Deno.test("getSettingSync: returns the fallback when the cache is cold", () => {
  // No DB in this test; a cold key serves the fallback (and fires a best-effort
  // background refresh that harmlessly fails against the dummy URL).
  assertEquals(getSettingSync("nonexistent_key_xyz", 123), 123);
});
