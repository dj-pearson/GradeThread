// US-1560: the documented routerâ†’scope registry for admin RBAC enforcement.
//
// Every src/routes/admin-*.ts file MUST have exactly one entry here â€” the
// drift-guard test (admin-scope-coverage_test.ts) walks the directory and
// fails on any router that is missing, stale, or whose source doesn't match
// its declared mode. This file is the single place a reviewer answers "which
// permission gates surface X?".
//
// Modes:
//   â€¢ "router"    â€” the whole router is guarded with use("*", requireScope(s)):
//                    reads included. Chosen for single-concern routers where
//                    revoking the scope should coherently close the surface.
//   â€¢ "mutations" â€” per-mutation requireScope guards; reads stay role-gated
//                    (mixed-concern routers where each write maps to a
//                    different scope).
//   â€¢ "role-only" â€” deliberately NOT scope-guarded: read-only aggregates with
//                    zero mutations, gated by the admin role + AAL2 alone. The
//                    rationale is mandatory and reviewed.
//
// super_admin implicitly holds every scope; the default `admin` role holds all
// scopes except users:role (00298 + 00343 seeds), so enforcement changed no
// effective access at rollout â€” operators narrow deliberately afterward.

import type { ScopeKey } from "./rbac-scopes.ts";

export type GuardMode = "router" | "mutations" | "role-only";

export interface AdminRouterScope {
  /** Basename under src/routes/, e.g. "admin-billing.ts". */
  file: string;
  /** The guarding scope; null only for mode "role-only" or "mutations". */
  scope: ScopeKey | null;
  mode: GuardMode;
  rationale: string;
}

export const ADMIN_ROUTER_SCOPES: AdminRouterScope[] = [
  // â”€â”€ billing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    file: "admin-billing.ts",
    scope: "billing:write",
    mode: "router",
    rationale: "Plans, credits, refunds, coupons â€” the original US-908 enforcement; unchanged.",
  },
  // â”€â”€ grading â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    file: "admin-grading.ts",
    scope: "grading:review",
    mode: "router",
    rationale: "Review queue, regrades, prompt/exemplar/eval management â€” all grade-outcome authority.",
  },
  {
    file: "admin-claims.ts",
    scope: "grading:review",
    mode: "router",
    rationale: "Guarantee claims adjudicate grade correctness (approval triggers the remedy).",
  },
  {
    file: "admin-disputes.ts",
    scope: "grading:review",
    mode: "router",
    rationale: "Grade disputes are re-adjudications of grade outcomes.",
  },
  // â”€â”€ moderation / trust & safety â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    file: "admin-moderation.ts",
    scope: "moderation:write",
    mode: "router",
    rationale: "Original US-908 enforcement; approve/reject/ban/takedown; unchanged.",
  },
  {
    file: "admin-safety.ts",
    scope: "moderation:write",
    mode: "router",
    rationale: "Abuse/safety actions are moderation authority.",
  },
  {
    file: "admin-compliance.ts",
    scope: "moderation:write",
    mode: "router",
    rationale: "Compliance holds/actions on user content and accounts sit with moderation authority.",
  },
  {
    file: "admin-fraud.ts",
    scope: null,
    mode: "role-only",
    rationale: "Zero mutations â€” read-only fraud signal dashboards; acting on them goes through moderation/safety routers.",
  },
  // â”€â”€ content â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    file: "admin-changelog.ts",
    scope: "content:publish",
    mode: "router",
    rationale: "Publishes public changelog entries.",
  },
  {
    file: "admin-newsletter.ts",
    scope: "content:publish",
    mode: "router",
    rationale: "Composes and dispatches the public newsletter.",
  },
  {
    file: "admin-knowledge-base.ts",
    scope: "content:publish",
    mode: "router",
    rationale: "Publishes public help-center content.",
  },
  {
    file: "admin-seo.ts",
    scope: "content:publish",
    mode: "router",
    rationale: "SEO/content operations mutate public-facing pages and metadata.",
  },
  {
    file: "admin-legal.ts",
    scope: "content:publish",
    mode: "router",
    rationale: "Publishes legal documents (terms/policies) shown to all users.",
  },
  {
    file: "admin-condition-index.ts",
    scope: "content:publish",
    mode: "router",
    rationale: "Recomputes/curates the public Condition Index content surface.",
  },
  // â”€â”€ users / roles / identity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    file: "admin-users.ts",
    scope: null,
    mode: "mutations",
    rationale: "Mixed: POST /:id/role â†’ users:role (original US-908 guard); POST /:id/suspend â†’ moderation:write (account action). Reads (user lookup/detail) stay role-gated for support workflows.",
  },
  {
    file: "admin-scopes.ts",
    scope: null,
    mode: "mutations",
    rationale: "Original US-908 enforcement: role/user scope edits â†’ users:role; reads (catalog, effective scopes) stay role-gated so the roles page renders for any admin.",
  },
  {
    file: "admin-impersonation.ts",
    scope: "users:role",
    mode: "router",
    rationale: "Acting AS a user is the most privileged identity operation â€” same authority tier as role grants.",
  },
  // â”€â”€ platform ops â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    file: "admin-config.ts",
    scope: "ops:write",
    mode: "router",
    rationale: "Platform config edits.",
  },
  {
    file: "admin-settings.ts",
    scope: "ops:write",
    mode: "router",
    rationale: "Settings-registry (system_settings) editor â€” operational constants incl. grading thresholds.",
  },
  {
    file: "admin-flags.ts",
    scope: "ops:write",
    mode: "router",
    rationale: "Feature flags gate whole subsystems (kill switches included).",
  },
  {
    file: "admin-jobs.ts",
    scope: "ops:write",
    mode: "router",
    rationale: "Manual job triggers / cron-run views are operational controls.",
  },
  {
    file: "admin-ops.ts",
    scope: "ops:write",
    mode: "router",
    rationale: "The ops console: broad operational mutations.",
  },
  {
    file: "admin-monitoring.ts",
    scope: "ops:write",
    mode: "router",
    rationale: "Monitoring config/acknowledgement; one mutation, ops-owned.",
  },
  {
    file: "admin-ai-budgets.ts",
    scope: "ops:write",
    mode: "router",
    rationale: "AI spend guardrails/budget edits change platform cost behavior.",
  },
  {
    file: "admin-pricing.ts",
    scope: "ops:write",
    mode: "router",
    rationale: "Plan/pricing configuration (distinct from per-customer billing actions).",
  },
  {
    file: "admin-views.ts",
    scope: "ops:write",
    mode: "router",
    rationale: "Shared admin saved-views/dashboards configuration.",
  },
  {
    file: "admin-passport-integrity.ts",
    scope: "ops:write",
    mode: "router",
    rationale: "Integrity scans/repairs over the passport chain are operational actions.",
  },
  {
    file: "admin-audit.ts",
    scope: "ops:write",
    mode: "router",
    rationale: "Audit-log views + anomaly acknowledgement; the one mutation is an ops action.",
  },
  // â”€â”€ marketplace â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    file: "admin-marketplace-connections.ts",
    scope: "marketplace:write",
    mode: "router",
    rationale: "Cross-tenant marketplace-connection administration.",
  },
  {
    file: "admin-marketplace-ops.ts",
    scope: "marketplace:write",
    mode: "router",
    rationale: "Marketplace operational actions (sync repair, webhook ops).",
  },
  {
    file: "admin-marketplace-pipeline.ts",
    scope: "marketplace:write",
    mode: "router",
    rationale: "Listing-pipeline administration.",
  },
  {
    file: "admin-category-map.ts",
    scope: "marketplace:write",
    mode: "router",
    rationale: "Garmentâ†’eBay category mappings feed every seller's listing generation.",
  },
  {
    file: "admin-ads.ts",
    scope: "marketplace:write",
    mode: "router",
    rationale: "Promoted-listings / ads administration on marketplace accounts.",
  },
  // â”€â”€ support â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    file: "admin-support.ts",
    scope: "support:write",
    mode: "router",
    rationale: "Support console actions on user accounts.",
  },
  {
    file: "admin-support-tickets.ts",
    scope: "support:write",
    mode: "router",
    rationale: "Ticket triage/replies.",
  },
  {
    file: "admin-messages.ts",
    scope: "support:write",
    mode: "router",
    rationale: "Adminâ†’user messages.",
  },
  {
    file: "admin-notifications.ts",
    scope: "support:write",
    mode: "router",
    rationale: "Admin notification-center management (mark/route notifications).",
  },
  {
    file: "admin-suppressions.ts",
    scope: "support:write",
    mode: "router",
    rationale: "Email suppression-list management.",
  },
  // â”€â”€ growth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    file: "admin-growth.ts",
    scope: "growth:write",
    mode: "router",
    rationale: "Segments, broadcast campaigns, announcements, push sends.",
  },
  {
    file: "admin-drip.ts",
    scope: "growth:write",
    mode: "router",
    rationale: "Drip email flows.",
  },
  {
    file: "admin-journeys.ts",
    scope: "growth:write",
    mode: "router",
    rationale: "Lifecycle journey configuration.",
  },
  {
    file: "admin-waitlist.ts",
    scope: "growth:write",
    mode: "router",
    rationale: "Waitlist management (invites/approvals).",
  },
  // â”€â”€ mixed bulk operations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    file: "admin-bulk.ts",
    scope: null,
    mode: "mutations",
    rationale: "Each bulk op maps to its owning scope: /credits â†’ billing:write, /suspend â†’ moderation:write, /regrade â†’ grading:review. POST /resolve is a read-only target lookup (no scope; US-1562).",
  },
  // â”€â”€ read-only aggregates (deliberately role-gated) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    file: "admin-ai-spend.ts",
    scope: null,
    mode: "role-only",
    rationale: "Zero mutations â€” AI spend/profitability/extraction-accuracy dashboards.",
  },
  {
    file: "admin-analytics.ts",
    scope: null,
    mode: "role-only",
    rationale: "Zero mutations â€” platform analytics aggregates.",
  },
  {
    file: "admin-revenue.ts",
    scope: null,
    mode: "role-only",
    rationale: "Zero mutations â€” revenue aggregates (mutating billing lives in admin-billing).",
  },
  {
    file: "admin-search.ts",
    scope: null,
    mode: "role-only",
    rationale: "Zero mutations â€” cross-entity admin search.",
  },
  {
    file: "admin-subscribers.ts",
    scope: null,
    mode: "role-only",
    rationale: "Zero mutations â€” subscriber list views (suppression edits live in admin-suppressions).",
  },
];
