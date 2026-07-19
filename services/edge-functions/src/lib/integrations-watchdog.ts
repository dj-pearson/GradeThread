// US-1604 / AGENTIC-OS Phase 1 (Module I): the Integrations Watchdog's domain
// logic — vendor-facing health, the OAuth token fleet, and the key-rotation
// calendar. Read-ABOUT-credentials only: this module sees expiry metadata,
// health signals, and rotation cadences — NEVER secret material.
//
// Everything here is PURE + fixture-tested; the tool (agent-tools.ts) supplies
// the impure reads (marketplace connections, ops events, rotation state) and
// this module turns them into a deterministic memo the agent narrates.

// ── Key-rotation registry (vault/10-ops/key-rotation.md encoded as data) ──────────────────
//
// US-2076: this is a SHIPPED copy of ops knowledge — the rotation cadences from
// the vault note, restructured as data so the watchdog can compute a due/overdue
// calendar. It is guarded, not generated: the note is prose with a procedure,
// this is a typed schedule, and neither derives cleanly from the other.
//
// @sourceNote vault/10-ops/key-rotation.md
// @reviewed 2026-07-19
//
// scripts/runbook-sync.mjs fails when that note has a commit newer than the date
// above. Bumping it asserts a human re-read both — cadences here, procedure
// there. Verified 2026-07-19: no entry repeats either of the two WRONG
// EDGE_ENCRYPTION_KEY procedures US-2049 found in the markdown (this registry
// only records that rotation needs dual-key re-encryption, which is true, and
// defers the steps to the note).
//
// The rotation SCHEDULE from vault/10-ops/key-rotation.md, checked in as structured data so
// the agent can compute a due/overdue calendar. `cadence_days: null` = an
// event-driven secret (rotate on leak / on policy / on endpoint change) — it has
// no timer and is never "overdue" on a clock, only flagged for awareness.

export interface RotationEntry {
  secret: string;
  location: string;
  cadence_days: number | null;
  note: string;
}

export const KEY_ROTATION_REGISTRY: readonly RotationEntry[] = [
  { secret: "FLIPDESK_INTERNAL_JOB_SECRET", location: "edge", cadence_days: 90, note: "Dual-secret zero-downtime rotation; or immediately on suspected leak." },
  { secret: "ANTHROPIC_API_KEY", location: "edge", cadence_days: 90, note: "Create new key, swap env, revoke old." },
  { secret: "STRIPE_SECRET_KEY", location: "edge", cadence_days: 365, note: "Roll in Stripe dashboard; update env; redeploy. Or on leak." },
  { secret: "STRIPE_WEBHOOK_SECRET", location: "edge", cadence_days: null, note: "On endpoint change — Stripe supports multiple signing secrets during cutover." },
  { secret: "EBAY_CERT_ID", location: "edge", cadence_days: null, note: "Per eBay policy; token refresh continues without re-consent." },
  { secret: "EDGE_ENCRYPTION_KEY", location: "edge", cadence_days: null, note: "Special: rotating requires dual-key re-encryption of stored eBay tokens (see vault/10-ops/key-rotation.md)." },
  { secret: "SUPABASE_SERVICE_ROLE_KEY", location: "edge", cadence_days: null, note: "On leak — high blast radius, coordinate." },
  { secret: "UNSUBSCRIBE_SECRET", location: "edge", cadence_days: null, note: "On leak — rotating invalidates outstanding unsubscribe links (acceptable)." },
  { secret: "DEPLOY_REGISTRY_TOKENS", location: "ci", cadence_days: 90, note: "Deploy/registry tokens in GitHub Actions (US-522 inventory)." },
];

// The warn window: a scheduled secret within this many days of its next due date
// is "due_soon" rather than "ok".
export const ROTATION_WARN_DAYS = 14;

export type RotationStatus = "ok" | "due_soon" | "overdue" | "baseline_needed" | "event_driven";

export interface RotationCalendarItem {
  secret: string;
  location: string;
  cadence_days: number | null;
  last_rotated_at: string | null;
  next_due_at: string | null;
  days_until_due: number | null; // negative = overdue
  status: RotationStatus;
  note: string;
}

/** Operator-maintained map secret → last-rotated ISO timestamp (system_settings). */
export type RotationState = Record<string, string>;

const DAY_MS = 24 * 3600_000;

// Compute the rotation calendar. Pure + deterministic. A scheduled secret with
// no recorded last-rotation is "baseline_needed" (record the date, don't
// false-alarm as overdue); event-driven secrets are surfaced but never timed.
export function computeRotationCalendar(
  registry: readonly RotationEntry[],
  state: RotationState,
  nowMs: number,
): RotationCalendarItem[] {
  return registry.map((e) => {
    const lastRaw = state[e.secret];
    const lastMs = lastRaw ? Date.parse(lastRaw) : NaN;
    const lastRotatedAt = Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null;

    if (e.cadence_days === null) {
      return {
        secret: e.secret,
        location: e.location,
        cadence_days: null,
        last_rotated_at: lastRotatedAt,
        next_due_at: null,
        days_until_due: null,
        status: "event_driven",
        note: e.note,
      };
    }
    if (lastRotatedAt === null) {
      return {
        secret: e.secret,
        location: e.location,
        cadence_days: e.cadence_days,
        last_rotated_at: null,
        next_due_at: null,
        days_until_due: null,
        status: "baseline_needed",
        note: e.note,
      };
    }
    const nextDueMs = lastMs + e.cadence_days * DAY_MS;
    const daysUntilDue = Math.floor((nextDueMs - nowMs) / DAY_MS);
    const status: RotationStatus = daysUntilDue < 0
      ? "overdue"
      : daysUntilDue <= ROTATION_WARN_DAYS
      ? "due_soon"
      : "ok";
    return {
      secret: e.secret,
      location: e.location,
      cadence_days: e.cadence_days,
      last_rotated_at: lastRotatedAt,
      next_due_at: new Date(nextDueMs).toISOString(),
      days_until_due: daysUntilDue,
      status,
      note: e.note,
    };
  });
}

// ── Token-fleet expiry forecast ──────────────────────────────────────────────

export interface ConnectionRow {
  marketplace: string | null;
  is_active: boolean | null;
  token_expires_at: string | null;
  refresh_error: string | null;
}

export interface TokenFleetForecast {
  total: number;
  active: number;
  with_refresh_error: number;
  expired: number;
  expiring_7d: number;
  expiring_30d: number;
  by_marketplace: Record<string, { total: number; expired: number; expiring_7d: number; expiring_30d: number }>;
}

// Bucket OAuth connections by how soon their token expires. `expiring_7d` and
// `expiring_30d` are cumulative-from-now horizons (an item expiring in 3 days
// counts in both). Pure.
export function computeTokenFleetForecast(
  connections: readonly ConnectionRow[],
  nowMs: number,
): TokenFleetForecast {
  const byMarketplace: TokenFleetForecast["by_marketplace"] = {};
  let active = 0, withError = 0, expired = 0, expiring7 = 0, expiring30 = 0;
  for (const c of connections) {
    const mk = c.marketplace ?? "unknown";
    const bucket = byMarketplace[mk] ?? (byMarketplace[mk] = { total: 0, expired: 0, expiring_7d: 0, expiring_30d: 0 });
    bucket.total++;
    if (c.is_active) active++;
    if (c.refresh_error) withError++;
    if (c.token_expires_at) {
      const dtDays = (Date.parse(c.token_expires_at) - nowMs) / DAY_MS;
      if (!Number.isFinite(dtDays)) continue;
      if (dtDays < 0) {
        expired++;
        bucket.expired++;
      } else {
        if (dtDays <= 7) {
          expiring7++;
          bucket.expiring_7d++;
        }
        if (dtDays <= 30) {
          expiring30++;
          bucket.expiring_30d++;
        }
      }
    }
  }
  return {
    total: connections.length,
    active,
    with_refresh_error: withError,
    expired,
    expiring_7d: expiring7,
    expiring_30d: expiring30,
    by_marketplace: byMarketplace,
  };
}

// ── Vendor health (from ops events) ──────────────────────────────────────────

export interface OpsEventLite {
  type: string;
  severity: string;
  source: string | null;
  created_at: string;
}

export interface VendorHealth {
  vendor: string;
  warnings: number;
  criticals: number;
  verdict: "healthy" | "degraded" | "down";
}

// Which ops-event sources/types name an external vendor. Keyed substrings so a
// source like "stripe.webhook" or a type like "ebay.token_refresh_failed" maps.
const VENDOR_KEYS = ["stripe", "ebay", "anthropic", "ses", "email", "google", "apple", "posthog", "sentry"] as const;

function vendorOf(e: OpsEventLite): string | null {
  const hay = `${e.source ?? ""} ${e.type}`.toLowerCase();
  return VENDOR_KEYS.find((k) => hay.includes(k)) ?? null;
}

// Per-vendor verdict from warning/critical ops events in the window. Pure:
// >=1 critical → "down", else >=3 warnings → "degraded", else "healthy".
export function summarizeVendorHealth(events: readonly OpsEventLite[]): VendorHealth[] {
  const byVendor = new Map<string, { warnings: number; criticals: number }>();
  for (const e of events) {
    if (e.severity !== "warning" && e.severity !== "critical") continue;
    const vendor = vendorOf(e);
    if (!vendor) continue;
    const agg = byVendor.get(vendor) ?? { warnings: 0, criticals: 0 };
    if (e.severity === "critical") agg.criticals++;
    else agg.warnings++;
    byVendor.set(vendor, agg);
  }
  return [...byVendor.entries()]
    .map(([vendor, { warnings, criticals }]) => ({
      vendor,
      warnings,
      criticals,
      verdict: (criticals > 0 ? "down" : warnings >= 3 ? "degraded" : "healthy") as VendorHealth["verdict"],
    }))
    .sort((a, b) => (b.criticals - a.criticals) || (b.warnings - a.warnings));
}

// ── The assembled memo ───────────────────────────────────────────────────────

export interface IntegrationsTelemetry {
  connections: readonly ConnectionRow[];
  opsEvents: readonly OpsEventLite[];
  rotationState: RotationState;
  emailDeadLetters: number;
  nowMs: number;
}

export interface IntegrationsMemo {
  summary: string;
  token_fleet: TokenFleetForecast;
  vendor_health: VendorHealth[];
  rotation: {
    overdue: RotationCalendarItem[];
    due_soon: RotationCalendarItem[];
    baseline_needed: RotationCalendarItem[];
    all: RotationCalendarItem[];
  };
  deliverability: { email_dead_letters: number };
  all_clear: boolean;
}

export function assembleIntegrationsMemo(t: IntegrationsTelemetry): IntegrationsMemo {
  const tokenFleet = computeTokenFleetForecast(t.connections, t.nowMs);
  const vendorHealth = summarizeVendorHealth(t.opsEvents);
  const calendar = computeRotationCalendar(KEY_ROTATION_REGISTRY, t.rotationState, t.nowMs);
  const overdue = calendar.filter((c) => c.status === "overdue");
  const dueSoon = calendar.filter((c) => c.status === "due_soon");
  const baselineNeeded = calendar.filter((c) => c.status === "baseline_needed");

  const degradedVendors = vendorHealth.filter((v) => v.verdict !== "healthy");
  const allClear = tokenFleet.expired === 0 &&
    tokenFleet.expiring_7d === 0 &&
    tokenFleet.with_refresh_error === 0 &&
    degradedVendors.length === 0 &&
    overdue.length === 0 &&
    t.emailDeadLetters === 0;

  const parts: string[] = [];
  if (allClear) {
    parts.push("Integrations healthy: no vendor degradations, no imminent token expiries, no overdue key rotations.");
  } else {
    if (degradedVendors.length) {
      parts.push(`${degradedVendors.length} vendor(s) degraded/down (${degradedVendors.map((v) => v.vendor).join(", ")})`);
    }
    if (tokenFleet.expired) parts.push(`${tokenFleet.expired} expired token(s)`);
    if (tokenFleet.expiring_7d) parts.push(`${tokenFleet.expiring_7d} token(s) expiring within 7d`);
    if (tokenFleet.with_refresh_error) parts.push(`${tokenFleet.with_refresh_error} connection(s) with refresh errors`);
    if (overdue.length) parts.push(`${overdue.length} overdue key rotation(s)`);
    if (baselineNeeded.length) parts.push(`${baselineNeeded.length} secret(s) with no rotation baseline recorded`);
    if (t.emailDeadLetters) parts.push(`${t.emailDeadLetters} email dead-letter(s)`);
  }

  return {
    summary: parts.join("; ") + ".",
    token_fleet: tokenFleet,
    vendor_health: vendorHealth,
    rotation: { overdue, due_soon: dueSoon, baseline_needed: baselineNeeded, all: calendar },
    deliverability: { email_dead_letters: t.emailDeadLetters },
    all_clear: allClear,
  };
}
