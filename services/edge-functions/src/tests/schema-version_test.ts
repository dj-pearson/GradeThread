// US-778: schema-version boot assertion + the CI sync-check that keeps
// EXPECTED_SCHEMA_VERSION from drifting from the migrations directory.
//
// schema-version.ts imports the service-role supabase client at init; set dummy
// env BEFORE the dynamic import.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { EXPECTED_SCHEMA_VERSION, compareSchemaVersion, assertSchemaVersion } = await import(
  "../lib/schema-version.ts"
);

// ── pure comparison ──────────────────────────────────────────────

Deno.test("compareSchemaVersion: equal numbers match (ignores the name suffix)", () => {
  assertEquals(compareSchemaVersion("00126", "00126_schema_version_fn"), "match");
  assertEquals(compareSchemaVersion("00126", "00126"), "match");
});

Deno.test("compareSchemaVersion: DB behind expected", () => {
  assertEquals(compareSchemaVersion("00126", "00125_abandoned"), "behind");
});

Deno.test("compareSchemaVersion: DB ahead of expected", () => {
  assertEquals(compareSchemaVersion("00126", "00130"), "ahead");
});

Deno.test("compareSchemaVersion: null/garbage latest is unknown", () => {
  assertEquals(compareSchemaVersion("00126", null), "unknown");
  assertEquals(compareSchemaVersion("00126", "no-digits"), "unknown");
});

// ── assertSchemaVersion behavior ─────────────────────────────────

Deno.test("prod + behind → fatal", async () => {
  let fatal: string | null = null;
  const cmp = await assertSchemaVersion({
    getLatest: () => Promise.resolve("00100"),
    env: "production",
    onFatal: (m) => { fatal = m; },
  });
  assertEquals(cmp, "behind");
  assert(fatal, "onFatal must fire on a confirmed behind-version in prod");
  assert(String(fatal).includes("STALE"));
});

Deno.test("dev + behind → warn, NOT fatal", async () => {
  let fatal = false;
  const cmp = await assertSchemaVersion({
    getLatest: () => Promise.resolve("00100"),
    env: "development",
    onFatal: () => { fatal = true; },
  });
  assertEquals(cmp, "behind");
  assertEquals(fatal, false);
});

Deno.test("unreadable migrations table → unknown, never fatal (fail-open)", async () => {
  let fatal = false;
  const cmp = await assertSchemaVersion({
    getLatest: () => Promise.resolve(null),
    env: "production",
    onFatal: () => { fatal = true; },
  });
  assertEquals(cmp, "unknown");
  assertEquals(fatal, false);
});

Deno.test("match → ok, never fatal", async () => {
  let fatal = false;
  const cmp = await assertSchemaVersion({
    getLatest: () => Promise.resolve(EXPECTED_SCHEMA_VERSION),
    env: "production",
    onFatal: () => { fatal = true; },
  });
  assertEquals(cmp, "match");
  assertEquals(fatal, false);
});

// ── CI sync-check: the constant matches the migrations directory ──

Deno.test("EXPECTED_SCHEMA_VERSION equals the LEXICALLY-last migration prefix", async () => {
  // The DB returns the latest via `ORDER BY version DESC` (text/lexical), which
  // is also how the prod apply loop (`ls … | sort`) orders files — so the
  // sync-check must use the SAME lexical ordering, not numeric. (A few legacy
  // 6-digit prefixes like 000385 sort BEFORE the 5-digit 001xx range, exactly as
  // they apply, so they're never the "latest".)
  const dir = new URL("../../../../supabase/migrations/", import.meta.url);
  let maxPrefix = "";
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const m = entry.name.match(/^(\d+)_/);
    if (!m) continue;
    if (m[1] > maxPrefix) maxPrefix = m[1];
  }
  assert(maxPrefix !== "", "found at least one NNNNN_*.sql migration");
  assertEquals(
    EXPECTED_SCHEMA_VERSION,
    maxPrefix,
    `EXPECTED_SCHEMA_VERSION (${EXPECTED_SCHEMA_VERSION}) must equal the lexically-last migration prefix (${maxPrefix}). ` +
      "Bump it in the same commit as the new migration.",
  );
});
