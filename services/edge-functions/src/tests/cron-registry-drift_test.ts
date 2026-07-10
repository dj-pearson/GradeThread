// US-1561: cron-registry drift guards.
//
// Three invariants, each of which has silently broken before:
//   1. CODE ↔ REGISTRY — every /api/jobs/* route registered in main.ts has a
//      CRON_REGISTRY entry and vice versa (a new cron without a registry entry
//      fails; a registry entry whose route was removed fails).
//   2. REGISTRY sanity — unique names/endpoints, every schedule parses through
//      nextCronRun (a typo'd cron string would silently never fire).
//   3. DOCS ↔ REGISTRY — COOLIFY.md and LAUNCH_CHECKLIST.md embed the exact
//      renderCronDocs() output between the cron-registry markers, so the
//      operator docs can never drift from the code again.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { CRON_REGISTRY, nextCronRun, renderCronDocs, renderCronSetupGuide } = await import(
  "../lib/cron-runs.ts"
);

const MAIN_TS = new URL("../main.ts", import.meta.url);
const EBAY_ROUTES = new URL("../routes/flipdesk-ebay.ts", import.meta.url);
const COOLIFY = new URL("../../COOLIFY.md", import.meta.url);
const CHECKLIST = new URL("../../../../LAUNCH_CHECKLIST.md", import.meta.url);
const CRON_SETUP = new URL("../../CRON_SETUP.md", import.meta.url);

Deno.test("US-1561: every /api/jobs/* route in main.ts is registered (and none is stale)", async () => {
  const main = await Deno.readTextFile(MAIN_TS);
  const routed = new Set(
    [...main.matchAll(/app\.post\("(\/api\/jobs\/[^"]+)"/g)].map((m) => m[1]),
  );
  const registered = new Set(
    CRON_REGISTRY.map((d) => d.endpoint).filter((e) => e.startsWith("/api/jobs/")),
  );
  for (const path of routed) {
    assert(
      registered.has(path),
      `${path} is mounted in main.ts but missing from CRON_REGISTRY — ` +
        "register it (schedule, secret, category) in lib/cron-runs.ts",
    );
  }
  for (const path of registered) {
    assert(
      routed.has(path),
      `${path} is in CRON_REGISTRY but no longer mounted in main.ts — remove the stale entry`,
    );
  }
});

Deno.test("US-1561: the eBay sub-router cron endpoints are registered", async () => {
  const src = await Deno.readTextFile(EBAY_ROUTES);
  const jobPaths = new Set(
    [...src.matchAll(/"(\/jobs\/[^"]+)"/g)].map(
      (m) => `/api/flipdesk/ebay${m[1]}`,
    ),
  );
  const registered = new Set(CRON_REGISTRY.map((d) => d.endpoint));
  for (const path of jobPaths) {
    assert(
      registered.has(path),
      `${path} (flipdesk-ebay.ts) is missing from CRON_REGISTRY`,
    );
  }
});

Deno.test("US-1561: registry entries are unique and every schedule parses", () => {
  const names = CRON_REGISTRY.map((d) => d.name);
  assertEquals(new Set(names).size, names.length, "duplicate cron names");
  const endpoints = CRON_REGISTRY.map((d) => d.endpoint);
  assertEquals(new Set(endpoints).size, endpoints.length, "duplicate endpoints");
  const from = new Date("2026-01-01T00:00:00Z");
  for (const def of CRON_REGISTRY) {
    assert(
      nextCronRun(def.schedule, from) !== null,
      `${def.name}: schedule "${def.schedule}" never fires (typo?)`,
    );
  }
});

Deno.test("US-1561: COOLIFY.md and LAUNCH_CHECKLIST.md embed the generated table verbatim", async () => {
  // renderCronDocs() emits LF; normalize the docs' line endings before matching
  // so the guard is agnostic to the dev's checkout config. On a Windows checkout
  // core.autocrlf=true smudges these LF-in-git files to CRLF in the working tree,
  // which would otherwise make the LF-only marker regex miss ("markers missing").
  const expected = renderCronDocs().replace(/\r\n/g, "\n").trim();
  for (const [doc, url] of [["COOLIFY.md", COOLIFY], ["LAUNCH_CHECKLIST.md", CHECKLIST]] as const) {
    const text = (await Deno.readTextFile(url)).replace(/\r\n/g, "\n");
    const m = text.match(
      /<!-- cron-registry:start[^>]*-->\n([\s\S]*?)\n<!-- cron-registry:end -->/,
    );
    assert(m, `${doc}: cron-registry markers missing`);
    assertEquals(
      m![1].trim(),
      expected,
      `${doc}: the embedded cron table drifted from CRON_REGISTRY — regenerate with ` +
        "`deno run --allow-env --allow-net --allow-read scripts/render-cron-docs.ts` and paste between the markers",
    );
  }
});

Deno.test("CRON_SETUP.md embeds the generated Coolify setup blocks verbatim", async () => {
  const expected = renderCronSetupGuide().replace(/\r\n/g, "\n").trim();
  const text = (await Deno.readTextFile(CRON_SETUP)).replace(/\r\n/g, "\n");
  const m = text.match(/<!-- cron-setup:start[^>]*-->\n([\s\S]*?)\n<!-- cron-setup:end -->/);
  assert(m, "CRON_SETUP.md: cron-setup markers missing");
  assertEquals(
    m![1].trim(),
    expected,
    "CRON_SETUP.md drifted from CRON_REGISTRY — regenerate with " +
      "`deno run --allow-env --allow-net --allow-read scripts/render-cron-setup.ts` and paste between the markers",
  );
});
