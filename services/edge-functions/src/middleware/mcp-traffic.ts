// US-9105: rate limiting and usage accounting for the MCP endpoint.
//
// THE PROBLEM THIS SOLVES. /api/v1 splits its read and write budgets by HTTP
// method: GET is cheap, POST spends AI credits. On MCP every message is a POST,
// so that split does not exist at the HTTP layer — and applying one budget to
// everything would let a `tools/list` poll drain the budget a publish needs,
// which is precisely what the separate budgets exist to prevent.
//
// So the class is derived from the JSON-RPC method instead, once, before the
// limiters run:
//   • tools/call on a tool annotated readOnlyHint  → READ budget
//   • tools/call on anything else                  → WRITE budget
//   • every other method                           → READ budget
//
// The registry lookup is what makes the first line possible, and it matters more
// than it looks. The write budget is deliberately the TIGHT one, so treating
// every tools/call as a write meant a connector doing ordinary read work —
// listing items, checking a grade — exhausted the budget a publish needs. An
// UNKNOWN tool name still counts as a write: erring toward the tighter limit is
// the right default for something we cannot classify.

import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { apiV1Tier } from "./api-v1-rate.ts";
import { recordApiUsage } from "../lib/api-usage-log.ts";
import { findTool } from "../lib/mcp-tools.ts";
import { redactError } from "../lib/log-redact.ts";
import {
  HEADER_METHOD,
  HEADER_PROTOCOL_VERSION,
  isModernVersion,
  JSON_RPC_ERROR,
  jsonRpcError,
} from "../lib/mcp-jsonrpc.ts";

export type McpRateClass = "read" | "write";

const CLASS_VAR = "mcpRateClass";
const METHOD_VAR = "mcpRpcMethod";
const TOOL_VAR = "mcpToolName";

/** JSON-RPC methods that can act on something rather than describe it. */
const WRITE_METHODS = new Set(["tools/call"]);

/**
 * Methods that cost nothing and must NOT create a usage-ledger row. Handshake,
 * discovery and listing are protocol overhead a client performs to be correct;
 * billing them would make an efficient client look expensive and would let
 * reconnect churn eat a partner's monthly quota.
 */
const NON_BILLABLE_METHODS = new Set([
  "initialize",
  "ping",
  "server/discover",
  "tools/list",
  "resources/list",
  "prompts/list",
]);

function ctxStr(c: Context, key: string): string | undefined {
  try {
    const value = (c.get as (k: string) => unknown)(key);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the JSON-RPC method without consuming the body.
 *
 * The modern era mirrors it into `Mcp-Method` precisely so an intermediary can
 * route on it, and the spec warns that a mirrored header must not be trusted
 * unless the version says header/body validation applies — so the header is used
 * ONLY when MCP-Protocol-Version names a modern revision. Everything else falls
 * back to the body, which Hono caches, so the route parses it again for free.
 *
 * Mis-reading the method here can only mis-bucket one request; the route's own
 * header validation (-32020) is what actually catches a lying client.
 */
async function readMethod(c: Context): Promise<{ method?: string; tool?: string }> {
  const version = c.req.header(HEADER_PROTOCOL_VERSION);
  const headerMethod = c.req.header(HEADER_METHOD);
  if (version && isModernVersion(version) && headerMethod) {
    // Mcp-Name carries the tool, but it may be base64-wrapped; the ledger wants
    // a stable label, and the route decodes and validates it properly. Reading
    // the body here keeps one decoder rather than two.
    const body = await peekBody(c);
    return { method: headerMethod, tool: toolNameOf(body) };
  }
  const body = await peekBody(c);
  const method = typeof body?.method === "string" ? body.method : undefined;
  return { method, tool: toolNameOf(body) };
}

async function peekBody(c: Context): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = await c.req.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    // Malformed or empty body. The route answers -32700; classification just
    // treats it as a read so a flood of garbage still hits the tighter of the
    // two ceilings it can reach.
    return undefined;
  }
}

function toolNameOf(body: Record<string, unknown> | undefined): string | undefined {
  const params = body?.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const name = (params as Record<string, unknown>).name;
  return typeof name === "string" ? name : undefined;
}

/**
 * Classify the request before the limiters run. Must be mounted AFTER
 * mcpAuthMiddleware (so an unauthenticated flood is shed before we parse
 * anything) and BEFORE the limiters.
 */
export const mcpClassifyMiddleware = createMiddleware(async (c, next) => {
  const { method, tool } = await readMethod(c);
  const rateClass = classifyRpcMethod(method, tool);
  c.set(CLASS_VAR, rateClass);
  if (method) c.set(METHOD_VAR, method);
  if (tool) c.set(TOOL_VAR, tool);
  await next();
});

export function mcpReadLimit(c: Context): number {
  return apiV1Tier(c).read;
}

export function mcpWriteLimit(c: Context): number {
  return apiV1Tier(c).write;
}

/**
 * `bypass` predicates so one limiter governs reads and the other writes without
 * touching the shared rateLimiter. A GET (the legacy SSE stream) or DELETE
 * carries no JSON-RPC method and is classified as a read by default.
 */
export function bypassUnlessRead(c: Context): boolean {
  return (ctxStr(c, CLASS_VAR) ?? "read") !== "read";
}

export function bypassUnlessWrite(c: Context): boolean {
  return (ctxStr(c, CLASS_VAR) ?? "read") !== "write";
}

/**
 * The 429 an MCP client can parse. /api/v1's envelope body is unreadable to
 * one, so the retry-after lands in the JSON-RPC error data as well as the
 * header the shared limiter already sets.
 */
export function mcpRateLimitBody(info: { retryAfter: number; limit: number }): unknown {
  return jsonRpcError(null, {
    code: JSON_RPC_ERROR.INVALID_REQUEST,
    message: `Rate limit exceeded. Retry after ${info.retryAfter}s.`,
    data: {
      reason: "rate_limited",
      retry_after_seconds: info.retryAfter,
      limit_per_minute: info.limit,
    },
  });
}

/**
 * One usage-ledger row per billable MCP call, broken out by tool so the partner
 * usage view can separate connector activity from raw API calls.
 *
 * Mount AFTER auth and the limiters: a 401 or 429 returned before this runs, and
 * neither is billable usage.
 */
export const mcpUsageMiddleware = createMiddleware(async (c, next) => {
  await next();
  try {
    const method = ctxStr(c, METHOD_VAR);
    if (!method || NON_BILLABLE_METHODS.has(method) || method.startsWith("notifications/")) return;

    const tool = ctxStr(c, TOOL_VAR);
    recordApiUsage({
      userId: ctxStr(c, "userId") ?? null,
      apiKeyId: ctxStr(c, "apiKeyId") ?? null,
      // Namespaced so /mcp rows never collide with an /api/v1 path, and carrying
      // the tool so "which tool is this partner actually using" is answerable.
      endpoint: tool ? `/mcp:${method}:${tool}` : `/mcp:${method}`,
      method: c.req.method,
      statusCode: c.res.status,
      sandbox: false,
    });
  } catch (err) {
    console.error("[mcp-usage] middleware error:", redactError(err));
  }
});

/**
 * The classification rule, without the HTTP plumbing.
 *
 * A tools/call is a write UNLESS the named tool is annotated read-only. An
 * unknown name stays a write: erring toward the tighter budget is the right
 * default for something we cannot classify, and it is also what a caller
 * probing for tool names would hit.
 */
export function classifyRpcMethod(
  method: string | undefined,
  toolName?: string,
): McpRateClass {
  if (!method || !WRITE_METHODS.has(method)) return "read";
  if (!toolName) return "write";
  return findTool(toolName)?.annotations.readOnlyHint === true ? "read" : "write";
}

/** Exported for tests: whether a method creates a usage-ledger row. */
export function isBillableRpcMethod(method: string | undefined): boolean {
  if (!method) return false;
  if (method.startsWith("notifications/")) return false;
  return !NON_BILLABLE_METHODS.has(method);
}
