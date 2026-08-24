// Android Digital Asset Links — served at
// https://gradethread.com/.well-known/assetlinks.json so the native Android app
// can claim verified App Links (the Android equivalent of iOS Universal Links;
// see apple-app-site-association.ts). A verified App Link lets the OS open
// gradethread.com/app/* directly in the app — without the disambiguation
// chooser — and lets Chrome Custom Tabs complete the eBay + Supabase OAuth
// handshakes against an https URL instead of a claimable custom scheme
// (com.gradethread.app://) any app could intercept.
//
// Cloudflare Pages Functions route by file path; `assetlinks.json.ts` responds
// to the exact `/.well-known/assetlinks.json` path Android's verifier fetches
// (mirrors robots.txt.ts → /robots.txt). It MUST be served as application/json
// with a 200 and no redirect.
//
// The verification is keyed on the app's SIGNING certificate SHA-256
// fingerprint(s). With Play App Signing, the fingerprint that matters is the
// Google-managed app-signing key (Play Console → App integrity); add the upload
// key's fingerprint too if you verify against it. Fingerprints are not secret
// but are environment-specific, so they're injected via the ANDROID_CERT_SHA256
// Pages env var (comma-separated for multiple keys). Until it's configured the
// endpoint returns 503 — verified App Links simply aren't live yet, which is
// correct (the app falls back to the custom scheme / unverified links on that
// build).

import { headOf } from "../_shared/head-of";

interface AssetLinksEnv {
  ANDROID_CERT_SHA256?: string;
  ANDROID_PACKAGE_NAME?: string;
}

// The Android applicationId, which is NOT the iOS bundle id and NOT the Kotlin
// namespace — both of those are com.gradethread.app. The Play record was
// created as myapp and a Play package name cannot be changed after the fact.
const DEFAULT_PACKAGE_NAME = "com.gradethread.myapp";

export const onRequestGet: PagesFunction<AssetLinksEnv> = ({ env }) => {
  // Accept one or many comma/whitespace-separated fingerprints; normalize to the
  // colon-separated upper-hex form Android expects and drop anything malformed.
  const fingerprints = (env.ANDROID_CERT_SHA256 ?? "")
    .split(/[\s,]+/)
    .map((f) => f.trim().toUpperCase())
    .filter((f) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(f));

  if (fingerprints.length === 0) {
    return new Response(
      JSON.stringify({
        error:
          "App Links not configured: set ANDROID_CERT_SHA256 (colon-separated SHA-256 signing-cert fingerprint, comma-separated for multiple) on the Pages project.",
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

  // Blank counts as unset, same as the iOS association file: `??` does not
  // fall through on an empty string, so `ANDROID_PACKAGE_NAME=` yielded `""`
  // and this served an assetlinks entry naming no package, with HTTP 200. The
  // fingerprint check above already fails closed on a blank; this did not.
  const packageName = (env.ANDROID_PACKAGE_NAME ?? "").trim() || DEFAULT_PACKAGE_NAME;

  const body = [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: packageName,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Android's verifier re-fetches periodically; an hour keeps propagation
      // reasonable without hammering the function (mirrors the AASA endpoint).
      "Cache-Control": "public, max-age=3600",
    },
  });
};

// US-2620: HEAD answers with the GET's status and headers, no body.
export const onRequestHead = headOf(onRequestGet);
