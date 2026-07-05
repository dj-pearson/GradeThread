// US-1604: Integrations Watchdog pure domain logic — rotation calendar, token
// fleet forecast, vendor health, and the assembled memo. No env/DB needed
// (this module imports nothing impure), so no dynamic-import dance.
import { assert, assertEquals } from "@std/assert";
import {
  assembleIntegrationsMemo,
  computeRotationCalendar,
  computeTokenFleetForecast,
  type ConnectionRow,
  KEY_ROTATION_REGISTRY,
  type OpsEventLite,
  type RotationEntry,
  summarizeVendorHealth,
} from "../lib/integrations-watchdog.ts";

const NOW = Date.parse("2026-07-05T00:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

// ── Rotation calendar ────────────────────────────────────────────────────────

const REG: RotationEntry[] = [
  { secret: "SCHEDULED_90", location: "edge", cadence_days: 90, note: "n" },
  { secret: "EVENT_ONLY", location: "edge", cadence_days: null, note: "n" },
];

Deno.test("computeRotationCalendar: overdue when last-rotated + cadence is in the past", () => {
  const cal = computeRotationCalendar(REG, { SCHEDULED_90: iso(-100 * DAY) }, NOW);
  const item = cal.find((c) => c.secret === "SCHEDULED_90")!;
  assertEquals(item.status, "overdue");
  assert(item.days_until_due! < 0);
});

Deno.test("computeRotationCalendar: due_soon inside the warn window, ok outside it", () => {
  const soon = computeRotationCalendar(REG, { SCHEDULED_90: iso(-83 * DAY) }, NOW); // due in 7d
  assertEquals(soon.find((c) => c.secret === "SCHEDULED_90")!.status, "due_soon");
  const ok = computeRotationCalendar(REG, { SCHEDULED_90: iso(-10 * DAY) }, NOW); // due in 80d
  assertEquals(ok.find((c) => c.secret === "SCHEDULED_90")!.status, "ok");
});

Deno.test("computeRotationCalendar: no recorded date → baseline_needed (not a false overdue)", () => {
  const cal = computeRotationCalendar(REG, {}, NOW);
  assertEquals(cal.find((c) => c.secret === "SCHEDULED_90")!.status, "baseline_needed");
});

Deno.test("computeRotationCalendar: event-driven secrets are never timed", () => {
  const cal = computeRotationCalendar(REG, { EVENT_ONLY: iso(-9999 * DAY) }, NOW);
  const item = cal.find((c) => c.secret === "EVENT_ONLY")!;
  assertEquals(item.status, "event_driven");
  assertEquals(item.next_due_at, null);
});

Deno.test("KEY_ROTATION_REGISTRY: encodes the KEY_ROTATION.md scheduled + event-driven split", () => {
  const scheduled = KEY_ROTATION_REGISTRY.filter((e) => e.cadence_days !== null).map((e) => e.secret);
  assert(scheduled.includes("ANTHROPIC_API_KEY"));
  assert(scheduled.includes("FLIPDESK_INTERNAL_JOB_SECRET"));
  const eventDriven = KEY_ROTATION_REGISTRY.filter((e) => e.cadence_days === null).map((e) => e.secret);
  assert(eventDriven.includes("SUPABASE_SERVICE_ROLE_KEY"));
});

// ── Token fleet forecast ─────────────────────────────────────────────────────

Deno.test("computeTokenFleetForecast: buckets expiry horizons cumulatively", () => {
  const conns: ConnectionRow[] = [
    { marketplace: "ebay", is_active: true, token_expires_at: iso(-DAY), refresh_error: null }, // expired
    { marketplace: "ebay", is_active: true, token_expires_at: iso(3 * DAY), refresh_error: null }, // <=7 and <=30
    { marketplace: "ebay", is_active: true, token_expires_at: iso(20 * DAY), refresh_error: "boom" }, // <=30 only
    { marketplace: "ebay", is_active: false, token_expires_at: iso(90 * DAY), refresh_error: null }, // neither
  ];
  const f = computeTokenFleetForecast(conns, NOW);
  assertEquals(f.total, 4);
  assertEquals(f.expired, 1);
  assertEquals(f.expiring_7d, 1); // the 3-day one only
  assertEquals(f.expiring_30d, 2); // 3-day + 20-day
  assertEquals(f.with_refresh_error, 1);
  assertEquals(f.by_marketplace.ebay.expired, 1);
});

// ── Vendor health ────────────────────────────────────────────────────────────

Deno.test("summarizeVendorHealth: critical → down, 3+ warnings → degraded, ignores non-vendor", () => {
  const events: OpsEventLite[] = [
    { type: "stripe.webhook_failed", severity: "critical", source: "stripe", created_at: iso(0) },
    { type: "ebay.token_refresh_slow", severity: "warning", source: "ebay", created_at: iso(0) },
    { type: "ebay.token_refresh_slow", severity: "warning", source: "ebay", created_at: iso(0) },
    { type: "ebay.browse_slow", severity: "warning", source: "ebay", created_at: iso(0) },
    { type: "grading.queue_deep", severity: "warning", source: "grading", created_at: iso(0) }, // not a vendor
  ];
  const health = summarizeVendorHealth(events);
  assertEquals(health.find((v) => v.vendor === "stripe")!.verdict, "down");
  assertEquals(health.find((v) => v.vendor === "ebay")!.verdict, "degraded");
  assertEquals(health.find((v) => v.vendor === "grading"), undefined);
});

// ── Assembled memo ───────────────────────────────────────────────────────────

Deno.test("assembleIntegrationsMemo: all-clear when nothing is wrong", () => {
  const memo = assembleIntegrationsMemo({
    connections: [{ marketplace: "ebay", is_active: true, token_expires_at: iso(200 * DAY), refresh_error: null }],
    opsEvents: [],
    rotationState: Object.fromEntries(
      KEY_ROTATION_REGISTRY.filter((e) => e.cadence_days).map((e) => [e.secret, iso(-1 * DAY)]),
    ),
    emailDeadLetters: 0,
    nowMs: NOW,
  });
  assertEquals(memo.all_clear, true);
  assert(memo.summary.includes("healthy"));
});

Deno.test("assembleIntegrationsMemo: surfaces expired tokens + overdue rotation, not all-clear", () => {
  const memo = assembleIntegrationsMemo({
    connections: [{ marketplace: "ebay", is_active: true, token_expires_at: iso(-DAY), refresh_error: null }],
    opsEvents: [{ type: "stripe.webhook_failed", severity: "critical", source: "stripe", created_at: iso(0) }],
    rotationState: { ANTHROPIC_API_KEY: iso(-200 * DAY) },
    emailDeadLetters: 2,
    nowMs: NOW,
  });
  assertEquals(memo.all_clear, false);
  assertEquals(memo.token_fleet.expired, 1);
  assert(memo.rotation.overdue.some((r) => r.secret === "ANTHROPIC_API_KEY"));
  assertEquals(memo.deliverability.email_dead_letters, 2);
  assert(memo.vendor_health.some((v) => v.vendor === "stripe" && v.verdict === "down"));
});
