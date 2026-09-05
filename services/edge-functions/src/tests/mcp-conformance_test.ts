// US-9125: the connector's public shape, pinned.
//
// TOOL NAMES AND SCHEMAS ARE A PUBLIC INTERFACE the moment one seller writes a
// prompt that uses them. Renaming gradethread_list_items breaks that prompt
// silently: the model simply stops finding the tool and says it cannot help.
// Nothing errors, nothing logs, and the seller concludes the product got worse.
//
// So the snapshot below is deliberately annoying to update. A change to any
// name, description, schema or annotation has to be made here on purpose, in a
// diff a reviewer can read, rather than arriving as a side effect of a
// refactor.
//
// The transport half asserts the contract a client depends on rather than the
// implementation: status codes, error codes, and the shapes the spec names.

import { assert, assertEquals, assertExists } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
Deno.env.set("MCP_ENABLED", "true");

const { TOOLS, listToolsFor } = await import("../lib/mcp-tools.ts");
const { API_KEY_SCOPES } = await import("../lib/api-key.ts");
const { mcpRoutes } = await import("../routes/mcp.ts");
const {
  JSON_RPC_ERROR,
  MCP_ERROR,
  MCP_PREFERRED_MODERN_VERSION,
  MCP_SUPPORTED_VERSIONS,
} = await import("../lib/mcp-jsonrpc.ts");

// ---------------------------------------------------------------------------
// The golden tool list
// ---------------------------------------------------------------------------

/**
 * Every tool, with the fields a client sees. Ordered by name so a reordering of
 * the registry array is not a diff.
 *
 * To update: run the suite, read the failure, and change this list ONLY if the
 * change is intended. If it is a rename, say so in the commit message — someone
 * has a saved prompt that uses the old name.
 */
const GOLDEN_TOOLS = [
  "gradethread_apply_price_suggestion",
  "gradethread_comps",
  "gradethread_create_draft",
  "gradethread_dismiss_price_suggestion",
  "gradethread_end_listing",
  "gradethread_end_listings",
  "gradethread_extension_queue",
  "gradethread_get_batch",
  "gradethread_get_grade",
  "gradethread_get_item",
  "gradethread_grade_batch",
  "gradethread_grade_item",
  "gradethread_grading_readiness",
  "gradethread_list_grades",
  "gradethread_list_items",
  "gradethread_list_listings",
  "gradethread_list_sales",
  "gradethread_price_guide",
  "gradethread_price_suggestions",
  "gradethread_publish_listing",
  "gradethread_queue_extension_work",
  "gradethread_relist",
  "gradethread_reprice_apply",
  "gradethread_reprice_preview",
  "gradethread_sandbox_grade",
  "gradethread_sandbox_price_guide",
  "gradethread_sandbox_publish",
  "gradethread_update_draft",
  "gradethread_usage",
];

Deno.test("the published tool NAMES have not changed", () => {
  const actual = TOOLS.map((t) => t.name).sort();
  assertEquals(
    actual,
    GOLDEN_TOOLS,
    "The connector's tool names changed. A rename breaks every saved prompt that " +
      "uses the old name, silently — the model just stops finding the tool. Update " +
      "GOLDEN_TOOLS only if the change is intended, and say so in the commit.",
  );
});

/**
 * A stable fingerprint of everything else a client reads. Not the full schema
 * text: that would fail on a comment reflow and teach people to update the
 * snapshot without reading it.
 */
function fingerprint(tool: typeof TOOLS[number]): string {
  const args = Object.keys(tool.inputSchema.properties ?? {}).sort().join(",");
  const required = (tool.inputSchema.required ?? []).slice().sort().join(",");
  const mode = tool.annotations.readOnlyHint === true ? "read" : "destructive";
  return `${tool.name}|scope=${tool.requiredScope}|${mode}|args=${args}|required=${required}`;
}

const GOLDEN_FINGERPRINTS = [
  "gradethread_apply_price_suggestion|scope=submit|destructive|args=suggestion_id|required=suggestion_id",
  "gradethread_comps|scope=read|read|args=item_id|required=item_id",
  "gradethread_create_draft|scope=submit|destructive|args=item_ids,template_id,use_comps|required=item_ids",
  "gradethread_dismiss_price_suggestion|scope=submit|destructive|args=suggestion_id|required=suggestion_id",
  "gradethread_end_listings|scope=submit|destructive|args=confirm_token,listing_ids,mode|required=listing_ids",
  "gradethread_end_listing|scope=submit|destructive|args=confirm_token,listing_id,mode|required=listing_id",
  "gradethread_extension_queue|scope=read|read|args=|required=",
  "gradethread_get_batch|scope=read|read|args=batch_id|required=batch_id",
  "gradethread_get_grade|scope=read|read|args=submission_id|required=submission_id",
  "gradethread_get_item|scope=read|read|args=item_id|required=item_id",
  "gradethread_grade_batch|scope=submit|destructive|args=confirm_token,item_ids,mode,tier|required=item_ids",
  "gradethread_grade_item|scope=submit|destructive|args=confirm_token,item_id,mode,tier|required=item_id",
  "gradethread_grading_readiness|scope=read|read|args=item_ids,tier|required=item_ids",
  "gradethread_list_grades|scope=read|read|args=limit,page,status|required=",
  "gradethread_list_items|scope=read|read|args=brand,category,created_after,created_before,cursor,limit,listed,search,status|required=",
  "gradethread_list_listings|scope=read|read|args=cursor,limit,marketplace,max_price_cents,min_days_live,min_price_cents,min_watchers,status|required=",
  "gradethread_list_sales|scope=read|read|args=cursor,limit,marketplace,sold_after,sold_before,status|required=",
  "gradethread_price_guide|scope=read|read|args=slug|required=",
  "gradethread_price_suggestions|scope=read|read|args=limit|required=",
  "gradethread_publish_listing|scope=submit|destructive|args=confirm_token,item_id,mode|required=item_id",
  "gradethread_queue_extension_work|scope=submit|destructive|args=confirm_token,item_ids,kind,mode,platforms|required=item_ids,kind,platforms",
  "gradethread_relist|scope=submit|destructive|args=confirm_token,listing_id,mode,quantity|required=listing_id",
  "gradethread_reprice_apply|scope=submit|destructive|args=confirm_token,items|required=confirm_token,items",
  "gradethread_reprice_preview|scope=read|read|args=listing_ids|required=listing_ids",
  "gradethread_sandbox_grade|scope=read|read|args=brand,title|required=title",
  "gradethread_sandbox_price_guide|scope=read|read|args=slug|required=",
  "gradethread_sandbox_publish|scope=read|read|args=marketplace,price_cents,title|required=title",
  "gradethread_update_draft|scope=submit|destructive|args=condition,condition_description,description,item_specifics,listing_id,price,quantity,title|required=listing_id",
  "gradethread_usage|scope=read|read|args=|required=",
];

Deno.test("the published tool SCHEMAS, scopes and safety hints have not changed", () => {
  const actual = TOOLS.map(fingerprint).sort();
  assertEquals(
    actual,
    GOLDEN_FINGERPRINTS,
    "A tool's arguments, required fields, scope or safety hint changed. Removing " +
      "or renaming an argument breaks callers; adding a REQUIRED one breaks every " +
      "existing call. Update the snapshot only if that is intended.",
  );
});

Deno.test("the golden list is not silently empty or truncated", () => {
  // Guard the guard: an assertion against an empty registry passes forever.
  assert(GOLDEN_TOOLS.length >= 10, "the golden list looks truncated");
  assertEquals(GOLDEN_TOOLS.length, GOLDEN_FINGERPRINTS.length);
  assertEquals(GOLDEN_TOOLS.length, TOOLS.length);
});

Deno.test("what a full-scope credential sees matches the registry", () => {
  const listed = listToolsFor([...API_KEY_SCOPES]).map((t) => t.name as string).sort();
  assertEquals(listed, GOLDEN_TOOLS);
});

// ---------------------------------------------------------------------------
// The transport contract
// ---------------------------------------------------------------------------

function modernRequest(method: string, extra: Record<string, string> = {}): Request {
  const version = MCP_PREFERRED_MODERN_VERSION;
  return new Request("http://localhost/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "MCP-Protocol-Version": version,
      "Mcp-Method": method,
      ...extra,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": version,
          "io.modelcontextprotocol/clientInfo": { name: "conformance", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

async function call(req: Request) {
  const res = await mcpRoutes.request(req);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

Deno.test("conformance: server/discover reports every version we serve", async () => {
  const { status, json } = await call(modernRequest("server/discover"));
  assertEquals(status, 200);
  const result = json.result as Record<string, unknown>;
  assertEquals(result.resultType, "complete");
  assertEquals(result.supportedVersions, MCP_SUPPORTED_VERSIONS);
  // A client that retries from this list must land on something we accept.
  for (const version of result.supportedVersions as string[]) {
    assert(MCP_SUPPORTED_VERSIONS.includes(version));
  }
});

Deno.test("conformance: an unsupported version is 400 with -32022 and the supported list", async () => {
  const req = new Request("http://localhost/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "1999-01-01",
      "Mcp-Method": "ping",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1999-01-01" } },
    }),
  });
  const { status, json } = await call(req);
  assertEquals(status, 400);
  const error = json.error as { code: number; data: { supported: string[] } };
  assertEquals(error.code, MCP_ERROR.UNSUPPORTED_PROTOCOL_VERSION);
  assertExists(error.data.supported);
});

Deno.test("conformance: an unknown method is 404 with -32601", async () => {
  // The JSON-RPC body is what tells a client we are a modern server rather than
  // a legacy one that does not host this path at all.
  const { status, json } = await call(modernRequest("resources/subscribe"));
  assertEquals(status, 404);
  assertEquals((json.error as { code: number }).code, JSON_RPC_ERROR.METHOD_NOT_FOUND);
});

Deno.test("conformance: a mirrored header that disagrees with the body is -32020", async () => {
  const { status, json } = await call(
    modernRequest("tools/list", { "Mcp-Method": "tools/call" }),
  );
  assertEquals(status, 400);
  assertEquals((json.error as { code: number }).code, MCP_ERROR.HEADER_MISMATCH);
});

Deno.test("conformance: malformed JSON is -32700 and carries no id", async () => {
  const res = await mcpRoutes.request(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    }),
  );
  assertEquals(res.status, 400);
  const json = await res.json();
  assertEquals(json.error.code, JSON_RPC_ERROR.PARSE_ERROR);
  assertEquals(json.id, undefined);
});

Deno.test("conformance: GET and DELETE without a legacy session are 405", async () => {
  for (const method of ["GET", "DELETE"]) {
    const res = await mcpRoutes.request(new Request("http://localhost/", { method }));
    assertEquals(res.status, 405, `${method} should be 405 in the modern revision`);
  }
});

Deno.test("conformance: an accepted notification is 202 with an empty body", async () => {
  const version = MCP_PREFERRED_MODERN_VERSION;
  const res = await mcpRoutes.request(
    new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": version,
        "Mcp-Method": "notifications/initialized",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": version } },
      }),
    }),
  );
  assertEquals(res.status, 202);
  assertEquals(await res.text(), "");
});

Deno.test("conformance: every error body is a well-formed JSON-RPC error", async () => {
  // A client parses these. An HTML error page or a bare string is unreadable to
  // one, and the failure surfaces as "the connector stopped working".
  const cases = [
    modernRequest("resources/subscribe"),
    modernRequest("tools/list", { "Mcp-Method": "tools/call" }),
  ];
  for (const req of cases) {
    const { json } = await call(req);
    assertEquals(json.jsonrpc, "2.0");
    const error = json.error as { code: number; message: string };
    assertExists(error);
    assertEquals(typeof error.code, "number");
    assert(error.message.length > 0);
    // And no internals: no stack, no SQL, no table names.
    assert(!/\bat \w+ \(/.test(error.message), `error message leaked a stack: ${error.message}`);
    assert(!/supabase|postgres|relation "/i.test(error.message), "error message leaked internals");
  }
});
