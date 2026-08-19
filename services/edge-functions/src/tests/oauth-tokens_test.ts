// US-9122: the authorization server's security core.
//
// Every test here corresponds to an attack. That framing is deliberate: an
// OAuth implementation that passes a happy-path test and nothing else is the
// normal way these ship broken, because the happy path is the one part everyone
// exercises by hand.
//
// The store is injected, so all of it runs with no database — which is the
// reason this could be built and reviewed before the migration exists.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  AUTHORIZATION_CODE_TTL_MS,
  generateOpaqueToken,
  hashSecret,
  isAudienceValid,
  redeemAuthorizationCode,
  rotateRefreshToken,
  timingSafeEqual,
  verifyPkce,
} = await import("../lib/oauth-tokens.ts");

type CodeRecord = Awaited<ReturnType<typeof makeStore>>["codes"] extends
  Map<string, infer T> ? T : never;

const NOW = Date.parse("2026-08-18T12:00:00.000Z");
const RESOURCE = "https://functions.gradethread.com/mcp";
const CLIENT = "https://claude.ai/mcp-client";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

/** A verifier of legal length from the unreserved set. */
const VERIFIER = "a".repeat(64);

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeStore() {
  const codes = new Map<string, Record<string, unknown>>();
  const grants = new Map<string, Record<string, unknown>>();
  const refreshes = new Map<string, Record<string, unknown>>();
  const revoked: string[] = [];

  const store = {
    findCode: (hash: string) => Promise.resolve((codes.get(hash) ?? null) as never),
    markCodeConsumed: (hash: string, nowMs: number) => {
      const c = codes.get(hash);
      if (c) c.consumedAtMs = nowMs;
      return Promise.resolve();
    },
    findGrant: (id: string) => Promise.resolve((grants.get(id) ?? null) as never),
    revokeGrant: (id: string, nowMs: number) => {
      revoked.push(id);
      const g = grants.get(id);
      if (g) g.revokedAtMs = nowMs;
      return Promise.resolve();
    },
    findRefresh: (hash: string) => Promise.resolve((refreshes.get(hash) ?? null) as never),
    rotateRefresh: (oldHash: string, next: Record<string, unknown>, nowMs: number) => {
      const old = refreshes.get(oldHash);
      if (old) old.rotatedAtMs = nowMs;
      refreshes.set(next.tokenHash as string, next);
      return Promise.resolve();
    },
  };

  return { codes, grants, refreshes, revoked, store };
}

async function seedCode(
  s: ReturnType<typeof makeStore>,
  code: string,
  overrides: Record<string, unknown> = {},
) {
  const hash = await hashSecret(code);
  s.codes.set(hash, {
    codeHash: hash,
    clientId: CLIENT,
    userId: "user-1",
    redirectUri: REDIRECT,
    codeChallenge: await challengeFor(VERIFIER),
    codeChallengeMethod: "S256",
    scopes: ["read"],
    resource: RESOURCE,
    expiresAtMs: NOW + AUTHORIZATION_CODE_TTL_MS,
    ...overrides,
  });
  return hash;
}

function baseArgs(s: ReturnType<typeof makeStore>, code: string) {
  return {
    code,
    clientId: CLIENT,
    redirectUri: REDIRECT,
    codeVerifier: VERIFIER,
    resource: RESOURCE,
    store: s.store as never,
    nowMs: NOW + 1000,
  };
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

Deno.test("PKCE: the right verifier matches its challenge", async () => {
  assert(await verifyPkce(VERIFIER, await challengeFor(VERIFIER), "S256"));
});

Deno.test("PKCE: a different verifier does not", async () => {
  assert(!await verifyPkce("b".repeat(64), await challengeFor(VERIFIER), "S256"));
});

Deno.test("PKCE: `plain` is refused even when the values match", async () => {
  // plain makes PKCE decorative: whoever intercepted the authorization request
  // also has the verifier. OAuth 2.1 removed it, and our metadata advertises
  // S256 alone — accepting plain would be honouring something we said we do not.
  assert(!await verifyPkce(VERIFIER, VERIFIER, "plain"));
  assert(!await verifyPkce(VERIFIER, await challengeFor(VERIFIER), "plain"));
});

Deno.test("PKCE: a verifier below the RFC length floor is refused", async () => {
  // 42 characters is brute-forceable and the floor is the only thing stopping it.
  const short = "a".repeat(42);
  assert(!await verifyPkce(short, await challengeFor(short), "S256"));
});

Deno.test("PKCE: a verifier above the ceiling is refused", async () => {
  const long = "a".repeat(129);
  assert(!await verifyPkce(long, await challengeFor(long), "S256"));
});

Deno.test("PKCE: a verifier outside the unreserved character set is refused", async () => {
  const bad = "a".repeat(60) + "!@#$";
  assert(!await verifyPkce(bad, await challengeFor(bad), "S256"));
});

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

Deno.test("a valid code redeems once", async () => {
  const s = makeStore();
  await seedCode(s, "code-1");
  const result = await redeemAuthorizationCode(baseArgs(s, "code-1"));
  assert(result.ok, `expected success, got ${JSON.stringify(result)}`);
});

Deno.test("REPLAY: a second use is refused AND revokes the grant it produced", async () => {
  // The rule most worth getting right. A code presented twice means the client
  // is broken or someone else has it, and there is no way to tell which from
  // here — so the safe reading is the second, and the grant dies with it.
  // Detecting the replay while leaving the grant alive is not a defence: the
  // grant is the thing the attacker wanted.
  const s = makeStore();
  const hash = await seedCode(s, "code-1");
  s.grants.set("grant-1", {
    grantId: "grant-1",
    clientId: CLIENT,
    userId: "user-1",
    scopes: ["read"],
    resource: RESOURCE,
  });

  const first = await redeemAuthorizationCode(baseArgs(s, "code-1"));
  assert(first.ok);
  // The endpoint records which grant the code produced.
  s.codes.get(hash)!.grantId = "grant-1";

  const second = await redeemAuthorizationCode(baseArgs(s, "code-1"));
  assert(!second.ok);
  assertEquals(second.reason, "code_replayed");
  assertEquals(s.revoked, ["grant-1"]);
});

Deno.test("a code that fails a later check is STILL spent", async () => {
  // Otherwise the failures become an oracle: a caller retries against the same
  // code, varying one parameter at a time, until something lines up.
  const s = makeStore();
  const hash = await seedCode(s, "code-1");
  const wrongClient = { ...baseArgs(s, "code-1"), clientId: "https://someone.else/client" };

  const first = await redeemAuthorizationCode(wrongClient);
  assert(!first.ok);
  assertEquals(first.reason, "client_mismatch");
  assert(s.codes.get(hash)!.consumedAtMs !== undefined, "the code was not consumed");

  // And the correct client cannot now use it either.
  const second = await redeemAuthorizationCode(baseArgs(s, "code-1"));
  assert(!second.ok);
  assertEquals(second.reason, "code_replayed");
});

Deno.test("an expired code is refused", async () => {
  const s = makeStore();
  await seedCode(s, "code-1");
  const result = await redeemAuthorizationCode({
    ...baseArgs(s, "code-1"),
    nowMs: NOW + AUTHORIZATION_CODE_TTL_MS + 1,
  });
  assert(!result.ok);
  assertEquals(result.reason, "code_expired");
});

Deno.test("the code TTL is short, per OAuth 2.1", () => {
  assert(
    AUTHORIZATION_CODE_TTL_MS <= 10 * 60_000,
    "an authorization code must not live longer than ten minutes",
  );
});

Deno.test("REDIRECT SWAP: a code cannot be exchanged from a different redirect_uri", async () => {
  // This is what stops a code stolen out of one callback being cashed at
  // another. It is compared exactly, not by prefix.
  const s = makeStore();
  await seedCode(s, "code-1");
  const result = await redeemAuthorizationCode({
    ...baseArgs(s, "code-1"),
    redirectUri: "https://claude.ai/api/mcp/auth_callback/extra",
  });
  assert(!result.ok);
  assertEquals(result.reason, "redirect_mismatch");
});

Deno.test("CONFUSED DEPUTY: a code authorized for another resource is refused", async () => {
  const s = makeStore();
  await seedCode(s, "code-1", { resource: "https://someone-else.example.com/mcp" });
  const result = await redeemAuthorizationCode(baseArgs(s, "code-1"));
  assert(!result.ok);
  assertEquals(result.reason, "resource_mismatch");
});

Deno.test("a wrong PKCE verifier is refused even when everything else matches", async () => {
  const s = makeStore();
  await seedCode(s, "code-1");
  const result = await redeemAuthorizationCode({
    ...baseArgs(s, "code-1"),
    codeVerifier: "b".repeat(64),
  });
  assert(!result.ok);
  assertEquals(result.reason, "pkce_failed");
});

Deno.test("an unknown code is refused without touching anything", async () => {
  const s = makeStore();
  const result = await redeemAuthorizationCode(baseArgs(s, "never-issued"));
  assert(!result.ok);
  assertEquals(result.reason, "unknown_code");
  assertEquals(s.revoked, []);
});

// ---------------------------------------------------------------------------
// Refresh rotation
// ---------------------------------------------------------------------------

async function seedRefresh(
  s: ReturnType<typeof makeStore>,
  token: string,
  overrides: Record<string, unknown> = {},
) {
  const hash = await hashSecret(token);
  s.grants.set("grant-1", {
    grantId: "grant-1",
    clientId: CLIENT,
    userId: "user-1",
    scopes: ["read"],
    resource: RESOURCE,
  });
  s.refreshes.set(hash, {
    tokenHash: hash,
    grantId: "grant-1",
    generation: 1,
    expiresAtMs: NOW + 86_400_000,
    ...overrides,
  });
  return hash;
}

Deno.test("a refresh token rotates to a new one", async () => {
  const s = makeStore();
  await seedRefresh(s, "refresh-1");
  const result = await rotateRefreshToken({
    refreshToken: "refresh-1",
    store: s.store as never,
    nowMs: NOW + 1000,
  });
  assert(result.ok);
  assert(result.nextToken.startsWith("gtr_"));
  assert(result.nextToken !== "refresh-1");
});

Deno.test("REUSE DETECTION: presenting an already-rotated token kills the whole grant", async () => {
  // Rotation WITHOUT this is bookkeeping. Issuing a new token each time only
  // helps if presenting an old one is treated as evidence that a copy exists
  // somewhere else. The legitimate client is logged out and re-authorizes,
  // which is cheap; the attacker's copy dies with it, which is the point.
  const s = makeStore();
  await seedRefresh(s, "refresh-1");

  const first = await rotateRefreshToken({
    refreshToken: "refresh-1",
    store: s.store as never,
    nowMs: NOW + 1000,
  });
  assert(first.ok);

  const replay = await rotateRefreshToken({
    refreshToken: "refresh-1",
    store: s.store as never,
    nowMs: NOW + 2000,
  });
  assert(!replay.ok);
  assertEquals(replay.reason, "reuse_detected");
  assertEquals(s.revoked, ["grant-1"]);
});

Deno.test("after reuse revokes the grant, the NEW token stops working too", async () => {
  // The whole chain dies, not just the replayed link — otherwise the attacker
  // keeps whatever they rotated into.
  const s = makeStore();
  await seedRefresh(s, "refresh-1");
  const first = await rotateRefreshToken({
    refreshToken: "refresh-1",
    store: s.store as never,
    nowMs: NOW + 1000,
  });
  assert(first.ok);

  await rotateRefreshToken({
    refreshToken: "refresh-1",
    store: s.store as never,
    nowMs: NOW + 2000,
  });

  const afterRevoke = await rotateRefreshToken({
    refreshToken: first.nextToken,
    store: s.store as never,
    nowMs: NOW + 3000,
  });
  assert(!afterRevoke.ok);
  assertEquals(afterRevoke.reason, "grant_revoked");
});

Deno.test("an expired refresh token is refused", async () => {
  const s = makeStore();
  await seedRefresh(s, "refresh-1", { expiresAtMs: NOW - 1 });
  const result = await rotateRefreshToken({
    refreshToken: "refresh-1",
    store: s.store as never,
    nowMs: NOW + 1000,
  });
  assert(!result.ok);
  assertEquals(result.reason, "token_expired");
});

Deno.test("a token on an already-revoked grant is refused", async () => {
  const s = makeStore();
  await seedRefresh(s, "refresh-1");
  s.grants.get("grant-1")!.revokedAtMs = NOW;
  const result = await rotateRefreshToken({
    refreshToken: "refresh-1",
    store: s.store as never,
    nowMs: NOW + 1000,
  });
  assert(!result.ok);
  assertEquals(result.reason, "grant_revoked");
});

// ---------------------------------------------------------------------------
// Storage and comparison
// ---------------------------------------------------------------------------

Deno.test("nothing is stored in plaintext: the store only ever sees a hash", async () => {
  const s = makeStore();
  await seedCode(s, "code-1");
  const stored = [...s.codes.keys()];
  assertEquals(stored.length, 1);
  assert(!stored[0].includes("code-1"), "the raw code appears in the store key");
  assertEquals(stored[0], await hashSecret("code-1"));
  assertEquals(stored[0].length, 64, "expected a hex SHA-256 digest");
});

Deno.test("the same secret hashes stably, and different secrets do not collide", async () => {
  assertEquals(await hashSecret("abc"), await hashSecret("abc"));
  assert(await hashSecret("abc") !== await hashSecret("abd"));
});

Deno.test("generated tokens are long, prefixed and unique", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const token = generateOpaqueToken("gtr");
    assert(token.startsWith("gtr_"));
    assert(token.length > 40, token);
    assert(!seen.has(token), "a generated token repeated");
    seen.add(token);
  }
});

Deno.test("timingSafeEqual is correct, whatever else it is", () => {
  assert(timingSafeEqual("abc", "abc"));
  assert(!timingSafeEqual("abc", "abd"));
  assert(!timingSafeEqual("abc", "ab"));
  assert(timingSafeEqual("", ""));
});

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------

Deno.test("audience binding accepts only an exact match", () => {
  // A token a seller granted to some other service using the same authorization
  // server must not be accepted here. Trailing-slash and case leniency is what
  // turns an audience check into a prefix check.
  assert(isAudienceValid(RESOURCE, RESOURCE));
  assert(!isAudienceValid("https://functions.gradethread.com/mcp/", RESOURCE));
  assert(!isAudienceValid("https://FUNCTIONS.gradethread.com/mcp", RESOURCE));
  assert(!isAudienceValid("https://functions.gradethread.com", RESOURCE));
  assert(!isAudienceValid("https://evil.example.com/mcp", RESOURCE));
  assert(!isAudienceValid("", RESOURCE));
});
