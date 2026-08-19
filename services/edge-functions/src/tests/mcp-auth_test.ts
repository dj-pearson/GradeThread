// US-9104: authentication on the MCP endpoint.
//
// No database is reachable here, so every well-formed key resolves to "unknown"
// — which is exactly what makes the equivalence assertions meaningful: if
// Bearer extraction were broken, a Bearer-only request would fail as MISSING
// (401 with no error parameter) instead of as an unknown credential. The two
// failures are distinguishable, so the test can tell them apart.

import { assert, assertEquals, assertExists } from "@std/assert";
import { Hono } from "hono";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { extractApiKey, extractBearerToken } = await import("../middleware/api-key-auth.ts");
const { insufficientScope, mcpAuthMiddleware, mcpResourceUri } = await import(
  "../middleware/mcp-auth.ts"
);

/** A syntactically valid key (gt_sk_ + 64 hex) that no database will ever know. */
const WELL_FORMED_KEY = "gt_sk_" + "a".repeat(64);

function app(): Hono {
  const instance = new Hono();
  instance.use("/*", mcpAuthMiddleware);
  instance.post("/", (c) => c.json({ reached: true }));
  return instance;
}

function headerLookup(headers: Record<string, string>) {
  return (name: string): string | undefined => {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : undefined;
  };
}

async function authPost(headers: Record<string, string>) {
  const res = await app().request(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    challenge: res.headers.get("WWW-Authenticate"),
    json: text ? JSON.parse(text) : {},
  };
}

/** Parse a `Bearer k="v", k2="v2"` challenge into its parameters. */
function parseChallenge(header: string): Record<string, string> {
  assert(header.startsWith("Bearer "), `challenge must use the Bearer scheme, got: ${header}`);
  const out: Record<string, string> = {};
  for (const [, key, value] of header.slice(7).matchAll(/([a-z_]+)="([^"]*)"/g)) {
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Credential extraction
// ---------------------------------------------------------------------------

Deno.test("extractApiKey reads X-API-Key, and X-API-Key wins when both are sent", () => {
  assertEquals(extractApiKey(headerLookup({ "X-API-Key": "gt_sk_direct" })), "gt_sk_direct");
  assertEquals(
    extractApiKey(headerLookup({
      "X-API-Key": "gt_sk_direct",
      Authorization: "Bearer gt_sk_bearer",
    })),
    "gt_sk_direct",
  );
});

Deno.test("extractApiKey reads Authorization: Bearer, case-insensitively on the scheme", () => {
  assertEquals(extractApiKey(headerLookup({ Authorization: "Bearer gt_sk_x" })), "gt_sk_x");
  assertEquals(extractApiKey(headerLookup({ Authorization: "bearer gt_sk_x" })), "gt_sk_x");
});

Deno.test("extractApiKey leaves a non-GradeThread bearer alone, so /api/v1 callers are unaffected", () => {
  // A Supabase JWT in Authorization must NOT become "invalid API key format" on
  // /api/v1, which is what claiming any bearer would have done.
  const headers = headerLookup({ Authorization: "Bearer eyJhbGciOiJIUzI1NiIs.someJwt" });
  assertEquals(extractApiKey(headers), undefined);
  // It is still readable, because /mcp reports it differently.
  assertEquals(extractBearerToken(headers), "eyJhbGciOiJIUzI1NiIs.someJwt");
});

Deno.test("extractApiKey returns undefined when no credential header is present", () => {
  assertEquals(extractApiKey(headerLookup({})), undefined);
  assertEquals(extractApiKey(headerLookup({ Authorization: "Basic abc" })), undefined);
});

// ---------------------------------------------------------------------------
// The two transports resolve identically
// ---------------------------------------------------------------------------

Deno.test("X-API-Key and Authorization: Bearer take the same resolution path", async () => {
  const viaHeader = await authPost({ "X-API-Key": WELL_FORMED_KEY });
  const viaBearer = await authPost({ Authorization: `Bearer ${WELL_FORMED_KEY}` });

  assertEquals(viaHeader.status, viaBearer.status);
  assertEquals(viaHeader.json, viaBearer.json);

  // Both must report an UNKNOWN credential, not a missing one. A missing
  // credential carries no `error` parameter, so this distinguishes them.
  for (const result of [viaHeader, viaBearer]) {
    assertExists(result.challenge);
    assertEquals(parseChallenge(result.challenge).error, "invalid_token");
  }
});

Deno.test("an expired-or-unknown key fails the same way through both transports", async () => {
  // Expiry is enforced inside resolveApiKeyIdentity against the stored row, so
  // without a database this asserts the shared path, not the expiry branch: the
  // point is that neither transport can bypass the resolver.
  const viaHeader = await authPost({ "X-API-Key": WELL_FORMED_KEY });
  const viaBearer = await authPost({ Authorization: `Bearer ${WELL_FORMED_KEY}` });
  assertEquals(viaHeader.status, 401);
  assertEquals(viaBearer.status, 401);
});

// ---------------------------------------------------------------------------
// Challenge shapes
// ---------------------------------------------------------------------------

Deno.test("no credential returns 401 with a well-formed WWW-Authenticate challenge", async () => {
  const { status, challenge, json } = await authPost({});
  assertEquals(status, 401);
  assertExists(challenge);

  const params = parseChallenge(challenge);
  // The scopes needed are emitted together, not one challenge at a time.
  assertExists(params.scope);
  assert(params.scope.split(" ").length >= 1);
  // A missing credential is not an invalid one, so no error parameter.
  assertEquals(params.error, undefined);

  // The body an MCP client can actually parse.
  assertEquals(json.jsonrpc, "2.0");
  assertExists(json.error);
});

Deno.test("the challenge points at the discovery document ONLY when it is served", async () => {
  // This test used to assert resource_metadata was always present, and it broke
  // when the OAuth discovery documents were gated behind MCP_OAUTH_ENABLED
  // (US-9120). It was right to break: a pointer to a document that 404s sends a
  // client down a dead end instead of to the static-credential path that works,
  // and that is precisely what the gate exists to prevent. Nothing was
  // asserting it, so both states are covered now.
  const previous = Deno.env.get("MCP_OAUTH_ENABLED");
  try {
    Deno.env.set("MCP_OAUTH_ENABLED", "false");
    const off = await authPost({});
    assertEquals(parseChallenge(off.challenge!).resource_metadata, undefined);

    Deno.env.set("MCP_OAUTH_ENABLED", "true");
    const on = await authPost({});
    const pointer = parseChallenge(on.challenge!).resource_metadata;
    assertExists(pointer);
    assert(pointer.endsWith("/.well-known/oauth-protected-resource"), pointer);
  } finally {
    if (previous === undefined) Deno.env.delete("MCP_OAUTH_ENABLED");
    else Deno.env.set("MCP_OAUTH_ENABLED", previous);
  }
});

Deno.test("a malformed credential is 401 invalid_token, not a generic failure", async () => {
  const { status, challenge } = await authPost({ "X-API-Key": "not-a-gradethread-key" });
  assertEquals(status, 401);
  assertEquals(parseChallenge(challenge!).error, "invalid_token");
});

Deno.test("a bearer token that is not ours is 401 invalid_token, not 'missing credential'", async () => {
  // An OAuth access token arriving before US-9122 lands must not read as if the
  // caller forgot to authenticate — they did authenticate, with the wrong thing.
  const { status, challenge } = await authPost({ Authorization: "Bearer opaque-oauth-token" });
  assertEquals(status, 401);
  assertEquals(parseChallenge(challenge!).error, "invalid_token");
});

Deno.test("insufficientScope is 403 and names every scope the operation needs", () => {
  const headers: Record<string, string> = {};
  const fakeContext = {
    header: (k: string, v: string) => {
      headers[k] = v;
    },
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), { status: status ?? 200 }),
  };

  const res = insufficientScope(fakeContext, ["submit", "webhook_manage"]);
  // 403, never 401: re-authenticating hands back the same under-scoped token.
  assertEquals(res.status, 403);

  const params = parseChallenge(headers["WWW-Authenticate"]);
  assertEquals(params.error, "insufficient_scope");
  assertEquals(params.scope, "submit webhook_manage");
  assertExists(params.resource_metadata);
});

// ---------------------------------------------------------------------------
// Resource identity
// ---------------------------------------------------------------------------

Deno.test("mcpResourceUri is a canonical absolute URI with no trailing slash or fragment", () => {
  const uri = mcpResourceUri();
  const parsed = new URL(uri);
  assertEquals(parsed.protocol, "https:");
  assertEquals(parsed.hash, "");
  assert(!uri.endsWith("/"), `resource URI must not end with a slash: ${uri}`);
  assert(uri.endsWith("/mcp"), `resource URI must name the MCP endpoint: ${uri}`);
});

Deno.test("mcpResourceUri honours MCP_PUBLIC_BASE_URL and strips a trailing slash", () => {
  const previous = Deno.env.get("MCP_PUBLIC_BASE_URL");
  Deno.env.set("MCP_PUBLIC_BASE_URL", "https://staging.gradethread.com/");
  try {
    assertEquals(mcpResourceUri(), "https://staging.gradethread.com/mcp");
  } finally {
    if (previous === undefined) Deno.env.delete("MCP_PUBLIC_BASE_URL");
    else Deno.env.set("MCP_PUBLIC_BASE_URL", previous);
  }
});
