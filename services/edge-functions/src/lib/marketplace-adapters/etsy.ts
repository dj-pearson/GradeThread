import {
  buildConsentUrl,
  codeChallengeS256,
  generateCodeVerifier,
  getEtsyConnection,
  isEtsyEnabled,
} from "../etsy-client.ts";
import { supabaseAdmin } from "../supabase.ts";
import { mapSiblingListingFields } from "../cross-listing-fields.ts";
import {
  type MarketplaceAdapter,
  notImplemented,
} from "./types.ts";

// Etsy adapter (US-1659) — the CONNECTION half of a new real-API marketplace,
// mirroring how Depop shipped (US-713 connection → US-714 listing/order):
//   • connect      → OAuth 2.0 + PKCE (etsy-client), gated behind ETSY_ENABLED
//   • refreshToken → confirms the stored token resolves/refreshes
//   • publish / updateListing / delist / syncListings / syncOrders → typed 501
//     NotImplemented until the listing + receipt path lands in US-1660, so
//     cross-push still mints the local `listings` row today and can push it once
//     the integration ships (no silent eBay fallthrough — the US-599 gap).
//   • mapDraftToListing → real (pure), so a sibling row maps correctly the
//     moment Etsy is selected in the composer.
//
// EVERYTHING network-facing stays gated behind isEtsyEnabled() (ETSY_ENABLED +
// keystring): while the app is awaiting Etsy's commercial-scope approval, connect
// returns 503 — no fake flow.
//
// SECURITY (US-268): connections live on the workspace owner (owner-scoped),
// established from the ownerId the dispatcher passes.

export const etsyAdapter: MarketplaceAdapter = {
  platform: "etsy",

  async connect(input) {
    if (!isEtsyEnabled()) {
      return {
        ok: false as const,
        status: 503,
        error: "Etsy is not available yet — app approval is pending.",
      };
    }
    try {
      // PKCE: stash the verifier on the single-use state row so the callback can
      // present it at the token exchange (migration 00175).
      const codeVerifier = generateCodeVerifier();
      const { error } = await supabaseAdmin.from("oauth_states").insert({
        state: input.state,
        user_id: input.ownerId,
        marketplace: "etsy",
        code_verifier: codeVerifier,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      if (error) {
        return {
          ok: false as const,
          status: 500,
          error: "Could not start Etsy connect.",
        };
      }
      const challenge = await codeChallengeS256(codeVerifier);
      return { ok: true as const, consentUrl: buildConsentUrl(input.state, challenge) };
    } catch (err) {
      return {
        ok: false as const,
        status: 500,
        error: err instanceof Error ? err.message : "Could not start Etsy connect.",
      };
    }
  },

  // getEtsyConnection refreshes the access token inline when it's near expiry,
  // so confirming the connection resolves also proves the token is fresh.
  async refreshToken(input) {
    if (!isEtsyEnabled()) {
      return { ok: false, status: 503, error: "Etsy is not available yet." };
    }
    const conn = await getEtsyConnection(input.ownerId);
    return conn
      ? { ok: true }
      : { ok: false, status: 400, error: "Etsy is not connected." };
  },

  // Listing + order path is US-1660: return the typed 501 so cross-push mints the
  // local row and surfaces an honest "ships once the integration lands" message.
  publish: () => Promise.resolve(notImplemented("etsy")),
  updateListing: () => Promise.resolve(notImplemented("etsy")),
  delist: () => Promise.resolve(notImplemented("etsy")),
  syncListings: () => Promise.resolve(notImplemented("etsy")),
  syncOrders: () => Promise.resolve(notImplemented("etsy")),

  mapDraftToListing: (input) =>
    mapSiblingListingFields("etsy", input.source, input.price, input.variant),
};
