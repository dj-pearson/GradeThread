// US-905: audit-log anomaly detection logic.
import { assert, assertEquals } from "@std/assert";
import {
  type AnomalyConfig,
  type AuditRowLite,
  detectAnomalies,
  isDestructive,
  isOffHours,
  isRefundOrCredit,
  isRoleChange,
} from "../lib/audit-anomaly.ts";

const CFG: AnomalyConfig = {
  enabled: true,
  roleChangesPerHour: 3,
  refundsPerHour: 4,
  businessHoursStart: 7,
  businessHoursEnd: 20,
};

// A fixed window-end so the dedupe bucket is deterministic (2026-06-14T03:00Z).
const NOW = Date.UTC(2026, 5, 14, 3, 0, 0);

function row(partial: Partial<AuditRowLite>): AuditRowLite {
  return {
    id: partial.id ?? crypto.randomUUID(),
    admin_user_id: partial.admin_user_id ?? "admin-1",
    actor_role: partial.actor_role ?? "super_admin",
    action: partial.action ?? "admin.change_role",
    target_type: partial.target_type ?? "user",
    created_at: partial.created_at ?? new Date(NOW).toISOString(),
  };
}

// ── classifiers ─────────────────────────────────────────────────────

Deno.test("isRoleChange matches the role-change action only", () => {
  assert(isRoleChange("admin.change_role"));
  assert(!isRoleChange("admin.suspend_user"));
});

Deno.test("isRefundOrCredit matches refund/credit/comp actions", () => {
  for (const a of [
    "admin.pack_refund",
    "admin.refund_charge",
    "admin.comp_credits",
    "admin.credit_adjust",
    "admin.bulk_comp_credits",
    "admin.grade_refund_resolved",
  ]) {
    assert(isRefundOrCredit(a), `expected ${a} to be a refund/credit`);
  }
  assert(!isRefundOrCredit("admin.change_role"));
});

Deno.test("isDestructive matches deletes/cancels/refunds/role changes", () => {
  assert(isDestructive("ai_budget.delete"));
  assert(isDestructive("jobs.cancel"));
  assert(isDestructive("admin.suspend_user"));
  assert(isDestructive("admin.refund_charge"));
  assert(isDestructive("admin.change_role"));
  assert(!isDestructive("admin.view_user"));
  // Must not match a destructive keyword embedded mid-word (no . or _ boundary).
  assert(!isDestructive("admin.predeletion"));
});

Deno.test("isOffHours flags before-start and at/after-end (UTC)", () => {
  assert(isOffHours("2026-06-14T03:00:00Z", CFG)); // before 07:00
  assert(isOffHours("2026-06-14T20:00:00Z", CFG)); // at end (exclusive)
  assert(isOffHours("2026-06-14T23:30:00Z", CFG));
  assert(!isOffHours("2026-06-14T09:00:00Z", CFG)); // inside business hours
});

// ── detection ───────────────────────────────────────────────────────

Deno.test("disabled config yields no findings", () => {
  const rows = Array.from({ length: 10 }, () => row({}));
  assertEquals(detectAnomalies(rows, { ...CFG, enabled: false }, NOW), []);
});

Deno.test("role-change burst fires only above the threshold, per actor", () => {
  // 4 role changes by admin-1 (> threshold 3), 2 by admin-2 (not over).
  const rows = [
    ...Array.from({ length: 4 }, () => row({ admin_user_id: "admin-1" })),
    ...Array.from({ length: 2 }, () => row({ admin_user_id: "admin-2" })),
  ];
  const found = detectAnomalies(rows, CFG, NOW).filter(
    (f) => f.detector === "role_change_burst",
  );
  assertEquals(found.length, 1);
  assertEquals(found[0]!.actorUserId, "admin-1");
  assertEquals(found[0]!.eventCount, 4);
  assert(found[0]!.dedupeKey.startsWith("role_change_burst:admin-1:"));
});

Deno.test("mass refund fires platform-wide above the threshold", () => {
  // 5 refund/credit actions (> threshold 4) at 09:00 (in-hours, so off-hours
  // detector should NOT also fire on these).
  const ts = "2026-06-14T09:00:00Z";
  const rows = Array.from({ length: 5 }, (_, i) =>
    row({
      id: `r${i}`,
      action: "admin.refund_charge",
      target_type: "charge",
      created_at: ts,
    }));
  const found = detectAnomalies(rows, CFG, NOW);
  const refund = found.filter((f) => f.detector === "mass_refund");
  assertEquals(refund.length, 1);
  assertEquals(refund[0]!.eventCount, 5);
  // In-hours refunds must not trip the off-hours detector.
  assertEquals(found.filter((f) => f.detector === "off_hours_destructive").length, 0);
});

Deno.test("off-hours destructive aggregates only the off-hours rows", () => {
  const rows = [
    row({ id: "a", action: "ai_budget.delete", created_at: "2026-06-14T03:00:00Z" }),
    row({ id: "b", action: "jobs.cancel", created_at: "2026-06-14T04:30:00Z" }),
    // In-hours destructive — excluded.
    row({ id: "c", action: "ai_budget.delete", created_at: "2026-06-14T10:00:00Z" }),
    // Off-hours but NOT destructive — excluded.
    row({ id: "d", action: "admin.view_user", created_at: "2026-06-14T02:00:00Z" }),
  ];
  const found = detectAnomalies(rows, CFG, NOW).filter(
    (f) => f.detector === "off_hours_destructive",
  );
  assertEquals(found.length, 1);
  assertEquals(found[0]!.eventCount, 2);
});

Deno.test("dedupe key is stable for the same hour window", () => {
  const rows = Array.from({ length: 4 }, () => row({}));
  const a = detectAnomalies(rows, CFG, NOW)[0]!;
  const b = detectAnomalies(rows, CFG, NOW + 60_000)[0]!; // +1 min, same hour
  assertEquals(a.dedupeKey, b.dedupeKey);
});

// ── US-2319 AC3: an alert that never went out is not "already handled" ──────
//
// The scan upserts the finding, then dispatches the alert, then sets `alerted`
// only if a channel accepted it. The gate in front of all that used to be
// `isNew = !existing`, so the upsert — which happens either way — was what
// decided whether anyone was ever told.
//
// A finding whose dispatch failed (no channel configured, an SMTP blip, a
// webhook 500) was therefore `existing` on the next run, read as already
// flagged, and skipped from then on. The detector had done its job and the
// alert died silently. That is the one direction an alerting path must never
// fail in, and this file is where the rule lives.
//
// Scanned from source rather than driven: persistFinding talks to the
// service-role client directly, so exercising it needs a database. What can be
// pinned without one is that the decision reads `alerted`.
Deno.test("US-2319: an undelivered alert is retried, not swallowed", () => {
  const src = Deno.readTextFileSync(
    new URL("../routes/jobs-audit-anomaly.ts", import.meta.url),
  );
  // Comments stripped. The explanation above the fix names the old expression
  // verbatim, so a scan of the raw text would find `!existing` in prose and
  // report the bug as present — or, worse, find the new form in a comment after
  // a revert and report it fixed.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

  assert(
    /needsAlert\s*=\s*!prior\s*\|\|\s*!prior\.alerted/.test(code),
    "the alert decision no longer considers whether the alert was DELIVERED — " +
      "a finding whose dispatch failed is skipped forever",
  );
  assert(
    !/isNew\s*=\s*!existing/.test(code),
    "the first-sighting-only gate is back",
  );
  // And `alerted` must still be read out of the row, or there is nothing to
  // decide with. It was selected and ignored for the whole life of this bug.
  assert(
    /\.select\("id, alerted"\)/.test(code),
    "the alerted column is no longer fetched",
  );
  // The flag is set only after a successful delivery — the other half of the
  // contract. If it were set unconditionally the retry would never happen.
  assert(
    /if \(delivered\) \{[\s\S]{0,200}markAlerted/.test(code),
    "markAlerted no longer depends on the delivery succeeding",
  );
});
