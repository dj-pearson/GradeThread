// US-9106: the tool registry's invariants and its dispatch contract.
//
// The invariant block is the point of this file. Every rule it checks is either
// a published Claude connector-directory rejection cause or a US-268 tenancy
// rule, and each is checked by ENUMERATING the registry — so a tool added later
// is covered without anyone remembering to add a test for it.

import { assert, assertEquals, assertExists } from "@std/assert";
import { Hono } from "hono";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
Deno.env.set("MCP_ENABLED", "true");

const {
  findTool,
  listToolsFor,
  TOOL_NAME_MAX_LENGTH,
  TOOL_NAME_PREFIX,
  TOOLS,
  toolInvariantViolations,
  validateAgainstSchema,
} = await import("../lib/mcp-tools.ts");
const { API_KEY_SCOPES } = await import("../lib/api-key.ts");
const { mcpRoutes } = await import("../routes/mcp.ts");
const { __setConnectorPlanCheckForTest } = await import("../middleware/mcp-auth.ts");

// US-9124: the connector plan gate moved into the dispatcher, so it now runs
// before every non-sandbox tool. These cases are about scope checks, argument
// validation and tenant resolution - none of which is about billing - so the
// gate is opened here. Without this they all stop at the gate and assert
// nothing about what they were written for.
__setConnectorPlanCheckForTest(() => Promise.resolve(true));

// ---------------------------------------------------------------------------
// Registry invariants — enumerated, so new tools are covered automatically
// ---------------------------------------------------------------------------

Deno.test("every registered tool satisfies the directory and tenancy invariants", () => {
  assert(TOOLS.length > 0, "the registry must not be empty; the invariants would assert nothing");
  const failures: string[] = [];
  for (const tool of TOOLS) {
    const problems = toolInvariantViolations(tool);
    if (problems.length > 0) failures.push(`${tool.name}: ${problems.join("; ")}`);
  }
  assertEquals(failures, [], failures.join("\n"));
});

Deno.test("no tool claims to be both read-only and destructive", () => {
  for (const tool of TOOLS) {
    const readOnly = tool.annotations.readOnlyHint === true;
    const destructive = tool.annotations.destructiveHint === true;
    assert(
      readOnly !== destructive,
      `${tool.name} must set exactly one of readOnlyHint / destructiveHint`,
    );
  }
});

Deno.test("every tool name is unique, prefixed and within the 64-character limit", () => {
  const seen = new Set<string>();
  for (const tool of TOOLS) {
    assert(!seen.has(tool.name), `duplicate tool name: ${tool.name}`);
    seen.add(tool.name);
    assert(tool.name.startsWith(TOOL_NAME_PREFIX), `${tool.name} is missing the prefix`);
    assert(
      tool.name.length <= TOOL_NAME_MAX_LENGTH,
      `${tool.name} is ${tool.name.length} characters`,
    );
  }
});

Deno.test("every tool declares a scope the API key system can actually grant", () => {
  for (const tool of TOOLS) {
    assert(
      (API_KEY_SCOPES as readonly string[]).includes(tool.requiredScope),
      `${tool.name} requires '${tool.requiredScope}', which is not a real API key scope`,
    );
  }
});

Deno.test("every tool description says when to call it, not just what it is", () => {
  for (const tool of TOOLS) {
    // A description that never mentions calling is the shape that gets a
    // directory rejection for "does not specify when Claude should call it".
    assert(
      /\bcall\b|\buse\b|\bwhen\b/i.test(tool.description),
      `${tool.name}: description must say when Claude should call it`,
    );
    assert(tool.description.length >= 40, `${tool.name}: description is too thin to be useful`);
  }
});

Deno.test("toolInvariantViolations actually rejects a bad tool", () => {
  // Guard the guard: an invariant checker that never fails is decoration.
  const bad = {
    name: "not_prefixed",
    title: "",
    description: "",
    inputSchema: { type: "string" as const },
    requiredScope: "read" as const,
    annotations: { readOnlyHint: true as const, destructiveHint: false as const },
    handler: () => Promise.resolve({ content: [] }),
  };
  const problems = toolInvariantViolations(bad);
  assert(problems.some((p) => p.includes("must start with")), problems.join("; "));
  assert(problems.some((p) => p.includes("title")), problems.join("; "));
  assert(problems.some((p) => p.includes("description")), problems.join("; "));
  assert(problems.some((p) => p.includes("inputSchema")), problems.join("; "));
});

// ---------------------------------------------------------------------------
// Scope filtering
// ---------------------------------------------------------------------------

Deno.test("listToolsFor hides tools the credential cannot call", () => {
  const withRead = listToolsFor(["read"]);
  assert(withRead.length > 0, "a read credential should see at least one read tool");

  const withNothing = listToolsFor([]);
  assertEquals(withNothing, []);

  // Every listed tool is one this credential could actually invoke.
  for (const listed of listToolsFor(["read"])) {
    const tool = findTool(listed.name as string);
    assertExists(tool);
    assertEquals(tool.requiredScope, "read");
  }
});

Deno.test("a listed tool carries the fields the directory requires", () => {
  for (const listed of listToolsFor([...API_KEY_SCOPES])) {
    assertExists(listed.title, `${listed.name} must publish a title`);
    assertExists(listed.description);
    assertExists(listed.inputSchema);
    assertExists(listed.annotations);
  }
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const SAMPLE = {
  type: "object" as const,
  properties: {
    status: { type: "string" as const, enum: ["draft", "listed"] },
    limit: { type: "integer" as const, minimum: 1, maximum: 100 },
    tags: { type: "array" as const, items: { type: "string" as const } },
    live: { type: "boolean" as const },
  },
  required: ["status"],
  additionalProperties: false,
};

Deno.test("validateAgainstSchema accepts a well-formed object", () => {
  assertEquals(
    validateAgainstSchema(SAMPLE, { status: "draft", limit: 20, tags: ["a"], live: true }),
    null,
  );
});

Deno.test("validateAgainstSchema names the offending field, not just 'invalid'", () => {
  assertEquals(validateAgainstSchema(SAMPLE, {})?.path, "status");
  assertEquals(validateAgainstSchema(SAMPLE, { status: "nope" })?.path, "status");
  assertEquals(validateAgainstSchema(SAMPLE, { status: "draft", limit: 0 })?.path, "limit");
  assertEquals(validateAgainstSchema(SAMPLE, { status: "draft", limit: 1.5 })?.path, "limit");
  assertEquals(validateAgainstSchema(SAMPLE, { status: "draft", limit: 900 })?.path, "limit");
  assertEquals(validateAgainstSchema(SAMPLE, { status: "draft", tags: [1] })?.path, "tags[0]");
  assertEquals(validateAgainstSchema(SAMPLE, { status: "draft", nope: 1 })?.path, "nope");
});

Deno.test("validateAgainstSchema lets protocol _meta through an additionalProperties:false object", () => {
  // A conforming MCP client sends _meta; rejecting it would reject correctness.
  assertEquals(
    validateAgainstSchema(SAMPLE, { status: "draft", _meta: { anything: true } }),
    null,
  );
});

// ---------------------------------------------------------------------------
// Dispatch through the route
// ---------------------------------------------------------------------------

type ToolEnv = {
  Variables: {
    userId: string;
    apiKeyId: string;
    apiKeyScopes: string[];
    workspaceOwnerId: string;
  };
};

/** Mount the router behind a stub that sets exactly what real auth would set. */
function appWith(vars: Partial<ToolEnv["Variables"]>): Hono {
  const app = new Hono();
  app.use("/*", async (c, next) => {
    for (const [key, value] of Object.entries(vars)) {
      if (value !== undefined) (c.set as (k: string, v: unknown) => void)(key, value);
    }
    await next();
  });
  app.route("/", mcpRoutes);
  return app;
}

async function callTool(
  app: Hono,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

const AUTHED = {
  userId: "11111111-1111-4111-8111-111111111111",
  apiKeyId: "22222222-2222-4222-8222-222222222222",
  apiKeyScopes: ["read", "submit", "webhook_manage"],
};

Deno.test("tools/list through the route reflects the caller's scopes", async () => {
  const withRead = await appWith(AUTHED).request(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  const listed = (await withRead.json()).result.tools as Array<{ name: string }>;
  assert(listed.length > 0);

  const withoutScopes = await appWith({ ...AUTHED, apiKeyScopes: [] }).request(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  assertEquals((await withoutScopes.json()).result.tools, []);
});

Deno.test("tools/call re-checks the scope even though tools/list already filtered", async () => {
  // The whole point: hiding a tool is a display decision, this is the
  // authorization decision. Call it by name with no scopes at all.
  const { json } = await callTool(appWith({ ...AUTHED, apiKeyScopes: [] }), "gradethread_usage");
  const error = json.error as { message: string; data?: Record<string, unknown> };
  assertExists(error);
  assert(error.message.includes("scope"), error.message);
  assertEquals(error.data?.reason, "insufficient_scope");
});

Deno.test("tools/call on an unknown tool names the tool rather than failing generically", async () => {
  const { json } = await callTool(appWith(AUTHED), "gradethread_does_not_exist");
  const error = json.error as { message: string };
  assertExists(error);
  assert(error.message.includes("gradethread_does_not_exist"), error.message);
});

Deno.test("tools/call rejects an unknown argument with the field name", async () => {
  const { json } = await callTool(appWith(AUTHED), "gradethread_usage", { surprise: 1 });
  const error = json.error as { message: string; data?: Record<string, unknown> };
  assertExists(error);
  assert(error.message.includes("surprise"), error.message);
  assertEquals(error.data?.field, "surprise");
});

Deno.test("a tool cannot run without a resolved tenant", async () => {
  // No userId / apiKeyId on the context: unreachable behind mcpAuthMiddleware,
  // and it must fail closed rather than run for nobody.
  const { json } = await callTool(appWith({ apiKeyScopes: ["read"] }), "gradethread_usage");
  const error = json.error as { message: string };
  assertExists(error);
  assertEquals(error.message, "Internal error");
});

Deno.test("the handler receives the workspace OWNER as the tenant, not the calling member", async () => {
  // US-268: a member acts on the owner's data. Proven by calling the registry
  // handler directly with the context the route builds.
  const seen: Array<Record<string, unknown>> = [];
  const tool = findTool("gradethread_usage");
  assertExists(tool);
  const originalHandler = tool.handler;
  (tool as { handler: typeof originalHandler }).handler = (_args, ctx) => {
    seen.push({ ...ctx });
    return Promise.resolve({ content: [{ type: "text" as const, text: "stubbed" }] });
  };
  try {
    await callTool(
      appWith({
        ...AUTHED,
        workspaceOwnerId: "33333333-3333-4333-8333-333333333333",
      }),
      "gradethread_usage",
    );
  } finally {
    (tool as { handler: typeof originalHandler }).handler = originalHandler;
  }

  assertEquals(seen.length, 1);
  assertEquals(seen[0].tenantId, "33333333-3333-4333-8333-333333333333");
  assertEquals(seen[0].userId, AUTHED.userId);
});
