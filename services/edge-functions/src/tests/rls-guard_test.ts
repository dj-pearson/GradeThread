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
  // US-900: support ticket replies. No user_id of its own (author_user_id is
  // not a tenant key) — tenancy flows through support_tickets (its FK parent).
  // The user SELECT policy scopes by the parent's user_id AND excludes internal
  // notes; admins read all; all writes are service-role only.
  "support_ticket_messages",
];

// Tenant tables that are intentionally client-invisible: RLS is enabled and
// there is NO policy, so anon/authenticated get nothing and only the edge
// service-role (which bypasses RLS) reads/writes them. This is the most
// restrictive configuration, not a gap.
const SERVICE_ROLE_ONLY = new Set([
  // US-1710 Brand & Style Knowledge Base (00389): five GLOBAL REFERENCE tables —
  // brand facts only, NO tenant data and no owner column. RLS enabled, zero
  // policies by design: the edge service-role client reads the packs (US-1711
  // resolver) and the admin routes (US-1715) write them; the SPA never queries
  // them directly. Deny-all is the most restrictive config, not a gap.
  "brand_knowledge",
  "brand_styles",
  "brand_style_codes",
  "brand_colorways",
  "brand_size_charts",
  // US-1565: admin task board — internal operator tooling; client policies
  // dropped in 00344, all CRUD flows through /api/admin/tasks (edge boundary).
  "admin_task_projects",
  "admin_tasks",
  "admin_task_comments",
  "flipdesk_subscription_events",
  "oauth_states",
  // US-1533 garment expectation briefs: RLS enabled, zero policies by design —
  // written by the lazy baseline generator and read by the grading pipeline,
  // both service-role; admins edit via /api/admin/grading/baselines. No tenant
  // data (brand + category knowledge only); the SPA never queries it directly.
  "garment_baselines",
  // US-1579 MeasureCard mail-fulfillment queue: shipping addresses are PII, so
  // deny-all by design — sellers go through /api/flipdesk/measure/card-request
  // (edge, owner-scoped) and operators through /api/admin/measure-cards. Keyed
  // by owner_user_id per the operator-table convention; the SPA never reads it.
  "measure_card_requests",
  // US-1580 measurement-correction telemetry: deltas/class/confidence only —
  // written by the edge correction endpoint, read via documented SQL. The SPA
  // never queries it; deny-all by design. Keyed by owner_user_id.
  "measure_corrections",
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
  // Google Play consumable dedup ledger (00321): RLS enabled, zero policies by
  // design — written only by the service-role edge (POST /api/payments/google/
  // verify); the SPA never reads it. The Android analogue of
  // appstore_processed_transactions.
  "google_processed_purchases",
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
  // US-905 audit-log anomaly findings: RLS enabled with an explicit
  // `revoke all from anon, authenticated` and zero policies by design
  // (migration 00227). Written by the scheduled audit-anomaly scan and
  // read/triaged ONLY by the admin audit endpoints via the service-role client;
  // the SPA never reads it directly. Keyed by actor_user_id (the implicated
  // admin), not a tenant key — an operator surface, not user-owned data.
  "admin_audit_anomalies",
  // US-906 ops activity-feed event stream: RLS enabled with an explicit
  // `revoke all from anon, authenticated` and zero policies by design
  // (migration 00228). Appended by emitOpsEvent() and read/triaged ONLY by the
  // admin ops endpoints via the service-role client; the SPA never reads it
  // directly. actor_user_id (the acting admin) is not a tenant key — an operator
  // surface, not user-owned data.
  "ops_events",
  // US-1073 Ad Copy Studio: keyword_library (curated marketing keyword themes)
  // and ad_creatives (saved generations). RLS enabled with an explicit
  // `revoke all from anon, authenticated` and zero policies by design
  // (migration 00233). Read/written ONLY via the role-gated /api/admin/ads
  // endpoints on the service-role client; the SPA never reads them directly.
  // Operator-curated reference / output, not user-owned tenant data.
  "keyword_library",
  "ad_creatives",
  // US-1072 keyword-research ingestion: keyword_research_terms (ingested keyword
  // ideas + demand metrics) and keyword_research_runs (ingestion audit trail).
  // RLS enabled with an explicit `revoke all from anon, authenticated` and zero
  // policies by design (migration 00234). Read/written ONLY via the role-gated
  // /api/admin/ads endpoints + the keyword-research cron on the service-role
  // client; the SPA never reads them directly. Operator reference data, not
  // user-owned tenant data.
  "keyword_research_terms",
  "keyword_research_runs",
  // US-1067 few-shot exemplar sets: curated, versioned, PII-free exemplar blocks
  // mined from human-corrected grades. RLS enabled with an explicit
  // `revoke all from anon, authenticated` and zero policies by design
  // (migration 00238). Read/written ONLY via the role-gated /api/admin/grading
  // endpoints + the grade-time active-block read on the service-role client; the
  // SPA never reads it directly. Operator-curated reference data (created_by is
  // the authoring admin, not a tenant key), not user-owned tenant data.
  "grading_exemplar_sets",
  // US-1055: idempotency ledger for marketplace-event notifications (offer/
  // return/dispute). RLS enabled with an explicit `revoke all from anon,
  // authenticated` and zero policies by design (migration 00247). Written + read
  // ONLY by the edge marketplace-event poll/notify path via the service-role
  // client; the SPA never touches it. user_id is the tenant owner being notified.
  "marketplace_event_notifications",
  // US-946 trial-conversion drip engine tables (migration 00253). RLS enabled
  // with an explicit `revoke all from anon, authenticated` and zero policies by
  // design — written ONLY by the edge drip engine via the service-role client;
  // the dashboard reads exclusively through the aggregating drip_analytics RPC,
  // never the raw rows. user_id is the enrolled/converted tenant, not a client
  // read key. (drip_sends has no user_id, so it isn't auto-discovered.)
  "drip_enrollments",
  "drip_attributions",
  // US-931: newsletter confirmed-subscriber registry (migration 00278). RLS
  // enabled with an explicit `revoke all from anon, authenticated` and zero
  // policies by design — written by the edge consent/subscriber paths and read
  // ONLY through the aggregating newsletter_analytics RPC via the service-role
  // client; the SPA never reads the raw rows. user_id links a subscriber to a
  // platform account but is not a client read key.
  "email_subscribers",
  // US-932: internal behavioral event stream (migration 00277). RLS enabled with
  // an explicit `revoke all from anon, authenticated` and zero policies by design
  // — written + read ONLY by the edge via the service-role client
  // (lib/user-events.ts); the SPA never touches it. user_id is the acting tenant,
  // not a client read key (this is analytics, not user-facing content).
  "user_events",
  // US-930: newsletter console program tables (migration 00279). RLS enabled with
  // an explicit `revoke all from anon, authenticated` and zero policies by design
  // — read/written ONLY via the role-gated /api/admin/newsletter endpoints on the
  // service-role client; the SPA never reads the raw rows. These are an operator
  // program surface (created_by/approved_by/subscriber_user_id are not tenant
  // read keys), not user-owned data.
  "newsletter_issues",
  "newsletter_issue_recipients",
  // US-920: generated/selected newsletter imagery registry (migration 00288). A
  // child of the operator-only newsletter_issues — RLS enabled, deny-all, written
  // only by the edge service-role client. No tenant owner column.
  "newsletter_issue_assets",
  // US-917: evergreen educational topic bank (migration 00290). RLS enabled,
  // deny-all, read/written ONLY by the edge service-role client (the assembler's
  // topic selection + the refill cron); the SPA never reads it. No tenant owner
  // column — operator-curated reference data, not user-owned tenant data.
  "email_topic_bank",
  // US-916: product "What's New" changelog (migration 00291). RLS enabled,
  // deny-all, read/written ONLY by the edge service-role client (admin CRUD +
  // the assembler + auto-capture); the public feed is served by a service-role
  // route hard-filtered to status='published', never anon RLS. No tenant owner
  // column — operator-curated product release notes, not user-owned data.
  "changelog_entries",
  // US-929: lifecycle email-journey engine tables (migration 00280). RLS enabled
  // with an explicit `revoke all from anon, authenticated` and zero policies by
  // design — read/written ONLY by the edge journey engine + the role-gated
  // /api/admin/journeys console via the service-role client; the SPA never reads
  // the raw rows. email_journey_enrollments.user_id is the enrolled tenant, not a
  // client read key (same model as drip_enrollments). The journeys/steps/sends
  // tables have no user_id of their own.
  "email_journeys",
  "email_journey_steps",
  "email_journey_enrollments",
  "email_journey_step_sends",
  // US-911: marketing-consent change audit trail (migration 00296). RLS enabled,
  // deny-all — written ONLY by the no-login unsubscribe + preference-center edge
  // endpoints on the service-role client; the SPA never reads it. subscriber_user_id
  // links the row to an account but is a forensic reference, not a tenant read key.
  "email_consent_audit",
  // US-909: admin saved views + admin notification center (migration 00297). RLS
  // enabled, deny-all — read/written ONLY via the role-gated /api/admin/views +
  // /api/admin/notifications endpoints on the service-role client; the SPA never
  // reads the raw rows. admin_user_id is the owning operator (scoped per-admin in
  // the edge route), an operator surface, not user-owned tenant data.
  "admin_saved_views",
  "admin_notifications",
  // US-908 granular RBAC scope tables (migration 00298). All RLS enabled,
  // deny-all — read/written ONLY via the role-gated /api/admin/scopes endpoints
  // + the requireScope guard on the service-role client; the SPA never reads the
  // raw rows. permission_scopes/role_scopes are reference config (no ownership);
  // admin_scope_grants.admin_user_id is the targeted operator, not a tenant key.
  "permission_scopes",
  "role_scopes",
  "admin_scope_grants",
  // US-1113 buyer-guarantee claim → grading-accuracy feedback signals (migration
  // 00302). RLS enabled with an explicit `revoke all from anon, authenticated`
  // and zero policies by design — read/written ONLY by the service-role edge
  // client (lib/accuracy-tracking.ts: apply on claim approve, neutralize on
  // reject, aggregate for the admin grading-calibration panel); the SPA never
  // reads the raw rows. seller_user_id is the owning tenant (copied from the
  // already-verified guarantee_claims row), a grading-quality surface, not
  // client-readable user data.
  "claim_accuracy_signals",
  // US-1583 Agentic OS kernel (migration 00357). All five RLS-enabled with zero
  // policies by design — operator substrate for the governed agent fleet,
  // read/written ONLY by the edge service-role client (the agent kernel + the
  // role-gated /api/admin/agents Mission Control endpoints); the SPA never reads
  // the raw rows. No tenant owner column (agent_id/run_id are internal keys;
  // agent_proposals.decided_by is the deciding operator, not a tenant key).
  "agents",
  "agent_runs",
  "agent_run_steps",
  "agent_proposals",
  "agent_memory",
  // US-1613: agent-to-agent handoffs — deny-all, service-role only. Keys are
  // internal (target/origin agent keys + run ids); the payload is the emitting
  // agent's finding, no tenant data. Read/written only by the kernel.
  "agent_handoffs",
  // US-1698: Ads Command Center snapshots — our OWN Google Ads / Apple Search Ads
  // account structure + daily performance, synced by the service role and read by
  // the admin dashboard + Claude analysis. Platform-level operator data (one ads
  // account, not per-user tenant data); deny-all RLS, keyed by external resource
  // ids + owner_user_id. The SPA reads them only through /api/admin/ads/*.
  "ads_accounts",
  "ads_campaigns",
  "ads_ad_groups",
  "ads_ads",
  "ads_keywords",
  "ads_metrics_daily",
  "ads_sync_runs",
  // US-1700: ad click-id → conversion attributions. Written by the attribution
  // route + offline import (service role), read only by operator analysis; the
  // SPA never reads it. Keyed by click_id + owner_user_id (the converted user,
  // operator naming — not a tenant key). Deny-all by design.
  "ad_click_attributions",
  // US-1701: Claude ads-analysis recommendations (report-only). Written by the
  // analysis pass (service role), read by the Command Center via /api/admin/ads/*.
  // owner_user_id = who triggered the run (operator naming, not a tenant key).
  "ads_recommendations",
  // US-1703: guarded-apply audit + rollback ledger. Written by the apply flow
  // (service role), read by the Command Center via /api/admin/ads/*. owner_user_id
  // = the admin who acted (operator naming, not a tenant key). Deny-all by design.
  "ads_change_audit",
  // US-1706: Google Ads search-terms report snapshot. Written by the sync
  // (service role), mined for negative/new-keyword recommendations; read via
  // /api/admin/ads/*. owner_user_id = who ran the sync (operator naming).
  "ads_search_terms",
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
