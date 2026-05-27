// Mark US-183 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-183": {
    passes: true,
    notes:
      "Done 2026-05-27. ios/GradeThread/Marketplaces/ holds the eBay connect surface — the Marketplaces tab now renders a real connection card instead of the placeholder. EbayConnectionTypes.swift wraps the wire shapes: ConsentResponse decodes /oauth/start's `{ consent_url }` reply; RemoteMarketplaceConnection decodes the marketplace_connections row (account_handle, is_active, last_synced_at, refresh_error) — token columns are NEVER decoded client-side. EbayConnectResult parses the ASWebAuthenticationSession callback URL's `?ebay=` query param into .cancelled / .stateExpired / .connected / .error — matching the values the web's callback handler emits. EbayConnectionService runs the full handshake: getJSON('/api/flipdesk/ebay/oauth/start', query: redirect_to=com.gradethread.app://oauth/ebay) for the consent URL, ASWebAuthenticationSession with callbackURLScheme='com.gradethread.app' (custom scheme reused from US-170's URL types — Universal Link upgrade requires iOS 17.4+ + AASA at gradethread.com, noted as a polish pass), then polls marketplace_connections 3× × 600ms post-dismiss to absorb any token-exchange write delay before throwing .noActiveConnection. Disconnect updates the row's is_active=false + scrubs encrypted token columns via direct supabase-swift update (RLS filters to the user's own rows). prefersEphemeralWebBrowserSession=false so reconnect is a single tap. MarketplaceConnectionStore is the @MainActor @Observable state machine: .loading / .disconnected / .connected(row) / .reconnectRequired(row, message) — the last branch fires when fetchActiveConnection returns nil but fetchLatestConnection has a row with refresh_error, mirroring the web's 'Reconnect required' state for stale grants. MarketplacesView renders the right card per phase: Connect button when disconnected, account handle + relative-time last-sync + Disconnect + Reconnect when connected, exclamation banner + Reconnect when stale. Status pill in the upper-right reflects Connected / Setup required / Reconnect required. ContentView's MarketplacesPlaceholder now points at MarketplacesView. Tests in EbayConnectionTests cover ConsentResponse snake-to-camel decoding, RemoteMarketplaceConnection decoding with full row + null/refresh_error row, EbayConnectResult.from(callbackURL:) for cancelled / state_expired / connected (returns nil — caller fetches the row) / error / no-known-params (returns nil), and the store's initial phase. Service-layer integration tests against the real edge endpoint land on first TestFlight build with real eBay sandbox creds.",
  },
};

const prd = JSON.parse(fs.readFileSync(PRD, "utf8"));
let touched = 0;
for (const story of prd.userStories) {
  const u = updates[story.id];
  if (!u) continue;
  story.passes = u.passes;
  story.notes = u.notes;
  touched++;
}

fs.writeFileSync(PRD, JSON.stringify(prd, null, 2) + "\n", "utf8");
console.log(`Updated ${touched} stories in prd.json`);
