// Garment Passport ownership transfer core (US-1094 / US-1096).
//
// The deterministic "title transfer": create a new pseudonymous buyer node,
// append an ownership_transfer event, and move the garment's current owner.
// Shared by every Layer-1/2 handoff entry point (the claim-token redemption in
// passport.ts and the physical-tag scan-to-claim) so the chain logic lives in
// exactly one place.
//
// PII-free: the buyer node carries only an ordinal pseudonymous label
// ("Buyer B", "Buyer C", …); linkedUserId, when present, is a uuid linkage only.

import { supabaseAdmin } from "./supabase.ts";
import { pseudonymousLabel } from "./garment-passport.ts";

export interface TransferResult {
  nodeId: string;
  slug: string | null;
}

/**
 * Transfer `garmentId` to a fresh pseudonymous buyer node and append a
 * deterministic ownership_transfer event. Returns the new node id + the
 * garment's public slug, or null on failure (caller maps to an error response).
 *
 * `source` is recorded on the event (e.g. "claim", "tag-claim"). `linkedUserId`
 * optionally associates the node with an account (uuid only — no PII).
 */
export async function transferToNewBuyer(
  garmentId: string,
  opts: { linkedUserId?: string | null; source: string },
): Promise<TransferResult | null> {
  // Chain position: origin seller is seq 0 ("Seller A"); the Nth buyer is
  // seq = (prior ownership transfers) + 1 → "Buyer B", "Buyer C", …
  const { count } = await supabaseAdmin
    .from("garment_events")
    .select("id", { count: "exact", head: true })
    .eq("garment_id", garmentId)
    .eq("event_type", "ownership_transfer");
  const seq = (count ?? 0) + 1;

  const { data: node, error: nodeErr } = await supabaseAdmin
    .from("owner_nodes")
    .insert({
      pseudonymous_label: pseudonymousLabel("buyer", seq),
      kind: "buyer",
      linked_user_id: opts.linkedUserId ?? null,
    })
    .select("id")
    .single();
  if (nodeErr || !node) {
    console.error("[passport-transfer] buyer-node insert failed:", nodeErr?.message);
    return null;
  }
  const nodeId = (node as { id: string }).id;

  const { error: evErr } = await supabaseAdmin.from("garment_events").insert({
    garment_id: garmentId,
    event_type: "ownership_transfer",
    actor_node_id: nodeId,
    payload: {},
    confidence: "deterministic",
    source: opts.source.slice(0, 200),
  });
  if (evErr) {
    console.error("[passport-transfer] event insert failed:", evErr.message);
    return null;
  }

  const { error: updErr } = await supabaseAdmin
    .from("garments")
    .update({ current_owner_node_id: nodeId })
    .eq("id", garmentId);
  if (updErr) {
    console.error("[passport-transfer] current-owner update failed:", updErr.message);
    return null;
  }

  const { data: g } = await supabaseAdmin
    .from("garments")
    .select("public_passport_slug")
    .eq("id", garmentId)
    .maybeSingle();

  return {
    nodeId,
    slug: (g as { public_passport_slug: string } | null)?.public_passport_slug ?? null,
  };
}

/** Resolve an optional bearer JWT to a user id for account association. */
export async function userIdFromBearer(authorization: string | undefined): Promise<string | null> {
  const authz = authorization ?? "";
  const jwt = authz.toLowerCase().startsWith("bearer ") ? authz.slice(7).trim() : "";
  if (!jwt) return null;
  const { data } = await supabaseAdmin.auth.getUser(jwt);
  return data?.user?.id ?? null;
}
