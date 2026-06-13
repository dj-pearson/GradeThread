// US-713: pure helpers of the Depop connector — PKCE (verifier/challenge), the
// permanent-vs-transient auth-failure classifier, the DEPOP_ENABLED gate, and
// the consent-URL builder. The DB-touching connect/refresh paths are covered by
// the adapter test + (once partner access lands) the sandbox; here we lock the
// crypto + classification that must be correct before any token ever flows.

// depop-client.ts imports the service-role client at module init, so set dummy
// env BEFORE the dynamic import (mirrors shopify-orders_test).
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
  getDepopScopes,
  isDepopEnabled,
  isPermanentDepopAuthFailure,
} = await import("../lib/depop-client.ts");

// ── PKCE ──────────────────────────────────────────────────────────────

Deno.test("generateCodeVerifier produces a base64url string in the RFC range", () => {
  const v = generateCodeVerifier();
  // 32 random bytes → 43 base64url chars (no padding), within 43–128.
  assert(v.length >= 43 && v.length <= 128, `length ${v.length}`);
  assert(/^[A-Za-z0-9\-_]+$/.test(v), "only base64url chars");
  // High entropy → two calls differ.
  assert(v !== generateCodeVerifier());
});

Deno.test("codeChallengeS256 matches the RFC 7636 test vector", async () => {
  // RFC 7636 Appendix B: verifier → challenge.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = await codeChallengeS256(verifier);
  assertEquals(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  // No base64 padding / unsafe chars leaked into the URL value.
  assert(!challenge.includes("="));
  assert(!challenge.includes("+") && !challenge.includes("/"));
});

// ── Enabled gate ──────────────────────────────────────────────────────

Deno.test("isDepopEnabled requires both the flag AND creds (default off)", () => {
  const prev = {
    flag: Deno.env.get("DEPOP_ENABLED"),
    id: Deno.env.get("DEPOP_CLIENT_ID"),
    secret: Deno.env.get("DEPOP_CLIENT_SECRET"),
  };
  try {
    Deno.env.delete("DEPOP_ENABLED");
    Deno.env.delete("DEPOP_CLIENT_ID");
    Deno.env.delete("DEPOP_CLIENT_SECRET");
    assert(!isDepopEnabled(), "off by default");

    // Flag on but no creds → still off.
    Deno.env.set("DEPOP_ENABLED", "true");
    assert(!isDepopEnabled(), "flag without creds stays off");

    // Creds present but flag off → off.
    Deno.env.set("DEPOP_ENABLED", "false");
    Deno.env.set("DEPOP_CLIENT_ID", "client");
    Deno.env.set("DEPOP_CLIENT_SECRET", "secret");
    assert(!isDepopEnabled(), "creds without flag stays off");

    // Both → on (accepts a few truthy spellings).
    for (const truthy of ["true", "1", "yes", "on"]) {
      Deno.env.set("DEPOP_ENABLED", truthy);
      assert(isDepopEnabled(), `flag=${truthy} should enable`);
    }
  } finally {
    if (prev.flag != null) Deno.env.set("DEPOP_ENABLED", prev.flag);
    else Deno.env.delete("DEPOP_ENABLED");
    if (prev.id != null) Deno.env.set("DEPOP_CLIENT_ID", prev.id);
    else Deno.env.delete("DEPOP_CLIENT_ID");
    if (prev.secret != null) Deno.env.set("DEPOP_CLIENT_SECRET", prev.secret);
    else Deno.env.delete("DEPOP_CLIENT_SECRET");
  }
});

// ── Consent URL ───────────────────────────────────────────────────────

Deno.test("buildConsentUrl carries PKCE + the multi-seller scope set", () => {
  const prev = {
    id: Deno.env.get("DEPOP_CLIENT_ID"),
    redirect: Deno.env.get("DEPOP_REDIRECT_URI"),
    scopes: Deno.env.get("DEPOP_SCOPES"),
  };
  try {
    Deno.env.set("DEPOP_CLIENT_ID", "client-123");
    Deno.env.set(
      "DEPOP_REDIRECT_URI",
      "https://functions.gradethread.com/api/flipdesk/depop/oauth/callback",
    );
    Deno.env.delete("DEPOP_SCOPES"); // use defaults

    const url = new URL(buildConsentUrl("state-xyz", "challenge-abc"));
    assertEquals(url.searchParams.get("client_id"), "client-123");
    assertEquals(url.searchParams.get("response_type"), "code");
    assertEquals(url.searchParams.get("state"), "state-xyz");
    assertEquals(url.searchParams.get("code_challenge"), "challenge-abc");
    assertEquals(url.searchParams.get("code_challenge_method"), "S256");

    const scope = url.searchParams.get("scope") ?? "";
    for (
      const s of [
        "products_read",
        "products_write",
        "orders_read",
        "orders_write",
        "offers_read",
        "offers_write",
        "shop_read",
      ]
    ) {
      assert(scope.includes(s), `scope missing ${s}`);
    }
    assertEquals(scope, getDepopScopes());
  } finally {
    if (prev.id != null) Deno.env.set("DEPOP_CLIENT_ID", prev.id);
    else Deno.env.delete("DEPOP_CLIENT_ID");
    if (prev.redirect != null) Deno.env.set("DEPOP_REDIRECT_URI", prev.redirect);
    else Deno.env.delete("DEPOP_REDIRECT_URI");
    if (prev.scopes != null) Deno.env.set("DEPOP_SCOPES", prev.scopes);
    else Deno.env.delete("DEPOP_SCOPES");
  }
});

// ── Auth-failure classification ───────────────────────────────────────

Deno.test("isPermanentDepopAuthFailure: revoked/4xx permanent, 5xx/429/network transient", () => {
  // Permanent: OAuth grant-error bodies.
  for (
    const m of [
      "Depop token refresh failed (400): {\"error\":\"invalid_grant\"}",
      "Depop token refresh failed (401): invalid_client",
      "token_revoked",
      "Depop token refresh failed (403): forbidden",
    ]
  ) {
    assert(isPermanentDepopAuthFailure(new Error(m)), `should be permanent: ${m}`);
  }
  // Transient: server/rate-limit/network.
  for (
    const m of [
      "Depop token refresh failed (500): upstream error",
      "Depop token refresh failed (503): unavailable",
      "Depop token refresh failed (429): rate limited",
      "network error: connection reset",
    ]
  ) {
    assert(!isPermanentDepopAuthFailure(new Error(m)), `should be transient: ${m}`);
  }
});
