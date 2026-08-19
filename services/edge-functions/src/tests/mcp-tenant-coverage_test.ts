// US-9112: a tool cannot ship without a cross-tenant case.
//
// WHY THIS IS A SEPARATE FILE AND NOT A CHECKLIST. Every tool in the registry
// runs on the service-role client, which bypasses RLS, so tenant isolation
// rests entirely on each handler filtering by the caller's tenant. A checklist
// that says "add an isolation case" is followed until the day it is not, and
// the failure is silent: the suite stays green because the case that would have
// failed was never written.
//
// So the registry is ENUMERATED and matched against the isolation suite's
// source. A tool with no case fails this test, which fails the build.
//
// It runs unconditionally: it reads files, needs no fixture, and a guard that
// only runs when a full stack is up is a guard nobody watches fail. The cases
// it requires DO need the stack, and skip cleanly without it — which is exactly
// why their EXISTENCE has to be checked somewhere that does not.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { TOOLS } = await import("../lib/mcp-tools.ts");

const ISOLATION_SUITE = await Deno.readTextFile(
  new URL("./tenant-isolation_test.ts", import.meta.url),
);

/** The tool names named by a Deno.test in the isolation suite. */
function coveredToolNames(): Set<string> {
  const covered = new Set<string>();
  for (const block of ISOLATION_SUITE.split("Deno.test(").slice(1)) {
    // Stop at the next test so a name mentioned in a later block is not
    // credited to this one.
    for (const match of block.matchAll(/gradethread_[a-z0-9_]+/g)) covered.add(match[0]);
  }
  return covered;
}

Deno.test("every MCP tool has a cross-tenant case in the isolation suite", () => {
  assert(TOOLS.length > 0, "the registry is empty; this guard would assert nothing");

  const covered = coveredToolNames();
  const uncovered = TOOLS.map((t) => t.name).filter((name) => !covered.has(name)).sort();

  assertEquals(
    uncovered,
    [],
    "These MCP tools have no cross-tenant case in src/tests/tenant-isolation_test.ts. " +
      "The edge bypasses RLS, so an unscoped tool leaks another seller's data and nothing " +
      "else catches it. Add a case driving the tool as tenant B against tenant A's id.",
  );
});

Deno.test("the isolation suite does not name tools that no longer exist", () => {
  // A case for a deleted tool asserts nothing, and reads as coverage.
  const registered = new Set(TOOLS.map((t) => t.name));
  const stale = [...coveredToolNames()].filter((name) => !registered.has(name)).sort();
  assertEquals(
    stale,
    [],
    "These tool names appear in the isolation suite but are not in the registry, so those " +
      "cases test nothing. Remove them or fix the name.",
  );
});

Deno.test("the guard can actually fail: a fabricated tool name is not covered", () => {
  // Guard the guard. If coveredToolNames() ever started returning everything —
  // a regex that matched too much, a file read that silently returned "" — the
  // two tests above would pass forever.
  const covered = coveredToolNames();
  assert(
    !covered.has("gradethread_this_tool_does_not_exist"),
    "coveredToolNames() is matching names that are not in the suite",
  );
  assert(covered.size > 0, "coveredToolNames() found nothing; the suite path or regex is wrong");
});
