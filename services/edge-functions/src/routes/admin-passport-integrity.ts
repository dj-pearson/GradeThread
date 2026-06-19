import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { runPassportIntegrityScan } from "./jobs-passport-integrity-scan.ts";
import type {
  IntegritySeverity,
  IntegrityStatus,
  PassportIntegrityType,
} from "../lib/passport-integrity.ts";

// US-1103: Garment Passport — admin integrity & fraud signals console.
//
// The durable, triageable counterpart to the passport-integrity-scan cron: lists
// the anomalies it persists (wear reversal, duplicate fingerprint across owners,
// rapid re-claim, token replay) and moves each through open -> reviewing ->
// actioned/dismissed. Admin actions (AC2): FLAG (status), ANNOTATE (notes), and
// SEVER a probable link (mark a fraudulent garment_event severed — dropping it
// from the public passport timeline + chain). Every state change is audited.
//
// Mounted at /api/admin/passport-integrity, inheriting authMiddleware +
// adminAuthMiddleware (admin JWT + AAL2) from the /api/admin/* group in main.ts.
// Reads cross-tenant by design (the legitimate admin use of the service-role
// client) and exposes only the anomaly FACT + ids + pseudonymous labels — never
// image bytes or PII. Resolving/severing additionally requires a fresh MFA
// step-up, matching the abuse-signal console's bar.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminPassportIntegrityRoutes = new Hono<AdminEnv>();

const SIGNAL_TYPES = new Set<PassportIntegrityType>([
  "wear_reversal",
  "duplicate_fingerprint",
  "rapid_reclaim",
  "token_replay",
]);
const SEVERITIES = new Set<IntegritySeverity>(["low", "medium", "high", "critical"]);
const STATUSES = new Set<IntegrityStatus>(["open", "reviewing", "actioned", "dismissed"]);

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_NOTE_LEN = 2000;

interface SignalRow {
  id: string;
  signal_type: PassportIntegrityType;
  severity: IntegritySeverity;
  status: IntegrityStatus;
  garment_id: string;
  dedupe_key: string;
  evidence: Record<string, unknown> | null;
  notes: Array<{ by: string; at: string; text: string }> | null;
  resolved_by: string | null;
  resolution_reason: string | null;
  resolved_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

interface GarmentLite {
  garmentId: string;
  slug: string | null;
  skuClass: Record<string, unknown>;
  status: string;
}

// Resolve the garments a page of signals references (subject + any counterpart),
// so each row deep-links to a passport. Cross-tenant by design (admin view); we
// expose ONLY the public slug + sku-class descriptor, never created_by/PII.
async function loadGarments(ids: string[]): Promise<Map<string, GarmentLite>> {
  const map = new Map<string, GarmentLite>();
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return map;
  const { data } = await supabaseAdmin
    .from("garments")
    .select("id, public_passport_slug, sku_class, status")
    .in("id", unique);
  for (
    const g of (data ?? []) as Array<{
      id: string;
      public_passport_slug: string | null;
      sku_class: Record<string, unknown> | null;
      status: string;
    }>
  ) {
    map.set(g.id, {
      garmentId: g.id,
      slug: g.public_passport_slug,
      skuClass: g.sku_class ?? {},
      status: g.status,
    });
  }
  return map;
}

function counterpartGarmentId(row: SignalRow): string | null {
  const cp = row.evidence?.counterpart_garment_id;
  return typeof cp === "string" ? cp : null;
}

// Shape a signal for the console. evidence passes through untouched (the scan
// only ever writes ids + hashes + counts there — never image bytes or PII).
function serialize(row: SignalRow, garments: Map<string, GarmentLite>) {
  const cpId = counterpartGarmentId(row);
  return {
    id: row.id,
    signalType: row.signal_type,
    severity: row.severity,
    status: row.status,
    garmentId: row.garment_id,
    garment: garments.get(row.garment_id) ?? null,
    counterpartGarment: cpId ? garments.get(cpId) ?? null : null,
    evidence: row.evidence ?? {},
    notes: Array.isArray(row.notes) ? row.notes : [],
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
adminPassportIntegrityRoutes.get("/signals", async (c: Context<AdminEnv>) => {
  const url = new URL(c.req.url);
  const type = url.searchParams.get("type");
  const severity = url.searchParams.get("severity");
  const statusParam = url.searchParams.get("status") ?? "open"; // default queue
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number(url.searchParams.get("page_size") ?? String(DEFAULT_PAGE_SIZE)) || DEFAULT_PAGE_SIZE),
  );

  let q = supabaseAdmin
    .from("passport_integrity_signals")
    .select("*", { count: "exact" });

  if (type) {
    if (!SIGNAL_TYPES.has(type as PassportIntegrityType)) {
      return c.json({ error: "Invalid type filter" }, 400);
    }
    q = q.eq("signal_type", type);
  }
  if (severity) {
    if (!SEVERITIES.has(severity as IntegritySeverity)) {
      return c.json({ error: "Invalid severity filter" }, 400);
    }
    q = q.eq("severity", severity);
  }
  if (statusParam !== "all") {
    if (!STATUSES.has(statusParam as IntegrityStatus)) {
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
  const garmentIds = [
    ...rows.map((r) => r.garment_id),
    ...rows.map((r) => counterpartGarmentId(r)).filter((id): id is string => !!id),
  ];
  const garments = await loadGarments(garmentIds);

  const total = count ?? rows.length;
  return c.json({
    signals: rows.map((r) => serialize(r, garments)),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

// The garment's severable LINK events (probable/unknown ownership_transfer or
// listed events not already severed) — the candidates for "sever a probable link".
async function loadSeverableLinks(garmentId: string) {
  const { data } = await supabaseAdmin
    .from("garment_events")
    .select("id, event_type, confidence, source, created_at")
    .eq("garment_id", garmentId)
    .in("event_type", ["ownership_transfer", "listed"])
    .is("severed_at", null)
    .order("created_at", { ascending: true });
  return ((data ?? []) as Array<{
    id: string;
    event_type: string;
    confidence: string;
    source: string | null;
    created_at: string;
  }>).map((e) => ({
    id: e.id,
    eventType: e.event_type,
    confidence: e.confidence,
    source: e.source,
    createdAt: e.created_at,
  }));
}

// GET /signals/:id — one signal + the garment's severable links for the drawer.
adminPassportIntegrityRoutes.get("/signals/:id", async (c: Context<AdminEnv>) => {
  const id = c.req.param("id");
  const { data, error } = await supabaseAdmin
    .from("passport_integrity_signals")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "Signal not found" }, 404);
  const row = data as SignalRow;
  const ids = [row.garment_id, counterpartGarmentId(row)].filter((x): x is string => !!x);
  const [garments, links] = await Promise.all([
    loadGarments(ids),
    loadSeverableLinks(row.garment_id),
  ]);
  return c.json({ signal: serialize(row, garments), links });
});

interface StatusBody {
  status?: unknown;
  reason?: unknown;
}

// PATCH /signals/:id — move a signal through its triage lifecycle.
//   reviewing            — claim it; any admin.
//   actioned | dismissed — resolve it; a reason is required for the audit trail.
//   open                 — reopen a resolved signal.
// Resolving / reopening closes or re-opens a fraud concern → gated by a fresh MFA
// step-up, matching the abuse-signal console.
adminPassportIntegrityRoutes.patch("/signals/:id", async (c: Context<AdminEnv>) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as StatusBody;
  const status = body.status;
  if (typeof status !== "string" || !STATUSES.has(status as IntegrityStatus)) {
    return c.json({ error: "`status` must be one of open|reviewing|actioned|dismissed" }, 400);
  }
  const resolving = status === "actioned" || status === "dismissed" || status === "open";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  if ((status === "actioned" || status === "dismissed") && !reason) {
    return c.json({ error: "A reason is required when resolving a signal." }, 400);
  }
  if (resolving) {
    const stepUp = requireStepUp(c);
    if (stepUp) return stepUp;
  }

  const { data: existing, error: loadErr } = await supabaseAdmin
    .from("passport_integrity_signals")
    .select("id, status, resolution_reason")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) return c.json({ error: loadErr.message }, 500);
  if (!existing) return c.json({ error: "Signal not found" }, 404);
  const prev = existing as { status: IntegrityStatus; resolution_reason: string | null };

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
    .from("passport_integrity_signals")
    .update(patch)
    .eq("id", id);
  if (updErr) return c.json({ error: updErr.message }, 500);

  await writeAuditLog(c, {
    action: "admin.passport_integrity_status",
    targetType: "passport_integrity_signal",
    targetId: id,
    details: { reason: reason || null },
    before: { status: prev.status, resolution_reason: prev.resolution_reason },
    after: { status },
  });

  return c.json({ ok: true, status });
});

interface NoteBody {
  text?: unknown;
}

// POST /signals/:id/notes — annotate a signal (AC2). Appends an operator note;
// any admin. Audited. Notes are operator context, kept separate from the machine
// evidence and never surfaced publicly.
adminPassportIntegrityRoutes.post("/signals/:id/notes", async (c: Context<AdminEnv>) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as NoteBody;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "A note `text` is required." }, 400);
  if (text.length > MAX_NOTE_LEN) {
    return c.json({ error: `Note too long (max ${MAX_NOTE_LEN}).` }, 400);
  }

  const { data: existing, error: loadErr } = await supabaseAdmin
    .from("passport_integrity_signals")
    .select("id, notes")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) return c.json({ error: loadErr.message }, 500);
  if (!existing) return c.json({ error: "Signal not found" }, 404);

  const prev = (existing as { notes: unknown }).notes;
  const notes = Array.isArray(prev) ? prev : [];
  const note = { by: c.get("userId"), at: new Date().toISOString(), text };
  const next = [...notes, note];

  const { error: updErr } = await supabaseAdmin
    .from("passport_integrity_signals")
    .update({ notes: next })
    .eq("id", id);
  if (updErr) return c.json({ error: updErr.message }, 500);

  await writeAuditLog(c, {
    action: "admin.passport_integrity_note",
    targetType: "passport_integrity_signal",
    targetId: id,
    details: { text },
  });

  return c.json({ ok: true, note });
});

interface SeverBody {
  event_id?: unknown;
  reason?: unknown;
}

// POST /signals/:id/sever — sever a probable link (AC2). Marks a specific
// garment_event (an ownership_transfer/listed link) severed, dropping it from the
// public passport timeline + chain. The event MUST belong to the signal's garment
// (the id from the body is never trusted blindly). Severing edits the ledger an
// otherwise append-only chain, so it carries the resolve bar: super_admin + a
// fresh MFA step-up, audited.
adminPassportIntegrityRoutes.post("/signals/:id/sever", async (c: Context<AdminEnv>) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Severing a link requires super_admin." }, 403);
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as SeverBody;
  const eventId = typeof body.event_id === "string" ? body.event_id : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!eventId) return c.json({ error: "`event_id` is required." }, 400);
  if (!reason) return c.json({ error: "A reason is required to sever a link." }, 400);

  // Resolve the signal → its garment, so we can confirm the link belongs to it.
  const { data: signal, error: sigErr } = await supabaseAdmin
    .from("passport_integrity_signals")
    .select("id, garment_id")
    .eq("id", id)
    .maybeSingle();
  if (sigErr) return c.json({ error: sigErr.message }, 500);
  if (!signal) return c.json({ error: "Signal not found" }, 404);
  const garmentId = (signal as { garment_id: string }).garment_id;

  // Verify the event is a LINK on THIS garment and not already severed — the body
  // id is never trusted; a mismatched id resolves to no row → 404.
  const { data: event, error: evErr } = await supabaseAdmin
    .from("garment_events")
    .select("id, event_type, confidence, severed_at")
    .eq("id", eventId)
    .eq("garment_id", garmentId)
    .in("event_type", ["ownership_transfer", "listed"])
    .maybeSingle();
  if (evErr) return c.json({ error: evErr.message }, 500);
  if (!event) {
    return c.json({ error: "Link not found on this signal's garment." }, 404);
  }
  const ev = event as { confidence: string; severed_at: string | null };
  if (ev.severed_at) return c.json({ error: "Link already severed." }, 409);

  const { error: updErr } = await supabaseAdmin
    .from("garment_events")
    .update({
      severed_at: new Date().toISOString(),
      severed_by: c.get("userId"),
      severed_reason: reason,
    })
    .eq("id", eventId)
    .eq("garment_id", garmentId)
    .is("severed_at", null);
  if (updErr) return c.json({ error: updErr.message }, 500);

  await writeAuditLog(c, {
    action: "admin.passport_integrity_sever_link",
    targetType: "garment_event",
    targetId: eventId,
    details: { signal_id: id, garment_id: garmentId, reason, confidence: ev.confidence },
  });

  return c.json({ ok: true, severed_event_id: eventId });
});

// POST /scan — run the integrity scan on demand (super_admin). Handy for the
// console's "Run scan now" and for verifying a freshly-introduced anomaly without
// waiting for the cron. Audited.
adminPassportIntegrityRoutes.post("/scan", async (c: Context<AdminEnv>) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Running the scan requires super_admin." }, 403);
  }
  const result = await runPassportIntegrityScan();
  await writeAuditLog(c, {
    action: "admin.passport_integrity_scan",
    targetType: "passport_integrity_signal",
    targetId: null,
    details: result,
  });
  return c.json({ ok: true, ...result });
});
