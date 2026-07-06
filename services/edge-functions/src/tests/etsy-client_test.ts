// US-1659: pure helpers of the Etsy connector — PKCE (verifier/challenge), the
// permanent-vs-transient auth-failure classifier, the ETSY_ENABLED gate, and the
// consent-URL builder. The DB-touching connect/refresh paths are covered by the
// adapter + (once app approval lands) the sandbox; here we lock the crypto +
// classification that must be correct before any token ever flows.

// etsy-client.ts imports the service-role client at module init, so set dummy env
// BEFORE the dynamic import (mirrors depop-client_test).
import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  buildConsentUrl,
  codeChallengeS256,
  generateCodeVerifier,
  getEtsyScopes,
  isEtsyEnabled,
  isPermanentEtsyAuthFailure,
} = await import("../lib/etsy-client.ts");

// ── PKCE ──────────────────────────────────────────────────────────────

Deno.test("generateCodeVerifier produces a base64url string in the RFC range", () => {
  const v = generateCodeVerifier();
  assert(v.length >= 43 && v.length <= 128, `length ${v.length}`);
  assert(/^[A-Za-z0-9\-_]+$/.test(v), "only base64url chars");
  assert(v !== generateCodeVerifier());
});

Deno.test("codeChallengeS256 matches the RFC 7636 test vector", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = await codeChallengeS256(verifier);
  assertEquals(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert(!challenge.includes("="));
  assert(!challenge.includes("+") && !challenge.includes("/"));
});

// ── Enabled gate ──────────────────────────────────────────────────────

Deno.test("isEtsyEnabled requires both the flag AND the keystring (default off)", () => {
  const prev = {
    flag: Deno.env.get("ETSY_ENABLED"),
    key: Deno.env.get("ETSY_KEYSTRING"),
  };
  try {
    Deno.env.delete("ETSY_ENABLED");
    Deno.env.delete("ETSY_KEYSTRING");
    assert(!isEtsyEnabled(), "off by default");

    // Flag on but no keystring → still off.
    Deno.env.set("ETSY_ENABLED", "true");
    assert(!isEtsyEnabled(), "flag without keystring stays off");

    // Keystring present but flag off → off.
    Deno.env.set("ETSY_ENABLED", "false");
    Deno.env.set("ETSY_KEYSTRING", "keystring-abc");
    assert(!isEtsyEnabled(), "keystring without flag stays off");

    // Both → on (accepts a few truthy spellings).
    for (const truthy of ["true", "1", "yes", "on"]) {
      Deno.env.set("ETSY_ENABLED", truthy);
      assert(isEtsyEnabled(), `flag=${truthy} should enable`);
    }
  } finally {
    if (prev.flag != null) Deno.env.set("ETSY_ENABLED", prev.flag);
    else Deno.env.delete("ETSY_ENABLED");
    if (prev.key != null) Deno.env.set("ETSY_KEYSTRING", prev.key);
    else Deno.env.delete("ETSY_KEYSTRING");
  }
});

// ── Consent URL ───────────────────────────────────────────────────────

Deno.test("buildConsentUrl carries PKCE + the read+write scope set (keystring as client_id)", () => {
  const prev = {
    key: Deno.env.get("ETSY_KEYSTRING"),
    redirect: Deno.env.get("ETSY_REDIRECT_URI"),
    scopes: Deno.env.get("ETSY_SCOPES"),
  };
  try {
    Deno.env.set("ETSY_KEYSTRING", "keystring-123");
    Deno.env.set(
      "ETSY_REDIRECT_URI",
      "https://functions.gradethread.com/api/flipdesk/etsy/oauth/callback",
    );
    Deno.env.delete("ETSY_SCOPES"); // use defaults

    const url = new URL(buildConsentUrl("state-xyz", "challenge-abc"));
    // Etsy uses the app keystring as the OAuth client_id.
    assertEquals(url.searchParams.get("client_id"), "keystring-123");
    assertEquals(url.searchParams.get("response_type"), "code");
    assertEquals(url.searchParams.get("state"), "state-xyz");
    assertEquals(url.searchParams.get("code_challenge"), "challenge-abc");
    assertEquals(url.searchParams.get("code_challenge_method"), "S256");

    const scope = url.searchParams.get("scope") ?? "";
    for (
      const s of [
        "listings_r",
        "listings_w",
        "listings_d",
        "transactions_r",
        "shops_r",
        "email_r",
      ]
    ) {
      assert(scope.includes(s), `scope missing ${s}`);
    }
    assertEquals(scope, getEtsyScopes());
  } finally {
    if (prev.key != null) Deno.env.set("ETSY_KEYSTRING", prev.key);
    else Deno.env.delete("ETSY_KEYSTRING");
    if (prev.redirect != null) Deno.env.set("ETSY_REDIRECT_URI", prev.redirect);
    else Deno.env.delete("ETSY_REDIRECT_URI");
    if (prev.scopes != null) Deno.env.set("ETSY_SCOPES", prev.scopes);
    else Deno.env.delete("ETSY_SCOPES");
  }
});

// ── Auth-failure classification ───────────────────────────────────────

Deno.test("isPermanentEtsyAuthFailure: revoked/4xx permanent, 5xx/429/network transient", () => {
  for (
    const m of [
      'Etsy token refresh failed (400): {"error":"invalid_grant"}',
      "Etsy token refresh failed (401): invalid_client",
      "token_revoked",
      "Etsy token refresh failed (403): forbidden",
    ]
  ) {
    assert(isPermanentEtsyAuthFailure(new Error(m)), `should be permanent: ${m}`);
  }
  for (
    const m of [
      "Etsy token refresh failed (500): upstream error",
      "Etsy token refresh failed (503): unavailable",
      "Etsy token refresh failed (429): rate limited",
      "network error: connection reset",
    ]
  ) {
    assert(!isPermanentEtsyAuthFailure(new Error(m)), `should be transient: ${m}`);
  }
});
