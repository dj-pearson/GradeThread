import {
  buildConsentUrl,
  codeChallengeS256,
  generateCodeVerifier,
  getDepopConnection,
  isDepopEnabled,
} from "../depop-client.ts";
import { supabaseAdmin } from "../supabase.ts";
import { mapSiblingListingFields } from "../cross-listing-fields.ts";
import {
  type MarketplaceAdapter,
  notImplemented,
} from "./types.ts";

// Depop adapter (US-713) — the CONNECTION half is now real (OAuth 2.0 + PKCE +
// token refresh via depop-client); the publish/update/delist/sync listing half
// is still US-714 and returns the typed 501 until that ships. cross-push (US-708)
// can therefore mint + map the local Depop `listings` row today, then publish it
// once US-714 lands. mapDraftToListing is pure (no Depop access needed).
//
// Everything is gated behind isDepopEnabled(): while partner access is pending
// (US-712), connect/refresh return 503 so there is no fake connect flow.

export const depopAdapter: MarketplaceAdapter = {
  platform: "depop",

  async connect(input) {
    if (!isDepopEnabled()) {
      return {
        ok: false as const,
        status: 503,
        error: "Depop is not available yet — partner access is pending.",
      };
    }
    try {
      // PKCE: stash the verifier on the single-use state row so the callback can
      // present it at the token exchange (migration 00175).
      const codeVerifier = generateCodeVerifier();
      const { error } = await supabaseAdmin.from("oauth_states").insert({
        state: input.state,
        user_id: input.ownerId,
        marketplace: "depop",
        code_verifier: codeVerifier,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      if (error) {
        return {
          ok: false as const,
          status: 500,
          error: "Could not start Depop connect.",
        };
      }
      const challenge = await codeChallengeS256(codeVerifier);
      return { ok: true as const, consentUrl: buildConsentUrl(input.state, challenge) };
    } catch (err) {
      return {
        ok: false as const,
        status: 500,
        error: err instanceof Error ? err.message : "Could not start Depop connect.",
      };
    }
  },

  // getDepopConnection refreshes the access token inline when it's near expiry,
  // so confirming the connection resolves also proves the token is fresh.
  async refreshToken(input) {
    if (!isDepopEnabled()) {
      return { ok: false, status: 503, error: "Depop is not available yet." };
    }
    const conn = await getDepopConnection(input.ownerId);
    return conn
      ? { ok: true }
      : { ok: false, status: 400, error: "Depop is not connected." };
  },

  // Listing lifecycle is US-714 — returns the typed 501 (cross-push still maps
  // the local row via mapDraftToListing below).
  publish: () => Promise.resolve(notImplemented("depop")),
  updateListing: () => Promise.resolve(notImplemented("depop")),
  delist: () => Promise.resolve(notImplemented("depop")),
  syncListings: () => Promise.resolve(notImplemented("depop")),
  syncOrders: () => Promise.resolve(notImplemented("depop")),

  mapDraftToListing: (input) =>
    mapSiblingListingFields("depop", input.source, input.price, input.variant),
};
