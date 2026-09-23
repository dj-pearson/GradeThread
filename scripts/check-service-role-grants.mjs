#!/usr/bin/env node
// Prove the service-role-only tables are closed to anon and authenticated in a
// real database, not just in the migration text.
//
// service-role-grant-posture_test.ts already scores the migrations against each
// other: every table in SERVICE_ROLE_ONLY (rls-guard_test.ts) must carry a
// table-level REVOKE, and no later GRANT may undo it. What source cannot answer
// is whether the database the migrations BUILD agrees. A revoke inside a
// format() the regex cannot see, a default-privilege change, a grant from a
// role the parser does not know: each would leave the text clean and the table
// open. This asks Postgres.
//
// ⚠ Run it on a schema the migrations built and nothing else touched. The two
// integration workflows run GRANT ALL ON ALL TABLES before seeding, which opens
// every one of these tables (US-3350); scripts/replay-migration-privileges.mjs
// is what puts the revokes back, and this is also how that replay is checked.
//
// It proves it can fail: inside a transaction that rolls back, it grants
// SELECT on one registered table to anon and requires the same query to see it.
//
// Usage:
//   node scripts/check-service-role-grants.mjs --dsn "postgresql://..."
//   node scripts/check-service-role-grants.mjs                  # docker
//
// Exit: 0 all closed, 1 a registered table is reachable by a client role,
// 2 the database could not be reached or answered nothing.
//
// Writes nothing.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { looksUnreachable, psqlTarget } from "./lib/psql-target.mjs";

const RLS_GUARD = join(
  import.meta.dirname,
  "..",
  "services",
  "edge-functions",
  "src",
  "tests",
  "rls-guard_test.ts",
);

/** The SERVICE_ROLE_ONLY Set literal, comments stripped. Same parse as the posture test. */
export function parseServiceRoleRegistry(src) {
  const block = /const SERVICE_ROLE_ONLY = new Set\(\[([\s\S]*?)\n\]\);/.exec(src);
  if (!block) return [];
  const body = block[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return [...body.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

const CLIENT_ROLES = ["anon", "authenticated"];

/** One row per (table, role) that holds any privilege, table- or column-level. */
function openGrantsQuery(tag, arrayLiteral) {
  const checks = [
    ["SELECT", "has_table_privilege(r.role, c.oid, 'SELECT') or has_any_column_privilege(r.role, c.oid, 'SELECT')"],
    ["INSERT", "has_table_privilege(r.role, c.oid, 'INSERT') or has_any_column_privilege(r.role, c.oid, 'INSERT')"],
    ["UPDATE", "has_table_privilege(r.role, c.oid, 'UPDATE') or has_any_column_privilege(r.role, c.oid, 'UPDATE')"],
    ["DELETE", "has_table_privilege(r.role, c.oid, 'DELETE')"],
    ["TRUNCATE", "has_table_privilege(r.role, c.oid, 'TRUNCATE')"],
    ["REFERENCES", "has_table_privilege(r.role, c.oid, 'REFERENCES') or has_any_column_privilege(r.role, c.oid, 'REFERENCES')"],
    ["TRIGGER", "has_table_privilege(r.role, c.oid, 'TRIGGER')"],
  ];
  const privs = checks.map(([name, expr]) => `case when ${expr} then '${name}' end`).join(", ");
  return `
select '${tag} ' || c.relname || ' ' || r.role || ' ' || concat_ws(',', ${privs})
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join (values ${CLIENT_ROLES.map((r) => `('${r}')`).join(", ")}) as r(role)
 where n.nspname = 'public'
   and c.relkind in ('r', 'p', 'v', 'm', 'f')
   and c.relname = any (${arrayLiteral})
   and concat_ws(',', ${privs}) <> ''
 order by c.relname, r.role;`;
}

export function buildSql(tables) {
  const arr = `array[${tables.map((t) => `'${t}'`).join(", ")}]::text[]`;
  return `
\\set ON_ERROR_STOP on
select 'PRESENT ' || count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f') and c.relname = any (${arr});
select 'MISSING ' || t from unnest(${arr}) as t
 where not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = t);
${openGrantsQuery("OPEN", arr)}
-- Guard the guard: open one closed table for the length of a transaction and
-- require the same query to report it.
begin;
do $$
declare t text;
begin
  select c.relname into t
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relname = any (${arr})
     and not has_table_privilege('anon', c.oid, 'SELECT')
   order by c.relname limit 1;
  if t is null then
    raise notice 'SELFCHECK_TABLE none';
  else
    raise notice 'SELFCHECK_TABLE %', t;
    execute format('grant select on public.%I to anon', t);
  end if;
end $$;
${openGrantsQuery("SELFCHECK", arr)}
rollback;
select 'DONE';
`;
}

export function parseOutput(out) {
  const lines = out.split("\n").map((l) => l.trim());
  const pick = (prefix) =>
    lines.filter((l) => l.startsWith(prefix + " ")).map((l) => l.slice(prefix.length + 1));
  const selfTable = /SELFCHECK_TABLE (\S+)/.exec(out)?.[1] ?? null;
  return {
    present: Number(pick("PRESENT")[0] ?? NaN),
    missing: pick("MISSING"),
    open: pick("OPEN"),
    selfcheck: pick("SELFCHECK"),
    selfTable: selfTable === "none" ? null : selfTable,
    done: lines.includes("DONE"),
  };
}

function main() {
  const registry = parseServiceRoleRegistry(readFileSync(RLS_GUARD, "utf8"));
  if (registry.length < 100) {
    console.error(
      `✗ only ${registry.length} tables parsed out of SERVICE_ROLE_ONLY in ` +
        `rls-guard_test.ts; the parse broke, and a check over nothing proves nothing.`,
    );
    process.exit(2);
  }

  const target = psqlTarget();
  const run = spawnSync(target.cmd, target.argv, { input: buildSql(registry), encoding: "utf8" });
  const out = String(run.stdout ?? "") + String(run.stderr ?? "");
  const status = run.status ?? (run.error ? -1 : 0);
  if (run.error || looksUnreachable(out, status)) {
    console.error(`✗ could not reach ${target.how}.\n  ${target.hint}`);
    process.exit(2);
  }
  const r = parseOutput(out);
  if (!r.done || !Number.isFinite(r.present)) {
    console.error("✗ the query did not finish, so nothing was proved. Raw tail:\n" + out.slice(-1500));
    process.exit(2);
  }

  console.log(`  SERVICE_ROLE_ONLY tables in the registry   ${registry.length}`);
  console.log(`  present in schema public                   ${r.present}`);
  if (r.missing.length) console.log(`  absent (dropped or not yet created)        ${r.missing.join(", ")}`);

  const problems = [];
  if (r.present < 100) {
    problems.push(`only ${r.present} registered tables exist in this database; is it migrated?`);
  }
  if (!r.selfTable) {
    problems.push("self-check had no closed table to open, so the query was never shown to fail");
  } else if (!r.selfcheck.some((l) => l.startsWith(`${r.selfTable} anon `))) {
    problems.push(
      `self-check: granting SELECT on ${r.selfTable} to anon was NOT reported by the query. ` +
        `The detector is broken, and a clean result below means nothing.`,
    );
  }
  for (const row of r.open) {
    const [table, role, privs] = row.split(" ");
    problems.push(`${table}: ${role} holds ${privs}`);
  }

  if (problems.length) {
    console.error(
      "\n✗ service-role-only tables reachable by a client role:\n" +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\n  Each needs `revoke all on table public.<t> from anon, authenticated;` in a migration " +
        "(vault/20-domain/service-role-tables.md). On a stack the integration workflows touched, " +
        "run scripts/replay-migration-privileges.mjs first.",
    );
    process.exit(1);
  }
  console.log(
    `\n✓ ${r.present} service-role-only tables: anon and authenticated hold no privilege on ` +
      `any of them (self-check opened ${r.selfTable} and the query saw it).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
