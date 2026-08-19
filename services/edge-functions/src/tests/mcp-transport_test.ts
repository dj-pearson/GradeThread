// US-9103: the MCP endpoint's transport contract, both eras.
//
// These are behavioural tests against the mounted Hono router, not shape checks
// on a helper: the failures worth catching here (a 405 that should be a 404, a
// header mismatch that gets served anyway, a legacy session that survives being
// deleted) only exist once HTTP is involved.

import { assert, assertEquals, assertExists } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
Deno.env.set("MCP_ENABLED", "true");

const { mcpRoutes, __resetLegacySessionsForTest } = await import("../routes/mcp.ts");
const {
  decodeHeaderValue,
  detectEra,
  JSON_RPC_ERROR,
  MCP_ERROR,
  MCP_PREFERRED_MODERN_VERSION,
  MCP_SUPPORTED_VERSIONS,
  parseJsonRpcMessage,
  validateModernHeaders,
} = await import("../lib/mcp-jsonrpc.ts");

const MODERN = MCP_PREFERRED_MODERN_VERSION;

interface ModernOpts {
  id?: string | number | null;
  name?: string;
  version?: string;
  headerOverrides?: Record<string, string>;
  omitHeaders?: string[];
}

/** Build a spec-shaped modern POST: body _meta plus the mirrored headers. */
function modernRequest(method: string, opts: ModernOpts = {}): Request {
  const version = opts.version ?? MODERN;
  const params: Record<string, unknown> = {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": version,
      "io.modelcontextprotocol/clientInfo": { name: "TestClient", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  };
  if (opts.name !== undefined) params.name = opts.name;

  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (opts.id !== null) body.id = opts.id ?? 1;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": version,
    "Mcp-Method": method,
    ...(opts.name !== undefined ? { "Mcp-Name": opts.name } : {}),
    ...(opts.headerOverrides ?? {}),
  };
  for (const drop of opts.omitHeaders ?? []) delete headers[drop];

  return new Request("http://localhost/", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function post(req: Request): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await mcpRoutes.request(req);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

function errorOf(json: Record<string, unknown>): { code: number; message: string; data?: unknown } {
  const err = json.error as { code: number; message: string; data?: unknown } | undefined;
  assertExists(err, `expected a JSON-RPC error, got ${JSON.stringify(json)}`);
  return err;
}

// ---------------------------------------------------------------------------
// Modern era
// ---------------------------------------------------------------------------

Deno.test("modern: server/discover answers with every supported version and the tools capability", async () => {
  const { status, json } = await post(modernRequest("server/discover"));
  assertEquals(status, 200);
  const result = json.result as Record<string, unknown>;
  assertExists(result);
  assertEquals(result.resultType, "complete");
  assertEquals(result.supportedVersions, MCP_SUPPORTED_VERSIONS);
  assertExists((result.capabilities as Record<string, unknown>).tools);
  // serverInfo is namespaced under _meta in this revision, not top level.
  const meta = result._meta as Record<string, unknown>;
  assertExists(meta["io.modelcontextprotocol/serverInfo"]);
});

Deno.test("modern: tools/list is empty for a request carrying no scopes", async () => {
  // These tests drive the router directly, so no auth middleware has set
  // apiKeyScopes. The registry (US-9106) filters on scope, so the correct answer
  // is an empty list - see mcp-tools_test.ts for the scoped cases.
  const { status, json } = await post(modernRequest("tools/list"));
  assertEquals(status, 200);
  assertEquals((json.result as { tools: unknown[] }).tools, []);
});

Deno.test("modern: ping returns an empty result object, not null", async () => {
  const { status, json } = await post(modernRequest("ping"));
  assertEquals(status, 200);
  assertEquals(json.result, {});
});

Deno.test("modern: Mcp-Method disagreeing with the body is rejected 400 / -32020", async () => {
  const { status, json } = await post(
    modernRequest("tools/list", { headerOverrides: { "Mcp-Method": "tools/call" } }),
  );
  assertEquals(status, 400);
  assertEquals(errorOf(json).code, MCP_ERROR.HEADER_MISMATCH);
});

Deno.test("modern: a missing MCP-Protocol-Version header is a header mismatch, not a version error", async () => {
  const { status, json } = await post(
    modernRequest("tools/list", { omitHeaders: ["MCP-Protocol-Version"] }),
  );
  assertEquals(status, 400);
  assertEquals(errorOf(json).code, MCP_ERROR.HEADER_MISMATCH);
});

Deno.test("modern: tools/call without the required Mcp-Name header is rejected", async () => {
  const req = modernRequest("tools/call", { name: "gradethread_ping", omitHeaders: ["Mcp-Name"] });
  const { status, json } = await post(req);
  assertEquals(status, 400);
  assertEquals(errorOf(json).code, MCP_ERROR.HEADER_MISMATCH);
});

Deno.test("modern: an Mcp-Name carrying the base64 sentinel is decoded before comparison", async () => {
  // A non-ASCII tool name cannot ride in a plain header value, so the client
  // wraps it. Decoding it wrong would reject a legitimate request.
  const name = "gradethread_grade_été";
  const encoded = "=?base64?" + btoa(String.fromCharCode(...new TextEncoder().encode(name))) + "?=";
  const req = modernRequest("tools/call", {
    name,
    headerOverrides: { "Mcp-Name": encoded },
  });
  const { status, json } = await post(req);
  // Header validation passes, so we reach dispatch and fail on the unknown tool
  // rather than on the header.
  assertEquals(status, 400);
  assertEquals(errorOf(json).code, JSON_RPC_ERROR.INVALID_PARAMS);
});

Deno.test("modern: an unsupported protocol version returns -32022 listing what we do support", async () => {
  const { status, json } = await post(modernRequest("tools/list", { version: "1900-01-01" }));
  assertEquals(status, 400);
  const err = errorOf(json);
  assertEquals(err.code, MCP_ERROR.UNSUPPORTED_PROTOCOL_VERSION);
  const data = err.data as { supported: string[]; requested: string };
  assertEquals(data.requested, "1900-01-01");
  assertEquals(data.supported, MCP_SUPPORTED_VERSIONS);
});

Deno.test("modern: an unknown method is 404 with -32601, which is what marks us as a modern server", async () => {
  const { status, json } = await post(modernRequest("resources/subscribe"));
  assertEquals(status, 404);
  assertEquals(errorOf(json).code, JSON_RPC_ERROR.METHOD_NOT_FOUND);
});

Deno.test("modern: an accepted notification returns 202 with no body", async () => {
  const req = modernRequest("notifications/initialized", { id: null });
  const res = await mcpRoutes.request(req);
  assertEquals(res.status, 202);
  assertEquals(await res.text(), "");
});

Deno.test("modern: an unrecognised notification is rejected rather than silently accepted", async () => {
  const req = modernRequest("notifications/invented", { id: null });
  const res = await mcpRoutes.request(req);
  assertEquals(res.status, 400);
});

Deno.test("transport: a JSON-RPC batch is refused with a message naming why", async () => {
  const res = await mcpRoutes.request(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]),
    }),
  );
  assertEquals(res.status, 400);
  const json = await res.json();
  assertEquals(errorOf(json).code, JSON_RPC_ERROR.INVALID_REQUEST);
  assert(errorOf(json).message.includes("batching"));
});

Deno.test("transport: malformed JSON is -32700 and carries no id", async () => {
  const res = await mcpRoutes.request(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    }),
  );
  assertEquals(res.status, 400);
  const json = await res.json();
  assertEquals(errorOf(json).code, JSON_RPC_ERROR.PARSE_ERROR);
  assertEquals(json.id, undefined);
});

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

Deno.test("transport: an untrusted Origin is 403 (DNS-rebinding defence)", async () => {
  const req = modernRequest("ping", { headerOverrides: { Origin: "https://evil.example.com" } });
  const { status } = await post(req);
  assertEquals(status, 403);
});

Deno.test("transport: an absent Origin is normal for an MCP client and is allowed", async () => {
  const { status } = await post(modernRequest("ping"));
  assertEquals(status, 200);
});

// ---------------------------------------------------------------------------
// Legacy era
// ---------------------------------------------------------------------------

Deno.test("legacy: initialize mints a session and the id is required afterwards", async () => {
  __resetLegacySessionsForTest();

  const initRes = await mcpRoutes.request(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "LegacyClient", version: "1.0.0" },
        },
      }),
    }),
  );
  assertEquals(initRes.status, 200);
  const sessionId = initRes.headers.get("Mcp-Session-Id");
  assertExists(sessionId);
  const initJson = await initRes.json();
  assertEquals((initJson.result as { protocolVersion: string }).protocolVersion, "2025-11-25");

  // The session works.
  const listRes = await mcpRoutes.request(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Mcp-Session-Id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }),
  );
  assertEquals(listRes.status, 200);

  // An id we never issued is 404 so the client re-initializes instead of looping.
  const staleRes = await mcpRoutes.request(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Mcp-Session-Id": crypto.randomUUID() },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    }),
  );
  assertEquals(staleRes.status, 404);
});

Deno.test("legacy: initialize answers a version we serve even when the client asks for one we do not", async () => {
  __resetLegacySessionsForTest();
  const res = await mcpRoutes.request(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "1900-01-01", capabilities: {}, clientInfo: { name: "Old" } },
      }),
    }),
  );
  assertEquals(res.status, 200);
  const json = await res.json();
  const agreed = (json.result as { protocolVersion: string }).protocolVersion;
  assert(
    MCP_SUPPORTED_VERSIONS.includes(agreed),
    `initialize offered ${agreed}, which is not in the supported list`,
  );
});

Deno.test("legacy: DELETE terminates the session, and a second DELETE is 405", async () => {
  __resetLegacySessionsForTest();
  const initRes = await mcpRoutes.request(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "C" } },
      }),
    }),
  );
  const sessionId = initRes.headers.get("Mcp-Session-Id")!;

  const first = await mcpRoutes.request(
    new Request("http://localhost/", { method: "DELETE", headers: { "Mcp-Session-Id": sessionId } }),
  );
  assertEquals(first.status, 204);

  const second = await mcpRoutes.request(
    new Request("http://localhost/", { method: "DELETE", headers: { "Mcp-Session-Id": sessionId } }),
  );
  assertEquals(second.status, 405);
});

Deno.test("modern-only clients: GET and DELETE without a session are 405, as the revision requires", async () => {
  __resetLegacySessionsForTest();
  const get = await mcpRoutes.request(new Request("http://localhost/", { method: "GET" }));
  assertEquals(get.status, 405);
  const del = await mcpRoutes.request(new Request("http://localhost/", { method: "DELETE" }));
  assertEquals(del.status, 405);
});

Deno.test("legacy: GET with a live session opens an SSE stream with buffering disabled", async () => {
  __resetLegacySessionsForTest();
  const initRes = await mcpRoutes.request(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "C" } },
      }),
    }),
  );
  const sessionId = initRes.headers.get("Mcp-Session-Id")!;

  const controller = new AbortController();
  const res = await mcpRoutes.request(
    new Request("http://localhost/", {
      method: "GET",
      headers: { "Mcp-Session-Id": sessionId },
      signal: controller.signal,
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Content-Type"), "text/event-stream");
  // Without X-Accel-Buffering the proxy holds events until its buffer fills and
  // the stream looks dead to the client.
  assertEquals(res.headers.get("X-Accel-Buffering"), "no");

  // Closing the stream is the cancellation signal on this transport; the server
  // must not keep the keep-alive timer alive after the client goes away.
  controller.abort();
  await res.body?.cancel().catch(() => {});
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

Deno.test("MCP_ENABLED=false hides the endpoint entirely (404, not 503)", async () => {
  Deno.env.set("MCP_ENABLED", "false");
  try {
    const { status } = await post(modernRequest("ping"));
    assertEquals(status, 404);
    const get = await mcpRoutes.request(new Request("http://localhost/", { method: "GET" }));
    assertEquals(get.status, 404);
  } finally {
    Deno.env.set("MCP_ENABLED", "true");
  }
});

// ---------------------------------------------------------------------------
// Framing helpers, unit level
// ---------------------------------------------------------------------------

Deno.test("decodeHeaderValue passes plain ASCII through and decodes the sentinel", () => {
  assertEquals(decodeHeaderValue("us-west1"), "us-west1");
  assertEquals(decodeHeaderValue("=?base64?SGVsbG8sIOS4lueVjA==?="), "Hello, 世界");
});

Deno.test("decodeHeaderValue returns null for a malformed sentinel rather than guessing", () => {
  assertEquals(decodeHeaderValue("=?base64?not-valid-base64!!?="), null);
});

Deno.test("parseJsonRpcMessage distinguishes a request from a notification by id presence", () => {
  const req = parseJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "ping" });
  assertEquals(req.kind, "request");
  const note = parseJsonRpcMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  assertEquals(note.kind, "notification");
});

Deno.test("parseJsonRpcMessage rejects a non-string/number id instead of coercing it", () => {
  const parsed = parseJsonRpcMessage({ jsonrpc: "2.0", id: { nested: true }, method: "ping" });
  assertEquals(parsed.kind, "invalid");
});

Deno.test("detectEra: body _meta wins over a stray session header", () => {
  const message = {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "tools/list",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } },
  };
  assertEquals(detectEra(message, MODERN), "modern");
});

Deno.test("detectEra: initialize is legacy by definition, the modern era has no such method", () => {
  assertEquals(detectEra({ jsonrpc: "2.0", id: 1, method: "initialize" }), "legacy");
});

Deno.test("detectEra: no version anywhere is treated as a pre-header legacy client", () => {
  assertEquals(detectEra({ jsonrpc: "2.0", id: 1, method: "tools/list" }), "legacy");
});

Deno.test("validateModernHeaders passes when every mirrored header matches the body", () => {
  const message = {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "tools/call",
    params: {
      name: "gradethread_list_items",
      _meta: { "io.modelcontextprotocol/protocolVersion": MODERN },
    },
  };
  const headers: Record<string, string> = {
    "MCP-Protocol-Version": MODERN,
    "Mcp-Method": "tools/call",
    "Mcp-Name": "gradethread_list_items",
  };
  assertEquals(validateModernHeaders(message, (n) => headers[n]), null);
});

Deno.test("validateModernHeaders catches a body whose _meta version disagrees with the header", () => {
  const message = {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "ping",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } },
  };
  const headers: Record<string, string> = {
    "MCP-Protocol-Version": MODERN,
    "Mcp-Method": "ping",
  };
  const failure = validateModernHeaders(message, (n) => headers[n]);
  assertExists(failure);
  assertEquals(failure.code, MCP_ERROR.HEADER_MISMATCH);
});
