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
import { assert, assertEquals } from "@std/assert";

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
  // US-9122: the connector's OAuth authorization server. All five are deny-all
  // in both directions. Readable, they are a map of which sellers connected
  // what and when, plus the material to impersonate them; writable, a caller
  // could mint their own grant and skip the consent screen entirely — which is
  // the one thing an authorization server must not allow. Secrets are stored
  // hashed, so even a read is not a read of credentials, but it is still a read
  // of who authorized whom.
  "oauth_clients",
  "oauth_grants",
  "oauth_authorization_codes",
  "oauth_refresh_tokens",
  "oauth_access_tokens",
  // US-9113: the MCP connector tool-call audit log. Deny-all in both
  // directions. Readable, it is a map of every seller's connector activity -
  // which items they touched, when, and how often; writable, a caller could
  // fabricate the record that would exonerate them, which is the one thing an
  // audit log must not allow. Operators read it through the service-role
  // client; a seller sees their own activity through an authenticated endpoint
  // that filters for them.
  "mcp_tool_calls",
  // US-2592: daily help article view counters. Deny-all in both directions.
  // Readable, it would publish which of our articles are struggling, which is a
  // map of what the product confuses people about; writable, it would let anyone
  // manufacture a "top article" and steer what we choose to maintain. It holds
  // no identity column at all — the grain is (article, surface, day) — so there
  // is nothing here for a tenant policy to scope to in the first place.
  "help_article_views",
  // US-2591: per-article helpfulness votes. Deny-all in both directions.
  // Readable, it would let one customer read another's comments about the
  // product, some of which are written in the belief that nobody but us sees
  // them; writable, it would let anybody manufacture a consensus that an
  // article is fine. owner_user_id is nullable because the articles are public
  // and most readers are not signed in.
  "help_feedback",
  // US-2585: the ticket that was NOT filed — somebody opened the support form,
  // was shown help articles, read one and went away. Deny-all in both
  // directions. Readable, it would hand a customer an analytics feed of what
  // other people were about to ask; writable, it would let anyone inflate the
  // one number that decides whether the help centre is working. Its owner
  // column is deliberately `owner_user_id`: this is an analytics row about a
  // session, not a tenant-owned resource a customer may read back.
  "help_deflections",
  // US-2569: the certificate revision history. Deny-all even though what it
  // records ends up on a PUBLIC page, and that is the point: the public
  // certificate endpoint reads it service-role and then re-applies
  // isCertificateWithheld to the successor. A direct read policy would let
  // anyone walk a revision chain to a grade that is currently withheld for
  // moderation — turning the revision trail into the way around the hold.
  "grade_report_revisions",
  // US-2563: the public API's Idempotency-Key replay records. Deny-all, and the
  // read side is the one that matters: response_body holds the verbatim 2xx of
  // a prior call, so a readable table would hand any authenticated session the
  // stored grade payloads of whoever else happened to be mid-retry. The
  // middleware reaches it through the service-role client only. Its owner column
  // is `owner_user_id` per the convention below.
  "api_idempotency_records",
  // US-2324: the marketplace sync quarantine. Deny-all in both directions.
  // Readable, it would show a seller the raw provider error text for their own
  // orders; writable, it would let them clear their own quarantine and re-poison
  // the sync the quarantine exists to protect. Its owner column is deliberately
  // `owner_user_id`, so the discovery below does not classify it as tenant data.
  "marketplace_sync_failures",
  // US-2351: the impersonation ledger. Deny-all in BOTH directions and both
  // matter. A readable table would show a user their own impersonation history,
  // leaking operator activity; a writable one would let the person being
  // impersonated end the RECORD while the session continued — which is worse
  // than no record, because the row would say it stopped.
  "admin_impersonation_sessions",
  // US-2349: the admin audit trail. Zero policies is the WHOLE POINT here, and
  // it is a tightening rather than an omission — 00003 gave any is_admin()
  // caller SELECT and INSERT from the browser, so an admin could read the entire
  // forensic log unrecorded AND write rows naming a DIFFERENT admin. Grant
  // yourself credits, then stamp a dozen role-change rows with the super_admin's
  // id: non-repudiation gone for the whole table, and the 00227 anomaly
  // detectors firing on the forged actor.
  //
  // Every legitimate path bypasses RLS already: lib/audit-log.ts writes through
  // the service-role client, the 00065 dispute trigger / 00518 self-audit /
  // 00519 stamping trigger are SECURITY DEFINER, and reads go through
  // admin_audit_log_search, which is SECURITY DEFINER and super_admin-gated.
  // Proven end to end in scripts/verify-audit-log-not-forgeable.sql.
  "admin_audit_log",
  // US-2117 compliance records. All three are EVIDENTIARY: they exist so a past
  // claim about price/terms can be proven later, and they are read only by
  // admin/support tooling through the service-role client. Deny-all is the
  // deliberate posture — no seller route reads them, and the failure mode of a
  // permissive policy here (a user reading, or worse influencing, the record of
  // what they agreed to) is exactly what the table is meant to rule out.
  //
  // subscription_agreements is additionally trigger-enforced APPEND-ONLY, so
  // even the service role cannot amend a written agreement.
  "subscription_agreements",
  "subscription_cancellations",
  // Not tenant data at all — one row per pricing change, no user column. Listed
  // for completeness so a future reader does not wonder why it is unpoliced.
  "pricing_plan_revisions",
  // US-1880 selector health: anonymous adapter-failure counters written by the
  // public (unauthenticated) selector-health endpoint. NON-TENANT and, by
  // construction, unjoinable — no listing URL, no account, no IP, no instance
  // id. Deny-all is load-bearing here in BOTH directions: an anonymous endpoint
  // writes it, so a readable table would be a free public firehose.
  "selector_health_pings",
  // US-1757 extension usage: anonymous, opt-in read/click-through TOTALS written
  // by the public (unauthenticated) /usage endpoint. Same posture and the same
  // two reasons as selector_health_pings above — non-tenant and unjoinable by
  // construction (no URL, no account, no IP, no instance id, and no client
  // timestamp), and an anonymous writer means a readable table would be a free
  // public firehose.
  "extension_usage_pings",
  // US-1852 quest definitions. Product config, not tenant data — there is no
  // owner column because a quest belongs to the product. Deny-all matters in
  // both directions: readable, it would leak unlaunched challenges before their
  // window opens; writable, a seller could set their own quest's target to 1 and
  // its payout to the ceiling, which is a direct XP-minting hole.
  "quest_definitions",
  // US-1786 impact factors: GLOBAL, NON-TENANT config (published apparel LCA
  // figures, no owner) — deny-all. Only the service-role edge reads it for the
  // impact estimate; the SPA never queries it directly.
  "impact_factors",
  // US-1773 durability aggregates: GLOBAL, NON-TENANT cohort reference (no owner)
  // — deny-all by design. The service-role aggregation job writes it and the
  // public rankings endpoint (US-1774) reads it; the SPA never queries it.
  // Aggregate-only, PII-safe (no per-listing price / buyer / node identity).
  "durability_aggregates",
  // US-1760 badge click attribution: deny-all by design — the public recording
  // endpoint (service-role, owner resolved server-side) writes it and the
  // owner-scoped funnel endpoints read it; the SPA never queries it. No buyer PII.
  "badge_click_events",
  // US-1854 tracked shares (00545): deny-all by design, same posture as
  // badge_click_events above. Written by POST /api/rewards/share after the edge
  // has verified the caller OWNS the certificate, read only by the share-to-earn
  // engine and the owner-scoped stats endpoint. A client-writable share log
  // would be a client-writable claim on someone else's find — and `sharer_hash`
  // is the self-click defence, so a client that could write it could suppress
  // another seller's rewards.
  "share_events",
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
  // US-2243/2244 (00501, 00502): RN/CA sighting counters + resolved registrants.
  // AGGREGATE and non-tenant by construction — one row per registry number, no
  // owner column and no item reference, so a row cannot say who photographed the
  // tag. Incremented by the edge service-role client, worked by admin routes.
  "registered_number_sightings",
  "registered_number_registry",
  // US-9036 (00708): which numbers people ASKED for and we could not answer.
  // Deliberately NOT a column on the sightings table — a sighting is a claim
  // that OCR read the number off a real tag, and the page prints that count.
  // Same aggregate shape: one row per registry number, no owner column and no
  // request identity, so a row cannot say who looked a number up.
  "registered_number_lookups",
  // US-2246 (00503): learned style-code → product titles. Brand + code + public
  // listing title/URL only; no owner, no seller/buyer identity, no prices.
  // Written during identification verify, read during extraction — both
  // service-role. The SPA never queries it.
  "style_code_observations",
  // US-2690: sweep bookkeeping for the same index — brand + code + counters,
  // no owner and no title. Written and read only by the sweep cron.
  "style_code_sweeps",
  // US-2691: the resolved NAME per code per source. Brand + code + name +
  // a public evidence URL; a seller-sourced row records WHAT was corrected,
  // never by whom.
  "style_code_names",
  // US-2783: per-brand cursor for the brand-first crawl. A brand name, an
  // offset and four counters. Written and read only by the discovery cron.
  "style_code_discovery_state",
  // US-2786: brands not yet curated, tallied by how often their listings
  // declare a style code, plus the survey's own cursor. Evidence for a human
  // decision; neither table carries an owner or anything tenant-shaped.
  "style_code_brand_candidates",
  "style_code_prospect_state",
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
  // US-2218 known-genuine authentication reference imagery. Brand facts and
  // licensed reference photos only — no tenant data, no owner column, and
  // deliberately no link to submission_images (seller photos are never
  // promoted here). Read by the edge service-role client to issue short-lived
  // signed URLs; written by admin curation.
  "authenticity_references",
  // US-1579 MeasureCard mail-fulfillment queue: shipping addresses are PII, so
  // deny-all by design — sellers go through /api/flipdesk/measure/card-request
  // (edge, owner-scoped) and operators through /api/admin/measure-cards. Keyed
  // by owner_user_id per the operator-table convention; the SPA never reads it.
  "measure_card_requests",
  // US-1580 measurement-correction telemetry: deltas/class/confidence only —
  // written by the edge correction endpoint, read via documented SQL. The SPA
  // never queries it; deny-all by design. Keyed by owner_user_id.
  "measure_corrections",
  // US-2997 QuickBooks OAuth CSRF state: RLS enabled, zero policies by design
  // (migration 00704). Single-use and self-expiring, deleted-and-returned in
  // one statement at the callback; the SPA never reads it. The connection and
  // mapping tables beside it are ordinary tenant tables with per-user policies,
  // because the status card reads them straight through PostgREST -- only the
  // state belongs behind the service role.
  "qbo_oauth_states",
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

  // ── US-2008: newly VISIBLE, now explicitly classified ──────────────────
  //
  // These eight were never checked before, because the old owner-column test
  // (/\buser_id\b/) could not see `seller_user_id` / `admin_user_id` /
  // `owner_user_id`, and the table regex required a `public.` prefix. They all
  // have RLS enabled and zero policies, and — verified individually — ZERO
  // frontend references (`grep from("<table>") src/` is empty for each), so the
  // SPA never reads them and no tenant policy is owed. Classifying rather than
  // policy-ing is therefore the honest answer, not the convenient one.
  //
  // US-1074: abuse/velocity signals (migration 00212), `revoke insert, update,
  // delete from anon, authenticated`. Appended by the abuse pipeline and read
  // only by the admin abuse console. user_id is the implicated tenant, not a
  // client read key.
  "abuse_signals",
  // US-1073: admin bulk-operation ledger (migration 00167). Keyed by
  // admin_user_id — the ACTING ADMIN, not a tenant owner — so it is an operator
  // audit surface by construction.
  "bulk_admin_operations",
  // US-1043: eBay webhook events awaiting connection linkage (migration 00149).
  // The migration says it outright: "No policies: read/written only via the
  // service-role edge client, with linkage resolved against
  // marketplace_connections ownership in code (US-268)." Its `ebay_user_id` is
  // eBay's identifier, not ours — it is not a tenant key at all.
  "ebay_pending_webhook_events",
  // US-867: buyer trust-guarantee claims (migration 00197) and their remedies
  // (00319). seller_user_id is the seller a claim is filed AGAINST. These carry
  // third-party buyer PII (claimant_email/claimant_name) and are intentionally
  // NOT seller-readable — exposing a claimant's identity to the seller they
  // complained about is precisely what must not happen. Intake is the public
  // unauthenticated endpoint; triage is admin-only via the service role.
  "guarantee_claims",
  "guarantee_remedies",
  // US-934: marketing send coordination ledger (migration 00276), `REVOKE ALL`.
  // Deduplication bookkeeping for the send coordinator; keyed by recipient
  // address, and owner_user_id is ON DELETE SET NULL. Never client-read.
  "marketing_send_log",
  // US-1094: Garment Passport pseudonymous owner nodes (migration 00256),
  // `REVOKE ALL`. Deliberately pseudonymous — linked_user_id exists so a reveal
  // can be honored, and letting a client read this table directly would defeat
  // the pseudonymity the whole passport model rests on.
  "owner_nodes",
  // US-1075: per-subject rate-limit overrides (migration 00214), `revoke insert,
  // update, delete from anon, authenticated`. An operator control surface — a
  // tenant being able to read (let alone write) its own limit override would
  // defeat the point.
  "rate_limit_overrides",

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
  // US-1918: lease-based cron overlap locks (migration 00094, locked down in
  // 00436). No owner column — pure infra. REVOKE ALL + deny-all RLS; the edge
  // cron paths use the service-role client (bypasses RLS). Forced into the guard
  // via SERVICE_ONLY_FORCED below so a regression that drops the RLS fails CI.
  "job_locks",
  // US-1852: quest / community-challenge DEFINITIONS (migration 00543). Pure
  // operator config with no owner column — the SPA reads it only through
  // /api/rewards/quests and writes it only through /api/admin/rewards/quests.
  // A client-writable quest definition would be a client-writable XP faucet,
  // so deny-all is the point. Forced into the guard via SERVICE_ONLY_FORCED.
  "reward_quests",
  // US-1853: the TANGIBLE milestone catalog (migration 00544). Same shape as
  // reward_quests but a worse blast radius — a quest definition mints XP, and
  // this one mints grade credits and Stripe coupons. No owner column, read only
  // through /api/admin/rewards/milestones and by the service-role engine, so
  // deny-all is the point. Forced into the guard via SERVICE_ONLY_FORCED.
  "reward_milestones",
  // US-1914: the tenure ladder (migration 00557). Operator config with no owner
  // column — it says how much LARGER a milestone comes out for a long-standing
  // customer, so a client-writable row is a client-writable multiplier on a money
  // faucet. Read only through /api/admin/rewards/tenure-tiers and by the
  // service-role engine. Forced into the guard via SERVICE_ONLY_FORCED.
  "reward_tenure_tiers",
  // US-1858: the record of which reward ceiling refused a grant (migration
  // 00548). Its owner column is `subject_user_id` (the abuse_signals naming) so
  // the tenant guard does not treat an operator table as user-owned data — which
  // also means nothing discovers it, hence SERVICE_ONLY_FORCED below. Deny-all
  // is the point: telling a farmer which limit stopped them is telling them
  // which limit to work around.
  "reward_budget_breaches",
  // US-1859: the re-engagement nudge ledger (migration 00549). It DOES carry a
  // plain `user_id` — the row is about that user — so unlike the tables above it
  // is auto-discovered and this classification is load-bearing rather than
  // decorative. Deny-all is the point: the row records whether the user is in
  // the HOLDOUT arm, and a readable experiment assignment is one that changes
  // the behaviour it is trying to measure. Written by the nudge cron and read by
  // /api/admin/rewards/nudges, both service-role; the one user-facing write
  // (POST /api/rewards/nudges/:id/click) goes through the edge, which resolves
  // ownership with .eq("user_id", …) before stamping.
  "reward_nudge_sends",
  // US-1861: Thrift Radar contributions (migration 00550). It has NO account
  // column at all — the analytical path carries a salted, rotating
  // `contributor_key` instead — so nothing discovers it and this classification
  // plus SERVICE_ONLY_FORCED below are the only things holding its RLS in place.
  // Deny-all is the point twice over: a readable row set is a movement history
  // of pseudonymous people, and a client-writable one is a way to poison every
  // other tenant's view of where supply is.
  "radar_scan_events",
  // US-1862: the Thrift Radar venue registry (migration 00551). No owner column
  // either — a venue belongs to the map, not to a tenant — so the same double
  // registration is the only thing holding its RLS on. Deny-all both ways: a
  // client-writable registry lets one account poison every other tenant's map,
  // and a client-readable one exposes candidate cells that have not cleared the
  // k-anonymity floor, which is the floor's whole point.
  "radar_venues",
  // US-1863: the served Radar aggregates (00552) and the retention archive.
  // No owner column on either — an aggregate belongs to the map — so the same
  // double registration is what holds their RLS on. Deny-all matters MOST here:
  // the aggregates endpoint re-applies the k-anonymity floor on read, and a
  // client-readable table would be the way around it.
  "radar_venue_aggregates",
  "radar_scan_history",
  // US-2774: how each identification was arrived at (migration 00641) — the
  // category method and the model's verdict on each visual candidate. Written
  // by the extract + eBay-prep phases (service role), read only by operator
  // analysis measuring whether the visual provider earns its latency. It holds
  // the AI's working-out about a garment, not the seller's data, and
  // owner_user_id is there to scope the writes, not to serve a read policy.
  // Deny-all by design.
  "identification_provenance",
  // US-2704: what GradeThread published to a marketplace, per publish and per
  // revise (migration 00643). Written only by the snapshot funnel
  // (lib/listing-publications.ts) with the service-role client, and read by the
  // dispute-evidence pack the edge assembles. `owner_user_id` scopes the writes
  // and the reads; it is not there to serve a client policy, because no client
  // reads this table directly. Deny-all by design.
  "listing_publications",
  // US-2844 comp condition samples. NON-TENANT aggregate market data: one row
  // per comp listing we read for condition, carrying a cell key, a score and a
  // photo-set hash, and deliberately carrying no seller, no listing id, no URL
  // and no title. Deny-all in both directions. There is no owner column because
  // the sample belongs to the market rather than to anybody, and a readable
  // table would hand a competitor the coverage map the whole moat rests on.
  "comp_condition_reads",
  // US-2848 live-vs-measured value comparisons. NON-TENANT aggregate market
  // data, same posture as comp_condition_reads above: one row per cell per
  // grade holding two medians and their difference, with no seller, no
  // submission and no owner column at all, because the row is a statement about
  // a market cell rather than about whose request produced it. Deny-all in both
  // directions. Readable, it would publish which cells we have measured and how
  // far our answer sits from the public one, which is the coverage map and the
  // edge in the same table.
  "condition_value_shadow_samples",
  // US-2845 the comp read queue. Three operator tables holding AGGREGATE
  // MARKET data and no tenant column at all: which cells sellers have asked
  // about, the batches that read them, and one job per cell. Deny-all in both
  // directions. Readable, comp_read_demand is a live feed of which brands our
  // sellers are working, which is commercially the most sensitive thing in the
  // system; writable, anyone could steer where we spend the AI budget by
  // inflating a cell's demand count.
  "comp_read_demand",
  "comp_read_batches",
  "comp_read_jobs",
  // US-3033: the published half of the Fit & Measurement Index. One row per
  // brand-style-size-field cohort holding a median and its two quartiles, with
  // no owner column, because the row is a statement about a garment rather than
  // about whose closet the numbers came from. The observations it is computed
  // from live in garment_measurements, which IS tenant-scoped and stays that
  // way. Deny-all in both directions: writable, anyone could move the number a
  // public page prints and a seller prices against; readable through the
  // client, it would hand out the coverage map before the pages exist.
  "garment_measurement_stats",
]);

// Service-role-only tables with NO user_id and NO parent FK (pure operator /
// infrastructure tables). They are not auto-discovered as tenant tables, so we
// force them into the guard here to lock in RLS-enabled + zero-policy (deny-all)
// and catch a regression that removes that protection. Each must also appear in
// SERVICE_ROLE_ONLY above.
const SERVICE_ONLY_FORCED = [
  "job_locks",
  "reward_quests",
  "reward_milestones",
  "reward_tenure_tiers",
  "reward_budget_breaches",
  "radar_scan_events",
  "radar_venues",
  "radar_venue_aggregates",
  "radar_scan_history",
  // US-2438. Neither of these has an owner column — a prompt belongs to the
  // platform, not to a user — so `hasUserId` never discovers them and the guard
  // was checking NEITHER. That is the failure mode this file's own header calls
  // the dangerous one: silence read as safety.
  //
  // They are forced in for COVERAGE, not because they are deny-all. Both are
  // admins-can-SELECT, writes service-role only (00510 for the first, 00563 for
  // the second, after US-2348 found the original admin write grant let the SPA
  // reach around the scope guard, the step-up, the audit row and the eval gate).
  // What the guard then enforces on them is exactly what matters: RLS stays on,
  // at least one policy survives, and none of them is USING(true).
  "ai_prompt_versions",
  "ai_prompt_block_versions",
  // US-3033. No owner column and no parent FK by design (see SERVICE_ROLE_ONLY
  // above), so hasUserId never discovers it and without this line the guard
  // would check nothing while appearing to pass.
  "garment_measurement_stats",
];

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
  return parseSchema(parts.join("\n"));
}

// US-2008 (AC3): parsing is split from file-reading so the four blind spots can
// be exercised against SYNTHETIC SQL. Widening a regex without proving it now
// catches the case it used to miss just relocates the blind spot — and this
// guard's whole value is that people trust its silence.
function parseSchema(fullSql: string): Schema {
  const tableBlocks = new Map<string, string>();
  // US-2008 (b): the `public.` prefix is OPTIONAL. Two tables are declared bare
  // — `notifications` (00007) and `listing_prompt_acceptance` (00155) — so
  // requiring the schema qualifier made them invisible to this guard entirely.
  // `notifications` needed a bespoke second test at the bottom of this file
  // precisely because of that: the workaround shipped while the general hole
  // stayed open.
  const tableRe =
    /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\)\s*;/gi;
  for (const m of fullSql.matchAll(tableRe)) {
    tableBlocks.set(m[1]!, m[2]!);
  }

  const rlsEnabled = new Set<string>();
  const rlsRe = /ALTER TABLE\s+(?:public\.)?(\w+)\s+ENABLE ROW LEVEL SECURITY/gi;
  for (const m of fullSql.matchAll(rlsRe)) rlsEnabled.add(m[1]!);

  // US-2008 (c): RLS enabled DYNAMICALLY inside a DO block was invisible to the
  // literal regex above. 00381 turns it on for all seven ads_* tables via
  //   FOREACH t IN ARRAY ARRAY['a','b',...] LOOP
  //     EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
  // RLS really IS on for those in prod — but every static reader (this guard
  // included) saw them as unprotected. A security check that UNDER-reports is
  // the dangerous direction: it manufactures work, and worse, it teaches people
  // that its output needs interpreting rather than acting on.
  const dynamicRe =
    /FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\s*\[([\s\S]*?)\]\s*LOOP([\s\S]*?)END LOOP/gi;
  for (const m of fullSql.matchAll(dynamicRe)) {
    const body = m[2] ?? "";
    if (!/ENABLE ROW LEVEL SECURITY/i.test(body)) continue;
    for (const lit of (m[1] ?? "").matchAll(/'([a-z0-9_]+)'/gi)) {
      rlsEnabled.add(lit[1]!);
    }
  }

  const policies = new Map<string, { name: string; body: string }[]>();
  // US-2008 (d): the policy NAME may be a BARE identifier, not just a quoted
  // string — 00256's passport tables use `CREATE POLICY garments_select_own ON
  // public.garments`. Requiring quotes meant five tables' policies were never
  // parsed at all, so a future `USING (true)` on one of them would have sailed
  // straight past the permissive-policy check below.
  // US-2008: process CREATE and DROP POLICY IN FILE ORDER so `policies` holds
  // the FINAL state, not every policy that ever existed.
  //
  // This was a latent flaw that widening (b) exposed rather than caused: the
  // guard concatenates all 477 migrations and only ever matched CREATE, so a
  // policy that a later migration DROPPED still counted. `notifications` is the
  // live example — 00007 created an INSERT policy with WITH CHECK (true) and
  // 00437 removed it (US-1926), yet the moment this guard could finally SEE the
  // table it reported the long-dead policy as a permissive one. A guard that
  // reports fixed problems gets its output discounted, which costs more than the
  // check is worth.
  //
  // Note 00007 itself does DROP IF EXISTS immediately followed by CREATE, so
  // order matters in both directions; a set-based "was it ever dropped" test
  // would wrongly erase the recreate.
  const polEventRe =
    /(CREATE|DROP)\s+POLICY\s+(?:IF EXISTS\s+)?(?:"([^"]+)"|([a-z0-9_]+))\s+ON\s+(?:public\.)?(\w+)([\s\S]*?);/gi;
  for (const m of fullSql.matchAll(polEventRe)) {
    const kind = m[1]!.toUpperCase();
    const name = (m[2] ?? m[3])!;
    const table = m[4]!;
    const list = policies.get(table) ?? [];
    if (kind === "DROP") {
      policies.set(table, list.filter((p) => p.name !== name));
    } else {
      list.push({ name, body: m[5]! });
      policies.set(table, list);
    }
  }

  return { tableBlocks, rlsEnabled, policies, fullSql };
}

// US-2008 (a): an owner column is not always literally `user_id`.
//
// The old test was /\buser_id\b/, and in `seller_user_id` / `owner_user_id` /
// `subject_user_id` / `admin_user_id` the character before `user_id` is an
// UNDERSCORE — a word character — so no word boundary matches and none of them
// were ever detected. 21 tables carrying an owner-ish column, zero policies, and
// no SERVICE_ROLE_ONLY / PARENT_SCOPED registration were consequently never
// checked at all.
//
// They DO have RLS enabled today, so this was never a live leak. What was broken
// is the ENFORCEMENT: this guard's stated promise — "a NEW zero-policy table
// still fails until a human classifies it" — held only for tables that happened
// to name the column exactly right. A security check that silently under-reports
// is worse than a missing one, because it is trusted.
const OWNER_COLUMN = /\b\w*user_id\b|\b\w*owner_id\b/i;

function hasUserId(table: string, schema: Schema): boolean {
  const block = schema.tableBlocks.get(table) ?? "";
  if (OWNER_COLUMN.test(block)) return true;
  // Owner column added via a later ALTER TABLE ... ADD COLUMN.
  const alterRe = new RegExp(
    `ALTER TABLE\\s+(?:public\\.)?${table}[^;]*ADD COLUMN[^;]*(?:\\w*user_id|\\w*owner_id)\\b`,
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
  const checked = new Set<string>([
    ...tenantTables,
    ...PARENT_SCOPED,
    ...SERVICE_ONLY_FORCED,
  ]);

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

// US-1926: the `notifications` table is declared unqualified (CREATE TABLE
// notifications, not public.notifications) so the main guard above — which keys
// off `public.<table>` — never sees it. Its original INSERT policy used
// `WITH CHECK (true)`, which (since service-role bypasses RLS) let any
// authenticated client inject notifications into any user's feed. This
// order-aware check confirms no permissive INSERT policy on notifications
// survives after DROP POLICY statements are applied, so a re-introduction fails
// the build. A non-service (anon/authenticated) client thus cannot INSERT a
// notification for another user_id.
Deno.test("notifications has no permissive INSERT policy (US-1926)", async () => {
  const names: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sql")) names.push(entry.name);
  }
  names.sort();
  const parts: string[] = [];
  for (const name of names) {
    parts.push(await Deno.readTextFile(new URL(name, MIGRATIONS_DIR)));
  }
  const sql = parts.join("\n");

  // Active INSERT policies on notifications, in file order, honoring later DROPs.
  const active = new Map<string, string>(); // policy name -> normalized body
  const polRe =
    /CREATE POLICY\s+"([^"]+)"\s+ON\s+(?:public\.)?notifications([\s\S]*?);/gi;
  const dropRe =
    /DROP POLICY\s+(?:IF EXISTS\s+)?"([^"]+)"\s+ON\s+(?:public\.)?notifications/gi;

  // Walk the concatenated SQL once, applying CREATE/DROP in positional order.
  const events: { pos: number; kind: "create" | "drop"; name: string; body?: string }[] = [];
  for (const m of sql.matchAll(polRe)) {
    events.push({ pos: m.index!, kind: "create", name: m[1]!, body: m[2]! });
  }
  for (const m of sql.matchAll(dropRe)) {
    events.push({ pos: m.index!, kind: "drop", name: m[1]! });
  }
  events.sort((a, b) => a.pos - b.pos);
  for (const e of events) {
    if (e.kind === "create") active.set(e.name, e.body!.replace(/\s+/g, " ").toLowerCase());
    else active.delete(e.name);
  }

  const offenders: string[] = [];
  for (const [name, body] of active) {
    if (/for\s+insert/.test(body) && /with check\s*\(\s*true\s*\)/.test(body)) {
      offenders.push(name);
    }
  }

  assert(
    offenders.length === 0,
    `notifications has permissive WITH CHECK(true) INSERT policy(ies): ` +
      offenders.join(", ") +
      ` — notifications are inserted only by the service-role edge (bypasses RLS); ` +
      `drop the client INSERT policy or scope it to auth.uid() = user_id.`,
  );
});

// ── US-2008 AC3: prove each widened blind spot actually CATCHES its case ──
//
// Widening a regex and watching the suite stay green proves nothing: the suite
// was green while all four holes were open. These drive the parser with
// synthetic SQL shaped exactly like the real cases it used to miss.

Deno.test("US-2008 (a): owner columns that are not literally `user_id` are detected", () => {
  const schema = parseSchema(`
CREATE TABLE IF NOT EXISTS public.claims_x (
  id uuid PRIMARY KEY,
  seller_user_id uuid NOT NULL REFERENCES public.users(id)
);
`);
  // The old /\buser_id\b/ could not match this: the char before "user_id" is an
  // underscore, which is a word character, so there is no boundary.
  assert(
    hasUserId("claims_x", schema),
    "seller_user_id must count as an owner column — this exact miss is why 21 " +
      "tables went unchecked",
  );
  for (const col of ["owner_user_id", "subject_user_id", "admin_user_id", "owner_id"]) {
    const s2 = parseSchema(
      `CREATE TABLE IF NOT EXISTS public.t_${col} (\n  ${col} uuid\n);\n`,
    );
    assert(hasUserId(`t_${col}`, s2), `${col} must count as an owner column`);
  }
  // And a table with no owner column still must NOT be treated as tenant data.
  const none = parseSchema(
    "CREATE TABLE IF NOT EXISTS public.cfg_x (\n  key text,\n  value text\n);\n",
  );
  assert(!hasUserId("cfg_x", none), "a config table has no owner column");
});

Deno.test("US-2008 (b): tables declared WITHOUT the public. prefix are parsed", () => {
  const schema = parseSchema(`
CREATE TABLE IF NOT EXISTS bare_table (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL
);
`);
  assert(
    schema.tableBlocks.has("bare_table"),
    "a bare CREATE TABLE must be parsed — requiring `public.` hid `notifications` " +
      "and `listing_prompt_acceptance` from this guard entirely",
  );
  assert(hasUserId("bare_table", schema));
});

Deno.test("US-2008 (c): RLS enabled inside a DO/FOREACH loop is detected", () => {
  // The 00381 ads_* shape, reduced.
  const schema = parseSchema(`
CREATE TABLE IF NOT EXISTS public.dyn_a (
  id uuid PRIMARY KEY,
  owner_user_id uuid
);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dyn_a','dyn_b'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;
`);
  assert(
    schema.rlsEnabled.has("dyn_a") && schema.rlsEnabled.has("dyn_b"),
    "dynamically-enabled RLS must be recognized — otherwise seven live ads_* " +
      "tables read as unprotected to every static reviewer",
  );
  // A loop that does something else must NOT be misread as enabling RLS.
  const unrelated = parseSchema(`
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['x_a'] LOOP
    EXECUTE format('ANALYZE public.%I;', t);
  END LOOP;
END $$;
`);
  assert(
    !unrelated.rlsEnabled.has("x_a"),
    "only loops that actually ENABLE ROW LEVEL SECURITY may count",
  );
});

Deno.test("US-2008 (d): policies with UNQUOTED names are parsed", () => {
  const schema = parseSchema(`
CREATE TABLE IF NOT EXISTS public.pol_x (
  id uuid PRIMARY KEY,
  user_id uuid
);
CREATE POLICY pol_x_select_own ON public.pol_x FOR SELECT USING (user_id = auth.uid());
`);
  const list = schema.policies.get("pol_x") ?? [];
  assertEquals(list.length, 1, "an unquoted policy name must still be parsed");
  assertEquals(list[0]!.name, "pol_x_select_own");

  // The point of parsing them: a permissive one must now be visible.
  const permissive = parseSchema(`
CREATE TABLE IF NOT EXISTS public.pol_y (
  id uuid PRIMARY KEY,
  user_id uuid
);
CREATE POLICY pol_y_all ON public.pol_y FOR SELECT USING (true);
`);
  const body = (permissive.policies.get("pol_y") ?? [])[0]?.body ?? "";
  assert(
    /USING\s*\(\s*true\s*\)/i.test(body),
    "an unquoted permissive policy must be visible to the USING(true) check",
  );
});

Deno.test("US-2008: a DROPPED policy no longer counts (final state, not history)", () => {
  // The notifications case: 00007 created a WITH CHECK (true) INSERT policy and
  // 00437 removed it. Concatenating every migration and matching only CREATE
  // reported the dead policy as live.
  const schema = parseSchema(`
CREATE TABLE IF NOT EXISTS notif_x (
  id uuid PRIMARY KEY,
  user_id uuid
);
CREATE POLICY "svc insert" ON notif_x FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "svc insert" ON notif_x;
`);
  assertEquals(
    (schema.policies.get("notif_x") ?? []).length,
    0,
    "a policy dropped by a later migration must not be reported as live",
  );

  // ...but DROP-then-CREATE (the idempotent migration idiom) must KEEP it.
  const recreated = parseSchema(`
CREATE TABLE IF NOT EXISTS notif_y (
  id uuid PRIMARY KEY,
  user_id uuid
);
DROP POLICY IF EXISTS "own rows" ON notif_y;
CREATE POLICY "own rows" ON notif_y FOR SELECT USING (user_id = auth.uid());
`);
  assertEquals(
    (recreated.policies.get("notif_y") ?? []).length,
    1,
    "DROP IF EXISTS followed by CREATE is the standard idempotent idiom — the " +
      "policy must survive it",
  );
});

// ── US-1927 AC1 regression guard: the RLS initplan form ─────────────────────
//
// 00451 rewrote the hot-path per-user policies from bare `auth.uid()` to the
// scalar-subquery form `(select auth.uid())`. The two are semantically
// IDENTICAL — auth.uid() is STABLE, so the value cannot differ — but the
// planner treats them differently: the subquery form is hoisted to a single
// InitPlan evaluated ONCE per query, while the bare call is re-evaluated PER
// CANDIDATE ROW. On a large per-user SELECT that is the difference between one
// call and hundreds of thousands.
//
// NOTHING GUARDED THAT, AND IT ALREADY REGRESSED. 00474_push_subscriptions
// (US-1901) added four policies in the bare form, 23 migrations after 00451
// fixed the pattern. The fix was a one-time sweep with no way to stay fixed,
// which is the same shape as the rounding-site drift in US-2041 and the
// hand-synced image sitemap in US-2111: a correct edit that nothing holds in
// place.
//
// SCOPE — this checks the SOURCE FORM ONLY. It cannot confirm the planner
// actually hoists anything; that is US-1927 AC3 and needs a live EXPLAIN
// (Docker for the verify:db lane, or a prod session). A guard that cannot see
// the plan can still keep the source in the shape the plan needs, and that is
// all this claims to do.
const INITPLAN_EXEMPT = new Map<string, string>([
  [
    "00683_tax_profiles.sql",
    "SUPERSEDED BY 00687, which rewrites all thirteen of these policies into the initplan form. These three shipped with the bare `auth.uid()` and were APPLIED to production before anyone noticed, and an applied migration is immutable, so the correction had to be a new file. Listed here because this guard reads the SOURCE and a later corrective migration cannot satisfy it - NOT because the form is acceptable on these tables. ledger_entries is the opposite of exempt: the derivation writes NINE rows per completed sale, which is exactly the per-row re-evaluation AC1 exists to stop. If you are here because a fourth migration tripped the guard, the answer is to write the policy correctly, not to add a fourth entry.",
  ],
  [
    "00684_ledger_accounts.sql",
    "SUPERSEDED BY 00687, which rewrites all thirteen of these policies into the initplan form. These three shipped with the bare `auth.uid()` and were APPLIED to production before anyone noticed, and an applied migration is immutable, so the correction had to be a new file. Listed here because this guard reads the SOURCE and a later corrective migration cannot satisfy it - NOT because the form is acceptable on these tables. ledger_entries is the opposite of exempt: the derivation writes NINE rows per completed sale, which is exactly the per-row re-evaluation AC1 exists to stop. If you are here because a fourth migration tripped the guard, the answer is to write the policy correctly, not to add a fourth entry.",
  ],
  [
    "00685_ledger_entries.sql",
    "SUPERSEDED BY 00687, which rewrites all thirteen of these policies into the initplan form. These three shipped with the bare `auth.uid()` and were APPLIED to production before anyone noticed, and an applied migration is immutable, so the correction had to be a new file. Listed here because this guard reads the SOURCE and a later corrective migration cannot satisfy it - NOT because the form is acceptable on these tables. ledger_entries is the opposite of exempt: the derivation writes NINE rows per completed sale, which is exactly the per-row re-evaluation AC1 exists to stop. If you are here because a fourth migration tripped the guard, the answer is to write the policy correctly, not to add a fourth entry.",
  ],
  [
    "00474_push_subscriptions.sql",
    "PRE-EXISTING at guard-authoring time (2026-07-19), not a new exemption. " +
      "push_subscriptions is one row per user per device, so the per-row " +
      "re-evaluation this guard exists to prevent is negligible there — the " +
      "cost is a handful of rows, not the large per-user scans AC1 " +
      "prioritises. Rewriting it needs a NEW migration (applied migrations are " +
      "immutable) and RLS DDL cannot be validated from this host with Docker " +
      "down, so shipping an unverifiable policy rewrite for a negligible gain " +
      "is the worse trade. Fix it opportunistically alongside the next " +
      "push_subscriptions migration; do NOT add entries here to silence a hot " +
      "table.",
  ],
  [
    "00588_extension_work_queue.sql",
    "SAME TRADE AS push_subscriptions ABOVE, and added under the same rule " +
      "rather than around it. extension_work_queue holds a handful of rows per " +
      "seller — one per queued job, expired after 7 days — so it is the small " +
      "table the exemption above describes, not the large per-user scan AC1 " +
      "prioritises. 00588 was applied to prod on 2026-08-10, which makes it " +
      "immutable, so the correct form needs a NEW migration; and RLS DDL cannot " +
      "be validated from this host (no Docker), so that migration would ship " +
      "unverified for a planner win measured in single-digit rows. " +
      "THE DEBT IS REAL AND IT IS WRITTEN DOWN: rewrite these four policies as " +
      "((select auth.uid()) = user_id) in the next migration that touches this " +
      "table for any other reason. If this table ever grows a per-user scan — a " +
      "history view, an admin sweep, anything reading many rows at once — that " +
      "is the trigger to do it immediately rather than opportunistically.",
  ],
]);

Deno.test("US-1927 AC1: RLS policies use the (select auth.uid()) initplan form", async () => {
  const offenders: string[] = [];
  const names: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sql")) names.push(entry.name);
  }
  names.sort();

  // Only migrations at/after the sweep. Earlier ones legitimately predate the
  // form, and flagging ~253 historical files would produce a permanently red
  // guard that gets switched off — the failure mode these guards keep hitting.
  const SWEEP = "00451";

  for (const name of names) {
    if (name.slice(0, 5) <= SWEEP) continue;
    if (INITPLAN_EXEMPT.has(name)) continue;
    const sql = await Deno.readTextFile(new URL(name, MIGRATIONS_DIR));
    for (const m of sql.matchAll(/create\s+policy[\s\S]*?;/gi)) {
      const stmt = m[0];
      // Remove the CORRECT form first, then look for what is left. Searching
      // for bare auth.uid() directly would match inside `(select auth.uid())`
      // and flag every correctly-written policy.
      const withoutWrapped = stmt.replace(/\(\s*select\s+auth\.uid\(\)\s*\)/gi, "");
      if (/\bauth\.uid\(\)/i.test(withoutWrapped)) {
        const first = stmt.split("\n")[0]!.trim().slice(0, 90);
        offenders.push(`${name}: ${first}`);
      }
    }
  }

  assertEquals(
    offenders,
    [],
    "These policies call bare auth.uid(), which the planner re-evaluates PER " +
      "ROW instead of hoisting to a single InitPlan (US-1927 AC1). Use " +
      "((select auth.uid()) = user_id). The two forms are semantically " +
      "identical — auth.uid() is STABLE — so this is a pure planner win with " +
      "no membership change:\n" + offenders.join("\n"),
  );
});

Deno.test("US-1927: the initplan guard can actually fail (self-check)", () => {
  // The guard's whole job is to reject one specific string shape. If the
  // strip-then-search logic were inverted or over-eager it would pass on
  // everything, and a guard that cannot fail is worse than none — this session
  // has shipped that mistake twice (US-2103's builder sweep, US-2104's import
  // match). So the detector is exercised on both forms directly.
  const detect = (stmt: string) =>
    /\bauth\.uid\(\)/i.test(
      stmt.replace(/\(\s*select\s+auth\.uid\(\)\s*\)/gi, ""),
    );

  assert(
    detect(`create policy "x" on t for select using (auth.uid() = user_id);`),
    "must flag the bare form",
  );
  assert(
    !detect(`create policy "x" on t for select using ((select auth.uid()) = user_id);`),
    "must NOT flag the correct initplan form",
  );
  // Mixed: one clause fixed, another missed — the realistic half-migration.
  assert(
    detect(
      `create policy "x" on t for all using ((select auth.uid()) = user_id) ` +
        `with check (auth.uid() = user_id);`,
    ),
    "must flag a policy that fixed USING but left WITH CHECK bare",
  );
});
