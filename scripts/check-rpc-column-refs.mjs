#!/usr/bin/env node
// US-2663 AC2 + AC4 — CALL every RPC the edge invokes, and fail on a reference
// to a column or table that does not exist.
//
// WHY THIS EXISTS. revenue_dashboard selected public.users.trial_started_at, a
// column that has never existed on that table, and had done since 00215. It
// raised 42703 on EVERY call — there was no parameter combination that avoided
// it — and nothing noticed for months. Every gate we own was asking a different
// question:
//   • the db lane APPLIES migrations. `CREATE FUNCTION` does not validate a
//     plpgsql body, so a function referencing a missing column installs
//     perfectly and the lane goes green.
//   • `deno check` and `tsc -b` see a string being passed to .rpc(). There is
//     nothing to type-check.
//   • the unit suite mocks the client, so the SQL never runs.
// The body only fails when it EXECUTES. So the only gate that can catch this is
// one that executes it, which is what this does.
//
// SAFETY. Every call runs inside its own transaction that is ALWAYS rolled back,
// under a 5s statement_timeout, against the LOCAL throwaway stack. Nothing is
// written and nothing touches prod. Mutating functions are called too — that is
// deliberate, since a broken column reference in a write path is worse, not
// better — and the rollback is what makes it safe.
//
// SCOPE, stated because it is narrower than it looks. This proves a function's
// body RESOLVES against the live schema on the paths a generic argument reaches.
// It is not a correctness test: a function whose body is wrong but valid passes,
// and a branch only taken for a specific argument value is not exercised. What
// it rules out is the whole class of "names something that is not there", which
// is the one that had been sitting in production.
//
// Run: node scripts/check-rpc-column-refs.mjs
//   (needs Docker + the local Supabase stack; skips cleanly without them)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "services", "edge-functions", "src");
const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_gradethread";

/** Every `.rpc("name"` in non-test edge source. */
export function calledRpcNames(dir = SRC) {
  const names = new Set();
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) {
        if (e !== "tests") walk(p);
      } else if (p.endsWith(".ts")) {
        for (const m of readFileSync(p, "utf8").matchAll(/\.rpc\(\s*"([a-z0-9_]+)"/g)) {
          names.add(m[1]);
        }
      }
    }
  };
  walk(dir);
  return [...names].sort();
}

/**
 * A plausible NON-NULL literal per Postgres type.
 *
 * Non-null matters and cost two attempts to learn. Calling with no arguments
 * reaches almost nothing; calling with NULLs gets stopped by the functions' own
 * argument guards ("start must precede end"). Both leave the body unexecuted,
 * and an unexecuted body cannot reveal a bad column reference.
 *
 * The first timestamp in a signature is backdated and the rest are now(), which
 * satisfies the (p_start, p_end) ordering check these functions share.
 */
export function literalFor(type, tsIndex) {
  const t = type.toLowerCase().replace(/\[\]$/, "");
  if (type.endsWith("[]")) return `'{}'::${type}`;
  if (t.includes("timestamp")) return tsIndex === 0 ? "now() - interval '30 days'" : "now()";
  if (t === "date") return "current_date";
  if (t === "uuid") return "'00000000-0000-0000-0000-000000000000'::uuid";
  if (t.includes("int")) return "1";
  if (t === "numeric" || t.includes("double") || t === "real") return "1";
  if (t === "boolean") return "false";
  if (t === "jsonb" || t === "json") return `'{}'::${t}`;
  if (t === "interval") return "interval '1 day'";
  if (t.includes("char") || t === "text" || t === "name") return "'month'";
  return `null::${type}`;
}

/** Argument list -> a call expression's arguments. */
export function argsFor(identityArgs) {
  if (!identityArgs.trim()) return "";
  let tsIndex = 0;
  return identityArgs.split(",").map((a) => {
    const parts = a.trim().replace(/^(IN|OUT|INOUT|VARIADIC)\s+/i, "").split(/\s+/);
    const type = /^p?_?[a-z0-9_]+$/i.test(parts[0]) && parts.length > 1
      ? parts.slice(1).join(" ")
      : parts.join(" ");
    return literalFor(type, type.toLowerCase().includes("timestamp") ? tsIndex++ : -1);
  }).join(", ");
}

const psql = (args, input) =>
  spawnSync("docker", [
    "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", ...args,
  ], { input, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });

export function run() {
  const called = calledRpcNames();
  const probe = psql(["-At", "-c", "select 1"]);
  if (probe.status !== 0) {
    return { skipped: `local stack not reachable (${CONTAINER})`, called: called.length };
  }

  const sig = psql(["-At", "-F", "|", "-c",
    `select p.proname, pg_get_function_identity_arguments(p.oid)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in (${called.map((n) => `'${n}'`).join(",")})
     order by p.proname;`]);

  const rows = sig.stdout.trim().split("\n").filter(Boolean).map((l) => {
    const i = l.indexOf("|");
    return { fn: l.slice(0, i), args: l.slice(i + 1) };
  });

  const sql = rows.map(({ fn, args }) => `
begin;
set local statement_timeout = '5s';
do $probe$
declare msg text; code text;
begin
  begin
    perform public.${fn}(${argsFor(args)});
  exception when others then
    get stacked diagnostics code = returned_sqlstate, msg = message_text;
    if code in ('42703', '42P01') then
      raise notice 'BROKEN_REF|${fn}|%|%', code, msg;
    end if;
  end;
end
$probe$;
rollback;`).join("\n");

  const res = psql(["-q", "-f", "-"], sql);
  // ⚠ RAISE NOTICE goes to STDERR. Reading only stdout is how an earlier version
  // of this printed the finding to the terminal and then reported "none found".
  const out = String(res.stdout ?? "") + String(res.stderr ?? "");
  const broken = [...out.matchAll(/BROKEN_REF\|([a-z0-9_]+)\|(\d+)\|(.*)/g)]
    .map(([, fn, code, msg]) => ({ fn, code, msg: msg.trim() }));

  return { called: called.length, resolved: rows.length, broken };
}

if (process.argv[1]?.endsWith("check-rpc-column-refs.mjs")) {
  const r = run();
  if (r.skipped) {
    console.log(`- rpc column refs: SKIPPED (${r.skipped}); ${r.called} RPC(s) would be checked`);
    process.exit(0);
  }
  if (r.broken.length > 0) {
    console.error("");
    for (const b of r.broken) {
      console.error(`✗ ${b.fn} references something that does not exist (${b.code}): ${b.msg}`);
    }
    console.error(
      `\n${r.broken.length} RPC(s) the edge calls cannot run. CREATE FUNCTION does ` +
      `not validate a plpgsql body, so these install cleanly and fail only when ` +
      `called — which is why the db lane never saw them.`,
    );
    process.exit(1);
  }
  console.log(
    `✓ rpc column refs: ${r.resolved}/${r.called} edge-called RPC(s) executed ` +
    `against the live schema, none references a missing column or table`,
  );
}
