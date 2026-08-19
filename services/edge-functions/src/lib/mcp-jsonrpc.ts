// JSON-RPC framing, protocol-version handling and era detection for the MCP
// endpoint (US-9103). The transport route (routes/mcp.ts) owns HTTP; this file
// owns "what does this message mean", so both can be tested independently.
//
// THE THING TO UNDERSTAND FIRST: there are two incompatible eras of MCP and we
// answer both.
//
//   MODERN  (2026-07-28+)  No handshake, no session. Every POST carries its own
//                          protocol version, client info and capabilities in
//                          params._meta, mirrored into HTTP headers. No GET
//                          stream, no DELETE, no batching, no resumability.
//   LEGACY  (2025-11-25-)  An `initialize` handshake opens a session, the
//                          server assigns Mcp-Session-Id, and the client may
//                          open a standalone GET SSE stream.
//
// We implement both because the current revision is modern but Anthropic's own
// Messages API MCP connector (beta mcp-client-2025-11-20) is still legacy — a
// modern-only server would be spec-correct and unable to talk to the product
// this exists for. See vault/30-platform/claude-connector.md.

// ---------------------------------------------------------------------------
// Protocol versions
// ---------------------------------------------------------------------------

/** Revisions that convey version/identity/capabilities as per-request metadata. */
export const MCP_MODERN_VERSIONS = ["2026-07-28"] as const;

/**
 * Revisions that open a session with an `initialize` handshake. Ordered newest
 * first — the first entry is what we offer a legacy client that asks for
 * something we don't recognise.
 */
export const MCP_LEGACY_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;

export const MCP_SUPPORTED_VERSIONS: string[] = [
  ...MCP_MODERN_VERSIONS,
  ...MCP_LEGACY_VERSIONS,
];

export const MCP_PREFERRED_MODERN_VERSION: string = MCP_MODERN_VERSIONS[0];
export const MCP_PREFERRED_LEGACY_VERSION: string = MCP_LEGACY_VERSIONS[0];

/**
 * Pre-2025-06-18 clients did not send MCP-Protocol-Version at all. The spec
 * permits treating an absent header as this version rather than rejecting.
 */
export const MCP_ASSUMED_VERSION_WHEN_HEADER_ABSENT = "2025-03-26";

export function isModernVersion(version: string): boolean {
  return (MCP_MODERN_VERSIONS as readonly string[]).includes(version);
}

export function isLegacyVersion(version: string): boolean {
  return (MCP_LEGACY_VERSIONS as readonly string[]).includes(version);
}

export function isSupportedVersion(version: string): boolean {
  return MCP_SUPPORTED_VERSIONS.includes(version);
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/** Standard JSON-RPC 2.0 codes. */
export const JSON_RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * Codes the MCP specification allocates from its reserved sub-range.
 * HEADER_MISMATCH is returned when a mirrored HTTP header disagrees with the
 * request body — a security control, not bookkeeping: an intermediary routing
 * on the header while we execute on the body is exactly what it closes.
 */
export const MCP_ERROR = {
  HEADER_MISMATCH: -32020,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
} as const;

// ---------------------------------------------------------------------------
// _meta keys and mirrored headers
// ---------------------------------------------------------------------------

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

export const HEADER_PROTOCOL_VERSION = "MCP-Protocol-Version";
export const HEADER_METHOD = "Mcp-Method";
export const HEADER_NAME = "Mcp-Name";
export const HEADER_SESSION_ID = "Mcp-Session-Id";

/** Methods whose `Mcp-Name` header is REQUIRED in the modern era. */
export const METHODS_REQUIRING_NAME = new Set([
  "tools/call",
  "resources/read",
  "prompts/get",
]);

// ---------------------------------------------------------------------------
// Header value encoding
// ---------------------------------------------------------------------------

const SENTINEL_PREFIX = "=?base64?";
const SENTINEL_SUFFIX = "?=";

/**
 * Decode a mirrored header value. Values that are not header-safe ASCII arrive
 * wrapped as `=?base64?<base64 of the UTF-8 bytes>?=`; the markers are
 * lowercase and case-sensitive. Returns null when the wrapper is present but
 * the payload does not decode — a malformed sentinel is a rejectable request,
 * not a value to guess at.
 */
export function decodeHeaderValue(raw: string): string | null {
  if (!raw.startsWith(SENTINEL_PREFIX) || !raw.endsWith(SENTINEL_SUFFIX)) {
    return raw;
  }
  const payload = raw.slice(SENTINEL_PREFIX.length, raw.length - SENTINEL_SUFFIX.length);
  try {
    const bytes = Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Message shapes
// ---------------------------------------------------------------------------

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type ParsedMessage =
  | { kind: "request"; message: JsonRpcRequest }
  | { kind: "notification"; message: JsonRpcNotification }
  | { kind: "invalid"; error: JsonRpcErrorObject; id: JsonRpcId | null };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse one decoded JSON body into a request or a notification.
 *
 * Batching is deliberately NOT supported: JSON-RPC batch support was removed in
 * protocol revision 2025-06-18 and the modern Streamable HTTP binding requires
 * the POST body to be a single request or notification. An array gets an
 * explicit error rather than a partial read, so a client sending one learns why.
 */
export function parseJsonRpcMessage(body: unknown): ParsedMessage {
  if (Array.isArray(body)) {
    return {
      kind: "invalid",
      id: null,
      error: {
        code: JSON_RPC_ERROR.INVALID_REQUEST,
        message:
          "JSON-RPC batching is not supported; send one request or notification per POST",
      },
    };
  }
  if (!isPlainObject(body)) {
    return {
      kind: "invalid",
      id: null,
      error: { code: JSON_RPC_ERROR.INVALID_REQUEST, message: "Body must be a JSON object" },
    };
  }

  const rawId = body.id;
  const hasId = rawId !== undefined && rawId !== null;
  const id: JsonRpcId | null = typeof rawId === "string" || typeof rawId === "number"
    ? rawId
    : null;

  if (body.jsonrpc !== "2.0") {
    return {
      kind: "invalid",
      id,
      error: { code: JSON_RPC_ERROR.INVALID_REQUEST, message: 'Missing or invalid "jsonrpc": expected "2.0"' },
    };
  }
  if (typeof body.method !== "string" || body.method.length === 0) {
    return {
      kind: "invalid",
      id,
      error: { code: JSON_RPC_ERROR.INVALID_REQUEST, message: 'Missing or invalid "method"' },
    };
  }
  if (body.params !== undefined && !isPlainObject(body.params)) {
    return {
      kind: "invalid",
      id,
      error: { code: JSON_RPC_ERROR.INVALID_REQUEST, message: '"params" must be an object when present' },
    };
  }
  if (hasId && id === null) {
    return {
      kind: "invalid",
      id: null,
      error: { code: JSON_RPC_ERROR.INVALID_REQUEST, message: '"id" must be a string or a number' },
    };
  }

  const params = body.params as Record<string, unknown> | undefined;
  if (!hasId) {
    return { kind: "notification", message: { jsonrpc: "2.0", method: body.method, params } };
  }
  return { kind: "request", message: { jsonrpc: "2.0", id: id as JsonRpcId, method: body.method, params } };
}

// ---------------------------------------------------------------------------
// _meta accessors
// ---------------------------------------------------------------------------

export function metaOf(message: JsonRpcMessage): Record<string, unknown> | undefined {
  const meta = message.params?._meta;
  return isPlainObject(meta) ? meta : undefined;
}

/** The protocol version the body claims, or undefined if it carries none. */
export function bodyProtocolVersion(message: JsonRpcMessage): string | undefined {
  const value = metaOf(message)?.[META_PROTOCOL_VERSION];
  return typeof value === "string" ? value : undefined;
}

export function clientInfoOf(
  message: JsonRpcMessage,
): { name?: string; version?: string } | undefined {
  const value = metaOf(message)?.[META_CLIENT_INFO];
  return isPlainObject(value) ? (value as { name?: string; version?: string }) : undefined;
}

// ---------------------------------------------------------------------------
// Era detection
// ---------------------------------------------------------------------------

export type McpEra = "modern" | "legacy";

/**
 * Decide which era a request is speaking, per the spec's dual-era rule: a
 * request carrying modern per-request `_meta` is served statelessly, an
 * `initialize` request selects legacy semantics.
 *
 * Order matters. The body is the source of truth, so a modern `_meta` wins even
 * if a confused client also sent a session header. `initialize` is legacy by
 * definition — the modern era has no such method.
 */
export function detectEra(message: JsonRpcMessage, headerVersion?: string): McpEra {
  const bodyVersion = bodyProtocolVersion(message);
  if (bodyVersion && isModernVersion(bodyVersion)) return "modern";
  if (bodyVersion && isLegacyVersion(bodyVersion)) return "legacy";
  if (message.method === "initialize") return "legacy";
  if (headerVersion && isModernVersion(headerVersion)) return "modern";
  if (headerVersion && isLegacyVersion(headerVersion)) return "legacy";
  // No version anywhere and not an initialize: a pre-2025-06-18 client, which
  // the spec lets us treat as 2025-03-26 rather than reject.
  return "legacy";
}

// ---------------------------------------------------------------------------
// Modern header validation
// ---------------------------------------------------------------------------

export interface HeaderLookup {
  (name: string): string | undefined;
}

/**
 * Validate the mirrored HTTP headers against the request body for a modern-era
 * request. Returns null when everything matches, or the JSON-RPC error to
 * return with HTTP 400.
 *
 * Every failure here is -32020 HeaderMismatch, including a MISSING required
 * header: the spec lists "a required standard header is missing" as a
 * validation failure condition, not as a separate error.
 */
export function validateModernHeaders(
  message: JsonRpcMessage,
  header: HeaderLookup,
): JsonRpcErrorObject | null {
  const headerVersion = header(HEADER_PROTOCOL_VERSION);
  if (!headerVersion) {
    return mismatch(`Missing required ${HEADER_PROTOCOL_VERSION} header`);
  }
  const bodyVersion = bodyProtocolVersion(message);
  if (!bodyVersion) {
    return mismatch(
      `Request body carries no ${META_PROTOCOL_VERSION} in params._meta to match the ${HEADER_PROTOCOL_VERSION} header`,
    );
  }
  if (headerVersion !== bodyVersion) {
    return mismatch(
      `${HEADER_PROTOCOL_VERSION} header value '${headerVersion}' does not match body value '${bodyVersion}'`,
    );
  }

  const headerMethod = header(HEADER_METHOD);
  if (!headerMethod) {
    return mismatch(`Missing required ${HEADER_METHOD} header`);
  }
  if (headerMethod !== message.method) {
    return mismatch(
      `${HEADER_METHOD} header value '${headerMethod}' does not match body value '${message.method}'`,
    );
  }

  if (METHODS_REQUIRING_NAME.has(message.method)) {
    const rawName = header(HEADER_NAME);
    if (!rawName) {
      return mismatch(`Missing required ${HEADER_NAME} header for method '${message.method}'`);
    }
    const decoded = decodeHeaderValue(rawName);
    if (decoded === null) {
      return mismatch(`${HEADER_NAME} header value is not valid base64-sentinel encoded`);
    }
    const bodyName = message.params?.name ?? message.params?.uri;
    if (typeof bodyName !== "string") {
      return mismatch(
        `Method '${message.method}' requires params.name or params.uri to match the ${HEADER_NAME} header`,
      );
    }
    if (decoded !== bodyName) {
      return mismatch(
        `${HEADER_NAME} header value '${decoded}' does not match body value '${bodyName}'`,
      );
    }
  }

  return null;
}

function mismatch(message: string): JsonRpcErrorObject {
  return { code: MCP_ERROR.HEADER_MISMATCH, message: `Header mismatch: ${message}` };
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

export function jsonRpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(
  id: JsonRpcId | null,
  error: JsonRpcErrorObject,
): Record<string, unknown> {
  // An error with no id is legal and is what the spec asks for when the request
  // could not be parsed far enough to have one.
  return id === null
    ? { jsonrpc: "2.0", error }
    : { jsonrpc: "2.0", id, error };
}

/**
 * The -32022 body a client uses to pick a version we actually speak. `supported`
 * must list every version we serve, across both eras, or a legacy client
 * retrying from this list will pick something we reject.
 */
export function unsupportedVersionError(requested: string): JsonRpcErrorObject {
  return {
    code: MCP_ERROR.UNSUPPORTED_PROTOCOL_VERSION,
    message: "Unsupported protocol version",
    data: { supported: MCP_SUPPORTED_VERSIONS, requested },
  };
}

export function methodNotFoundError(method: string): JsonRpcErrorObject {
  return { code: JSON_RPC_ERROR.METHOD_NOT_FOUND, message: `Method not found: ${method}` };
}
