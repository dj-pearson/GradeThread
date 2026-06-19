import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { effectiveRevealedIdentity } from "../lib/garment-passport.ts";

// Garment Passport — opt-in identity reveal management (US-1105). The caller
// manages reveal consent on their OWN passport hops (the owner_nodes linked to
// their account when they claimed/were-sold a garment). Mounted behind
// authMiddleware (NOT workspaceMiddleware) in main.ts, so c.var.userId is the
// individual account — these nodes belong to the person, not a workspace tenant.
//
// PRIVACY (US-1090): the default is fully pseudonymous. A reveal only ever
// surfaces the user's OWN already-public Verified handle, is OFF by default,
// reversible, and PER-HOP. Every write is scoped to `linked_user_id = userId`
// (US-268) — a caller can never reveal or read another account's nodes.

type IdentityEnv = { Variables: { userId: string } };

export const passportIdentityRoutes = new Hono<IdentityEnv>();

// Cap the listing so a prolific reseller's request stays bounded.
const NODE_LIST_LIMIT = 200;

/** The caller's current public Verified profile (the only thing a reveal shows). */
async function loadVerified(userId: string): Promise<{
  verified_enabled: boolean;
  verified_handle: string | null;
  verified_display_name: string | null;
}> {
  const { data } = await supabaseAdmin
    .from("users")
    .select("verified_enabled, verified_handle, verified_display_name")
    .eq("id", userId)
    .maybeSingle();
  const u = data as
    | {
      verified_enabled: boolean | null;
      verified_handle: string | null;
      verified_display_name: string | null;
    }
    | null;
  return {
    verified_enabled: !!u?.verified_enabled,
    verified_handle: u?.verified_handle ?? null,
    verified_display_name: u?.verified_display_name ?? null,
  };
}

// GET /api/passport-identity/nodes — the caller's linked passport hops + their
// reveal state, with PII-free garment context (slug, label, kind) so the UI can
// let them choose which hops to reveal. Tenant-scoped to the caller's own nodes.
passportIdentityRoutes.get("/nodes", async (c) => {
  const userId = c.get("userId");

  const verified = await loadVerified(userId);
  const profilePublic = verified.verified_enabled && !!verified.verified_handle;

  // The caller's own linked nodes (service-role read, scoped by linked_user_id).
  const { data: nodeRows, error } = await supabaseAdmin
    .from("owner_nodes")
    .select("id, pseudonymous_label, kind, identity_revealed, identity_revealed_at, created_at")
    .eq("linked_user_id", userId)
    .order("created_at", { ascending: false })
    .limit(NODE_LIST_LIMIT);
  if (error) {
    console.error("[passport-identity] node list failed:", error.message);
    return c.json({ error: "Failed to load your passport identities." }, 500);
  }
  const nodes = (nodeRows ?? []) as Array<{
    id: string;
    pseudonymous_label: string;
    kind: string;
    identity_revealed: boolean | null;
    identity_revealed_at: string | null;
    created_at: string;
  }>;

  // Resolve each node to its garment passport (PII-free: slug + sku_class only).
  // A node is the current owner of at most one garment; surface that context so
  // the user recognizes which item each hop is. Best-effort — a node with no
  // current garment still lists (it may be a prior hop).
  const nodeIds = nodes.map((n) => n.id);
  const garmentByNode = new Map<string, { slug: string; sku_class: Record<string, unknown> }>();
  if (nodeIds.length > 0) {
    const { data: garments } = await supabaseAdmin
      .from("garments")
      .select("public_passport_slug, sku_class, current_owner_node_id")
      .in("current_owner_node_id", nodeIds);
    for (
      const g of (garments ?? []) as Array<{
        public_passport_slug: string;
        sku_class: Record<string, unknown>;
        current_owner_node_id: string;
      }>
    ) {
      garmentByNode.set(g.current_owner_node_id, {
        slug: g.public_passport_slug,
        sku_class: g.sku_class ?? {},
      });
    }
  }

  return c.json({
    // Whether revealing is even possible right now — the UI prompts the user to
    // publish a Verified profile first if not.
    verified_profile_public: profilePublic,
    verified_handle: profilePublic ? verified.verified_handle : null,
    nodes: nodes.map((n) => {
      const g = garmentByNode.get(n.id) ?? null;
      return {
        node_id: n.id,
        label: n.pseudonymous_label,
        kind: n.kind,
        revealed: !!n.identity_revealed,
        revealed_at: n.identity_revealed_at,
        // Effective only when consent AND a public profile both hold.
        revealed_effective: !!n.identity_revealed && profilePublic,
        passport_slug: g?.slug ?? null,
        sku_class: g?.sku_class ?? {},
      };
    }),
  });
});

// POST /api/passport-identity/nodes/:nodeId/reveal — toggle reveal on ONE hop.
// Body: { revealed: boolean }. Tenant-scoped: the node must be linked to the
// caller. Revealing requires a public Verified profile (so there's a handle to
// show); un-revealing is always allowed (reversibility, US-1105).
passportIdentityRoutes.post("/nodes/:nodeId/reveal", async (c) => {
  const userId = c.get("userId");
  const nodeId = c.req.param("nodeId");
  if (!nodeId) return c.json({ error: "node id is required" }, 400);

  let body: { revealed?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body.revealed !== "boolean") {
    return c.json({ error: "revealed must be true or false" }, 400);
  }
  const revealed = body.revealed;

  // US-268: confirm the node belongs to the caller BEFORE writing. The id from
  // the URL is never trusted — a non-owned node matches no row → 404.
  const { data: node, error: lookErr } = await supabaseAdmin
    .from("owner_nodes")
    .select("id, identity_revealed")
    .eq("id", nodeId)
    .eq("linked_user_id", userId)
    .maybeSingle();
  if (lookErr) {
    console.error("[passport-identity] node lookup failed:", lookErr.message);
    return c.json({ error: "Lookup failed" }, 500);
  }
  if (!node) return c.json({ error: "Passport hop not found" }, 404);

  // To REVEAL, the caller must have a public Verified profile (otherwise there's
  // no public handle to show — and consent without a target would be a no-op).
  if (revealed) {
    const verified = await loadVerified(userId);
    if (!verified.verified_enabled || !verified.verified_handle) {
      return c.json(
        {
          error:
            "Publish your GradeThread Verified profile before revealing your identity on a passport.",
          code: "verified_profile_required",
        },
        400,
      );
    }
  }

  const { error: updErr } = await supabaseAdmin
    .from("owner_nodes")
    .update({
      identity_revealed: revealed,
      // Stamp on reveal; clear on un-reveal so the audit timestamp reflects the
      // current consent state.
      identity_revealed_at: revealed ? new Date().toISOString() : null,
    })
    .eq("id", nodeId)
    .eq("linked_user_id", userId);
  if (updErr) {
    console.error("[passport-identity] reveal update failed:", updErr.message);
    return c.json({ error: "Failed to update reveal setting." }, 500);
  }

  // Echo the effective state so the client can reflect it without a refetch.
  const verified = await loadVerified(userId);
  const effective = effectiveRevealedIdentity(
    { identity_revealed: revealed, linked_user_id: userId },
    verified,
  );
  return c.json({ ok: true, revealed, revealed_effective: !!effective }, 200);
});
