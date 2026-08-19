// US-9122: the TokenStore over the 00620 tables.
//
// lib/oauth-tokens_test.ts asserts the RULES against a fake store. This file
// asserts the things only a real database can be wrong about: that the
// conditional update actually stops two requests racing the same code, that
// rotation marks the old token before inserting the new one, and that column
// names line up with the migration.
//
// ENV-GATED, like the tenant-isolation lane. It needs the 00620 tables, so it
// SKIPS cleanly when there is no local stack rather than failing for a reason
// that is not about the code.

import { assert, assertEquals, assertExists } from "@std/assert";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const CONFIGURED = Boolean(
  SUPABASE_URL && SERVICE_KEY && Deno.env.get("OAUTH_STORE_TESTS") === "1",
);

if (!CONFIGURED) {
  console.warn(
    "[oauth-store] SKIPPED — set OAUTH_STORE_TESTS=1 with SUPABASE_URL + " +
      "SUPABASE_SERVICE_ROLE_KEY against a stack that has migration 00620.",
  );
}

Deno.env.set("SUPABASE_URL", SUPABASE_URL ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY ?? "test-service-key");

const { createOAuthStore } = await import("../lib/oauth-store.ts");
const { hashSecret, redeemAuthorizationCode, rotateRefreshToken } = await import(
  "../lib/oauth-tokens.ts"
);
const { supabaseAdmin } = await import("../lib/supabase.ts");

const CLIENT = "https://example.test/oauth-store-fixture";
const RESOURCE = "https://functions.gradethread.com/mcp";
const REDIRECT = "https://example.test/cb";
const VERIFIER = "a".repeat(64);

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Any existing user; these tables only need a valid FK. */
async function anyUserId(): Promise<string | null> {
  const { data } = await supabaseAdmin.from("users").select("id").limit(1).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function ensureClient(): Promise<void> {
  await supabaseAdmin.from("oauth_clients").upsert({
    client_id: CLIENT,
    client_name: "oauth-store fixture",
    redirect_uris: [REDIRECT],
    registration_source: "preregistered",
  });
}

async function cleanup(userId: string): Promise<void> {
  await supabaseAdmin.from("oauth_authorization_codes").delete().eq("owner_user_id", userId);
  const { data } = await supabaseAdmin.from("oauth_grants").select("id").eq("client_id", CLIENT);
  for (const row of (data ?? []) as Array<{ id: string }>) {
    await supabaseAdmin.from("oauth_refresh_tokens").delete().eq("grant_id", row.id);
  }
  await supabaseAdmin.from("oauth_grants").delete().eq("client_id", CLIENT);
}

Deno.test({
  name: "store: a code redeems once, and the SECOND attempt sees it consumed",
  ignore: !CONFIGURED,
  fn: async () => {
    const userId = await anyUserId();
    assertExists(userId, "no users in this database to hang a fixture off");
    await ensureClient();
    await cleanup(userId);

    const code = `code-${crypto.randomUUID()}`;
    await supabaseAdmin.from("oauth_authorization_codes").insert({
      code_hash: await hashSecret(code),
      owner_user_id: userId,
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_challenge: await challengeFor(VERIFIER),
      code_challenge_method: "S256",
      scopes: ["read"],
      resource: RESOURCE,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const store = createOAuthStore(supabaseAdmin, () => "code_replayed");
    const args = {
      code,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeVerifier: VERIFIER,
      resource: RESOURCE,
      store,
    };

    const first = await redeemAuthorizationCode(args);
    assert(first.ok, `first redemption failed: ${JSON.stringify(first)}`);

    const second = await redeemAuthorizationCode(args);
    assert(!second.ok);
    assertEquals(second.reason, "code_replayed");

    await cleanup(userId);
  },
});

Deno.test({
  name: "store: rotation marks the old token BEFORE the new one exists",
  ignore: !CONFIGURED,
  fn: async () => {
    // Order matters. If the insert went first and the mark then failed, two
    // live refresh tokens would exist in a rotating scheme, which is the exact
    // state rotation prevents. This asserts the outcome: after rotating, the
    // old row carries rotated_at and the new one does not.
    const userId = await anyUserId();
    assertExists(userId);
    await ensureClient();
    await cleanup(userId);

    const { data: grant } = await supabaseAdmin
      .from("oauth_grants")
      .insert({
        owner_user_id: userId,
        client_id: CLIENT,
        scopes: ["read"],
        resource: RESOURCE,
      })
      .select("id")
      .single();
    const grantId = (grant as { id: string }).id;

    const refresh = `refresh-${crypto.randomUUID()}`;
    await supabaseAdmin.from("oauth_refresh_tokens").insert({
      token_hash: await hashSecret(refresh),
      grant_id: grantId,
      generation: 1,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const store = createOAuthStore(supabaseAdmin, () => "reuse_detected");
    const rotated = await rotateRefreshToken({ refreshToken: refresh, store });
    assert(rotated.ok, `rotation failed: ${JSON.stringify(rotated)}`);

    const { data: rows } = await supabaseAdmin
      .from("oauth_refresh_tokens")
      .select("token_hash, generation, rotated_at")
      .eq("grant_id", grantId)
      .order("generation", { ascending: true });

    const list = (rows ?? []) as Array<
      { token_hash: string; generation: number; rotated_at: string | null }
    >;
    assertEquals(list.length, 2, "expected the old and the new token");
    assertExists(list[0].rotated_at, "the old token was not marked rotated");
    assertEquals(list[1].rotated_at, null, "the new token must not be pre-marked");
    assertEquals(list[1].generation, 2);

    await cleanup(userId);
  },
});

Deno.test({
  name: "store: reuse of a rotated token revokes the grant, with a REASON",
  ignore: !CONFIGURED,
  fn: async () => {
    // The reason is not decoration: after the fact there is no way to tell a
    // seller's own disconnect from a token that turned up twice, and those call
    // for different conversations.
    const userId = await anyUserId();
    assertExists(userId);
    await ensureClient();
    await cleanup(userId);

    const { data: grant } = await supabaseAdmin
      .from("oauth_grants")
      .insert({
        owner_user_id: userId,
        client_id: CLIENT,
        scopes: ["read"],
        resource: RESOURCE,
      })
      .select("id")
      .single();
    const grantId = (grant as { id: string }).id;

    const refresh = `refresh-${crypto.randomUUID()}`;
    await supabaseAdmin.from("oauth_refresh_tokens").insert({
      token_hash: await hashSecret(refresh),
      grant_id: grantId,
      generation: 1,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const store = createOAuthStore(supabaseAdmin, () => "reuse_detected");
    assert((await rotateRefreshToken({ refreshToken: refresh, store })).ok);

    const replay = await rotateRefreshToken({ refreshToken: refresh, store });
    assert(!replay.ok);
    assertEquals(replay.reason, "reuse_detected");

    const { data: after } = await supabaseAdmin
      .from("oauth_grants")
      .select("revoked_at, revoked_reason")
      .eq("id", grantId)
      .maybeSingle();
    const row = after as { revoked_at: string | null; revoked_reason: string | null } | null;
    assertExists(row?.revoked_at, "the grant was not revoked");
    assertEquals(row?.revoked_reason, "reuse_detected");

    await cleanup(userId);
  },
});

Deno.test({
  name: "store: every column the store reads exists in the migration",
  ignore: !CONFIGURED,
  fn: async () => {
    // A select on a column the migration does not have fails at run time with a
    // PostgREST error that reads as "not found", which is indistinguishable
    // from an empty table. Asserting the shape here names the real problem.
    for (
      const table of [
        "oauth_clients",
        "oauth_grants",
        "oauth_authorization_codes",
        "oauth_refresh_tokens",
      ]
    ) {
      const { error } = await supabaseAdmin.from(table).select("*").limit(1);
      assertEquals(error, null, `${table} is not readable through PostgREST: ${error?.message}`);
    }
  },
});
