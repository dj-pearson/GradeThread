// US-1661: pure helpers of the Whatnot connector — PKCE, the permanent-vs-
// transient auth-failure classifier, the WHATNOT_ENABLED gate, and the consent-
// URL builder. The DB-touching connect/refresh paths are covered by the adapter
// + (once partner access lands) a sandbox.

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
  getWhatnotScopes,
  isWhatnotEnabled,
  isPermanentWhatnotAuthFailure,
} = await import("../lib/whatnot-client.ts");

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
  assert(!challenge.includes("=") && !challenge.includes("+") && !challenge.includes("/"));
});

Deno.test("isWhatnotEnabled requires both the flag AND creds (default off)", () => {
  const prev = {
    flag: Deno.env.get("WHATNOT_ENABLED"),
    id: Deno.env.get("WHATNOT_CLIENT_ID"),
    secret: Deno.env.get("WHATNOT_CLIENT_SECRET"),
  };
  try {
    Deno.env.delete("WHATNOT_ENABLED");
    Deno.env.delete("WHATNOT_CLIENT_ID");
    Deno.env.delete("WHATNOT_CLIENT_SECRET");
    assert(!isWhatnotEnabled(), "off by default");

    Deno.env.set("WHATNOT_ENABLED", "true");
    assert(!isWhatnotEnabled(), "flag without creds stays off");

    Deno.env.set("WHATNOT_ENABLED", "false");
    Deno.env.set("WHATNOT_CLIENT_ID", "client");
    Deno.env.set("WHATNOT_CLIENT_SECRET", "secret");
    assert(!isWhatnotEnabled(), "creds without flag stays off");

    for (const truthy of ["true", "1", "yes", "on"]) {
      Deno.env.set("WHATNOT_ENABLED", truthy);
      assert(isWhatnotEnabled(), `flag=${truthy} should enable`);
    }
  } finally {
    if (prev.flag != null) Deno.env.set("WHATNOT_ENABLED", prev.flag);
    else Deno.env.delete("WHATNOT_ENABLED");
    if (prev.id != null) Deno.env.set("WHATNOT_CLIENT_ID", prev.id);
    else Deno.env.delete("WHATNOT_CLIENT_ID");
    if (prev.secret != null) Deno.env.set("WHATNOT_CLIENT_SECRET", prev.secret);
    else Deno.env.delete("WHATNOT_CLIENT_SECRET");
  }
});

Deno.test("buildConsentUrl carries PKCE + the modeled scope set", () => {
  const prev = {
    id: Deno.env.get("WHATNOT_CLIENT_ID"),
    redirect: Deno.env.get("WHATNOT_REDIRECT_URI"),
    scopes: Deno.env.get("WHATNOT_SCOPES"),
  };
  try {
    Deno.env.set("WHATNOT_CLIENT_ID", "client-123");
    Deno.env.set(
      "WHATNOT_REDIRECT_URI",
      "https://functions.gradethread.com/api/flipdesk/whatnot/oauth/callback",
    );
    Deno.env.delete("WHATNOT_SCOPES");

    const url = new URL(buildConsentUrl("state-xyz", "challenge-abc"));
    assertEquals(url.searchParams.get("client_id"), "client-123");
    assertEquals(url.searchParams.get("response_type"), "code");
    assertEquals(url.searchParams.get("state"), "state-xyz");
    assertEquals(url.searchParams.get("code_challenge"), "challenge-abc");
    assertEquals(url.searchParams.get("code_challenge_method"), "S256");
    assertEquals(url.searchParams.get("scope"), getWhatnotScopes());
  } finally {
    if (prev.id != null) Deno.env.set("WHATNOT_CLIENT_ID", prev.id);
    else Deno.env.delete("WHATNOT_CLIENT_ID");
    if (prev.redirect != null) Deno.env.set("WHATNOT_REDIRECT_URI", prev.redirect);
    else Deno.env.delete("WHATNOT_REDIRECT_URI");
    if (prev.scopes != null) Deno.env.set("WHATNOT_SCOPES", prev.scopes);
    else Deno.env.delete("WHATNOT_SCOPES");
  }
});

Deno.test("isPermanentWhatnotAuthFailure: revoked/4xx permanent, 5xx/429/network transient", () => {
  for (
    const m of [
      'Whatnot token refresh failed (400): {"error":"invalid_grant"}',
      "Whatnot token refresh failed (401): invalid_client",
      "token_revoked",
      "Whatnot token refresh failed (403): forbidden",
    ]
  ) {
    assert(isPermanentWhatnotAuthFailure(new Error(m)), `should be permanent: ${m}`);
  }
  for (
    const m of [
      "Whatnot token refresh failed (500): upstream error",
      "Whatnot token refresh failed (429): rate limited",
      "network error: connection reset",
    ]
  ) {
    assert(!isPermanentWhatnotAuthFailure(new Error(m)), `should be transient: ${m}`);
  }
});
