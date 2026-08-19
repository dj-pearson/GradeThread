// US-9122: the token and revoke endpoints, end to end.
//
// The rules live in oauth-tokens_test.ts and the storage in oauth-store_test.ts.
// What this file asserts is the HTTP contract a real client depends on, and the
// two places an endpoint can undo a correct rule underneath it:
//
//   • by SAYING WHY a grant was rejected, which turns the endpoint into an
//     oracle a caller probes one parameter at a time;
//   • by letting the REQUEST override the grant — accepting a refresh token for
//     a client or a resource it was not issued to.
//
// Env-gated on the 00620 tables, like oauth-store_test.ts.

import { assert, assertEquals, assertExists } from "@std/assert";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const CONFIGURED = Boolean(
  SUPABASE_URL && SERVICE_KEY && Deno.env.get("OAUTH_STORE_TESTS") === "1",
);

if (!CONFIGURED) {
  console.warn("[oauth-endpoints] SKIPPED — set OAUTH_STORE_TESTS=1 against a stack with 00620.");
}

Deno.env.set("SUPABASE_URL", SUPABASE_URL ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY ?? "test-service-key");
Deno.env.set("MCP_OAUTH_ENABLED", "true");

const { oauthRoutes } = await import("../routes/oauth.ts");
const { resourceIdentifier } = await import("../lib/oauth-metadata.ts");
const { hashSecret } = await import("../lib/oauth-tokens.ts");
const { supabaseAdmin } = await import("../lib/supabase.ts");

const CLIENT = "https://example.test/oauth-endpoint-fixture";
const REDIRECT = "https://example.test/cb";
const VERIFIER = "a".repeat(64);
const RESOURCE = resourceIdentifier();

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function anyUserId(): Promise<string | null> {
  const { data } = await supabaseAdmin.from("users").select("id").limit(1).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function setup(): Promise<{ userId: string; code: string }> {
  const userId = (await anyUserId())!;
  await supabaseAdmin.from("oauth_clients").upsert({
    client_id: CLIENT,
    client_name: "endpoint fixture",
    redirect_uris: [REDIRECT],
    registration_source: "preregistered",
  });
  await cleanup();

  const code = `code-${crypto.randomUUID()}`;
  await supabaseAdmin.from("oauth_authorization_codes").insert({
    code_hash: await hashSecret(code),
    owner_user_id: userId,
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    code_challenge: await challengeFor(VERIFIER),
    code_challenge_method: "S256",
    scopes: ["read", "submit"],
    resource: RESOURCE,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  return { userId, code };
}

async function cleanup(): Promise<void> {
  const { data } = await supabaseAdmin.from("oauth_grants").select("id").eq("client_id", CLIENT);
  for (const row of (data ?? []) as Array<{ id: string }>) {
    await supabaseAdmin.from("oauth_access_tokens").delete().eq("grant_id", row.id);
    await supabaseAdmin.from("oauth_refresh_tokens").delete().eq("grant_id", row.id);
  }
  await supabaseAdmin.from("oauth_authorization_codes").delete().eq("client_id", CLIENT);
  await supabaseAdmin.from("oauth_grants").delete().eq("client_id", CLIENT);
}

async function post(path: string, form: Record<string, string>) {
  const res = await oauthRoutes.request(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    cacheControl: res.headers.get("Cache-Control"),
    json: text ? JSON.parse(text) : {},
  };
}

function codeExchange(code: string, overrides: Record<string, string> = {}) {
  return {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: RESOURCE,
    ...overrides,
  };
}

Deno.test({
  name: "token: a valid code exchanges for an access and refresh token",
  ignore: !CONFIGURED,
  fn: async () => {
    const { code } = await setup();
    const { status, json, cacheControl } = await post("/token", codeExchange(code));

    assertEquals(status, 200, JSON.stringify(json));
    assertEquals(json.token_type, "Bearer");
    assert(String(json.access_token).startsWith("gta_"));
    assert(String(json.refresh_token).startsWith("gtr_"));
    assertEquals(json.scope, "read submit");
    assert(json.expires_in > 0 && json.expires_in <= 3600);
    // A cached token response is a cached credential.
    assertEquals(cacheControl, "no-store");

    await cleanup();
  },
});

Deno.test({
  name: "token: the access token is stored HASHED, never in plaintext",
  ignore: !CONFIGURED,
  fn: async () => {
    const { code } = await setup();
    const { json } = await post("/token", codeExchange(code));

    const { data } = await supabaseAdmin
      .from("oauth_access_tokens")
      .select("token_hash")
      .eq("token_hash", await hashSecret(String(json.access_token)))
      .maybeSingle();
    assertExists(data, "the access token was not stored under its hash");

    const { data: all } = await supabaseAdmin.from("oauth_access_tokens").select("token_hash");
    for (const row of (all ?? []) as Array<{ token_hash: string }>) {
      assert(
        !row.token_hash.includes(String(json.access_token)),
        "a raw access token appears in the table",
      );
    }

    await cleanup();
  },
});

Deno.test({
  name: "token: EVERY code failure is the same invalid_grant, so it is not an oracle",
  ignore: !CONFIGURED,
  fn: async () => {
    // The reasons are genuinely different — replayed, expired, wrong redirect,
    // wrong PKCE — and saying which lets a caller retry against the same code
    // varying one parameter at a time until something lines up.
    //
    // Each case gets a FRESHLY seeded code, because setup() clears the previous
    // one. The first version of this test seeded three codes up front and then
    // exercised the last one three times, one of which was a fully valid
    // request that correctly returned 200 — a test bug that read as an endpoint
    // bug.
    const descriptions = new Set<string>();

    async function expectInvalidGrant(
      label: string,
      build: (code: string) => Record<string, string>,
    ) {
      const { code } = await setup();
      const { status, json } = await post("/token", build(code));
      assertEquals(status, 400, `${label}: ${JSON.stringify(json)}`);
      assertEquals(json.error, "invalid_grant", label);
      descriptions.add(String(json.error_description));
    }

    await expectInvalidGrant(
      "wrong redirect_uri",
      (code) => codeExchange(code, { redirect_uri: "https://example.test/other" }),
    );
    await expectInvalidGrant(
      "wrong PKCE verifier",
      (code) => codeExchange(code, { code_verifier: "b".repeat(64) }),
    );
    await expectInvalidGrant("unknown code", () => codeExchange("never-issued"));

    // A replay: exchange once for real, then again.
    const { code } = await setup();
    assertEquals((await post("/token", codeExchange(code))).status, 200);
    const replay = await post("/token", codeExchange(code));
    assertEquals(replay.status, 400);
    assertEquals(replay.json.error, "invalid_grant");
    descriptions.add(String(replay.json.error_description));

    assertEquals(
      descriptions.size,
      1,
      `the endpoint gave ${descriptions.size} different descriptions: ${
        [...descriptions].join(" | ")
      }`,
    );
    await cleanup();
  },
});

Deno.test({
  name: "token: a refresh token cannot be redeemed for a different client",
  ignore: !CONFIGURED,
  fn: async () => {
    // The GRANT is the authority, not the request. Without this check a leaked
    // refresh token could be moved to whatever client the attacker controls.
    const { code } = await setup();
    const first = await post("/token", codeExchange(code));
    assertEquals(first.status, 200);

    await supabaseAdmin.from("oauth_clients").upsert({
      client_id: "https://example.test/other-client",
      redirect_uris: [REDIRECT],
      registration_source: "preregistered",
    });

    const { status, json } = await post("/token", {
      grant_type: "refresh_token",
      refresh_token: String(first.json.refresh_token),
      client_id: "https://example.test/other-client",
      resource: RESOURCE,
    });
    assertEquals(status, 400);
    assertEquals(json.error, "invalid_grant");

    await cleanup();
    await supabaseAdmin.from("oauth_clients").delete().eq(
      "client_id",
      "https://example.test/other-client",
    );
  },
});

Deno.test({
  name: "token: the resource must name this server exactly",
  ignore: !CONFIGURED,
  fn: async () => {
    // RFC 8707. A token minted without knowing what it is for can be presented
    // anywhere that trusts the same authorization server.
    const { code } = await setup();
    const { status, json } = await post(
      "/token",
      codeExchange(code, { resource: "https://someone-else.example.com/mcp" }),
    );
    assertEquals(status, 400);
    assertEquals(json.error, "invalid_target");
    await cleanup();
  },
});

Deno.test({
  name: "token: a missing resource is refused rather than defaulted",
  ignore: !CONFIGURED,
  fn: async () => {
    const { code } = await setup();
    const body = codeExchange(code);
    delete (body as Record<string, string>).resource;
    const { status, json } = await post("/token", body);
    assertEquals(status, 400);
    assertEquals(json.error, "invalid_target");
    await cleanup();
  },
});

Deno.test({
  name: "token: an unknown grant_type is reported as such",
  ignore: !CONFIGURED,
  fn: async () => {
    const { status, json } = await post("/token", {
      grant_type: "password",
      client_id: CLIENT,
      resource: RESOURCE,
    });
    assertEquals(status, 400);
    assertEquals(json.error, "unsupported_grant_type");
  },
});

Deno.test({
  name: "revoke: revoking one token kills the whole grant",
  ignore: !CONFIGURED,
  fn: async () => {
    // More than RFC 7009 requires, and what a seller means by "disconnect".
    // Revoking an access token while its refresh token keeps minting new ones
    // is a revocation that does not revoke.
    const { code } = await setup();
    const issued = await post("/token", codeExchange(code));
    assertEquals(issued.status, 200);

    const revoked = await post("/revoke", { token: String(issued.json.access_token) });
    assertEquals(revoked.status, 200);

    const refreshAfter = await post("/token", {
      grant_type: "refresh_token",
      refresh_token: String(issued.json.refresh_token),
      client_id: CLIENT,
      resource: RESOURCE,
    });
    assertEquals(refreshAfter.status, 400, "the refresh token still worked after revocation");

    const { data } = await supabaseAdmin
      .from("oauth_grants")
      .select("revoked_at, revoked_reason")
      .eq("client_id", CLIENT)
      .maybeSingle();
    const row = data as { revoked_at: string | null; revoked_reason: string | null } | null;
    assertExists(row?.revoked_at);
    assertEquals(row?.revoked_reason, "user");

    await cleanup();
  },
});

Deno.test({
  name: "revoke: an unknown token is still 200, per RFC 7009",
  ignore: !CONFIGURED,
  fn: async () => {
    // Reporting "unknown token" confirms which tokens are real to anyone
    // willing to ask, and a client's cleanup should not fail for revoking
    // something twice.
    assertEquals((await post("/revoke", { token: "gta_never-existed" })).status, 200);
    assertEquals((await post("/revoke", {})).status, 200);
  },
});

Deno.test({
  name: "the endpoints 404 when the OAuth flow is not enabled",
  ignore: !CONFIGURED,
  fn: async () => {
    Deno.env.set("MCP_OAUTH_ENABLED", "false");
    try {
      assertEquals((await post("/token", { grant_type: "refresh_token" })).status, 404);
      assertEquals((await post("/revoke", { token: "x" })).status, 404);
    } finally {
      Deno.env.set("MCP_OAUTH_ENABLED", "true");
    }
  },
});
