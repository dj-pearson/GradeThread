// US-9120: the discovery documents, and the redirect rule that decides whether
// Claude Code can connect at all.
//
// Two things here are worth more than the rest.
//
// THE LOOPBACK EXEMPTION. Claude Code redirects to http://localhost:<port> with
// a port it picks at run time. Exact-string matching rejects that every single
// time, and the failure mode is "the connector cannot be added from a terminal"
// with no useful error. OAuth 2.1 permits loopback with a variable port for
// exactly this reason. The exemption is scoped to the PORT and to loopback
// hosts; the path still has to match, or a registered /cb accepts /anything.
//
// THE RESOURCE IDENTIFIER. It appears in the challenge header, in the published
// document, and (US-9122) in the audience of every token. Two definitions of it
// is a token that validates on one side and not the other.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  authorizationServerMetadata,
  CLAUDE_CALLBACK,
  invalidRedirectUris,
  isAllowedRedirectUri,
  OAUTH_SCOPES_SUPPORTED,
  protectedResourceMetadata,
  isOAuthEnabled,
  resourceIdentifier,
} = await import("../lib/oauth-metadata.ts");

// ---------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------

Deno.test("the protected-resource document names the resource and its authorization server", () => {
  const doc = protectedResourceMetadata() as Record<string, unknown>;
  assertEquals(doc.resource, resourceIdentifier());
  const servers = doc.authorization_servers as string[];
  assert(servers.length > 0);
  assertEquals(doc.bearer_methods_supported, ["header"]);
});

Deno.test("the resource identifier is canonical: https, no trailing slash, no fragment", () => {
  // The spec calls all three out, and a mismatch is a token that validates on
  // one side and not the other.
  const uri = resourceIdentifier();
  const parsed = new URL(uri);
  assertEquals(parsed.protocol, "https:");
  assertEquals(parsed.hash, "");
  assert(!uri.endsWith("/"), uri);
  assert(uri.endsWith("/mcp"), uri);
});

Deno.test("the authorization-server document advertises S256 only", () => {
  // `plain` is not acceptable under OAuth 2.1, and the connector review checks
  // for S256 specifically.
  const doc = authorizationServerMetadata() as Record<string, unknown>;
  assertEquals(doc.code_challenge_methods_supported, ["S256"]);
});

Deno.test("the authorization-server document names every endpoint a client needs", () => {
  const doc = authorizationServerMetadata() as Record<string, string>;
  for (const key of ["authorization_endpoint", "token_endpoint", "revocation_endpoint"]) {
    const value = doc[key];
    assert(typeof value === "string" && value.startsWith("https://"), `${key}: ${value}`);
  }
  assertEquals(doc.issuer, new URL(doc.authorization_endpoint).origin);
});

Deno.test("iss is advertised, because we emit it — including on errors", () => {
  // RFC 9207. A client is entitled to reject a response whose issuer it cannot
  // confirm, and advertising without emitting is worse than neither.
  const doc = authorizationServerMetadata() as Record<string, unknown>;
  assertEquals(doc.authorization_response_iss_parameter_supported, true);
});

Deno.test("Client ID Metadata Documents are advertised, since DCR is deprecated", () => {
  const doc = authorizationServerMetadata() as Record<string, unknown>;
  assertEquals(doc.client_id_metadata_document_supported, true);
  // The DCR endpoint still exists as a fallback for clients that cannot do
  // better, so it is still named.
  assert(typeof doc.registration_endpoint === "string");
});

Deno.test("offline_access is NOT advertised on the protected resource", () => {
  // Refresh tokens are not a resource requirement, and the spec says a
  // protected resource should not list it.
  const doc = protectedResourceMetadata() as Record<string, unknown>;
  const scopes = doc.scopes_supported as string[];
  assert(!scopes.includes("offline_access"), scopes.join(","));
});

Deno.test("advertised scopes are ones the API key system can actually grant", () => {
  const doc = authorizationServerMetadata() as Record<string, unknown>;
  for (const scope of doc.scopes_supported as string[]) {
    assert(
      (OAUTH_SCOPES_SUPPORTED as readonly string[]).includes(scope),
      `${scope} is advertised but is not a real scope`,
    );
  }
});

Deno.test("neither document carries a credential VALUE", () => {
  // Checking for the WORD "secret" was the first version of this, and it failed
  // on `client_secret_post` — a parameter NAME that has to be there. The risk is
  // a credential value, so that is what is looked for: our key prefix, a JWT, or
  // any long opaque blob that could be one.
  const values: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") values.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk([protectedResourceMetadata(), authorizationServerMetadata()]);
  assert(values.length > 0, "no string values found; the walk is broken");

  for (const value of values) {
    assert(!value.startsWith("gt_sk_"), `an API key leaked into a public document: ${value}`);
    assert(!value.startsWith("eyJ"), `a JWT leaked into a public document`);
    // Every legitimate value here is a URL or a short protocol token.
    const looksOpaque = /^[A-Za-z0-9+/_-]{32,}$/.test(value);
    assert(
      !looksOpaque,
      `a long opaque value appears in a public discovery document: ${value.slice(0, 16)}...`,
    );
  }
});

// ---------------------------------------------------------------------------
// Redirect URIs
// ---------------------------------------------------------------------------

Deno.test("the hosted Claude callback is accepted exactly", () => {
  assert(isAllowedRedirectUri(CLAUDE_CALLBACK, [CLAUDE_CALLBACK]));
});

Deno.test("a loopback redirect matches on ANY port, which is what lets Claude Code connect", () => {
  const registered = ["http://localhost/callback"];
  assert(isAllowedRedirectUri("http://localhost:51763/callback", registered));
  assert(isAllowedRedirectUri("http://localhost:8123/callback", registered));
  assert(isAllowedRedirectUri("http://127.0.0.1:9999/callback", registered));
});

Deno.test("the loopback exemption is the PORT only — the path still has to match", () => {
  // Otherwise a registered /callback accepts /anything, and the code goes
  // wherever the request said.
  const registered = ["http://localhost/callback"];
  assert(!isAllowedRedirectUri("http://localhost:51763/steal", registered));
});

Deno.test("the loopback exemption does not extend to a non-loopback host", () => {
  const registered = ["http://localhost/callback"];
  assert(!isAllowedRedirectUri("http://evil.example.com/callback", registered));
  assert(!isAllowedRedirectUri("https://evil.example.com/callback", registered));
});

Deno.test("a non-loopback redirect must match whole, not by prefix", () => {
  const registered = ["https://claude.ai/api/mcp/auth_callback"];
  assert(!isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback/extra", registered));
  assert(!isAllowedRedirectUri("https://claude.ai.evil.com/api/mcp/auth_callback", registered));
  assert(!isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback?x=1", registered));
});

Deno.test("http is refused for a non-loopback host", () => {
  assert(!isAllowedRedirectUri("http://claude.ai/cb", ["http://claude.ai/cb"]));
});

Deno.test("a fragment is refused, because it smuggles a second destination", () => {
  const uri = "https://claude.ai/cb#https://evil.example.com";
  assert(!isAllowedRedirectUri(uri, [uri]));
});

Deno.test("garbage is refused rather than throwing", () => {
  assert(!isAllowedRedirectUri("not a url", ["https://claude.ai/cb"]));
  assert(!isAllowedRedirectUri("", ["https://claude.ai/cb"]));
});

// ---------------------------------------------------------------------------
// Registration-time validation
// ---------------------------------------------------------------------------

Deno.test("registration rejects wildcards, http and fragments up front", () => {
  // Rejecting at BOTH registration and authorize is the point: a wildcard
  // accepted at registration is one somebody has to notice later.
  const bad = invalidRedirectUris([
    "https://ok.example.com/cb",
    "https://*.example.com/cb",
    "http://not-loopback.example.com/cb",
    "https://ok.example.com/cb#frag",
    "javascript:alert(1)",
    "http://localhost:1234/cb",
  ]);
  assertEquals(bad.sort(), [
    "http://not-loopback.example.com/cb",
    "https://*.example.com/cb",
    "https://ok.example.com/cb#frag",
    "javascript:alert(1)",
  ]);
});

Deno.test("a clean set of redirect URIs registers without complaint", () => {
  assertEquals(
    invalidRedirectUris([CLAUDE_CALLBACK, "http://localhost/callback", "http://127.0.0.1/cb"]),
    [],
  );
});

// ---------------------------------------------------------------------------
// Not served until the endpoints exist
// ---------------------------------------------------------------------------

Deno.test("OAuth discovery is OFF by default, because the endpoints do not exist yet", () => {
  // Publishing this metadata before /oauth/authorize and /oauth/token are real
  // would make the connector broken in a NEW way: a client reads the document,
  // starts an authorization flow, and 404s. Today the same client sees no
  // discovery, falls back to a static credential, and works. Advertising a
  // capability we do not have takes the working path away too.
  const previous = Deno.env.get("MCP_OAUTH_ENABLED");
  try {
    Deno.env.delete("MCP_OAUTH_ENABLED");
    assertEquals(isOAuthEnabled(), false);
    Deno.env.set("MCP_OAUTH_ENABLED", "false");
    assertEquals(isOAuthEnabled(), false);
    Deno.env.set("MCP_OAUTH_ENABLED", "true");
    assertEquals(isOAuthEnabled(), true);
    Deno.env.set("MCP_OAUTH_ENABLED", "1");
    assertEquals(isOAuthEnabled(), true);
  } finally {
    if (previous === undefined) Deno.env.delete("MCP_OAUTH_ENABLED");
    else Deno.env.set("MCP_OAUTH_ENABLED", previous);
  }
});

Deno.test("the documents are complete regardless of the flag, so turning it on is one change", () => {
  // The flag decides whether they are SERVED, not whether they are correct.
  // Anything the flag also gated would be untested until the day it flipped.
  const doc = authorizationServerMetadata() as Record<string, unknown>;
  assert(typeof doc.issuer === "string" && (doc.issuer as string).length > 0);
  assertEquals((doc.grant_types_supported as string[]).sort(), [
    "authorization_code",
    "refresh_token",
  ]);
});
