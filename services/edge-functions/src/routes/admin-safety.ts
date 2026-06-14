import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { getSetting } from "../lib/system-settings.ts";
import {
  bustOverrideCache,
  refreshOverrideCache,
  rowToOverride,
  validateOverrideInput,
} from "../lib/rate-limit-overrides.ts";
import type {
  AbuseSignalSeverity,
  AbuseSignalStatus,
  AbuseSignalType,
} from "../lib/abuse-signals.ts";

// US-888: Trust & Safety — fraud/abuse signals console (the read/triage API).
//
// The durable counterpart to /api/admin/fraud's live aggregate: lists the
// signals the abuse-scan cron persists and moves each through its triage
// lifecycle (open -> reviewing -> actioned/dismissed). ACTIONS that change a
// user/grade (suspend, void/refund a grade) are NOT re-implemented here — the
// SPA reuses the existing audited endpoints (POST /api/admin/users/:id/suspend,
// POST /api/admin/moderation/:submissionId/reject); this router only owns the
// signal's own triage state. Marking a signal actioned/dismissed is audited;
// no destructive cross-account write happens from this router, so only the
// triage PATCH is here and the heavy actions keep their existing step-up.
//
// Mounted at /api/admin/safety, inheriting authMiddleware + adminAuthMiddleware
// (admin JWT + AAL2) from the /api/admin/* group in main.ts. Reads cross-tenant
// by design (the legitimate admin use of the service-role client) and exposes
// only the collision FACT + ids + lightweight user labels — never image bytes.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminSafetyRoutes = new Hono<AdminEnv>();

const SIGNAL_TYPES = new Set<AbuseSignalType>([
  "phash_collision",
  "submission_velocity",
  "shared_payment",
  "disposable_email",
]);
const SEVERITIES = new Set<AbuseSignalSeverity>(["low", "medium", "high", "critical"]);
const STATUSES = new Set<AbuseSignalStatus>(["open", "reviewing", "actioned", "dismissed"]);

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

interface SignalRow {
  id: string;
  signal_type: AbuseSignalType;
  severity: AbuseSignalSeverity;
  status: AbuseSignalStatus;
  subject_user_id: string;
  dedupe_key: string;
  evidence: Record<string, unknown> | null;
  resolved_by: string | null;
  resolution_reason: string | null;
  resolved_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

interface UserLite {
  userId: string;
  email: string | null;
  fullName: string | null;
  plan: string | null;
  suspended: boolean;
}

// Resolve the subject + any counterpart users a page of signals references, so
// each row links to a real account. Cross-tenant by design (admin view).
async function loadUsers(ids: string[]): Promise<Map<string, UserLite>> {
  const map = new Map<string, UserLite>();
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return map;
  const { data } = await supabaseAdmin
    .from("users")
    .select("id, email, full_name, plan, suspended")
    .in("id", unique);
  for (const u of (data ?? []) as Array<{
    id: string;
    email: string | null;
    full_name: string | null;
    plan: string | null;
    suspended: boolean | null;
  }>) {
    map.set(u.id, {
      userId: u.id,
      email: u.email,
      fullName: u.full_name,
      plan: u.plan,
      suspended: !!u.suspended,
    });
  }
  return map;
}

function counterpartId(row: SignalRow): string | null {
  const cp = row.evidence?.counterpart_user_id;
  return typeof cp === "string" ? cp : null;
}

// Shape a signal for the console. Passes the evidence through untouched (the
// scan only ever writes ids + hashes + counts there — never image bytes) plus
// decorated subject/counterpart user labels.
function serialize(row: SignalRow, users: Map<string, UserLite>) {
  const cpId = counterpartId(row);
  return {
    id: row.id,
    signalType: row.signal_type,
    severity: row.severity,
    status: row.status,
    subjectUserId: row.subject_user_id,
    subject: users.get(row.subject_user_id) ?? null,
    counterpart: cpId ? users.get(cpId) ?? null : null,
    evidence: row.evidence ?? {},
    resolvedBy: row.resolved_by,
    resolutionReason: row.resolution_reason,
    resolvedAt: row.resolved_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /signals — filterable by type/severity/status, server-side paginated.
adminSafetyRoutes.get("/signals", async (c: Context<AdminEnv>) => {
  const url = new URL(c.req.url);
  const type = url.searchParams.get("type");
  const severity = url.searchParams.get("severity");
  // Default to the actionable queue; pass status=all to see everything.
  const statusParam = url.searchParams.get("status") ?? "open";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number(url.searchParams.get("page_size") ?? String(DEFAULT_PAGE_SIZE)) || DEFAULT_PAGE_SIZE),
  );

  let q = supabaseAdmin
    .from("abuse_signals")
    .select("*", { count: "exact" });

  if (type) {
    if (!SIGNAL_TYPES.has(type as AbuseSignalType)) {
      return c.json({ error: "Invalid type filter" }, 400);
    }
    q = q.eq("signal_type", type);
  }
  if (severity) {
    if (!SEVERITIES.has(severity as AbuseSignalSeverity)) {
      return c.json({ error: "Invalid severity filter" }, 400);
    }
    q = q.eq("severity", severity);
  }
  if (statusParam !== "all") {
    if (!STATUSES.has(statusParam as AbuseSignalStatus)) {
      return c.json({ error: "Invalid status filter" }, 400);
    }
    q = q.eq("status", statusParam);
  }

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const { data, count, error } = await q
    .order("last_seen_at", { ascending: false })
    .range(from, to);
  if (error) return c.json({ error: error.message }, 500);

  const rows = (data ?? []) as SignalRow[];
  const userIds = [
    ...rows.map((r) => r.subject_user_id),
    ...rows.map((r) => counterpartId(r)).filter((id): id is string => !!id),
  ];
  const users = await loadUsers(userIds);

  const total = count ?? rows.length;
  return c.json({
    signals: rows.map((r) => serialize(r, users)),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

// GET /signals/:id — one signal for the detail drawer.
adminSafetyRoutes.get("/signals/:id", async (c: Context<AdminEnv>) => {
  const id = c.req.param("id");
  const { data, error } = await supabaseAdmin
    .from("abuse_signals")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "Signal not found" }, 404);
  const row = data as SignalRow;
  const ids = [row.subject_user_id, counterpartId(row)].filter((x): x is string => !!x);
  const users = await loadUsers(ids);
  return c.json({ signal: serialize(row, users) });
});

interface StatusBody {
  status?: unknown;
  reason?: unknown;
}

// PATCH /signals/:id — move a signal through its triage lifecycle.
//   reviewing                  — claim it; any admin.
//   actioned | dismissed       — resolve it; a reason is required for an audit
//                                trail (esp. a dismissal). Resolving is a
//                                super_admin + step-up action: it closes a fraud
//                                concern, so it carries the same bar as the
//                                destructive actions it stands in for.
//   open                       — reopen a resolved signal; super_admin + step-up.
adminSafetyRoutes.patch("/signals/:id", async (c: Context<AdminEnv>) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as StatusBody;
  const status = body.status;
  if (typeof status !== "string" || !STATUSES.has(status as AbuseSignalStatus)) {
    return c.json({ error: "`status` must be one of open|reviewing|actioned|dismissed" }, 400);
  }
  const resolving = status === "actioned" || status === "dismissed" || status === "open";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  if ((status === "actioned" || status === "dismissed") && !reason) {
    return c.json({ error: "A reason is required when resolving a signal." }, 400);
  }

  // Resolving / reopening closes or re-opens a fraud concern — gate it like the
  // destructive moderation actions it represents.
  if (resolving) {
    const stepUp = requireStepUp(c);
    if (stepUp) return stepUp;
  }

  const { data: existing, error: loadErr } = await supabaseAdmin
    .from("abuse_signals")
    .select("id, status, resolution_reason")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) return c.json({ error: loadErr.message }, 500);
  if (!existing) return c.json({ error: "Signal not found" }, 404);
  const prev = existing as { status: AbuseSignalStatus; resolution_reason: string | null };

  const actorId = c.get("userId");
  const nowIso = new Date().toISOString();
  const isResolvedState = status === "actioned" || status === "dismissed";
  const patch: Record<string, unknown> = {
    status,
    resolution_reason: isResolvedState ? reason : null,
    resolved_by: isResolvedState ? actorId : null,
    resolved_at: isResolvedState ? nowIso : null,
  };

  const { error: updErr } = await supabaseAdmin
    .from("abuse_signals")
    .update(patch)
    .eq("id", id);
  if (updErr) return c.json({ error: updErr.message }, 500);

  await writeAuditLog(c, {
    action: "admin.abuse_signal_status",
    targetType: "abuse_signal",
    targetId: id,
    details: { reason: reason || null },
    before: { status: prev.status, resolution_reason: prev.resolution_reason },
    after: { status },
  });

  return c.json({ ok: true, status });
});

// ──────────────────────────────────────────────────────────────────────────
// US-890: rate-limit administration & temporary throttles.
//
// Inspect the distributed rate-limit counters (US-265 rate_limit_counters) per
// user, see the noisiest callers, and set/clear a TEMPORARY per-user override
// (throttle/boost/block) that the edge limiter honors at request time. Writes are
// super_admin + MFA step-up gated and audited; the override auto-expires and is
// ignored at read time (no cleanup job). Caps/defaults come from the system
// settings registry (US-884).
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_NOISY_LIMIT = 20;
const MAX_NOISY_LIMIT = 100;
const DEFAULT_WINDOW_MINUTES = 5;
const MAX_WINDOW_MINUTES = 60;
const NOISY_SCAN_ROWS = 1000;

interface CounterRow {
  bucket_key: string;
  window_start: string;
  count: number;
}

interface OverrideRowDb {
  subject_user_id: string;
  mode: "multiplier" | "cap" | "block";
  multiplier: number | null;
  cap: number | null;
  reason: string;
  expires_at: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// "<scope>|<subject>" → its two parts. The subject is "user:<uuid>", "ip:<addr>"
// or "apikey:<id>"; only user subjects carry an override.
function parseBucket(bucketKey: string): { scope: string; subject: string } {
  const i = bucketKey.indexOf("|");
  if (i < 0) return { scope: bucketKey, subject: "" };
  return { scope: bucketKey.slice(0, i), subject: bucketKey.slice(i + 1) };
}

function subjectUserId(subject: string): string | null {
  return subject.startsWith("user:") ? subject.slice("user:".length) : null;
}

function clampInt(raw: string | null, def: number, max: number): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

async function loadActiveOverride(userId: string) {
  const { data } = await supabaseAdmin
    .from("rate_limit_overrides")
    .select(
      "subject_user_id, mode, multiplier, cap, reason, expires_at, created_by, created_at, updated_at",
    )
    .eq("subject_user_id", userId)
    // AC3: an expired row is ignored at read time (no cleanup job).
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  return data ? rowToOverride(data as OverrideRowDb) : null;
}

async function loadBounds() {
  const [maxMultiplier, maxDurationMinutes, gradeDefault] = await Promise.all([
    getSetting<number>("rate_limit_override_max_multiplier", 20),
    getSetting<number>("rate_limit_override_max_duration_minutes", 10080),
    getSetting<number>("rate_limit_grade_per_min", 60),
  ]);
  return { maxMultiplier, maxDurationMinutes, gradeDefaultPerMin: gradeDefault };
}

// GET /rate-limits — the noisiest callers in the recent window + every active
// override, for the Trust & Safety overview.
adminSafetyRoutes.get("/rate-limits", async (c: Context<AdminEnv>) => {
  const url = new URL(c.req.url);
  const limit = clampInt(url.searchParams.get("limit"), DEFAULT_NOISY_LIMIT, MAX_NOISY_LIMIT);
  const windowMinutes = clampInt(
    url.searchParams.get("window_minutes"),
    DEFAULT_WINDOW_MINUTES,
    MAX_WINDOW_MINUTES,
  );
  const sinceIso = new Date(Date.now() - windowMinutes * 60_000).toISOString();

  const { data: counterData, error: counterErr } = await supabaseAdmin
    .from("rate_limit_counters")
    .select("bucket_key, window_start, count")
    .gte("window_start", sinceIso)
    .order("count", { ascending: false })
    .limit(NOISY_SCAN_ROWS);
  if (counterErr) return c.json({ error: counterErr.message }, 500);

  // Aggregate per subject across scopes in the window: total requests + the
  // single hottest scope.
  interface Agg {
    subject: string;
    total: number;
    topScope: string;
    topScopeCount: number;
    scopes: number;
  }
  const bySubject = new Map<string, Agg>();
  for (const row of (counterData ?? []) as CounterRow[]) {
    const { scope, subject } = parseBucket(row.bucket_key);
    if (!subject) continue;
    const agg = bySubject.get(subject) ?? {
      subject,
      total: 0,
      topScope: scope,
      topScopeCount: 0,
      scopes: 0,
    };
    agg.total += row.count;
    agg.scopes += 1;
    if (row.count > agg.topScopeCount) {
      agg.topScope = scope;
      agg.topScopeCount = row.count;
    }
    bySubject.set(subject, agg);
  }
  const ranked = [...bySubject.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);

  // Active overrides (cross-tenant by design — an admin view).
  const { data: ovData, error: ovErr } = await supabaseAdmin
    .from("rate_limit_overrides")
    .select(
      "subject_user_id, mode, multiplier, cap, reason, expires_at, created_by, created_at, updated_at",
    )
    .gt("expires_at", new Date().toISOString())
    .order("expires_at", { ascending: true });
  if (ovErr) return c.json({ error: ovErr.message }, 500);
  const overrides = ((ovData ?? []) as OverrideRowDb[]).map(rowToOverride);

  // Decorate every user subject (noisy callers + override subjects) with a label.
  const userIds = [
    ...ranked.map((r) => subjectUserId(r.subject)).filter((x): x is string => !!x),
    ...overrides.map((o) => o.subjectUserId),
  ];
  const users = await loadUsers(userIds);

  return c.json({
    windowMinutes,
    callers: ranked.map((r) => {
      const uid = subjectUserId(r.subject);
      return {
        subject: r.subject,
        userId: uid,
        user: uid ? users.get(uid) ?? null : null,
        totalRequests: r.total,
        scopes: r.scopes,
        topScope: r.topScope,
        topScopeCount: r.topScopeCount,
      };
    }),
    overrides: overrides.map((o) => ({
      ...o,
      user: users.get(o.subjectUserId) ?? null,
    })),
  });
});

// GET /rate-limits/:userId — one user's current counters + active override +
// the registry-driven defaults/bounds the override editor needs.
adminSafetyRoutes.get("/rate-limits/:userId", async (c: Context<AdminEnv>) => {
  const userId = c.req.param("userId");
  const url = new URL(c.req.url);
  const windowMinutes = clampInt(
    url.searchParams.get("window_minutes"),
    DEFAULT_WINDOW_MINUTES,
    MAX_WINDOW_MINUTES,
  );
  const sinceIso = new Date(Date.now() - windowMinutes * 60_000).toISOString();

  const [counterRes, override, users, bounds] = await Promise.all([
    supabaseAdmin
      .from("rate_limit_counters")
      .select("bucket_key, window_start, count")
      // Match this user's subject suffix across every scope. `|` and `:` are
      // literals in LIKE; the leading % matches any scope prefix.
      .like("bucket_key", `%|user:${userId}`)
      .gte("window_start", sinceIso)
      .order("count", { ascending: false }),
    loadActiveOverride(userId),
    loadUsers([userId]),
    loadBounds(),
  ]);
  if (counterRes.error) return c.json({ error: counterRes.error.message }, 500);

  const counters = ((counterRes.data ?? []) as CounterRow[]).map((row) => ({
    scope: parseBucket(row.bucket_key).scope,
    count: row.count,
    windowStart: row.window_start,
  }));

  return c.json({
    userId,
    user: users.get(userId) ?? null,
    windowMinutes,
    counters,
    override: override
      ? { ...override, user: users.get(userId) ?? null }
      : null,
    bounds,
  });
});

interface OverrideBody {
  mode?: unknown;
  multiplier?: unknown;
  cap?: unknown;
  expiresInMinutes?: unknown;
  reason?: unknown;
}

// POST /rate-limits/:userId/override — set/replace a temporary override. A
// throttle/boost/block changes how aggressively a real account is limited, so it
// carries the same bar as the destructive safety actions: super_admin + a fresh
// MFA step-up, audited. The new override is upserted (one active per user) and the
// limiter's cache is busted + warmed so it takes effect immediately.
adminSafetyRoutes.post("/rate-limits/:userId/override", async (c: Context<AdminEnv>) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const userId = c.req.param("userId");
  const body = (await c.req.json().catch(() => ({}))) as OverrideBody;

  const bounds = await loadBounds();
  const parsed = validateOverrideInput(body, bounds, Date.now());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  // Confirm the subject is a real account before writing an enforcement record.
  const { data: subjectUser, error: userErr } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  if (userErr) return c.json({ error: userErr.message }, 500);
  if (!subjectUser) return c.json({ error: "User not found" }, 404);

  const before = await loadActiveOverride(userId);

  const { error: upErr } = await supabaseAdmin
    .from("rate_limit_overrides")
    .upsert(
      {
        subject_user_id: userId,
        mode: parsed.value.mode,
        multiplier: parsed.value.multiplier,
        cap: parsed.value.cap,
        reason: parsed.value.reason,
        expires_at: parsed.value.expiresAt,
        created_by: c.get("userId"),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "subject_user_id" },
    );
  if (upErr) return c.json({ error: upErr.message }, 500);

  // Land the override on the very next request (this replica) and bound cross-
  // replica propagation to the cache TTL.
  bustOverrideCache();
  await refreshOverrideCache();

  await writeAuditLog(c, {
    action: "admin.rate_limit_override_set",
    targetType: "user",
    targetId: userId,
    details: {
      mode: parsed.value.mode,
      multiplier: parsed.value.multiplier,
      cap: parsed.value.cap,
      reason: parsed.value.reason,
      expires_at: parsed.value.expiresAt,
    },
    before: before
      ? { mode: before.mode, multiplier: before.multiplier, cap: before.cap, expires_at: before.expiresAt }
      : null,
    after: { mode: parsed.value.mode, multiplier: parsed.value.multiplier, cap: parsed.value.cap, expires_at: parsed.value.expiresAt },
  });

  return c.json({ ok: true, override: await loadActiveOverride(userId) });
});

// DELETE /rate-limits/:userId/override — lift an override early. Same super_admin
// + step-up bar (lifting a throttle/block is itself a sensitive change), audited.
adminSafetyRoutes.delete("/rate-limits/:userId/override", async (c: Context<AdminEnv>) => {
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const userId = c.req.param("userId");
  const before = await loadActiveOverride(userId);

  const { error: delErr } = await supabaseAdmin
    .from("rate_limit_overrides")
    .delete()
    .eq("subject_user_id", userId);
  if (delErr) return c.json({ error: delErr.message }, 500);

  bustOverrideCache();
  await refreshOverrideCache();

  await writeAuditLog(c, {
    action: "admin.rate_limit_override_clear",
    targetType: "user",
    targetId: userId,
    before: before
      ? { mode: before.mode, multiplier: before.multiplier, cap: before.cap, expires_at: before.expiresAt }
      : null,
    after: null,
  });

  return c.json({ ok: true });
});
