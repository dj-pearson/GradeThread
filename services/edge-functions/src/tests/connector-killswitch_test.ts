// US-9127 AC7: the rollback that does not need a deploy.
//
// MCP_ENABLED is an environment variable, and changing one means a redeploy —
// minutes during which the surface you are trying to stop keeps publishing
// listings. The `claude_connector` feature flag closes every replica within the
// 30-second flag cache TTL instead.
//
// The behaviour was verified end to end against a seeded stack (200 → 404 → 200
// across a toggle and back). What THIS file protects is the wiring, because the
// failure mode is silent: a gate that stops consulting the flag looks exactly
// like a connector that is working.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const SRC = await Deno.readTextFile(new URL("../routes/mcp.ts", import.meta.url));
const FLAGS = await Deno.readTextFile(new URL("../lib/feature-flags.ts", import.meta.url));

Deno.test("the flag key is declared", () => {
  assert(
    /\|\s*"claude_connector"/.test(FLAGS),
    "claude_connector is no longer a FeatureKey, so the kill switch reads nothing",
  );
});

Deno.test("EVERY method on /mcp goes through the gate", () => {
  // A stop button that closes POST but leaves GET open is not a stop button.
  // Counted rather than spot-checked: a method added later without the gate is
  // the shape this catches.
  const handlers = SRC.match(/mcpRoutes\.(post|get|delete)\(/g) ?? [];
  const gates = SRC.match(/await isConnectorLive\(\)/g) ?? [];
  assert(handlers.length >= 3, `expected the three HTTP methods, saw ${handlers.length}`);
  assertEquals(
    gates.length,
    handlers.length,
    "a method on /mcp does not check the kill switch",
  );
});

Deno.test("EITHER gate being off closes the endpoint", () => {
  // The env var is the deploy-time default and the flag is the stop button.
  // A stop button should need one thing to say stop, not two things to agree,
  // so this is an AND of both rather than a fallback from one to the other.
  const fn = SRC.slice(SRC.indexOf("async function isConnectorLive"));
  assert(
    /if \(!isMcpEnabled\(\)\) return false;/.test(fn),
    "the env var no longer closes the endpoint on its own",
  );
  assert(
    /isFeatureEnabled\("claude_connector"\)/.test(fn),
    "the flag no longer closes the endpoint on its own",
  );
});

Deno.test("the flag read FAILS OPEN, like every other ops kill switch", () => {
  // An unreachable flag table must not take the connector down with it. The
  // thing that fails CLOSED on this surface is the ALLOWANCE, which gates
  // spending — and that one does.
  const fn = SRC.slice(SRC.indexOf("async function isConnectorLive"));
  assert(
    !/defaultEnabled:\s*false/.test(fn),
    "the connector flag was made fail-closed; an outage in the flag store would " +
      "now take the connector down, which is not what a kill switch is for",
  );
});

Deno.test("US-9127: the flag has a ROW, or an operator cannot press it", async () => {
  // 00607's lesson, applied rather than repeated: the admin console lists rows
  // and the toggle endpoint 404s "Unknown feature flag" when there is none, so
  // a declared switch with no row exists in the type system and nowhere an
  // operator can reach during an incident.
  const migration = await Deno.readTextFile(
    new URL("../../../../supabase/migrations/00623_seed_claude_connector_flag.sql", import.meta.url),
  );
  assert(
    /insert into public\.feature_flags[\s\S]*'claude_connector'/.test(migration),
    "00623 no longer seeds the claude_connector row",
  );
  assert(
    /on conflict \(key\) do nothing/.test(migration),
    "the seed must not clobber an operator override on a re-run",
  );
});
