// US-2393: an RPC the edge calls must not be guarded against the edge.
//
// THE DEFECT THIS EXISTS FOR. `is_admin()` answers "is the CALLER an admin?" by
// looking up `auth.uid()`. A service-role JWT carries no `sub`, so auth.uid() is
// NULL and is_admin() is false — always, unconditionally. Every route in this
// service calls Postgres through `supabaseAdmin`, the service-role client. So a
// SECURITY DEFINER function guarded with a bare `if not public.is_admin() then
// raise` rejects 100% of the calls the edge makes to it.
//
// admin_system_metrics() and admin_revenue_metrics() were in exactly that state,
// and GET /admin-dashboard/system had been answering 500 since US-1565 moved
// that page behind the edge admin boundary. Nothing caught it because nothing
// exercises an admin RPC through the role that actually calls it: reading the
// SQL, the guard looks correct, and reading the route, the call looks correct.
// The bug lives in the seam.
//
// WHY THE SEAM IS SCANNED RATHER THAN THE FUNCTIONS. Relaxing the two guards
// fixes two functions. The failure is a CLASS — it recurs whenever someone adds
// an admin RPC, guards it the obvious way, and calls it from a route. So this
// test derives both sides from source: the RPC names the edge actually invokes,
// and the newest SQL definition of each. A future function with the wrong guard
// fails here on the commit that introduces it.
//
// THE TWO ACCEPTABLE GUARD SHAPES, and why both are correct:
//
//   `auth.role() = 'service_role' or public.is_admin()`   (00207, 00227, 00514)
//       Explicitly admits the service-role caller. Gives up nothing: routes
//       reaching these are already behind the edge admin middleware (JWT + role
//       + AAL2 + audit), and an authenticated non-admin is still refused.
//
//   `auth.uid() is not null and not public.is_admin()`    (ai_spend and friends)
//       Refuses only callers it can identify. A service-role caller has no uid,
//       so the guard does not fire. Same outcome, arrived at from the other
//       side.
//
// A function called ONLY from the browser (admin_user_list_stats,
// admin_audit_log_filter_options) may keep the strict form — there auth.uid() is
// populated and strictness is right. Those are not in the scanned set precisely
// because the edge does not call them.
import { assert, assertEquals } from "@std/assert";

const SRC_DIR = new URL("../", import.meta.url);
const MIGRATIONS_DIR = new URL("../../../../supabase/migrations/", import.meta.url);

async function walk(dir: URL, out: string[] = []): Promise<string[]> {
  for await (const e of Deno.readDir(dir)) {
    const child = new URL(`${e.name}${e.isDirectory ? "/" : ""}`, dir);
    if (e.isDirectory) await walk(child, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith("_test.ts")) {
      out.push(child.href);
    }
  }
  return out;
}

/** Every RPC name this service invokes. `ctx.io.rpc` wraps supabaseAdmin.rpc. */
async function edgeCalledRpcs(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const file of await walk(SRC_DIR)) {
    const src = await Deno.readTextFile(new URL(file));
    for (const m of src.matchAll(/\.rpc\(\s*"([a-z0-9_]+)"/g)) {
      names.add(m[1]!);
    }
  }
  return names;
}

/**
 * The NEWEST SQL definition of every function, by migration order.
 *
 * Newest wins because migrations are replayed in order: an early strict guard
 * that a later migration relaxed is not a live defect, and reporting it would
 * train people to ignore this test.
 */
async function latestFunctionBodies(): Promise<Map<string, string>> {
  const files: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS_DIR)) {
    if (e.isFile && e.name.endsWith(".sql")) files.push(e.name);
  }
  files.sort();

  const bodies = new Map<string, string>();
  for (const name of files) {
    const sql = await Deno.readTextFile(new URL(name, MIGRATIONS_DIR));
    // `create or replace function public.foo(...) ... as $tag$ BODY $tag$`
    const re =
      /create\s+or\s+replace\s+function\s+public\.([a-z0-9_]+)\s*\([\s\S]*?\bas\s+(\$[a-z_]*\$)/gi;
    for (const m of sql.matchAll(re)) {
      const fn = m[1]!.toLowerCase();
      const tag = m[2]!;
      const bodyStart = m.index! + m[0].length;
      const bodyEnd = sql.indexOf(tag, bodyStart);
      if (bodyEnd === -1) continue;
      bodies.set(fn, sql.slice(bodyStart, bodyEnd));
    }
  }
  return bodies;
}

const EDGE_RPCS = await edgeCalledRpcs();
const BODIES = await latestFunctionBodies();

/** Does this body's admin guard tolerate a caller with no auth.uid()? */
function toleratesServiceRole(body: string): boolean {
  const b = body.toLowerCase();
  return b.includes("service_role") || b.includes("auth.uid() is not null");
}

Deno.test("US-2393: every admin-guarded RPC the edge calls admits the service role", () => {
  const offenders: string[] = [];
  for (const fn of [...EDGE_RPCS].sort()) {
    const body = BODIES.get(fn);
    // Not every RPC is defined in a `create or replace` we can parse, and not
    // every one is admin-guarded. Only guarded ones are in scope.
    if (!body || !body.includes("is_admin()")) continue;
    if (!toleratesServiceRole(body)) offenders.push(fn);
  }
  assertEquals(
    offenders,
    [],
    "These functions are called by the edge through the SERVICE-ROLE client, " +
      "but guard with a bare is_admin() — which resolves through auth.uid(), " +
      "which is NULL for service-role. They reject every call the edge makes " +
      "and the route answers 500. Use `auth.role() = 'service_role' or " +
      "public.is_admin()`.",
  );
});

Deno.test("US-2393: the two functions the bug was found in are fixed", () => {
  // Named explicitly so the fix cannot regress quietly if the scan above is
  // ever narrowed or its parsing breaks.
  for (const fn of ["admin_system_metrics", "admin_revenue_metrics"]) {
    const body = BODIES.get(fn);
    assert(body, `${fn} has no parsed definition — did the scan break?`);
    assert(
      body.includes("service_role"),
      `${fn} is back to a service-role-hostile guard; /admin-dashboard/system ` +
        `returns 500 whenever it is`,
    );
  }
});

Deno.test("US-2393: the scan actually found something to check", () => {
  // Guards the guard. Both halves are derived by parsing, so a regex that
  // silently stops matching would make the assertions above pass vacuously —
  // the exact way a source scan rots.
  assert(EDGE_RPCS.size > 20, `only ${EDGE_RPCS.size} RPC call sites parsed`);
  assert(BODIES.size > 50, `only ${BODIES.size} function bodies parsed`);
  const guarded = [...EDGE_RPCS].filter((fn) =>
    BODIES.get(fn)?.includes("is_admin()")
  );
  assert(
    guarded.length >= 8,
    `only ${guarded.length} admin-guarded edge RPCs found; the scan is not ` +
      `covering what it claims to`,
  );
});
