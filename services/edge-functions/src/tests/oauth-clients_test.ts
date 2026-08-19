// US-9120: how a client gets a client_id, and the SSRF that comes with it.
//
// Client ID Metadata Documents mean fetching a URL a stranger supplied, from
// inside our network. That is server-side request forgery with a specification
// attached, and it is the reason this file leads with the guard rather than
// with the happy path.
//
// The fetcher is injected, so the metadata rules are asserted without a network
// and the SSRF behaviour is asserted by handing the real guard a hostile URL.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { parseClientMetadata, resolveClient } = await import("../lib/oauth-clients.ts");
const { safeFetch, SsrfError } = await import("../lib/ssrf.ts");

const CLIENT_URL = "https://client.example.com/metadata.json";
const REDIRECT = "https://client.example.com/cb";

/** A db stub that records upserts and answers lookups. */
function stubDb(row: Record<string, unknown> | null = null) {
  const upserts: Array<Record<string, unknown>> = [];
  return {
    upserts,
    db: {
      from() {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }),
          }),
          upsert(values: Record<string, unknown>) {
            upserts.push(values);
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  };
}

/** A fetcher that returns a fixed document. */
function stubFetch(body: unknown, contentType = "application/json", status = 200) {
  return () =>
    Promise.resolve({
      status,
      bytes: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
      contentType,
    });
}

// ---------------------------------------------------------------------------
// The SSRF guard, with the REAL fetcher
// ---------------------------------------------------------------------------

Deno.test("a metadata URL pointing at loopback is refused by the guard, not fetched", async () => {
  // The whole risk of this feature in one case: a client_id of
  // https://localhost/... would have us fetch our own internal surface and
  // parse whatever it returns.
  let threw: unknown;
  try {
    await safeFetch("https://127.0.0.1/metadata.json", { timeoutMs: 1000 });
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof SsrfError, `expected SsrfError, got ${threw}`);
});

Deno.test("link-local metadata endpoints are refused, which is the cloud-credential case", async () => {
  // 169.254.169.254 is the instance metadata service on every major cloud.
  let threw: unknown;
  try {
    await safeFetch("https://169.254.169.254/latest/meta-data/", { timeoutMs: 1000 });
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof SsrfError, `expected SsrfError, got ${threw}`);
});

Deno.test("resolveClient turns a blocked fetch into a clean failure, not a crash", async () => {
  const { db } = stubDb();
  const result = await resolveClient("https://127.0.0.1/metadata.json", db);
  assert(!result.ok);
  assertEquals(result.failure.reason, "metadata_unreachable");
  // The message must not name what was blocked or why — that is a probe result.
  assert(!result.failure.message.includes("127.0.0.1"));
});

// ---------------------------------------------------------------------------
// Metadata validation
// ---------------------------------------------------------------------------

Deno.test("a valid metadata document resolves and is cached as a row", async () => {
  const { db, upserts } = stubDb();
  const result = await resolveClient(
    CLIENT_URL,
    db,
    stubFetch({ client_id: CLIENT_URL, client_name: "Test", redirect_uris: [REDIRECT] }) as never,
  );
  assert(result.ok, JSON.stringify(result));
  assertEquals(result.client.registrationSource, "metadata_document");
  assertEquals(result.client.redirectUris, [REDIRECT]);
  assertEquals(upserts.length, 1);
  assertEquals(upserts[0].client_id, CLIENT_URL);
});

Deno.test("a document claiming a DIFFERENT client_id is refused", () => {
  // Otherwise a document at one URL asserts redirect URIs on behalf of another
  // client, and the URL stops meaning anything.
  const result = parseClientMetadata(CLIENT_URL, {
    client_id: "https://someone-else.example.com/metadata.json",
    redirect_uris: [REDIRECT],
  });
  assert(!result.ok);
  assertEquals(result.failure.reason, "metadata_invalid");
  assert(result.failure.message.includes("different client_id"));
});

Deno.test("a document omitting its client_id is accepted; the URL is the identity", () => {
  const result = parseClientMetadata(CLIENT_URL, { redirect_uris: [REDIRECT] });
  assert(result.ok);
  assertEquals(result.client.clientId, CLIENT_URL);
});

Deno.test("a document with no redirect_uris is refused", () => {
  const result = parseClientMetadata(CLIENT_URL, { client_name: "Test" });
  assert(!result.ok);
  assertEquals(result.failure.reason, "metadata_invalid");
});

Deno.test("a document's redirect URIs face the SAME validation as registration", () => {
  // A client arriving by URL must not get a laxer redirect check than one
  // arriving by POST; that difference is the hole someone finds.
  for (
    const uri of [
      "https://*.example.com/cb",
      "http://not-loopback.example.com/cb",
      "https://example.com/cb#frag",
      "javascript:alert(1)",
    ]
  ) {
    const result = parseClientMetadata(CLIENT_URL, { redirect_uris: [uri] });
    assert(!result.ok, `${uri} should have been refused`);
    assertEquals(result.failure.reason, "metadata_invalid");
  }
});

Deno.test("a non-JSON content type is refused BEFORE parsing", async () => {
  // A 40KB HTML error page is not a metadata document, and trying to parse one
  // spends effort on the only thing the attacker controls.
  const { db } = stubDb();
  const result = await resolveClient(
    CLIENT_URL,
    db,
    stubFetch("<html>nope</html>", "text/html") as never,
  );
  assert(!result.ok);
  assertEquals(result.failure.reason, "metadata_invalid");
  assert(result.failure.message.includes("not JSON"));
});

Deno.test("malformed JSON is refused cleanly", async () => {
  const { db } = stubDb();
  const result = await resolveClient(
    CLIENT_URL,
    db,
    stubFetch("{not json", "application/json") as never,
  );
  assert(!result.ok);
  assertEquals(result.failure.reason, "metadata_invalid");
});

Deno.test("a non-2xx metadata response is unreachable, not invalid", async () => {
  const { db } = stubDb();
  const result = await resolveClient(
    CLIENT_URL,
    db,
    stubFetch({}, "application/json", 404) as never,
  );
  assert(!result.ok);
  assertEquals(result.failure.reason, "metadata_unreachable");
});

Deno.test("a metadata client is RE-FETCHED, not trusted from cache forever", async () => {
  // A cached copy is a redirect allowlist nobody is maintaining: a client that
  // changes its redirect URIs should not need us to notice.
  const cached = {
    client_id: CLIENT_URL,
    redirect_uris: ["https://client.example.com/old"],
    registration_source: "metadata_document",
  };
  const { db, upserts } = stubDb(cached);
  const result = await resolveClient(
    CLIENT_URL,
    db,
    stubFetch({ redirect_uris: ["https://client.example.com/new"] }) as never,
  );
  assert(result.ok);
  assertEquals(result.client.redirectUris, ["https://client.example.com/new"]);
  assertEquals(upserts.length, 1, "the fresh document was not written back");
});

// ---------------------------------------------------------------------------
// Non-URL client ids
// ---------------------------------------------------------------------------

Deno.test("an opaque client_id is looked up, never fetched", async () => {
  const { db } = stubDb({
    client_id: "gtc_abc",
    client_name: "Registered",
    redirect_uris: [REDIRECT],
    registration_source: "dynamic",
  });
  const throwingFetch = () => {
    throw new Error("an opaque client_id must never be fetched");
  };
  const result = await resolveClient("gtc_abc", db, throwingFetch as never);
  assert(result.ok);
  assertEquals(result.client.registrationSource, "dynamic");
});

Deno.test("an unknown opaque client_id is refused without saying more", async () => {
  const { db } = stubDb(null);
  const result = await resolveClient("gtc_never-registered", db);
  assert(!result.ok);
  assertEquals(result.failure.reason, "unknown_client");
});

// ---------------------------------------------------------------------------
// The wiring this module is waiting on
// ---------------------------------------------------------------------------

Deno.test("the /authorize endpoint resolves its client through this module", async () => {
  // The risk: an authorize handler that reads client_id straight off the query
  // string accepts any client_id anyone sends, and looks like a working flow
  // while doing it.
  //
  // US-9121 landed /authorize and resolution moved one level down — the route
  // calls validateAuthorizeRequest, which calls resolveClient. So the guard
  // follows the CHAIN rather than insisting on a direct import, and checks both
  // links: a route that stopped validating, or a validator that stopped
  // resolving, each fails here.
  const route = await Deno.readTextFile(new URL("../routes/oauth.ts", import.meta.url));
  const hasAuthorize = /oauthRoutes\.(get|post)\(\s*["']\/authorize["']/.test(route);
  if (!hasAuthorize) return; // nothing to check if the endpoint is removed

  const direct = /import\s[^;]*from\s+["']\.\.\/lib\/oauth-clients\.ts["']/.test(route);
  const viaValidator = /validateAuthorizeRequest\(/.test(route);
  assert(
    direct || viaValidator,
    "routes/oauth.ts serves /authorize without resolving client_id against a " +
      "registered client — any client_id would be accepted",
  );

  if (viaValidator && !direct) {
    const validator = await Deno.readTextFile(
      new URL("../lib/oauth-authorize.ts", import.meta.url),
    );
    assert(
      /resolveClient\(/.test(validator),
      "lib/oauth-authorize.ts no longer calls resolveClient, so the route's " +
        "validation step accepts any client_id",
    );
  }
});

Deno.test("an http (not https) client_id is treated as opaque, so it is never fetched", async () => {
  // Otherwise "http://internal-service/" is a client_id that fetches an
  // internal service over plaintext.
  const { db } = stubDb(null);
  const throwingFetch = () => {
    throw new Error("an http client_id must never be fetched");
  };
  const result = await resolveClient("http://internal-service/meta", db, throwingFetch as never);
  assert(!result.ok);
  assertEquals(result.failure.reason, "unknown_client");
});
