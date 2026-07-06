import {
  buildConsentUrl,
  codeChallengeS256,
  generateCodeVerifier,
  getWhatnotConnection,
  isWhatnotEnabled,
} from "../whatnot-client.ts";
import { supabaseAdmin } from "../supabase.ts";
import { mapSiblingListingFields } from "../cross-listing-fields.ts";
import {
  type MarketplaceAdapter,
  notImplemented,
} from "./types.ts";

// Whatnot adapter (US-1661) — the CONNECTION half of a new partner-API
// marketplace, mirroring how Depop/Etsy shipped (connection story → listing
// story):
//   • connect      → OAuth 2.0 + PKCE (whatnot-client), gated behind WHATNOT_ENABLED
//   • refreshToken → confirms the stored token resolves/refreshes
//   • publish / updateListing / delist / syncListings / syncOrders → typed 501
//     NotImplemented until the listing + order path lands in US-1662, so
//     cross-push still mints the local `listings` row today (no silent eBay
//     fallthrough — the US-599 gap).
//   • mapDraftToListing → real (pure), so a sibling row maps the moment Whatnot
//     is selected in the composer.
//
// EVERYTHING network-facing stays gated behind isWhatnotEnabled() (WHATNOT_ENABLED
// + creds): while partner access is pending, connect returns 503 — no fake flow.
//
// SECURITY (US-268): connections live on the workspace owner, established from
// the ownerId the dispatcher passes.

export const whatnotAdapter: MarketplaceAdapter = {
  platform: "whatnot",

  async connect(input) {
    if (!isWhatnotEnabled()) {
      return {
        ok: false as const,
        status: 503,
        error: "Whatnot is not available yet — partner access is pending.",
      };
    }
    try {
      const codeVerifier = generateCodeVerifier();
      const { error } = await supabaseAdmin.from("oauth_states").insert({
        state: input.state,
        user_id: input.ownerId,
        marketplace: "whatnot",
        code_verifier: codeVerifier,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      if (error) {
        return { ok: false as const, status: 500, error: "Could not start Whatnot connect." };
      }
      const challenge = await codeChallengeS256(codeVerifier);
      return { ok: true as const, consentUrl: buildConsentUrl(input.state, challenge) };
    } catch (err) {
      return {
        ok: false as const,
        status: 500,
        error: err instanceof Error ? err.message : "Could not start Whatnot connect.",
      };
    }
  },

  async refreshToken(input) {
    if (!isWhatnotEnabled()) {
      return { ok: false, status: 503, error: "Whatnot is not available yet." };
    }
    const conn = await getWhatnotConnection(input.ownerId);
    return conn
      ? { ok: true }
      : { ok: false, status: 400, error: "Whatnot is not connected." };
  },

  // Listing + order path is US-1662: typed 501 so cross-push mints the local row
  // and surfaces an honest "ships once the integration lands" message.
  publish: () => Promise.resolve(notImplemented("whatnot")),
  updateListing: () => Promise.resolve(notImplemented("whatnot")),
  delist: () => Promise.resolve(notImplemented("whatnot")),
  syncListings: () => Promise.resolve(notImplemented("whatnot")),
  syncOrders: () => Promise.resolve(notImplemented("whatnot")),

  mapDraftToListing: (input) =>
    mapSiblingListingFields("whatnot", input.source, input.price, input.variant),
};
