// US-2417 AC1: the browser's only way in and out of the business & shipping
// profile.
//
// `users.business_phone` and `users.ship_from_address` used to be read from the
// `profile` row the auth store already had and written with supabase-js from
// settings.tsx. Both are now AES-256-GCM ciphertext bound to the account owner,
// and the key is an edge-only secret, so the browser can neither read nor write
// them. Migration 00567 removed both columns from the users self-update
// allowlist, which means the old direct write does not fail silently — it raises.
//
// Anything that needs a seller's phone or ship-from address goes through here.
// `profile.business_phone` and `profile.ship_from_address` now hold ciphertext
// and must not be rendered.

import { edgeFetch } from "@/lib/edge-fetch";

export interface ShipFromAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

export interface ShippingProfile {
  business_name: string | null;
  business_phone: string | null;
  ship_from_address: ShipFromAddress | null;
}

/** Shared TanStack Query key, so a save can invalidate every reader at once. */
export const SHIPPING_PROFILE_QUERY_KEY = ["account", "shipping-profile"] as const;

async function unwrap(res: Response): Promise<ShippingProfile> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error || "Could not load your business details.",
    );
  }
  const data = await res.json() as Partial<ShippingProfile>;
  return {
    business_name: data.business_name ?? null,
    business_phone: data.business_phone ?? null,
    ship_from_address: data.ship_from_address ?? null,
  };
}

export async function fetchShippingProfile(): Promise<ShippingProfile> {
  // skipWorkspaceHeader: this is the caller's OWN account row. A member acting
  // inside someone else's workspace must not read the owner's home address, and
  // sending the header would invite the route to honour it one day.
  return await unwrap(
    await edgeFetch("/api/account/shipping-profile", { skipWorkspaceHeader: true }),
  );
}

export async function saveShippingProfile(
  input: ShippingProfile,
): Promise<ShippingProfile> {
  return await unwrap(
    await edgeFetch("/api/account/shipping-profile", {
      method: "PUT",
      skipWorkspaceHeader: true,
      json: {
        business_name: input.business_name ?? "",
        business_phone: input.business_phone ?? "",
        ship_from_address: input.ship_from_address,
      },
    }),
  );
}

/** True when the address has the four fields a shipping label needs. */
export function isShipFromComplete(addr: ShipFromAddress | null | undefined): boolean {
  if (!addr) return false;
  return Boolean(
    addr.line1?.trim() && addr.city?.trim() && addr.state?.trim() && addr.postal_code?.trim(),
  );
}
