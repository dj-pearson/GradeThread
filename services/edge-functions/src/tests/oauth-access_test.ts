// US-9122 AC10: an OAuth access token at /mcp.
//
// The property that matters most is REVOCATION. A seller clicking disconnect
// has to stop the tokens already issued, or "disconnect" quietly means
// "disconnect within an hour", and nobody finds that out until it matters.
//
// After that: expiry, audience, and the fact that every failure looks identical
// to the caller. Telling an unknown token apart from a revoked one tells
// someone holding a stolen token which it is.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { looksLikeOAuthAccessToken, resolveOAuthAccessToken } = await import(
  "../lib/oauth-access.ts"
);
const { hashSecret } = await import("../lib/oauth-tokens.ts");
const { resourceIdentifier } = await import("../lib/oauth-metadata.ts");

const TOKEN = "gta_" + "a".repeat(32);
const NOW = 1_700_000_000_000;

function grantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "grant-1",
    owner_user_id: "user-1",
    client_id: "https://claude.ai/metadata",
    resource: resourceIdentifier(),
    revoked_at: null,
    ...overrides,
  };
}

/** A db stub that returns one access-token row joined to its grant. */
function stubDb(row: Record<string, unknown> | null) {
  const queried: string[] = [];
  return {
    queried,
    db: {
      from() {
        return {
          select: () => ({
            eq: (_col: string, value: string) => {
              queried.push(value);
              return { maybeSingle: () => Promise.resolve({ data: row, error: null }) };
            },
          }),
        };
      },
    },
  };
}

function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    grant_id: "grant-1",
    scopes: ["read", "submit"],
    expires_at: new Date(NOW + 3_600_000).toISOString(),
    oauth_grants: grantRow(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

Deno.test("only our access-token prefix is treated as one", () => {
  // A malformed API key must still get the API-key error, not a confusing
  // OAuth one, so the prefix is what routes the credential.
  assert(looksLikeOAuthAccessToken(TOKEN));
  assert(!looksLikeOAuthAccessToken("gt_live_something"));
  assert(!looksLikeOAuthAccessToken("gtr_a_refresh_token"));
  assert(!looksLikeOAuthAccessToken("Bearer nonsense"));
});

Deno.test("a non-oauth token is reported as not_oauth, not as invalid", async () => {
  // The middleware needs to tell "this is not mine" from "this is mine and it
  // is bad", because only the second is a 401 about the token.
  const { db } = stubDb(null);
  const result = await resolveOAuthAccessToken("gt_live_key", db, NOW);
  assert(!result.ok);
  assertEquals(result.reason, "not_oauth");
});

Deno.test("a valid token resolves to the grant's owner and the TOKEN's scopes", async () => {
  const { db } = stubDb(tokenRow());
  const result = await resolveOAuthAccessToken(TOKEN, db, NOW);
  assert(result.ok, JSON.stringify(result));
  assertEquals(result.identity.userId, "user-1");
  assertEquals(result.identity.grantId, "grant-1");
  assertEquals(result.identity.scopes, ["read", "submit"]);
});

Deno.test("the token is looked up by HASH, never by its plaintext", async () => {
  const { db, queried } = stubDb(tokenRow());
  await resolveOAuthAccessToken(TOKEN, db, NOW);
  assertEquals(queried.length, 1);
  assertEquals(queried[0], await hashSecret(TOKEN));
  assert(queried[0] !== TOKEN, "the plaintext token was used as the lookup key");
});

Deno.test("a REVOKED grant stops a token that has not expired", async () => {
  // The whole point of the check. Without it, clicking disconnect means
  // "disconnect within an hour" and nobody finds out until it matters.
  const { db } = stubDb(tokenRow({ oauth_grants: grantRow({ revoked_at: "2026-01-01T00:00:00Z" }) }));
  const result = await resolveOAuthAccessToken(TOKEN, db, NOW);
  assert(!result.ok);
  assertEquals(result.reason, "invalid");
});

Deno.test("an expired token is refused, on the boundary too", async () => {
  const expired = stubDb(tokenRow({ expires_at: new Date(NOW - 1).toISOString() }));
  assert(!(await resolveOAuthAccessToken(TOKEN, expired.db, NOW)).ok);

  // Exactly at the expiry instant is expired, not valid.
  const exact = stubDb(tokenRow({ expires_at: new Date(NOW).toISOString() }));
  assert(!(await resolveOAuthAccessToken(TOKEN, exact.db, NOW)).ok);

  const alive = stubDb(tokenRow({ expires_at: new Date(NOW + 1).toISOString() }));
  assert((await resolveOAuthAccessToken(TOKEN, alive.db, NOW)).ok);
});

Deno.test("a token minted for ANOTHER resource is refused (RFC 8707)", async () => {
  // The confused-deputy hole resource indicators exist to close. Accepting a
  // stranger's token because it parses is exactly how it stays open.
  const { db } = stubDb(
    tokenRow({ oauth_grants: grantRow({ resource: "https://someone-else.example.com/mcp" }) }),
  );
  const result = await resolveOAuthAccessToken(TOKEN, db, NOW);
  assert(!result.ok);
  assertEquals(result.reason, "invalid");
});

Deno.test("an unknown token and a revoked one are indistinguishable to the caller", async () => {
  // Saying which tells someone holding a stolen token what they are holding.
  const unknown = await resolveOAuthAccessToken(TOKEN, stubDb(null).db, NOW);
  const revoked = await resolveOAuthAccessToken(
    TOKEN,
    stubDb(tokenRow({ oauth_grants: grantRow({ revoked_at: "2026-01-01T00:00:00Z" }) })).db,
    NOW,
  );
  assertEquals(unknown, revoked);
});

Deno.test("a missing grant join is refused rather than assumed", async () => {
  const { db } = stubDb(tokenRow({ oauth_grants: null }));
  const result = await resolveOAuthAccessToken(TOKEN, db, NOW);
  assert(!result.ok);
});

Deno.test("a token with NO scopes resolves to none, not to everything", async () => {
  // Fails closed. An empty scope array must mean "can call nothing", which is
  // what the dispatcher's per-tool check then enforces.
  const { db } = stubDb(tokenRow({ scopes: null }));
  const result = await resolveOAuthAccessToken(TOKEN, db, NOW);
  assert(result.ok);
  assertEquals(result.identity.scopes, []);
});

// ---------------------------------------------------------------------------
// the wiring
// ---------------------------------------------------------------------------

Deno.test("the middleware routes an access token before the API-key path", async () => {
  // Order matters: the API-key resolver would report a well-formed-looking
  // access token as an unknown KEY, which is a true statement and a useless
  // error. Source-guarded because reaching it needs a database.
  const src = await Deno.readTextFile(
    new URL("../middleware/mcp-auth.ts", import.meta.url),
  );
  const oauthBranch = src.indexOf("looksLikeOAuthAccessToken(bearer)");
  const keyPath = src.indexOf("await resolveApiKeyIdentity(rawKey)");
  assert(oauthBranch > -1, "the middleware no longer accepts OAuth access tokens");
  assert(oauthBranch < keyPath, "the API-key path now runs first");
});

Deno.test("an OAuth identity fills the SAME variables an API key does", async () => {
  // Every tool reads userId and apiKeyScopes, and every subject (audit, budget,
  // confirm token) reads apiKeyId. A second set of variables would mean each of
  // those had to learn about a second kind of caller.
  const src = await Deno.readTextFile(
    new URL("../middleware/mcp-auth.ts", import.meta.url),
  );
  const fn = src.slice(src.indexOf("function applyOAuthIdentity"));
  for (const key of ["userId", "apiKeyId", "apiKeyScopes", "apiKeyPlan"]) {
    assert(fn.includes(`c.set("${key}"`), `applyOAuthIdentity does not set ${key}`);
  }
  assert(
    /c\.set\("apiKeyId", identity\.grantId\)/.test(fn),
    "the subject must be the GRANT id, so revoking a grant revokes its budget " +
      "and audit trail with it",
  );
});
