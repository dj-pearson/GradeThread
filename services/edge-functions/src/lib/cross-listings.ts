import { supabaseAdmin } from "./supabase.ts";
import { withdrawOffer } from "./ebay-client.ts";

// Auto-end of cross-listed siblings (US-149). When one listing in a
// cross-listing group (rows sharing listings.draft_id) sells, end the others
// so the same garment isn't sold twice. Gated by the per-user
// flipdesk_settings.auto_end_cross_listings toggle (absent row = enabled).
//
// Imports withdrawOffer directly from ebay-client (NOT via the marketplace
// adapters) so flipdesk-ebay.ts → cross-listings.ts stays cycle-free: the
// eBay adapter imports publishItemForOwner from flipdesk-ebay.ts.

interface SiblingRow {
  id: string;
  platform: string;
  platform_offer_id: string | null;
  listing_status: string;
  inventory_items: { user_id: string };
}

// Best-effort: never throws. Returns how many sibling listings were ended.
export async function autoEndCrossListings(
  ownerId: string,
  soldListingId: string,
): Promise<number> {
  try {
    const { data: sold } = await supabaseAdmin
      .from("listings")
      .select("draft_id")
      .eq("id", soldListingId)
      .maybeSingle();
    const draftId = (sold as { draft_id: string | null } | null)?.draft_id;
    if (!draftId) return 0; // not part of a cross-listing group

    const { data: settings } = await supabaseAdmin
      .from("flipdesk_settings")
      .select("auto_end_cross_listings")
      .eq("user_id", ownerId)
      .maybeSingle();
    const enabled =
      (settings as { auto_end_cross_listings: boolean } | null)
        ?.auto_end_cross_listings !== false;
    if (!enabled) return 0;

    // Tenant-scoped via inventory_items.user_id (US-268) — listings carry no
    // user_id of their own.
    const { data, error } = await supabaseAdmin
      .from("listings")
      .select(
        "id, platform, platform_offer_id, listing_status, inventory_items!inner(user_id)",
      )
      .eq("draft_id", draftId)
      .eq("inventory_items.user_id", ownerId)
      .neq("id", soldListingId)
      .in("listing_status", ["draft", "active"]);
    if (error) {
      console.error(
        "[cross-listings] sibling lookup failed:",
        error.message,
      );
      return 0;
    }

    let ended = 0;
    for (const row of (data ?? []) as unknown as SiblingRow[]) {
      // eBay siblings that are live get withdrawn upstream first; an
      // already-ended offer throws here, which is fine — we still want the
      // local row marked ended.
      if (row.platform === "ebay" && row.platform_offer_id) {
        try {
          await withdrawOffer(ownerId, row.platform_offer_id);
        } catch (err) {
          console.warn(
            "[cross-listings] withdrawOffer during auto-end failed (continuing):",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      const { error: updErr } = await supabaseAdmin
        .from("listings")
        .update({ listing_status: "ended", is_active: false })
        .eq("id", row.id);
      if (updErr) {
        console.error(
          "[cross-listings] failed to end sibling listing:",
          updErr.message,
        );
      } else {
        ended++;
      }
    }
    return ended;
  } catch (err) {
    console.error(
      "[cross-listings] autoEndCrossListings failed:",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}
