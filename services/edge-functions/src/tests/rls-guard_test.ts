// US-355: CI guard that every tenant-scoped table has restrictive RLS.
//
// The SPA reads Supabase via PostgREST with the ANON key, so Row-Level Security
// is the ONLY thing standing between one tenant and another's rows. This test
// statically parses the migration SQL and fails the build if a multi-tenant
// table is missing RLS, has no policy (and isn't an explicit service-role-only
// table), or carries an over-broad policy (USING(true) / bare authenticated).
//
// It is intentionally conservative to avoid false CI failures:
//   - user_id-bearing tables are auto-discovered (a NEW one is covered for free)
//   - well-known parent-scoped tables (tenant via a parent FK, no user_id of
//     their own) are checked from a curated list
//   - tables that are deliberately client-invisible (RLS on, zero policies =>
//     deny-all, service-role writes only) must be named in SERVICE_ROLE_ONLY,
//     so a NEW zero-policy table still fails until a human classifies it.
import { assert } from "@std/assert";

const MIGRATIONS_DIR = new URL(
  "../../../../supabase/migrations/",
  import.meta.url,
);

// Parent-scoped multi-tenant tables (no user_id column; tenancy flows through a
// parent FK such as submissions/inventory_items). Keep this list current when
// adding a tenant table that is keyed by a parent rather than user_id.
const PARENT_SCOPED = [
  "grade_reports",
  "submission_images",
  "item_photos",
  "listings",
  "sales",
  "shipments",
  "flipdesk_grading_submissions",
  "grade_outcomes",
  "listing_generation_jobs",
  "workspace_invitations",
  "workspace_members",
];

// Tenant tables that are intentionally client-invisible: RLS is enabled and
// there is NO policy, so anon/authenticated get nothing and only the edge
// service-role (which bypasses RLS) reads/writes them. This is the most
// restrictive configuration, not a gap.
const SERVICE_ROLE_ONLY = new Set([
  "flipdesk_subscription_events",
  "oauth_states",
]);

// Tokens that signal a policy is tenant/role scoped rather than wide open.
const TENANT_PREDICATE_TOKENS = [
  "auth.uid()",
  "user_id",
  "is_admin",
  "is_super_admin",
  "is_workspace_member",
  "certificate_id",
  "owner_id",
  "member_id",
];

interface Schema {
  tableBlocks: Map<string, string>;
  rlsEnabled: Set<string>;
  policies: Map<string, { name: string; body: string }[]>;
  fullSql: string;
}

async function loadSchema(): Promise<Schema> {
  const parts: string[] = [];
  const names: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sql")) names.push(entry.name);
  }
  names.sort();
  for (const name of names) {
    parts.push(await Deno.readTextFile(new URL(name, MIGRATIONS_DIR)));
  }
  const fullSql = parts.join("\n");

  const tableBlocks = new Map<string, string>();
  const tableRe =
    /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+public\.(\w+)\s*\(([\s\S]*?)\n\)\s*;/gi;
  for (const m of fullSql.matchAll(tableRe)) {
    tableBlocks.set(m[1]!, m[2]!);
  }

  const rlsEnabled = new Set<string>();
  const rlsRe = /ALTER TABLE\s+public\.(\w+)\s+ENABLE ROW LEVEL SECURITY/gi;
  for (const m of fullSql.matchAll(rlsRe)) rlsEnabled.add(m[1]!);

  const policies = new Map<string, { name: string; body: string }[]>();
  const polRe = /CREATE POLICY\s+"([^"]+)"\s+ON\s+public\.(\w+)([\s\S]*?);/gi;
  for (const m of fullSql.matchAll(polRe)) {
    const list = policies.get(m[2]!) ?? [];
    list.push({ name: m[1]!, body: m[3]! });
    policies.set(m[2]!, list);
  }

  return { tableBlocks, rlsEnabled, policies, fullSql };
}

function hasUserId(table: string, schema: Schema): boolean {
  const block = schema.tableBlocks.get(table) ?? "";
  if (/\buser_id\b/i.test(block)) return true;
  // user_id added via a later ALTER TABLE ... ADD COLUMN.
  const alterRe = new RegExp(
    `ALTER TABLE\\s+public\\.${table}[^;]*ADD COLUMN[^;]*\\buser_id\\b`,
    "is",
  );
  return alterRe.test(schema.fullSql);
}

Deno.test("every tenant-scoped table has restrictive RLS", async () => {
  const schema = await loadSchema();
  assert(schema.tableBlocks.size > 0, "no tables parsed — path/regex broke");

  const tenantTables = [...schema.tableBlocks.keys()].filter((t) =>
    hasUserId(t, schema)
  );
  const checked = new Set<string>([...tenantTables, ...PARENT_SCOPED]);

  const problems: string[] = [];

  for (const t of [...checked].sort()) {
    if (!schema.tableBlocks.has(t)) {
      problems.push(`${t}: declared in PARENT_SCOPED but no CREATE TABLE found`);
      continue;
    }
    if (!schema.rlsEnabled.has(t)) {
      problems.push(`${t}: RLS is NOT enabled (ALTER TABLE ... ENABLE ROW LEVEL SECURITY missing)`);
    }
    const pols = schema.policies.get(t) ?? [];
    if (pols.length === 0 && !SERVICE_ROLE_ONLY.has(t)) {
      problems.push(
        `${t}: no RLS policy and not in SERVICE_ROLE_ONLY — add a tenant policy or classify it`,
      );
    }
    for (const p of pols) {
      const norm = p.body.replace(/\s+/g, " ").toLowerCase();
      if (/using\s*\(\s*true\s*\)/.test(norm) || /with check\s*\(\s*true\s*\)/.test(norm)) {
        problems.push(`${t}: policy "${p.name}" uses USING(true)/WITH CHECK(true)`);
      }
      // Bare authenticated-only (no tenant predicate) is only a leak on
      // user_id tables — global reference tables may legitimately allow any
      // authenticated read.
      if (
        tenantTables.includes(t) &&
        norm.includes("authenticated") &&
        !TENANT_PREDICATE_TOKENS.some((tok) => norm.includes(tok))
      ) {
        problems.push(
          `${t}: policy "${p.name}" is authenticated-only with no tenant predicate`,
        );
      }
    }
  }

  assert(
    problems.length === 0,
    `Tenant-isolation RLS guard found ${problems.length} issue(s):\n` +
      problems.map((p) => `  - ${p}`).join("\n"),
  );
});
