// US-9121: the authorization endpoint.
//
// One rule shapes most of this file, and it is the classic hole in an
// authorization endpoint: an error may only be REDIRECTED to a uri we have
// verified against the client's registration. Redirecting an error to whatever
// the query string carried turns this endpoint into an open redirector, and the
// attacker gets to choose where the browser lands.
//
// So a bad client_id or an unregistered redirect_uri is FATAL — answered on our
// own origin — and everything else redirects with error=. The tests below are
// mostly about which side of that line each failure falls on.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
Deno.env.set("MCP_OAUTH_ENABLED", "true");

const { authorizeRedirect, issueAuthorizationCode, validateAuthorizeRequest } = await import(
  "../lib/oauth-authorize.ts"
);
const { resourceIdentifier, issuerOrigin } = await import("../lib/oauth-metadata.ts");
const { AUTHORIZATION_CODE_TTL_MS } = await import("../lib/oauth-tokens.ts");

const CLIENT = "gtc_fixture";
const REDIRECT = "https://client.example.com/cb";
const CHALLENGE = "a".repeat(43);

/** A db stub answering the oauth_clients lookup resolveClient makes. */
function stubDb(row: Record<string, unknown> | null = {
  client_id: CLIENT,
  client_name: "Fixture Client",
  redirect_uris: [REDIRECT],
  registration_source: "preregistered",
}) {
  const inserted: Array<Record<string, unknown>> = [];
  return {
    inserted,
    db: {
      from() {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }),
          }),
          insert(values: Record<string, unknown>) {
            inserted.push(values);
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  };
}

function goodRequest(overrides: Record<string, string | undefined> = {}) {
  return {
    clientId: CLIENT,
    redirectUri: REDIRECT,
    responseType: "code",
    codeChallenge: CHALLENGE,
    codeChallengeMethod: "S256",
    scope: "read submit",
    state: "xyz",
    resource: resourceIdentifier(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// the open-redirector line
// ---------------------------------------------------------------------------

Deno.test("an unknown client is FATAL, never a redirect", async () => {
  const { db } = stubDb(null);
  const result = await validateAuthorizeRequest(goodRequest(), db);
  assert(!result.ok);
  assertEquals(result.kind, "fatal");
});

Deno.test("an unknown client does not say WHETHER it was unknown or unreachable", async () => {
  // Saying which tells someone probing client ids whether they guessed a real
  // one. The reason goes to the log instead.
  const { db } = stubDb(null);
  const result = await validateAuthorizeRequest(goodRequest(), db);
  assert(!result.ok && result.kind === "fatal");
  assert(!/unreachable|metadata/i.test(result.description), result.description);
});

Deno.test("an UNREGISTERED redirect_uri is FATAL, never a redirect", async () => {
  // The whole point. Sending error= to an address the client never registered
  // is an open redirect wearing an OAuth costume.
  const { db } = stubDb();
  const result = await validateAuthorizeRequest(
    goodRequest({ redirectUri: "https://attacker.example.com/steal" }),
    db,
  );
  assert(!result.ok);
  assertEquals(result.kind, "fatal");
});

Deno.test("a missing client_id is FATAL before anything is looked up", async () => {
  const { db } = stubDb();
  const result = await validateAuthorizeRequest(goodRequest({ clientId: undefined }), db);
  assert(!result.ok);
  assertEquals(result.kind, "fatal");
});

Deno.test("a client with several registered uris and none requested is FATAL", async () => {
  // There is nothing to guess, and guessing is the hole.
  const { db } = stubDb({
    client_id: CLIENT,
    redirect_uris: [REDIRECT, "https://client.example.com/other"],
    registration_source: "preregistered",
  });
  const result = await validateAuthorizeRequest(goodRequest({ redirectUri: undefined }), db);
  assert(!result.ok);
  assertEquals(result.kind, "fatal");
});

Deno.test("a client with exactly ONE registered uri may omit it", async () => {
  const { db } = stubDb();
  const result = await validateAuthorizeRequest(goodRequest({ redirectUri: undefined }), db);
  assert(result.ok, JSON.stringify(result));
  assertEquals(result.request.redirectUri, REDIRECT);
});

// ---------------------------------------------------------------------------
// everything else redirects
// ---------------------------------------------------------------------------

Deno.test("a bad response_type redirects with error, because the uri is verified", async () => {
  const { db } = stubDb();
  const result = await validateAuthorizeRequest(goodRequest({ responseType: "token" }), db);
  assert(!result.ok);
  assertEquals(result.kind, "redirect");
  assert(result.kind === "redirect" && result.error === "unsupported_response_type");
  assert(result.kind === "redirect" && result.state === "xyz", "state must survive an error");
});

Deno.test("code_challenge_method=plain is refused, not downgraded to", async () => {
  // OAuth 2.1 removed plain, and Anthropic's connector review checks for S256
  // specifically. Accepting plain would be the one failure nobody notices.
  const { db } = stubDb();
  const result = await validateAuthorizeRequest(
    goodRequest({ codeChallengeMethod: "plain" }),
    db,
  );
  assert(!result.ok && result.kind === "redirect");
  assert(/S256/.test(result.description));
});

Deno.test("a missing or wrong-length code_challenge is refused", async () => {
  const { db } = stubDb();
  for (const challenge of [undefined, "short", "a".repeat(42), "a".repeat(44)]) {
    const result = await validateAuthorizeRequest(
      goodRequest({ codeChallenge: challenge }),
      db,
    );
    assert(!result.ok, `${challenge} was accepted`);
  }
});

Deno.test("an unknown scope is named in the error", async () => {
  const { db } = stubDb();
  const result = await validateAuthorizeRequest(goodRequest({ scope: "read wat" }), db);
  assert(!result.ok && result.kind === "redirect");
  assertEquals(result.error, "invalid_scope");
  assert(result.description.includes("wat"));
});

Deno.test("an empty scope is refused rather than defaulted", async () => {
  // Defaulting would grant something nobody asked for.
  const { db } = stubDb();
  const result = await validateAuthorizeRequest(goodRequest({ scope: "" }), db);
  assert(!result.ok && result.kind === "redirect");
  assertEquals(result.error, "invalid_scope");
});

Deno.test("a resource that is not ours is refused (RFC 8707)", async () => {
  // Accepting it would mint a token audience-bound to something else, which is
  // the confused-deputy hole the resource indicator exists to close.
  const { db } = stubDb();
  const result = await validateAuthorizeRequest(
    goodRequest({ resource: "https://someone-else.example.com/mcp" }),
    db,
  );
  assert(!result.ok && result.kind === "redirect");
  assertEquals(result.error, "invalid_target");
});

Deno.test("an absent resource defaults to ours rather than being refused", async () => {
  const { db } = stubDb();
  const result = await validateAuthorizeRequest(goodRequest({ resource: undefined }), db);
  assert(result.ok);
  assertEquals(result.request.resource, resourceIdentifier());
});

// ---------------------------------------------------------------------------
// the redirect itself
// ---------------------------------------------------------------------------

Deno.test("every redirect carries iss, including the error ones (RFC 9207)", () => {
  // Only sending iss on success is how a mixed-up-provider attack survives: the
  // client cannot confirm which authorization server answered.
  const ok = authorizeRedirect(REDIRECT, { code: "abc", state: "xyz" });
  assert(new URL(ok).searchParams.get("iss") === issuerOrigin());

  const err = authorizeRedirect(REDIRECT, { error: "access_denied", state: "xyz" });
  assert(new URL(err).searchParams.get("iss") === issuerOrigin());
});

Deno.test("a null param is omitted rather than written as the string null", () => {
  const url = new URL(authorizeRedirect(REDIRECT, { code: "abc", state: null }));
  assertEquals(url.searchParams.get("state"), null);
});

Deno.test("an existing query on the redirect uri survives", () => {
  const url = new URL(authorizeRedirect("https://client.example.com/cb?keep=1", { code: "a" }));
  assertEquals(url.searchParams.get("keep"), "1");
  assertEquals(url.searchParams.get("code"), "a");
});

// ---------------------------------------------------------------------------
// issuing the code
// ---------------------------------------------------------------------------

async function validRequest() {
  const { db } = stubDb();
  const result = await validateAuthorizeRequest(goodRequest(), db);
  assert(result.ok);
  return result.request;
}

Deno.test("the code is stored HASHED, with a 60-second life", async () => {
  const { db, inserted } = stubDb();
  const request = await validRequest();
  const nowMs = 1_700_000_000_000;
  const result = await issueAuthorizationCode({
    ownerUserId: "user-1",
    request,
    grantedScopes: ["read", "submit"],
    nowMs,
    db,
  });
  assert(result.ok, JSON.stringify(result));

  assertEquals(inserted.length, 1);
  const row = inserted[0];
  const code = new URL(result.redirectTo).searchParams.get("code")!;
  assert(code.startsWith("gtac_"));
  assert(
    !JSON.stringify(row).includes(code),
    "the authorization code was stored in the clear",
  );
  assertEquals(
    row.expires_at,
    new Date(nowMs + AUTHORIZATION_CODE_TTL_MS).toISOString(),
  );
  assert(AUTHORIZATION_CODE_TTL_MS <= 60_000, "OAuth 2.1 asks for 60 seconds or less");
});

Deno.test("the seller may NARROW the scopes", async () => {
  // AC4: read-only must be obtainable from the consent screen, not only from
  // the API-keys page.
  const { db, inserted } = stubDb();
  const request = await validRequest();
  const result = await issueAuthorizationCode({
    ownerUserId: "user-1",
    request,
    grantedScopes: ["read"],
    db,
  });
  assert(result.ok);
  assertEquals(inserted[0].scopes, ["read"]);
});

Deno.test("the seller may NOT widen the scopes", async () => {
  // A consent page that could add a scope is a consent page that could grant
  // itself one. The requested set is the ceiling.
  const { db, inserted } = stubDb();
  const request = await validRequest();
  const result = await issueAuthorizationCode({
    ownerUserId: "user-1",
    request,
    grantedScopes: ["read", "submit", "webhook_manage"],
    db,
  });
  assert(result.ok);
  assertEquals(inserted[0].scopes, ["read", "submit"]);
});

Deno.test("granting nothing is refused rather than stored as an empty grant", async () => {
  const { db, inserted } = stubDb();
  const request = await validRequest();
  const result = await issueAuthorizationCode({
    ownerUserId: "user-1",
    request,
    grantedScopes: [],
    db,
  });
  assert(!result.ok);
  assertEquals(inserted.length, 0);
});

Deno.test("the code carries the challenge, the redirect and the resource", async () => {
  // All three are re-checked at the token endpoint, and they can only be
  // re-checked if they were pinned here rather than trusted from the exchange.
  const { db, inserted } = stubDb();
  const request = await validRequest();
  await issueAuthorizationCode({
    ownerUserId: "user-1",
    request,
    grantedScopes: ["read"],
    db,
  });
  const row = inserted[0];
  assertEquals(row.code_challenge, CHALLENGE);
  assertEquals(row.code_challenge_method, "S256");
  assertEquals(row.redirect_uri, REDIRECT);
  assertEquals(row.resource, resourceIdentifier());
  assertEquals(row.owner_user_id, "user-1");
});

Deno.test("state comes back with the code", async () => {
  const { db } = stubDb();
  const request = await validRequest();
  const result = await issueAuthorizationCode({
    ownerUserId: "user-1",
    request,
    grantedScopes: ["read"],
    db,
  });
  assert(result.ok);
  assertEquals(new URL(result.redirectTo).searchParams.get("state"), "xyz");
});
