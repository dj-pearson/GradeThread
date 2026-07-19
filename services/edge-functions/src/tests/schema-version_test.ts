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

Deno.test("prod + behind (no grace) → fatal", async () => {
  let fatal: string | null = null;
  const cmp = await assertSchemaVersion({
    getLatest: () => Promise.resolve("00100"),
    env: "production",
    onFatal: (m) => { fatal = m; },
    graceAttempts: 0, // opt out of the retry window for an instant assertion
  });
  assertEquals(cmp, "behind");
  assert(fatal, "onFatal must fire on a confirmed behind-version in prod");
  assert(String(fatal).includes("STALE"));
});

// Grace window (B): the deploy/migrate race — DB is behind at boot but the
// migration lands within the window. The guard must re-poll and proceed, NOT
// crash-loop the service.
Deno.test("prod + behind that recovers within grace → proceeds, never fatal", async () => {
  let fatal = false;
  let slept = 0;
  // First read is behind; the 2nd (after one grace sleep) catches up to the
  // version this build expects. Subsequent reads stay caught up.
  const reads = ["00100", EXPECTED_SCHEMA_VERSION];
  let i = 0;
  const cmp = await assertSchemaVersion({
    getLatest: () => Promise.resolve(reads[Math.min(i++, reads.length - 1)]!),
    env: "production",
    onFatal: () => { fatal = true; },
    graceAttempts: 5,
    graceDelayMs: 1,
    sleep: () => { slept++; return Promise.resolve(); },
  });
  assertEquals(fatal, false, "must NOT be fatal when the migration lands in-window");
  assert(slept >= 1, "must have waited at least one grace interval");
  assertEquals(cmp, "match");
});

// Grace window exhausted: a genuinely-forgotten migration. The guard still ends
// in the loud fatal — just after the window, not before it.
Deno.test("prod + behind for the whole window → fatal after exhausting grace", async () => {
  let fatal: string | null = null;
  let polls = 0;
  const cmp = await assertSchemaVersion({
    getLatest: () => { polls++; return Promise.resolve("00100"); },
    env: "production",
    onFatal: (m) => { fatal = m; },
    graceAttempts: 3,
    graceDelayMs: 1,
    sleep: () => Promise.resolve(),
  });
  assertEquals(cmp, "behind");
  assert(fatal, "onFatal must fire once the grace window is exhausted");
  assert(String(fatal).includes("grace window"));
  // 1 initial read + 3 in-window re-polls.
  assertEquals(polls, 4);
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

// ── CI guard: every migration AFTER the self-recording infra self-records ──
//
// US-1108: 00254 added public.applied_migrations + a per-file footer so a
// migration records its own version no matter how it's applied (Studio paste /
// psql / CLI), keeping the US-778 boot guard in sync without manual catchup
// files. This test fails the build if a NEW migration forgets the footer.
// Files at/before 00254 predate the convention and are seeded by 00254 itself.
Deno.test("migrations after 00254 self-record their version (US-1108)", async () => {
  const SELF_RECORD_SINCE = "00254"; // exclusive — a GREATER prefix must comply
  const dir = new URL("../../../../supabase/migrations/", import.meta.url);
  const missing: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const m = entry.name.match(/^(\d+)_/);
    if (!m) continue;
    const prefix = m[1]!;
    if (prefix <= SELF_RECORD_SINCE) continue;
    const sql = await Deno.readTextFile(new URL(entry.name, dir));
    // Lenient: an insert of THIS file's own prefix into applied_migrations.
    if (!new RegExp(`applied_migrations[\\s\\S]*?'${prefix}'`, "i").test(sql)) {
      missing.push(entry.name);
    }
  }
  assertEquals(
    missing,
    [],
    "Every migration after " + SELF_RECORD_SINCE +
      " must end with the self-record footer (see MIGRATIONS.md):\n" +
      "  INSERT INTO public.applied_migrations (version) VALUES ('NNNNN') ON CONFLICT (version) DO NOTHING;\n" +
      "Missing in: " + missing.join(", "),
  );
});

// ── US-2009: set completeness, not just a max watermark ─────────────
//
// The watermark only moves forward and apply-prod-migrations.sh skips anything
// at or below it, so a migration that failed in the MIDDLE of the range is
// never re-applied and never seen again. This repo has already had one.

const { compareSchemaSets } = await import("../lib/schema-version.ts");
const { EXPECTED_MIGRATIONS, FOOTER_ERA_START } = await import(
  "../lib/migration-manifest.ts"
);

Deno.test("US-2009: a fully-applied set reports nothing", () => {
  const r = compareSchemaSets(["00254", "00255", "00256"], ["00254", "00255", "00256"], "00254");
  assertEquals(r.missing, []);
  assertEquals(r.unexpected, []);
});

// THE CASE THE WATERMARK CANNOT SEE: the head is present, so max comparison is
// happy, while a version underneath it never applied.
Deno.test("US-2009: a MID-SEQUENCE gap is detected even though the max matches", () => {
  const r = compareSchemaSets(
    ["00254", "00255", "00256"],
    ["00254", "00256"], // 00255 never applied; max is still 00256
    "00254",
  );
  assertEquals(r.missing, ["00255"]);
});

// THE PHANTOM CASE, measured live on 2026-07-19: /health/ready reported an
// applied version with no corresponding file anywhere in the repo. Reusing that
// number would satisfy the boot guard off a stale row even if the new SQL never
// ran — exactly the failure the guard exists to catch.
Deno.test("US-2009: a version applied with NO file in this build is flagged", () => {
  const r = compareSchemaSets(["00254", "00255"], ["00254", "00255", "00479"], "00254");
  assertEquals(r.unexpected, ["00479"]);
  assertEquals(r.missing, []);
});

// Pre-footer migrations carry no self-record, so their absence is expected and
// means nothing. Flagging them would produce ~253 permanent false positives —
// and a check that always fires is a check nobody reads.
Deno.test("US-2009: pre-footer-era versions are ignored in both directions", () => {
  const r = compareSchemaSets(["00254"], ["00100", "00253", "00254"], "00254");
  assertEquals(r.missing, []);
  assertEquals(r.unexpected, [], "an old recorded version is history, not a phantom");
});

Deno.test("US-2009: the shipped manifest is non-empty and starts at the footer era", () => {
  assert(EXPECTED_MIGRATIONS.length > 0, "manifest must not be empty");
  assertEquals(EXPECTED_MIGRATIONS[0], FOOTER_ERA_START);
  // Sorted + unique: the comparison relies on both.
  const sorted = [...EXPECTED_MIGRATIONS].sort();
  assertEquals([...EXPECTED_MIGRATIONS], sorted, "manifest must be sorted");
  assertEquals(new Set(EXPECTED_MIGRATIONS).size, EXPECTED_MIGRATIONS.length, "no duplicates");
});

// The manifest is generated, so it can go stale the moment someone adds a
// migration without regenerating — which would silently shrink what the boot
// guard checks.
Deno.test("US-2009: the manifest matches supabase/migrations on disk", async () => {
  const dir = new URL("../../../../supabase/migrations/", import.meta.url);
  const onDisk: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const v = entry.name.slice(0, entry.name.indexOf("_"));
    if (/^\d{5}$/.test(v) && v >= FOOTER_ERA_START) onDisk.push(v);
  }
  onDisk.sort();
  assertEquals(
    [...EXPECTED_MIGRATIONS],
    onDisk,
    "migration manifest is stale — run: node scripts/gen-migration-manifest.mjs",
  );
});
