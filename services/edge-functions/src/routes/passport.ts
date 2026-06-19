import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  generateClaimToken,
  hashClaimToken,
  isPseudonymousLabel,
} from "../lib/garment-passport.ts";
import { transferToNewBuyer, userIdFromBearer } from "../lib/passport-transfer.ts";
import {
  generateTagCode,
  isValidTagCode,
  normalizeTagCode,
  tagScanUrl,
} from "../lib/passport-tag.ts";

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

// US-1094: ownership-claim tokens are valid for 30 days from mint.
const CLAIM_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Public site origin (no trailing slash) for building claim links. */
function publicSiteUrl(): string {
  return (Deno.env.get("PUBLIC_SITE_URL")?.trim() || "https://gradethread.com").replace(/\/$/, "");
}

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

// POST /garments/:id/claim-token — authed, tenant-scoped. Mint a single-use,
// time-bounded claim token for a (sold) garment so its buyer can take over the
// passport. The RAW token is returned exactly once; only its hash is stored.
passportRoutes.post("/garments/:id/claim-token", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const garmentId = c.req.param("id");
  if (!garmentId) return c.json({ error: "garment id is required" }, 400);

  // US-268: verify the garment belongs to this workspace owner BEFORE minting.
  const { data: garment, error: gErr } = await supabaseAdmin
    .from("garments")
    .select("id")
    .eq("id", garmentId)
    .eq("created_by", ownerId)
    .maybeSingle();
  if (gErr) {
    console.error("[passport] claim-token ownership lookup failed:", gErr.message);
    return c.json({ error: "Lookup failed" }, 500);
  }
  if (!garment) return c.json({ error: "Garment not found" }, 404);

  const token = generateClaimToken();
  const tokenHash = await hashClaimToken(token);
  const expiresAt = new Date(Date.now() + CLAIM_TOKEN_TTL_MS).toISOString();

  const { error: insErr } = await supabaseAdmin.from("passport_claim_tokens").insert({
    garment_id: garmentId,
    token_hash: tokenHash,
    created_by: ownerId,
    expires_at: expiresAt,
  });
  if (insErr) {
    console.error("[passport] claim-token insert failed:", insErr.message);
    return c.json({ error: "Failed to create claim token" }, 500);
  }

  // The raw token is shown ONCE — it is not recoverable from the stored hash.
  return c.json(
    { token, claim_url: `${publicSiteUrl()}/claim/${token}`, expires_at: expiresAt },
    201,
  );
});

// POST /claim — ANONYMOUS (not under /garments/*, so no auth middleware). Redeem
// a claim token: transfer the passport to a new pseudonymous buyer node and
// append a deterministic ownership_transfer event. No account required; if a
// valid bearer token is present the buyer node is linked to that account (a uuid
// linkage only — never any PII). Single-use + time-bounded + replay-guarded.
passportRoutes.post("/claim", async (c) => {
  let body: { token?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return c.json({ error: "token is required" }, 400);

  const tokenHash = await hashClaimToken(token);
  const nowIso = new Date().toISOString();

  // Atomic single-use claim: the UPDATE succeeds only if the token is still
  // unclaimed AND unexpired. A replay / concurrent double-claim loses this race
  // (claimed_at is already set) and matches no row → rejected below. This is the
  // core replay guard (US-1094 AC#3).
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from("passport_claim_tokens")
    .update({ claimed_at: nowIso })
    .eq("token_hash", tokenHash)
    .is("claimed_at", null)
    .gt("expires_at", nowIso)
    .select("id, garment_id")
    .maybeSingle();
  if (claimErr) {
    console.error("[passport] claim update failed:", claimErr.message);
    return c.json({ error: "Claim failed" }, 500);
  }
  if (!claimed) {
    // Invalid / expired / already-used — deliberately indistinguishable so a
    // caller can't probe which tokens exist.
    return c.json({ error: "This claim link is invalid, expired, or already used." }, 410);
  }
  const garmentId = (claimed as { id: string; garment_id: string }).garment_id;
  const tokenId = (claimed as { id: string }).id;

  // Optional account association (no PII — just the auth user's uuid).
  const linkedUserId = await userIdFromBearer(c.req.header("Authorization"));

  // Shared deterministic transfer: new pseudonymous buyer node +
  // ownership_transfer event + current-owner move.
  const transfer = await transferToNewBuyer(garmentId, { linkedUserId, source: "claim" });
  if (!transfer) return c.json({ error: "Claim failed" }, 500);

  // Audit: record which node redeemed the token (best-effort).
  await supabaseAdmin
    .from("passport_claim_tokens")
    .update({ claimed_by_node_id: transfer.nodeId })
    .eq("id", tokenId)
    .then(() => {}, () => {});

  return c.json({ ok: true, passport_slug: transfer.slug }, 200);
});

// ── Physical tags (US-1096, Layer 2) ─────────────────────────────────────────

// POST /garments/:id/tags — authed, tenant-scoped. Issue a printable QR + short
// code bound to the garment's passport. Re-issuable (call again for a fresh
// code); pass { revoke_existing: true } to revoke prior tags (lost-tag reissue).
passportRoutes.post("/garments/:id/tags", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const garmentId = c.req.param("id");
  if (!garmentId) return c.json({ error: "garment id is required" }, 400);

  let body: { revoke_existing?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    /* body is optional */
  }

  // US-268: verify the garment belongs to this workspace owner BEFORE issuing.
  const { data: garment, error: gErr } = await supabaseAdmin
    .from("garments")
    .select("id, public_passport_slug")
    .eq("id", garmentId)
    .eq("created_by", ownerId)
    .maybeSingle();
  if (gErr) {
    console.error("[passport] tag issue ownership lookup failed:", gErr.message);
    return c.json({ error: "Lookup failed" }, 500);
  }
  if (!garment) return c.json({ error: "Garment not found" }, 404);
  const slug = (garment as { public_passport_slug: string }).public_passport_slug;

  if (body.revoke_existing === true) {
    await supabaseAdmin
      .from("passport_tags")
      .update({ revoked_at: new Date().toISOString() })
      .eq("garment_id", garmentId)
      .eq("created_by", ownerId)
      .is("revoked_at", null)
      .then(() => {}, () => {});
  }

  // Generate a unique code (retry on the rare unique-constraint collision).
  let tagId: string | null = null;
  let displayCode = "";
  let storedCode = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    displayCode = generateTagCode();
    storedCode = normalizeTagCode(displayCode);
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("passport_tags")
      .insert({ garment_id: garmentId, short_code: storedCode, created_by: ownerId })
      .select("id")
      .maybeSingle();
    if (!insErr && inserted) {
      tagId = (inserted as { id: string }).id;
      break;
    }
    // 23505 = unique_violation → retry with a fresh code; other errors abort.
    if (insErr && insErr.code !== "23505") {
      console.error("[passport] tag insert failed:", insErr.message);
      return c.json({ error: "Failed to issue tag" }, 500);
    }
  }
  if (!tagId) return c.json({ error: "Failed to issue tag" }, 500);

  return c.json(
    {
      tag_id: tagId,
      short_code: displayCode,
      scan_url: tagScanUrl(publicSiteUrl(), storedCode),
      passport_slug: slug,
    },
    201,
  );
});

// POST /garments/:id/tags/:tagId/revoke — authed, tenant-scoped. Revoke a (lost)
// tag so its code no longer resolves; issue a fresh one via POST .../tags.
passportRoutes.post("/garments/:id/tags/:tagId/revoke", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const garmentId = c.req.param("id");
  const tagId = c.req.param("tagId");
  if (!garmentId || !tagId) return c.json({ error: "garment id and tag id are required" }, 400);

  const { data: revoked, error } = await supabaseAdmin
    .from("passport_tags")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", tagId)
    .eq("garment_id", garmentId)
    .eq("created_by", ownerId)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[passport] tag revoke failed:", error.message);
    return c.json({ error: "Revoke failed" }, 500);
  }
  if (!revoked) return c.json({ error: "Tag not found" }, 404);
  return c.json({ ok: true }, 200);
});

// GET /tag/:code — PUBLIC, rate-limited. Resolve a scanned tag to its passport
// slug (so the scan can open the public timeline). Revoked/invalid → 404.
passportRoutes.get("/tag/:code", async (c) => {
  const code = normalizeTagCode(c.req.param("code") ?? "");
  if (!isValidTagCode(code)) return c.json({ error: "Tag not found" }, 404);

  const { data: tag } = await supabaseAdmin
    .from("passport_tags")
    .select("garment_id")
    .eq("short_code", code)
    .is("revoked_at", null)
    .maybeSingle();
  if (!tag) return c.json({ error: "Tag not found" }, 404);

  const { data: g } = await supabaseAdmin
    .from("garments")
    .select("public_passport_slug, status")
    .eq("id", (tag as { garment_id: string }).garment_id)
    .maybeSingle();
  if (!g) return c.json({ error: "Tag not found" }, 404);
  const garment = g as { public_passport_slug: string; status: string };

  return c.json({ passport_slug: garment.public_passport_slug, status: garment.status });
});

// POST /tag/:code/claim — PUBLIC, rate-limited. Scan-to-claim: the physical tag
// is the bearer credential, so whoever holds it can take over the chain
// (deterministic Layer-1 handoff). Revoked/invalid → 404.
passportRoutes.post("/tag/:code/claim", async (c) => {
  const code = normalizeTagCode(c.req.param("code") ?? "");
  if (!isValidTagCode(code)) return c.json({ error: "Tag not found" }, 404);

  const { data: tag } = await supabaseAdmin
    .from("passport_tags")
    .select("garment_id")
    .eq("short_code", code)
    .is("revoked_at", null)
    .maybeSingle();
  if (!tag) {
    return c.json({ error: "This tag is invalid or has been revoked." }, 404);
  }

  const linkedUserId = await userIdFromBearer(c.req.header("Authorization"));
  const transfer = await transferToNewBuyer(
    (tag as { garment_id: string }).garment_id,
    { linkedUserId, source: "tag-claim" },
  );
  if (!transfer) return c.json({ error: "Claim failed" }, 500);

  return c.json({ ok: true, passport_slug: transfer.slug }, 200);
});
