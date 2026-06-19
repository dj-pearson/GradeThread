import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { isPseudonymousLabel } from "../lib/garment-passport.ts";

// Garment Passport edge API (US-1092). Mounted at /api/passport.
//
//   GET  /:slug                — PUBLIC, PII-free chain read (no auth).
//   POST /garments/:id/events  — AUTHED + tenant-scoped append (US-268).
//
// Tenancy: the append path verifies the garment belongs to the workspace owner
// (created_by) BEFORE writing — the id from the URL is never trusted. The
// service-role client bypasses RLS, so explicit scoping is mandatory (US-268).
// The public read is intentionally unscoped but exposes ONLY pseudonymous
// labels + sanitized payloads (US-1090). The ledger is append-only: events are
// inserted, never updated/deleted.

export const passportRoutes = new Hono<{
  Variables: {
    userId: string;
    workspaceOwnerId: string;
    workspaceRole: "viewer" | "member" | "listing_manager" | "admin" | "owner";
  };
}>();

// Events a user may append here. graded/sold/fingerprinted are written by their
// own pipelines (grading, sale reconciliation, fingerprint service), not here.
const APPENDABLE_EVENT_TYPES = new Set(["ownership_transfer", "listed"]);
const CONFIDENCE_VALUES = new Set(["deterministic", "probable", "unknown"]);

// Drop any payload key that could carry identity — defense-in-depth for the
// public response (US-1090 AC#2). The edge only writes PII-free payloads, but a
// public surface must never echo an id/email/handle/address even by accident.
const PII_KEY_RE = /(^|_)(id|ids|email|user|owner|handle|address|name|phone)$/i;
// Exported for unit coverage (US-1092 AC#5) — this is the AC#2 PII defense.
export function sanitizePayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (PII_KEY_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// GET /:slug — public passport chain. PII-free by construction.
passportRoutes.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "slug is required" }, 400);

  const { data: garment, error: gErr } = await supabaseAdmin
    .from("garments")
    .select("id, public_passport_slug, sku_class, status, created_at")
    .eq("public_passport_slug", slug)
    .maybeSingle();
  if (gErr) {
    console.error("[passport] garment lookup failed:", gErr.message);
    return c.json({ error: "Lookup failed" }, 500);
  }
  if (!garment) return c.json({ error: "Passport not found" }, 404);
  const g = garment as {
    id: string;
    public_passport_slug: string;
    sku_class: unknown;
    status: string;
    created_at: string;
  };

  const { data: eventRows } = await supabaseAdmin
    .from("garment_events")
    .select("event_type, confidence, source, payload, created_at, actor_node_id")
    .eq("garment_id", g.id)
    .order("created_at", { ascending: true });
  const rows = (eventRows ?? []) as Array<{
    event_type: string;
    confidence: string;
    source: string | null;
    payload: unknown;
    created_at: string;
    actor_node_id: string | null;
  }>;

  // Resolve actor nodes → pseudonymous labels ONLY (never ids / linked_user_id).
  const nodeIds = [...new Set(rows.map((r) => r.actor_node_id).filter((x): x is string => !!x))];
  const labelByNode = new Map<string, string>();
  if (nodeIds.length > 0) {
    const { data: nodes } = await supabaseAdmin
      .from("owner_nodes")
      .select("id, pseudonymous_label")
      .in("id", nodeIds);
    for (const n of (nodes ?? []) as Array<{ id: string; pseudonymous_label: string }>) {
      labelByNode.set(
        n.id,
        isPseudonymousLabel(n.pseudonymous_label) ? n.pseudonymous_label : "Unknown",
      );
    }
  }

  return c.json({
    slug: g.public_passport_slug,
    sku_class: g.sku_class ?? {},
    status: g.status,
    created_at: g.created_at,
    events: rows.map((r) => ({
      event_type: r.event_type,
      confidence: r.confidence,
      actor: r.actor_node_id ? (labelByNode.get(r.actor_node_id) ?? "Unknown") : null,
      source: r.source,
      payload: sanitizePayload(r.payload),
      created_at: r.created_at,
    })),
  });
});

// POST /garments/:id/events — authed, tenant-scoped, append-only.
passportRoutes.post("/garments/:id/events", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const garmentId = c.req.param("id");
  if (!garmentId) return c.json({ error: "garment id is required" }, 400);

  let body: {
    event_type?: unknown;
    payload?: unknown;
    confidence?: unknown;
    source?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const eventType = typeof body.event_type === "string" ? body.event_type : "";
  if (!APPENDABLE_EVENT_TYPES.has(eventType)) {
    return c.json(
      { error: `event_type must be one of: ${[...APPENDABLE_EVENT_TYPES].join(", ")}` },
      400,
    );
  }
  const confidence = typeof body.confidence === "string" && CONFIDENCE_VALUES.has(body.confidence)
    ? body.confidence
    : "deterministic";
  const source = typeof body.source === "string" ? body.source.slice(0, 200) : "passport-api";
  const payload = sanitizePayload(body.payload);

  // US-268: verify the garment belongs to this workspace owner BEFORE writing.
  // The URL id is never trusted — a non-owned id resolves to no row → 404.
  const { data: garment, error: gErr } = await supabaseAdmin
    .from("garments")
    .select("id, current_owner_node_id")
    .eq("id", garmentId)
    .eq("created_by", ownerId)
    .maybeSingle();
  if (gErr) {
    console.error("[passport] ownership lookup failed:", gErr.message);
    return c.json({ error: "Lookup failed" }, 500);
  }
  if (!garment) return c.json({ error: "Garment not found" }, 404);
  const g = garment as { id: string; current_owner_node_id: string | null };

  // Append-only insert. The actor is the garment's current owner node (the
  // acting party); actor ids from the body are deliberately NOT accepted.
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("garment_events")
    .insert({
      garment_id: g.id,
      event_type: eventType,
      actor_node_id: g.current_owner_node_id,
      payload,
      confidence,
      source,
    })
    .select("id, event_type, confidence, source, created_at")
    .single();
  if (insErr || !inserted) {
    console.error("[passport] event append failed:", insErr?.message);
    return c.json({ error: "Failed to append event" }, 500);
  }

  return c.json({ ok: true, event: inserted }, 201);
});
