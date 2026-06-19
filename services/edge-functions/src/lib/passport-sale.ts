// Garment Passport sale → sold-to node + claim offer (US-1100, Layer 4).
//
// When a graded item sells (today: eBay, via the orders sync / webhook), we
// capture "who it sold to" and set up "did they resell it" detection WITHOUT
// storing buyer PII:
//   1. Append a deterministic 'sold' garment_event to the item's passport.
//   2. Create a pseudonymous sold-to BUYER node whose only identity signal is a
//      SALTED SHA-256 of the buyer identifier (minimizeLinkageRef, US-1090) —
//      never a name/email/address. The same hash reappearing later (the buyer
//      becomes a seller) links the nodes to detect resale (owner_nodes.linkage_hash).
//   3. Move the garment's current owner to the sold-to node (the buyer holds it).
//   4. Mint a single-use, time-bounded CLAIM TOKEN (US-1094) so the buyer can
//      take over the passport — the claim OFFER. Only the token hash is stored.
//
// Tenant-scoping (US-268): the garment is resolved ONLY through an inventory
// item we've confirmed belongs to the workspace owner (resolveGarmentForItem),
// never an id from the request. Best-effort + idempotent: a passport failure
// must never fail or slow a recorded sale, and a re-synced sale must not append
// a second 'sold' event / mint a second token (guarded by the sold-to node
// already owning the garment).

import { supabaseAdmin } from "./supabase.ts";
import {
  generateClaimToken,
  hashClaimToken,
  minimizeLinkageRef,
  pseudonymousLabel,
} from "./garment-passport.ts";
import { resolveGarmentForItem } from "./passport-relist.ts";

// Claim tokens minted on a sale are valid for 30 days (mirrors passport.ts).
const CLAIM_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Public site origin (no trailing slash) for building the claim link. */
function publicSiteUrl(): string {
  return (Deno.env.get("PUBLIC_SITE_URL")?.trim() || "https://gradethread.com").replace(/\/$/, "");
}

export interface RecordSaleResult {
  garmentId: string;
  soldToNodeId: string;
  /** The buyer's one-time claim link (raw token — shown/handed off once). */
  claimUrl: string | null;
}

// Minimal structural type of the bits of the Supabase client this module uses —
// so the writes can be exercised by a fake DB in unit tests (US-1100 AC4/AC5)
// without a live database. Production passes the real service-role client.
// deno-lint-ignore no-explicit-any
export type SaleDb = { from: (table: string) => any };

export interface RecordSaleDeps {
  db: SaleDb;
  /** Tenant-scoped garment resolver (the US-268 wall). */
  resolveGarment: (
    inventoryItemId: string,
    ownerId: string,
  ) => Promise<{ garmentId: string; slug: string | null } | null>;
}

const defaultDeps: RecordSaleDeps = {
  db: supabaseAdmin,
  resolveGarment: resolveGarmentForItem,
};

/**
 * Record a passport sale: append a 'sold' event, create the pseudonymous
 * sold-to buyer node (salted-hash linkage, no PII), move ownership to it, and
 * mint a claim token for the buyer. Returns null when the item has no passport
 * (e.g. a pre-passport grade) or on any soft failure. Never throws.
 */
export async function recordEbaySale(
  input: {
    inventoryItemId: string;
    ownerId: string;
    /** The marketplace buyer identifier — hashed, NEVER stored raw. */
    buyerIdentifier: string | null;
    /** Marketplace label for the event source/payload (default "ebay"). */
    platform?: string;
  },
  deps: Partial<RecordSaleDeps> = {},
): Promise<RecordSaleResult | null> {
  const { db, resolveGarment } = { ...defaultDeps, ...deps };
  const platform = (input.platform ?? "ebay").slice(0, 40);
  try {
    // US-268: confirm ownership + resolve the garment through the owned item.
    const resolved = await resolveGarment(input.inventoryItemId, input.ownerId);
    if (!resolved) return null;
    const garmentId = resolved.garmentId;

    // Limited-PII linkage key: salted hash of the buyer identifier (or null).
    const buyerHash = input.buyerIdentifier?.trim()
      ? await minimizeLinkageRef(input.buyerIdentifier)
      : null;

    // Idempotency: if the garment's current owner is already a sold-to node for
    // THIS buyer hash, we've recorded this sale — no-op (re-sync safe).
    const { data: garment } = await db
      .from("garments")
      .select("current_owner_node_id")
      .eq("id", garmentId)
      .maybeSingle();
    const currentNodeId =
      (garment as { current_owner_node_id: string | null } | null)?.current_owner_node_id ?? null;
    if (buyerHash && currentNodeId) {
      const { data: curNode } = await db
        .from("owner_nodes")
        .select("linkage_hash")
        .eq("id", currentNodeId)
        .maybeSingle();
      if ((curNode as { linkage_hash: string | null } | null)?.linkage_hash === buyerHash) {
        return { garmentId, soldToNodeId: currentNodeId, claimUrl: null };
      }
    }

    // Chain position: count prior transfers (sold + ownership_transfer) so the
    // ordinal label ("Buyer B", "Buyer C", …) stays monotonic.
    const { count } = await db
      .from("garment_events")
      .select("id", { count: "exact", head: true })
      .eq("garment_id", garmentId)
      .in("event_type", ["sold", "ownership_transfer"]);
    const seq = (count ?? 0) + 1;

    // Pseudonymous sold-to node — identity carried ONLY as the salted hash.
    const { data: node, error: nodeErr } = await db
      .from("owner_nodes")
      .insert({
        pseudonymous_label: pseudonymousLabel("buyer", seq),
        kind: "buyer",
        linkage_hash: buyerHash,
      })
      .select("id")
      .single();
    if (nodeErr || !node) {
      console.error("[passport-sale] sold-to node insert failed:", nodeErr?.message);
      return null;
    }
    const soldToNodeId = (node as { id: string }).id;

    // Append the deterministic 'sold' event (PII-free payload).
    const { error: evErr } = await db.from("garment_events").insert({
      garment_id: garmentId,
      event_type: "sold",
      actor_node_id: soldToNodeId,
      payload: { platform },
      confidence: "deterministic",
      source: `sale:${platform}`.slice(0, 200),
    });
    if (evErr) {
      console.error("[passport-sale] sold event insert failed:", evErr.message);
      return null;
    }

    // The buyer now holds the garment.
    await db
      .from("garments")
      .update({ current_owner_node_id: soldToNodeId })
      .eq("id", garmentId)
      .then(() => {}, () => {});

    // Claim offer: mint a single-use, time-bounded token (only the hash is
    // stored). The raw token is returned once for the seller to hand to the
    // buyer (e.g. in the package/insert). Best-effort — a token failure still
    // leaves the sold-to node + event recorded.
    let claimUrl: string | null = null;
    try {
      const token = generateClaimToken();
      const tokenHash = await hashClaimToken(token);
      const expiresAt = new Date(Date.now() + CLAIM_TOKEN_TTL_MS).toISOString();
      const { error: tokErr } = await db.from("passport_claim_tokens").insert({
        garment_id: garmentId,
        token_hash: tokenHash,
        created_by: input.ownerId,
        expires_at: expiresAt,
      });
      if (!tokErr) claimUrl = `${publicSiteUrl()}/claim/${token}`;
      else console.error("[passport-sale] claim-token insert failed:", tokErr.message);
    } catch (e) {
      console.error("[passport-sale] claim-token mint failed:", e instanceof Error ? e.message : e);
    }

    return { garmentId, soldToNodeId, claimUrl };
  } catch (e) {
    console.error("[passport-sale] recordEbaySale failed:", e instanceof Error ? e.message : e);
    return null;
  }
}
