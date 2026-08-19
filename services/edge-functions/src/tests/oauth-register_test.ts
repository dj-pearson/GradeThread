// US-9120: POST /oauth/register, the deprecated dynamic-registration fallback.
//
// AN OPEN REGISTRATION ENDPOINT IS AN OPEN WRITE ENDPOINT: anyone on the
// internet can create rows through it. So the interesting cases here are all
// refusals, and every refusal below happens BEFORE the handler touches the
// database — which is why this file needs no stack and runs in CI.
//
// The one thing it must never do is issue a client secret. A public client
// using PKCE does not need one, and a secret handed to an anonymous registrant
// is a credential with nobody accountable for it.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { oauthRoutes } = await import("../routes/oauth.ts");

/** Run one request with the flag forced, then put the flag back. */
async function register(body: unknown, enabled = true) {
  const previous = Deno.env.get("MCP_OAUTH_ENABLED");
  Deno.env.set("MCP_OAUTH_ENABLED", enabled ? "true" : "false");
  try {
    const res = await oauthRoutes.request(
      new Request("http://localhost/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : {} };
  } finally {
    if (previous === undefined) Deno.env.delete("MCP_OAUTH_ENABLED");
    else Deno.env.set("MCP_OAUTH_ENABLED", previous);
  }
}

Deno.test("register does not exist while the flow is off", async () => {
  // 404, not 503: a disabled endpoint that announces itself is still a
  // published surface, and this one is unauthenticated.
  const { status } = await register({ redirect_uris: ["https://a.test/cb"] }, false);
  assertEquals(status, 404);
});

Deno.test("register refuses a body that is not JSON", async () => {
  const { status, json } = await register("not json at all");
  assertEquals(status, 400);
  assertEquals(json.error, "invalid_client_metadata");
});

Deno.test("register refuses a registration with no redirect_uris", async () => {
  const { status, json } = await register({ client_name: "No callbacks" });
  assertEquals(status, 400);
  assertEquals(json.error, "invalid_redirect_uri");
});

Deno.test("register refuses more than ten redirect_uris", async () => {
  // A registrant with more than ten callbacks is not a client, it is a list.
  const uris = Array.from({ length: 11 }, (_, i) => `https://a.test/cb${i}`);
  const { status, json } = await register({ redirect_uris: uris });
  assertEquals(status, 400);
  assertEquals(json.error, "invalid_redirect_uri");
});

Deno.test("register refuses a wildcard redirect_uri", async () => {
  // A wildcard accepted here is one somebody has to notice at authorize time.
  const { status, json } = await register({ redirect_uris: ["https://*.a.test/cb"] });
  assertEquals(status, 400);
  assertEquals(json.error, "invalid_redirect_uri");
  assert(String(json.error_description).includes("*"));
});

Deno.test("register refuses plain http on a non-loopback host", async () => {
  const { status, json } = await register({ redirect_uris: ["http://a.test/cb"] });
  assertEquals(status, 400);
  assertEquals(json.error, "invalid_redirect_uri");
});

Deno.test("register refuses a redirect_uri carrying a fragment", async () => {
  const { status, json } = await register({ redirect_uris: ["https://a.test/cb#x"] });
  assertEquals(status, 400);
  assertEquals(json.error, "invalid_redirect_uri");
});

Deno.test("register refuses a non-http scheme outright", async () => {
  for (const uri of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
    const { status, json } = await register({ redirect_uris: [uri] });
    assertEquals(status, 400, `${uri} was not refused`);
    assertEquals(json.error, "invalid_redirect_uri");
  }
});

Deno.test("register refuses when ONE uri in an otherwise fine set is bad", async () => {
  // The failure mode this guards is a partial accept: nine good callbacks
  // carrying one wildcard through because the set looked reasonable.
  const { status, json } = await register({
    redirect_uris: ["https://a.test/cb", "https://*.a.test/cb"],
  });
  assertEquals(status, 400);
  assertEquals(json.error, "invalid_redirect_uri");
});

Deno.test("register accepts a loopback callback on any port, which is how a terminal connects", async () => {
  // Claude Code redirects to http://localhost:<varying port>. Refusing plain
  // http here would mean the connector cannot be added from a terminal at all.
  // This case only proves the URI passes validation; it is allowed to fail on
  // the insert when no stack is running, and it must NOT fail on the URI.
  const { status, json } = await register({ redirect_uris: ["http://127.0.0.1:41763/callback"] });
  assert(
    status !== 400,
    `a loopback callback was rejected as invalid: ${JSON.stringify(json)}`,
  );
});
