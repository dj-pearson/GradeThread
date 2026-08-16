// Apple App Site Association (AASA) — served at
// https://gradethread.com/.well-known/apple-app-site-association so the iOS app
// can claim Universal Links under /app/* (US-661). This is what lets
// ASWebAuthenticationSession.Callback.https complete the eBay + Supabase OAuth
// handshakes against an https URL instead of a claimable custom scheme
// (com.gradethread.app://), which any installed app could register and
// intercept.
//
// Cloudflare Pages Functions route by file path, so this file (no extension on
// the route) responds to the exact well-known path Apple fetches. It MUST be
// served as application/json with a 200 and no redirect. Apple's CDN caches it,
// so changes can take time to propagate to devices.
//
// The app identifier is `<TEAM_ID>.<BUNDLE_ID>`. The Team ID is environment-
// specific (and not a secret, but kept out of source) so it's injected via the
// APPLE_TEAM_ID Pages env var; BUNDLE_ID defaults to the shipping bundle id.
// Until APPLE_TEAM_ID is configured the endpoint returns 503 — Universal Links
// simply aren't live yet, which is correct (the app falls back to the custom
// scheme on that build).

import { headOf } from "../_shared/head-of";

interface AASAEnv {
  APPLE_TEAM_ID?: string;
  IOS_BUNDLE_ID?: string;
}

const DEFAULT_BUNDLE_ID = "com.gradethread.app";

// Paths the app intercepts as Universal Links. eBay OAuth lands on
// /app/oauth/ebay; Supabase auth (Google sign-in, magic link, recovery) lands
// on /app/auth-callback. Everything else on gradethread.com stays in the
// browser / SPA.
const APP_LINK_COMPONENTS = [
  { "/": "/app/oauth/*", comment: "eBay OAuth callback" },
  { "/": "/app/auth-callback*", comment: "Supabase auth callback" },
];

export const onRequestGet: PagesFunction<AASAEnv> = ({ env }) => {
  const teamId = (env.APPLE_TEAM_ID ?? "").trim();
  if (!teamId) {
    return new Response(
      JSON.stringify({
        error:
          "Universal Links not configured: set APPLE_TEAM_ID on the Pages project.",
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  // BLANK COUNTS AS UNSET. `??` falls through on undefined and never on an
  // empty string, so `IOS_BUNDLE_ID=` — a blank field on the Pages project —
  // produced `appId = "<TEAMID>."` and served it with HTTP 200. Apple fetches
  // this file, reads a malformed appID, and Universal Links stop opening the
  // app; nothing 404s and nothing errors.
  //
  // The team-id check above already fails CLOSED on a blank. This line did not,
  // which is the asymmetry rather than the concept being unknown here.
  const bundleId = (env.IOS_BUNDLE_ID ?? "").trim() || DEFAULT_BUNDLE_ID;
  const appId = `${teamId}.${bundleId}`;

  const body = {
    applinks: {
      details: [
        {
          appIDs: [appId],
          components: APP_LINK_COMPONENTS,
        },
      ],
    },
    // webcredentials lets the app share its associated domain for password
    // autofill; harmless to advertise alongside applinks and avoids a second
    // round-trip if we later add Passkeys/Associated Web Credentials.
    webcredentials: {
      apps: [appId],
    },
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Apple re-fetches periodically; an hour keeps propagation reasonable
      // without hammering the function.
      "Cache-Control": "public, max-age=3600",
    },
  });
};

// US-2620: HEAD answers with the GET's status and headers, no body.
export const onRequestHead = headOf(onRequestGet);
