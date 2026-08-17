import "./_env.ts";
// US-2379: no test file may depend on another test file having run first.
//
// lib/supabase.ts USED TO THROW at IMPORT time when SUPABASE_URL was missing —
// tolerable for a container, fatal for a test file that only wanted a pure
// function out of a route. 42 files were reaching it through their static
// import graph without setting the env, so they loaded fine in a full run
// (something earlier had set it) and threw "SUPABASE_URL is not set" when run
// alone. The suite passed in exactly one order, which also ruled out sharding
// and --shuffle.
//
// ⚠ THAT THROW IS GONE (US-2661) — the client is built on first USE now, so
// nothing in this list currently throws at import and the rule below is
// belt-and-braces rather than load-bearing. It is KEPT rather than deleted for
// one reason: the failure it prevents is order-dependence, which is invisible
// in a full run and only shows up when someone runs one file. The next module
// that reads env at load would recreate it silently, and adding that module to
// ENV_AT_IMPORT is a one-line fix only while the machinery still exists. The
// cost of keeping it is that new test files put "./_env.ts" first for no
// present reason, which is cheap and harmless.
//
// The rule this pins: if a test file's STATIC import graph can reach a module
// that reads env at load, "./_env.ts" must be its FIRST import. Files that
// instead set the env themselves and then `await import(...)` are unaffected —
// a dynamic import is not in the static graph, which is precisely why that
// pattern already worked.
//
// Checked by walking the graph rather than by running 570 subprocesses: same
// answer, and it takes milliseconds.

import { assert, assertEquals } from "@std/assert";
import { assertRequiredEnv, missingRequiredEnv } from "../lib/env-validation.ts";

const TESTS = new URL("./", import.meta.url);

// Modules that throw at import time when their env is absent. Reaching one of
// these — at any depth — is what makes a test file order-dependent.
const ENV_AT_IMPORT = ["src/lib/supabase.ts"];

const read = async (u: URL) => (await Deno.readTextFile(u)).replace(/\r\n/g, "\n");

/**
 * Static import specifiers, in source order.
 *
 * Excludes two kinds that do NOT load a module at runtime, and counting either
 * would produce a false positive:
 *   • `await import(…)` — dynamic, and deliberately how the env-setting files
 *     already avoid this problem.
 *   • `import type … from` / `export type … from` — erased by the compiler, so
 *     a test can name a type out of a supabase-touching module for free. Nine
 *     files do exactly that.
 */
function staticImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(?:import|export)([^;'"]*?)["']([^"']+)["']/gm)) {
    const prelude = m[1];
    if (/^\s+type\s/.test(prelude)) continue;
    // A static import's prelude holds only identifiers, braces, commas, `as`,
    // `*` and `from`. An `=` or `(` means the match ran past the statement and
    // landed on a quote further down — which is how `export const deps = {
    // … await import("./supabase.ts") }` was being read as a static import of
    // supabase, the exact opposite of what that lazy import is doing.
    if (/[=(]/.test(prelude)) continue;
    out.push(m[2]);
  }
  return out;
}

/** Repo-relative path of a URL under services/edge-functions/. */
function rel(u: URL): string {
  const root = new URL("../../", TESTS).href;
  return decodeURIComponent(u.href.slice(root.length));
}

const graphCache = new Map<string, boolean>();

/** Does this module reach an env-at-import module through static imports? */
async function reachesEnvModule(mod: URL, seen = new Set<string>()): Promise<boolean> {
  const key = mod.href;
  if (graphCache.has(key)) return graphCache.get(key)!;
  if (seen.has(key)) return false;
  seen.add(key);

  if (ENV_AT_IMPORT.includes(rel(mod))) return true;

  let src: string;
  try {
    src = await read(mod);
  } catch {
    return false; // not on disk (a bare npm/jsr specifier resolved oddly)
  }

  let hit = false;
  for (const spec of staticImports(src)) {
    if (!spec.startsWith(".")) continue; // npm:, jsr:, @std/… — never ours
    if (await reachesEnvModule(new URL(spec, mod), seen)) {
      hit = true;
      break;
    }
  }
  graphCache.set(key, hit);
  return hit;
}

async function testFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(TESTS)) {
    if (e.isFile && e.name.endsWith("_test.ts")) out.push(e.name);
  }
  return out.sort();
}

Deno.test("US-2379: a test file that reaches env-at-import loads _env.ts first", async () => {
  const offenders: string[] = [];
  for (const name of await testFiles()) {
    const url = new URL(name, TESTS);
    const src = await read(url);
    const imports = staticImports(src);
    // Only the graph matters — a file that imports nothing of ours is fine.
    const needsEnv = await (async () => {
      for (const spec of imports) {
        if (!spec.startsWith(".")) continue;
        if (spec === "./_env.ts") continue;
        if (await reachesEnvModule(new URL(spec, url))) return true;
      }
      return false;
    })();
    if (!needsEnv) continue;
    if (imports[0] !== "./_env.ts") {
      offenders.push(
        `${name}: reaches ${ENV_AT_IMPORT.join("/")} through its static imports, so ` +
          `it must start with import "./_env.ts"; (first import is ` +
          `${imports[0] ?? "none"})`,
      );
    }
  }
  assertEquals(
    offenders,
    [],
    "Test file(s) that only load because another file ran first:\n" + offenders.join("\n"),
  );
});

Deno.test("US-2379: _env.ts sets defaults and never overrides a real value", async () => {
  const src = await read(new URL("./_env.ts", TESTS));
  // The distinction that keeps the tenant-isolation fixture working: it runs
  // against a real stack, and a hardcoded Deno.env.set would clobber it.
  assert(
    src.includes('if (!Deno.env.get(key)) Deno.env.set(key, value)'),
    "_env.ts must only fill a MISSING value, never replace one",
  );
  assert(src.includes('"SUPABASE_URL"'), "_env.ts must cover SUPABASE_URL");
  assert(
    src.includes('"SUPABASE_SERVICE_ROLE_KEY"'),
    "_env.ts must cover the service key",
  );
});

Deno.test("US-2661: lib/supabase.ts builds its client lazily, not at import", async () => {
  // ⚠ THIS CASE USED TO ASSERT THE OPPOSITE, and its reasoning was right while
  // its mechanism was wrong. It read:
  //
  //   "The fix must not have been 'make the assertion lazy'. A container
  //    without credentials has to die at boot rather than serve 500s on first
  //    request."
  //
  // The requirement stands. The module-scope throw was never what delivered it,
  // though — main.ts calls assertRequiredEnv() before Deno.serve, and that is
  // what refuses the boot. Meanwhile the eager throw was breaking three
  // operator scripts that never query at all (US-2661): they died on
  // "SUPABASE_URL is not set" before printing their own usage line, purely
  // because something in their import graph reached this module.
  //
  // So the boot guarantee moves to the case below, where it is EXECUTED rather
  // than inferred from the shape of an if-statement.
  const src = await read(new URL("../lib/supabase.ts", TESTS));
  assert(
    !/^if \(!supabaseUrl\) \{$/m.test(src),
    "the module-scope env check is back — that breaks every script whose " +
      "import graph reaches this module without needing a database",
  );
  assert(
    src.includes("function realClient()"),
    "the client must be constructed inside a function, on first use",
  );
  // The binding is load-bearing and would fail SILENTLY: `supabase.from()` is
  // `this.rest.from(relation)`, so a proxy that hands back an unbound function
  // renders as an empty result rather than an error
  // (vault/70-agent/states-that-look-normal.md, shape 1 — where exactly this
  // showed up as a seller with no inventory and green unit tests).
  assert(
    src.includes("value.bind(c)"),
    "proxied functions must be bound to the real client, or `this` is lost",
  );
  // The error must still NAME the variable. A lazy client that degrades into a
  // confusing network error would be worse than the eager throw it replaced.
  assert(
    src.includes('throw new Error("SUPABASE_URL is not set")'),
    "the missing-variable error must survive, by name",
  );
});

Deno.test("US-2661: a credential-less boot still refuses, and names EVERY missing var", () => {
  // The guarantee the case above used to make by inspecting an if-statement,
  // made here by calling the thing that actually enforces it. assertRequiredEnv
  // takes an injectable getter, so this needs no subprocess and no --allow-run.
  //
  // Verified out-of-process too, once, by hand: `deno run src/main.ts` with the
  // three SUPABASE_* variables unset exits 1 from env-validation.ts:311 with
  // "[BOOT] Missing required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  // ANTHROPIC_API_KEY, ... — refusing to start." before Deno.serve is reached.
  const empty = (_k: string) => undefined;
  let thrown: Error | null = null;
  try {
    assertRequiredEnv(empty, "production");
  } catch (e) {
    thrown = e as Error;
  }
  assert(thrown !== null, "a production boot with no env must throw, not warn");
  assert(
    thrown.message.includes("refusing to start"),
    `boot must refuse, got: ${thrown.message}`,
  );
  // Strictly better than the old import-time throw, which named only the first
  // variable its import chain happened to reach.
  for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    assert(
      thrown.message.includes(key),
      `the boot error must name ${key} — it names every missing variable at ` +
        `once, which the import-time throw never did`,
    );
  }
  assert(
    missingRequiredEnv(empty, "production").length > 2,
    "more than the two supabase vars are required in production; if this " +
      "shrank, the boot check got weaker",
  );
});
