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
  // US-603: affiliate earned-link clicks. No user_id of their own — tenancy
  // flows through the code → referral_codes.user_id the owner already holds.
  "affiliate_clicks",
  // US-829: AI support transcript. No user_id of its own — tenancy flows
  // through support_conversations (its FK parent). The SELECT policy scopes by
  // the parent's user_id/workspace_owner_id and excludes system rows; all
  // writes are service-role only.
  "support_messages",
];

// Tenant tables that are intentionally client-invisible: RLS is enabled and
// there is NO policy, so anon/authenticated get nothing and only the edge
// service-role (which bypasses RLS) reads/writes them. This is the most
// restrictive configuration, not a gap.
const SERVICE_ROLE_ONLY = new Set([
  "flipdesk_subscription_events",
  "oauth_states",
  // US-146 Google Sheets OAuth CSRF state: RLS enabled, zero policies by design
  // (migration 00131 documents "all access via the service-role edge client").
  // Single-use + self-expiring; the SPA never reads it.
  "google_oauth_states",
  // US-147 Sheets-sync per-field snapshots: RLS enabled, zero policies by
  // design (migration 00132 documents "read/written only by the service-role
  // edge client"). Sync bookkeeping, never read by the SPA.
  "google_sheet_sync_state",
  // US-148 cross-source sync conflicts: RLS enabled, zero policies by design
  // (migration 00133 documents "read/written only via the service-role edge
  // client"). The SPA reads/resolves via /api/flipdesk/reconciliation/conflicts*,
  // which tenant-scope every query by user_id.
  "flipdesk_sync_conflicts",
  // RLS enabled, zero policies by design — the OAuth import session is written
  // and read ONLY by the service-role edge client; the SPA never touches it
  // (migration 00089 documents "all access via the service-role edge client").
  "google_photos_import_sessions",
  // Apple IAP consumable dedup ledger: RLS enabled, zero policies by design
  // (migration 00104 documents "service-role only: deny-all to anon/auth"). It
  // is written only by the grant_appstore_credits SECURITY DEFINER RPC via the
  // service-role edge client; the SPA never reads it.
  "appstore_processed_transactions",
  // US-771 per-grade refund operator queue: RLS enabled, zero policies by design
  // (migration 00123). Written by the grading pipeline and read/resolved ONLY by
  // the admin billing endpoints via the service-role edge client; the SPA never
  // touches it directly.
  "pending_refunds",
  // Anthropic per-call token/cost ledger: RLS enabled, zero policies by design
  // (migration 00163). Appended by the grading pipeline via the service-role
  // client and read ONLY by the admin AI-spend dashboard; the SPA never reads it.
  "ai_usage_events",
  // Launch waitlist capture + review/approve lifecycle: RLS enabled with an
  // explicit `revoke all from anon, authenticated` and zero policies by design
  // (migration 00165). Captured by the public edge route and managed ONLY by the
  // admin waitlist console via the service-role client; the SPA never reads it.
  "waitlist_entries",
  // US-831 AI support assistant per-day usage rollup: RLS enabled, zero policies
  // by design (migration 00185). Upserted by the assistant engine via the
  // increment_support_assistant_usage RPC on the service-role client and read
  // ONLY by the admin usage dashboard; the SPA never reads it.
  "support_assistant_usage",
  // US-831 AI support assistant abuse log: RLS enabled, zero policies by design
  // (migration 00185). Appended by the abuse pipeline via the service-role
  // client and read ONLY by the admin abuse-monitoring dashboard; never client-readable.
  "support_abuse_events",
  // US-889 cross-tenant moderation queue: RLS enabled with an explicit
  // `revoke insert,update,delete from anon, authenticated` and zero policies by
  // design (migration 00213). Enqueued by the fraud console/user reports and
  // drained ONLY by the admin moderation endpoints via the service-role client;
  // the SPA never reads it directly. Keyed by owner_user_id (not user_id) so it
  // is an operator surface, not user-owned tenant data.
  "content_moderation_flags",
  // US-893 Stripe reconciliation flags: RLS enabled, zero policies by design
  // (migration 00217). Written by the scheduled billing-reconciliation job and
  // read/resolved ONLY by the admin reconciliation console via the service-role
  // client; the SPA never reads it. Keyed by subject_user_id (not user_id) so it
  // is an operator surface, not user-owned tenant data.
  "billing_reconciliation_flags",
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
