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
