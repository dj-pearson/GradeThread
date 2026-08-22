// The GradeThread MCP endpoint (US-9103) — a remote Model Context Protocol
// server so a Claude client can drive the FlipDesk pipeline from a chat.
//
// Mounted at /mcp on the EDGE service (functions.gradethread.com). It cannot go
// on api.gradethread.com: that host is Kong and serves Supabase routes only, so
// an MCP URL published there 404s with no obvious cause.
//
// DUAL-ERA, deliberately. See lib/mcp-jsonrpc.ts for the era model and
// vault/30-platform/claude-connector.md for why both are required: the current
// revision (2026-07-28) is stateless and header-mirrored, but Anthropic's own
// Messages API connector still speaks the 2025-11-25 handshake, so a
// modern-only server would be spec-correct and unable to talk to the product
// this exists for.
//
// WHAT IS NOT HERE YET, and where it lands:
//   US-9104  authentication (Bearer API key / OAuth token) + the 401/403
//            WWW-Authenticate challenges. Until it ships this endpoint is
//            unauthenticated, which is why MCP_ENABLED defaults OFF in
//            production and why tools/list is empty — it exposes nothing.
//   US-9105  rate limits, usage ledger, quota, maintenance guard.
//   US-9120  the OAuth 2.1 authorization-server surface.

import { Hono } from "hono";
import type { Context } from "hono";
import { isAllowedOrigin } from "../lib/allowed-origins.ts";
import { isProduction } from "../lib/env.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";
import { logEvent } from "../lib/observability.ts";
import { redactError } from "../lib/log-redact.ts";
import { releaseSha } from "../lib/observability.ts";
import {
  findTool,
  hasScope,
  listToolsFor,
  type McpToolContext,
  validateAgainstSchema,
  WRITE_TOOL_NAMES,
} from "../lib/mcp-tools.ts";
import type { ApiKeyScope } from "../lib/api-key.ts";
import { sanitizeDeep } from "../lib/mcp-untrusted.ts";
import { recordToolCall, type ToolCallStatus } from "../lib/mcp-audit.ts";
import { budgetKindForTool, checkBudget } from "../lib/mcp-budget.ts";
// US-9131: Multi Round-Trip Requests, so a person is asked rather than a model
// reporting that it asked one.
import { confirmationRequired, readConfirmation } from "../lib/mcp-elicit.ts";
// US-9101: the monthly plan allowance, alongside the per-action budgets.
import { checkConnectorAllowance } from "../lib/connector-allowance.ts";
import { connectorPlanAllows } from "../middleware/mcp-auth.ts";
import {
  bodyProtocolVersion,
  clientInfoOf,
  detectEra,
  HEADER_PROTOCOL_VERSION,
  HEADER_SESSION_ID,
  isSupportedVersion,
  JSON_RPC_ERROR,
  type JsonRpcErrorObject,
  type JsonRpcId,
  jsonRpcError,
  type JsonRpcMessage,
  jsonRpcResult,
  MCP_PREFERRED_LEGACY_VERSION,
  MCP_SUPPORTED_VERSIONS,
  META_SERVER_INFO,
  type McpEra,
  methodNotFoundError,
  parseJsonRpcMessage,
  unsupportedVersionError,
  validateModernHeaders,
} from "../lib/mcp-jsonrpc.ts";

export const mcpRoutes = new Hono();

const SERVER_NAME = "gradethread";

/**
 * Self-reported and explicitly NOT a security signal (the spec says clients
 * should not change behaviour based on it), so the release sha is fine here and
 * is what makes a bug report actionable.
 */
function serverInfo(): { name: string; version: string } {
  return { name: SERVER_NAME, version: releaseSha() };
}

const INSTRUCTIONS =
  "GradeThread grades pre-owned clothing condition and manages reseller listings. " +
  "Use these tools to read inventory, grades and listings, and to draft, price and " +
  "publish listings on connected marketplaces. Actions that publish, reprice or end " +
  "a listing always require an explicit confirmation step.";

/**
 * Kill switch. Off in production until authentication (US-9104) lands, so the
 * unauthenticated window never exists on a real deployment. Off returns 404
 * rather than 503: an endpoint that is not open yet should not advertise that
 * it is coming.
 *
 * US-9127 replaces this with a real feature flag so it can be flipped without a
 * redeploy; an env var needs no migration and is enough to ship behind.
 *
 * EXPORTED for /health/ready (US-2687), not because anything else routes on it.
 * The alternative was a second copy of these five lines in health.ts, and the
 * whole point of reporting the kill switch is that the report agrees with the
 * switch — two readings of one env var is exactly how they drift apart.
 */
export function isMcpEnabled(): boolean {
  const raw = (Deno.env.get("MCP_ENABLED") ?? "").trim().toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return !isProduction();
}

/**
 * US-9127 AC7: the runtime kill switch, checked alongside the env var.
 *
 * MCP_ENABLED is the deploy-time default and changing it means a redeploy —
 * minutes during which the thing you are trying to stop keeps running. The
 * `claude_connector` feature flag stops every replica within the flag cache TTL
 * with no deploy at all, which is what a rollback plan has to mean for a
 * surface that publishes listings.
 *
 * EITHER being off closes the endpoint. That asymmetry is deliberate: a stop
 * button should need one thing to say stop, not two things to agree.
 *
 * Fail-OPEN on a flag-store outage, like every other ops kill switch — an
 * unreachable flag table must not take the connector down. The thing that fails
 * CLOSED here is the allowance (lib/connector-allowance.ts), which is the one
 * that gates spending.
 */
async function isConnectorLive(): Promise<boolean> {
  if (!isMcpEnabled()) return false;
  return await isFeatureEnabled("claude_connector");
}

// ---------------------------------------------------------------------------
// Legacy sessions
// ---------------------------------------------------------------------------

interface LegacySession {
  protocolVersion: string;
  clientName?: string;
  lastSeenMs: number;
}

const LEGACY_SESSION_TTL_MS = 30 * 60_000;

/**
 * In-memory and therefore per-container. A restart or a rolling deploy makes
 * every legacy session unknown, and the client re-initializes — which is the
 * documented recovery path, not an error. Nothing durable belongs here: a
 * session holds no authority (US-9104's credential does) and no state a tool
 * call depends on.
 */
const legacySessions = new Map<string, LegacySession>();

function sweepLegacySessions(now: number): void {
  for (const [id, session] of legacySessions) {
    if (now - session.lastSeenMs > LEGACY_SESSION_TTL_MS) legacySessions.delete(id);
  }
}

function touchLegacySession(id: string, now: number): LegacySession | undefined {
  const session = legacySessions.get(id);
  if (!session) return undefined;
  if (now - session.lastSeenMs > LEGACY_SESSION_TTL_MS) {
    legacySessions.delete(id);
    return undefined;
  }
  session.lastSeenMs = now;
  return session;
}

// ---------------------------------------------------------------------------
// Guards shared by every HTTP method on the endpoint
// ---------------------------------------------------------------------------

/**
 * DNS-rebinding defence. A spec MUST and a named connector-review rejection
 * cause: validate Origin when it is PRESENT, reject with 403 when it is
 * invalid. An absent Origin is the normal case here — MCP clients are servers,
 * not browsers — and is not by itself suspicious.
 */
function originRejection(c: Context): Response | null {
  const origin = c.req.header("Origin");
  if (!origin) return null;
  if (isAllowedOrigin(origin)) return null;
  logEvent("warn", "mcp.origin_rejected", { origin });
  return c.json(jsonRpcError(null, { code: JSON_RPC_ERROR.INVALID_REQUEST, message: "Origin not allowed" }), 403);
}

function notFound(c: Context): Response {
  return c.json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// POST — the whole modern transport, and every legacy request
// ---------------------------------------------------------------------------

mcpRoutes.post("/", async (c) => {
  if (!(await isConnectorLive())) return notFound(c);
  const rejected = originRejection(c);
  if (rejected) return rejected;

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(
      jsonRpcError(null, { code: JSON_RPC_ERROR.PARSE_ERROR, message: "Invalid JSON" }),
      400,
    );
  }

  const parsed = parseJsonRpcMessage(raw);
  if (parsed.kind === "invalid") {
    return c.json(jsonRpcError(parsed.id, parsed.error), 400);
  }

  const message = parsed.message;
  const isNotification = parsed.kind === "notification";
  const id: JsonRpcId | null = isNotification ? null : (message as { id: JsonRpcId }).id;
  const headerVersion = c.req.header(HEADER_PROTOCOL_VERSION);
  const era = detectEra(message, headerVersion);

  // Version support is checked before anything else that could act, so an
  // unsupported client is told what we speak instead of getting a method error
  // it cannot interpret.
  const claimed = bodyProtocolVersion(message) ?? headerVersion;
  if (claimed && !isSupportedVersion(claimed) && message.method !== "initialize") {
    return c.json(jsonRpcError(id, unsupportedVersionError(claimed)), 400);
  }

  // The modern header/body contract. Skipped for notifications: the spec does
  // not define header requirements for a notification POST in this revision.
  if (era === "modern" && !isNotification) {
    const mismatch = validateModernHeaders(message, (name) => c.req.header(name));
    if (mismatch) {
      logEvent("warn", "mcp.header_mismatch", { method: message.method });
      return c.json(jsonRpcError(id, mismatch), 400);
    }
  }

  const now = Date.now();
  sweepLegacySessions(now);

  // Legacy session enforcement. `initialize` is what mints the session, so it is
  // the one method that may arrive without one. An unknown or expired id gets
  // 404 so the client re-initializes rather than retrying forever.
  let sessionId: string | undefined;
  if (era === "legacy" && message.method !== "initialize") {
    sessionId = c.req.header(HEADER_SESSION_ID);
    if (sessionId && !touchLegacySession(sessionId, now)) {
      return c.json(
        jsonRpcError(id, { code: JSON_RPC_ERROR.INVALID_REQUEST, message: "Unknown or expired session; re-initialize" }),
        404,
      );
    }
  }

  if (isNotification) {
    const accepted = handleNotification(message);
    return accepted
      ? new Response(null, { status: 202 })
      : c.json(
        jsonRpcError(null, methodNotFoundError(message.method)),
        400,
      );
  }

  try {
    const outcome = await handleRequest(
      c,
      message as { id: JsonRpcId; method: string; params?: Record<string, unknown> },
      era,
      now,
    );
    if (outcome.error) {
      // Method-not-found is 404 in the modern binding — the JSON-RPC body is
      // what distinguishes it from a legacy server's 404 at the same path.
      const status = outcome.error.code === JSON_RPC_ERROR.METHOD_NOT_FOUND ? 404 : 400;
      return c.json(jsonRpcError(id, outcome.error), status);
    }
    if (outcome.sessionId) c.header(HEADER_SESSION_ID, outcome.sessionId);
    return c.json(jsonRpcResult(id as JsonRpcId, outcome.result));
  } catch (err) {
    logEvent("error", "mcp.request_failed", { method: message.method, error: redactError(err) });
    return c.json(
      jsonRpcError(id, { code: JSON_RPC_ERROR.INTERNAL_ERROR, message: "Internal error" }),
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// GET / DELETE — legacy only
// ---------------------------------------------------------------------------

// The modern revision removed the standalone GET stream and the DELETE
// terminate, and tells a modern-only server to answer both with 405. We are
// dual-era, so these exist for legacy clients and 405 for everyone else. A GET
// without a known session is indistinguishable from a modern client probing, so
// it gets the 405 the spec asks for.
mcpRoutes.get("/", async (c) => {
  if (!(await isConnectorLive())) return notFound(c);
  const rejected = originRejection(c);
  if (rejected) return rejected;

  const sessionId = c.req.header(HEADER_SESSION_ID);
  if (!sessionId || !touchLegacySession(sessionId, Date.now())) {
    return c.json(
      jsonRpcError(null, {
        code: JSON_RPC_ERROR.INVALID_REQUEST,
        message: "The standalone SSE stream requires a legacy session; this revision has no GET stream",
      }),
      405,
    );
  }

  // A legacy client opens this to receive server-initiated messages. We send
  // none: every tool result comes back on its own POST response, and the change
  // notifications a client could subscribe to do not exist yet. Holding the
  // stream open with keep-alives is correct and cheap; closing it immediately
  // would make well-behaved clients reconnect in a loop.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(": connected\n\n"));
      const timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          clearInterval(timer);
        }
      }, 25_000);
      c.req.raw.signal.addEventListener("abort", () => {
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          // Already closed by the client going away; nothing to do.
        }
      });
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      // Without this, nginx/Traefik buffers the stream and the client sees
      // nothing until the buffer fills.
      "X-Accel-Buffering": "no",
    },
  });
});

mcpRoutes.delete("/", async (c) => {
  if (!(await isConnectorLive())) return notFound(c);
  const rejected = originRejection(c);
  if (rejected) return rejected;

  const sessionId = c.req.header(HEADER_SESSION_ID);
  if (!sessionId || !legacySessions.has(sessionId)) {
    return c.json(
      jsonRpcError(null, {
        code: JSON_RPC_ERROR.INVALID_REQUEST,
        message: "No such session; this revision has no session to terminate",
      }),
      405,
    );
  }
  legacySessions.delete(sessionId);
  return new Response(null, { status: 204 });
});

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

interface RequestOutcome {
  result?: unknown;
  error?: JsonRpcErrorObject;
  /** Set only by `initialize`, to be echoed as the Mcp-Session-Id header. */
  sessionId?: string;
}

/** Returns true when the notification is one we recognise and accept. */
function handleNotification(message: JsonRpcMessage): boolean {
  switch (message.method) {
    // Legacy clients send this after initialize. There is nothing to do with
    // it, but accepting it is required — a 400 here makes a client think the
    // handshake failed.
    case "notifications/initialized":
      return true;
    // On HTTP, closing the response stream IS the cancellation signal, so this
    // should never arrive. Accept it rather than erroring: a client that sends
    // it belt-and-braces is not wrong, just redundant.
    case "notifications/cancelled":
      return true;
    default:
      return false;
  }
}

async function handleRequest(
  c: Context,
  message: { id: JsonRpcId; method: string; params?: Record<string, unknown> },
  era: McpEra,
  now: number,
): Promise<RequestOutcome> {
  switch (message.method) {
    case "server/discover":
      return { result: discoverResult() };

    case "initialize":
      return initialize(message, now);

    case "ping":
      // Deliberately an empty object, not null: the spec's ping result is an
      // empty result object and some clients type it strictly.
      return { result: {} };

    case "tools/list": {
      // Filtered by scope: a credential never SEES a tool it cannot call.
      //
      // NOT filtered by plan. A free account is shown the whole set with the
      // sandbox tools among them, because "here is what this does, try these
      // two" is the answer to "should I upgrade" and an empty list is not.
      return { result: { tools: listToolsFor(callerScopes(c)) } };
    }

    case "tools/call":
      return await callTool(c, message, era);

    default:
      void era;
      return { error: methodNotFoundError(message.method) };
  }
}

function discoverResult(): Record<string, unknown> {
  return {
    resultType: "complete",
    supportedVersions: MCP_SUPPORTED_VERSIONS,
    capabilities: { tools: {} },
    instructions: INSTRUCTIONS,
    _meta: { [META_SERVER_INFO]: serverInfo() },
  };
}

function initialize(
  message: { params?: Record<string, unknown> },
  now: number,
): RequestOutcome {
  const requested = typeof message.params?.protocolVersion === "string"
    ? message.params.protocolVersion
    : undefined;

  // A legacy client has no fall-forward mechanism, so when we cannot serve what
  // it asked for we still answer with a version we DO serve rather than an
  // error it cannot act on. That is the handshake's own negotiation rule.
  const agreed = requested && isSupportedVersion(requested)
    ? requested
    : MCP_PREFERRED_LEGACY_VERSION;

  const sessionId = crypto.randomUUID();
  const info = clientInfoOf({ jsonrpc: "2.0", method: "initialize", params: message.params });
  legacySessions.set(sessionId, {
    protocolVersion: agreed,
    clientName: typeof (message.params?.clientInfo as { name?: string } | undefined)?.name === "string"
      ? (message.params?.clientInfo as { name: string }).name
      : info?.name,
    lastSeenMs: now,
  });

  return {
    sessionId,
    result: {
      protocolVersion: agreed,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
      instructions: INSTRUCTIONS,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

function ctxStr(c: Context, key: string): string | undefined {
  try {
    const value = (c.get as (k: string) => unknown)(key);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function callerScopes(c: Context): ApiKeyScope[] {
  try {
    const value = (c.get as (k: string) => unknown)("apiKeyScopes");
    return Array.isArray(value) ? value as ApiKeyScope[] : [];
  } catch {
    return [];
  }
}

/**
 * Resolve the tenant a tool may act for.
 *
 * `workspaceOwnerId ?? userId` is the US-268 rule: a workspace member acts on
 * the OWNER's data, not their own. Returning null rather than falling back to
 * anything means a tool cannot run untenanted even if auth were misconfigured.
 */
function toolContext(c: Context): McpToolContext | null {
  const userId = ctxStr(c, "userId");
  const apiKeyId = ctxStr(c, "apiKeyId");
  if (!userId || !apiKeyId) return null;
  return {
    tenantId: ctxStr(c, "workspaceOwnerId") ?? userId,
    userId,
    apiKeyId,
    scopes: callerScopes(c),
  };
}

async function callTool(
  c: Context,
  message: { params?: Record<string, unknown> },
  era: McpEra,
): Promise<RequestOutcome> {
  const startedAt = Date.now();
  const name = typeof message.params?.name === "string" ? message.params.name : undefined;
  const rawArgs = message.params?.arguments;
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
    ? rawArgs as Record<string, unknown>
    : {};
  const ctx = toolContext(c);

  // US-9113: one audit row per call, refusals INCLUDED. A denied call is often
  // the more interesting row, because it is what a probe looks like. Skipped
  // only when there is no tenant to attribute it to, which is unreachable
  // behind mcpAuthMiddleware.
  const audit = (
    status: ToolCallStatus,
    errorCode?: string,
    detail?: Record<string, unknown>,
  ) => {
    if (!ctx) return;
    recordToolCall({
      tenantId: ctx.tenantId,
      apiKeyId: ctx.apiKeyId,
      toolName: name ?? "(unnamed)",
      // US-9117: a handler may add what the arguments could not say. Merged
      // under one key so it can never collide with a real argument name.
      args: detail ? { ...args, _detail: detail } : args,
      status,
      errorCode: errorCode ?? null,
      durationMs: Date.now() - startedAt,
    });
  };

  if (!name) {
    audit("refused", "missing_name");
    return { error: { code: JSON_RPC_ERROR.INVALID_PARAMS, message: "params.name is required" } };
  }

  const tool = findTool(name);
  if (!tool) {
    audit("refused", "unknown_tool");
    return { error: { code: JSON_RPC_ERROR.INVALID_PARAMS, message: `Unknown tool: ${name}` } };
  }

  // US-9124: the PLAN gate, here rather than in auth, because only here do we
  // know which tool was asked for. A sandbox tool is exempt on purpose - it
  // reads nothing, changes nothing, and being usable before you pay is the
  // entire point of it.
  if (ctx && !tool.sandbox) {
    if (!(await connectorPlanAllows(ctx.tenantId))) {
      audit("denied", "plan_required");
      return {
        error: {
          code: JSON_RPC_ERROR.INVALID_REQUEST,
          message:
            `The GradeThread connector is not included in this plan. ` +
            `Try the sandbox tools, or see https://gradethread.com/pricing to upgrade.`,
          data: { reason: "plan_required" },
        },
      };
    }
  }

  // Re-checked here even though tools/list already filtered: a filter is a
  // display decision, and this is the authorization decision.
  const scopes = callerScopes(c);
  if (!hasScope(scopes, tool.requiredScope)) {
    audit("denied", "insufficient_scope");
    return {
      error: {
        code: JSON_RPC_ERROR.INVALID_PARAMS,
        message: `This credential lacks the '${tool.requiredScope}' scope required by ${name}`,
        data: { reason: "insufficient_scope", required_scopes: [tool.requiredScope] },
      },
    };
  }

  // US-9119: the action ceiling, checked in the DISPATCHER.
  //
  // Rate limits stop a flood; they do not stop a well-paced mistake. Forty
  // publishes over forty minutes is inside every per-minute budget and is still
  // a seller's whole store live at the wrong price. A per-handler version of
  // this is a cap the next tool forgets, and the next tool is the one nobody
  // reviewed as carefully.
  const budgetKind = ctx ? budgetKindForTool(name) : null;
  if (ctx && budgetKind) {
    const verdict = await checkBudget({ subject: ctx.apiKeyId, kind: budgetKind });
    if (!verdict.allowed) {
      audit("denied", "budget_exceeded");
      return {
        error: {
          code: JSON_RPC_ERROR.INVALID_REQUEST,
          message: verdict.message ?? "Connector action limit reached.",
          data: {
            reason: "budget_exceeded",
            budget: verdict.kind,
            used: verdict.used,
            max: verdict.max,
            resets_at: verdict.resetsAt,
          },
        },
      };
    }
  }

  // US-9101: the MONTHLY plan allowance, which is a different question from the
  // per-action budgets above.
  //
  // The budgets bound a burst — twenty publishes an hour. This bounds the month,
  // and it is the number a plan is sold on. Checked only for tools that CHANGE
  // something: charging for a preview would teach a model to ask less, which is
  // the opposite of what the preview protocol wants.
  //
  // Fails CLOSED, like the budgets: an allowance we cannot read must not read as
  // unlimited for something that publishes listings.
  if (ctx && !tool.sandbox && tool.annotations.destructiveHint === true) {
    let verdict;
    try {
      verdict = await checkConnectorAllowance(ctx.tenantId, WRITE_TOOL_NAMES);
    } catch (err) {
      logEvent("error", "mcp.allowance_unavailable", { error: redactError(err) });
      verdict = {
        allowed: false,
        used: 0,
        limit: 0,
        resetsAt: "",
        message: "We could not check your connector allowance, so this was not run. " +
          "Try again shortly.",
      };
    }
    if (!verdict.allowed) {
      audit("denied", "allowance_exceeded");
      return {
        error: {
          code: JSON_RPC_ERROR.INVALID_REQUEST,
          message: verdict.message ?? "Connector allowance reached.",
          data: {
            reason: "allowance_exceeded",
            used: verdict.used,
            limit: verdict.limit,
            resets_at: verdict.resetsAt,
          },
        },
      };
    }
  }

  const violation = validateAgainstSchema(tool.inputSchema, args);
  if (violation) {
    audit("refused", "invalid_arguments");
    return {
      error: {
        code: JSON_RPC_ERROR.INVALID_PARAMS,
        message: `Invalid arguments: ${violation.path} ${violation.message}`,
        data: { field: violation.path },
      },
    };
  }

  if (!ctx) {
    // Unreachable behind mcpAuthMiddleware. Failing closed here means a future
    // mount that forgets the middleware breaks loudly instead of leaking.
    logEvent("error", "mcp.tool_missing_tenant", { tool: name });
    return { error: { code: JSON_RPC_ERROR.INTERNAL_ERROR, message: "Internal error" } };
  }

  // US-9131: ask a HUMAN, via MRTR (SEP-2322), before the acting call runs.
  //
  // MODERN ONLY. An InputRequiredResult is a 2026-07-28 shape; a legacy client
  // would read it as a malformed result and the tool would look broken. Those
  // clients keep the two-call preview/confirm flow, which still cannot act
  // without a token — which is why this is an improvement and not a dependency.
  //
  // It runs AFTER every gate above and BEFORE the handler, deliberately: there
  // is no point asking a person to approve something the plan, the scope or the
  // budget was going to refuse anyway.
  // US-2752: ownership is checked in the HANDLER, which runs after the prompt
  // below — so a cross-tenant acting call used to be answered with an approval
  // question instead of a refusal. This closes that gap on the same principle
  // the block below already states, and runs for EVERY era: a legacy client
  // reaching for another tenant's row should be refused too.
  if (tool.preConfirmCheck) {
    const refusal = await tool.preConfirmCheck(args, ctx);
    if (refusal) {
      audit("refused", "not_your_row");
      return { result: { content: [{ type: "text", text: refusal }], isError: true } };
    }
  }

  if (era === "modern" && tool.humanConfirmation) {
    const question = tool.humanConfirmation(args);
    if (question) {
      const verdict = readConfirmation(message.params, name);
      if (verdict.state === "not_asked") {
        // Not audited as a refusal: nothing was decided yet. The row is written
        // when the retry lands, so one seller decision is one audit row rather
        // than two.
        return { result: confirmationRequired(name, question) };
      }
      if (verdict.state === "refused") {
        audit("refused", "human_declined");
        return {
          result: { content: [{ type: "text", text: verdict.message }], isError: true },
        };
      }
    }
  }

  try {
    const { auditDetail, ...result } = await tool.handler(args, ctx);
    audit(result.isError ? "error" : "ok", undefined, auditDetail);

    // US-9111: EVERY tool result passes through here, so a tool added later is
    // covered without its author remembering. Cleaning (invisible characters,
    // delimiter neutralisation) is unconditional; the declared untrusted fields
    // are additionally wrapped with the do-not-follow preamble.
    return { result: sanitizeDeep(result, { wrapUntrustedFields: true }) };
  } catch (err) {
    // The row is written BEFORE the throw propagates, so a handler that blows
    // up still leaves a trace of having been called.
    audit("error", "handler_threw");
    throw err;
  }
}

/** Test seam: legacy sessions are process-local, so a suite must be able to reset them. */
export function __resetLegacySessionsForTest(): void {
  legacySessions.clear();
}
