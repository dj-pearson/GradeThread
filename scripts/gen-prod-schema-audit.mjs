// Generates scripts/prod-schema-audit.sql — a read-only diff of production's
// public schema against the schema every migration in this repo produces.
//
// HOW TO REGENERATE. Point a local stack at the full migration set, then:
//   docker start supabase_db_gradethread
//   node scripts/gen-prod-schema-audit.mjs
// It reads the LOCAL database, so the local database must be current first.
//
// TWO CONSTRAINTS SHAPED THE OUTPUT, both learned the hard way (US-2726).
//
// 1. NO psql meta-commands. The first version opened with `\set ON_ERROR_STOP`
//    and separated its sections with `\echo`. That works when psql reads the
//    file, and fails with `42601: syntax error at or near "\"` the moment
//    anyone pastes it into a SQL editor — which is how most people run one-off
//    SQL against a hosted database.
//
// 2. ONE statement, ONE result set. A GUI SQL editor typically shows only the
//    LAST statement's output, so four separate SELECTs would silently hide
//    three quarters of the findings. Everything is a single query with a `kind`
//    column, and temp tables are gone in favour of CTEs — a temp table declared
//    `ON COMMIT DROP` does not survive an editor that wraps each statement in
//    its own transaction.
//
// It reports NULLABILITY drift as well as missing objects: a column that exists
// with the wrong nullability is exactly the failure that cost an afternoon
// (`listings.listed_at`), and existence checks alone cannot see it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTAINER = process.env.GT_PG_CONTAINER ?? "supabase_db_gradethread";

function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-F", "|", "-c", sql],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
}

const cols = psql(`
  select c.table_name || '|' || c.column_name || '|' || c.is_nullable
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = c.table_schema and t.table_name = c.table_name
   and t.table_type = 'BASE TABLE'
  where c.table_schema = 'public'
  order by 1;`);

const funcs = psql(`
  select distinct p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' order by 1;`);

const idx = psql(`
  select indexname from pg_indexes where schemaname = 'public' order by 1;`);

const version = psql(`select coalesce(max(version),'none') from public.applied_migrations;`)[0];

const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const tuple = (line) => "(" + line.split("|").map(lit).join(",") + ")";

const sql = `-- GradeThread production schema audit (US-2726)
--
-- READ-ONLY. One statement, one result set, no temp tables and no psql
-- meta-commands, so it runs the same in psql, in \\i, and pasted into a SQL
-- editor. It creates and changes nothing.
--
-- Generated from a local stack carrying every migration in this repo
-- (highest applied_migrations version: ${version}; ${cols.length} columns,
-- ${funcs.length} functions, ${idx.length} indexes in schema public).
-- Regenerate with: node scripts/gen-prod-schema-audit.mjs
--
-- EVERY ROW IT RETURNS IS A PROBLEM. No rows means production matches the repo.
--
--   missing_table       a table the code expects that is not there
--   missing_column      the table exists, the column does not
--   nullability_differs the column exists with the wrong NOT NULL — invisible
--                       to an existence check, and the exact shape of the
--                       listings.listed_at failure this audit was written after
--   missing_function    a function or RPC that is not there
--   missing_index       an index that is not there (slow, not broken)

WITH exp_col (t, c, nullable) AS (VALUES
${cols.map(tuple).join(",\n")}
),
exp_fn (n) AS (VALUES
${funcs.map(tuple).join(",\n")}
),
exp_ix (n) AS (VALUES
${idx.map(tuple).join(",\n")}
),
have_col AS (
  SELECT table_name AS t, column_name AS c, is_nullable AS nullable
  FROM information_schema.columns WHERE table_schema = 'public'
),
have_tbl AS (
  SELECT table_name AS t FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
)
SELECT kind, object, detail FROM (
  SELECT 'missing_table' AS kind, e.t AS object, '' AS detail
  FROM (SELECT DISTINCT t FROM exp_col) e
  WHERE NOT EXISTS (SELECT 1 FROM have_tbl h WHERE h.t = e.t)

  UNION ALL
  SELECT 'missing_column', e.t || '.' || e.c, ''
  FROM exp_col e
  WHERE EXISTS (SELECT 1 FROM have_tbl h WHERE h.t = e.t)
    AND NOT EXISTS (SELECT 1 FROM have_col h WHERE h.t = e.t AND h.c = e.c)

  UNION ALL
  SELECT 'nullability_differs', e.t || '.' || e.c,
         'repo=' || e.nullable || ' prod=' || h.nullable
  FROM exp_col e
  JOIN have_col h ON h.t = e.t AND h.c = e.c
  WHERE h.nullable IS DISTINCT FROM e.nullable

  UNION ALL
  SELECT 'missing_function', e.n, ''
  FROM exp_fn e
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public' AND p.proname = e.n)

  UNION ALL
  SELECT 'missing_index', e.n, ''
  FROM exp_ix e
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_indexes i
    WHERE i.schemaname = 'public' AND i.indexname = e.n)
) findings
ORDER BY kind, object;
`;

fs.writeFileSync(path.join(HERE, "prod-schema-audit.sql"), sql);
console.log(
  `wrote scripts/prod-schema-audit.sql — ${cols.length} columns, ${funcs.length} functions, ${idx.length} indexes (local at ${version})`,
);
