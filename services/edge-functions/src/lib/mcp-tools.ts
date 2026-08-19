// US-9106: the MCP tool registry.
//
// ONE place declares every tool: its schema, the scope it needs, whether it
// mutates anything, and the handler. Nothing else may add a tool, because the
// invariants below are enforced by construction rather than by review:
//
//   • a human-readable `title`
//   • exactly one of readOnlyHint / destructiveHint set true
//   • a name at most 64 characters, prefixed `gradethread_`
//   • a requiredScope
//   • a handler that receives the resolved TENANT as an argument
//
// The first three are published Claude connector-directory review criteria and
// a tool that violates one is rejected at submission. The last is US-268: /mcp
// runs on the service-role client and bypasses RLS, so a handler that could
// reach the Hono context directly could run untenanted. It cannot: the tenant
// arrives as data.
//
// SCOPE CHECKS HAPPEN TWICE, deliberately. tools/list hides what the caller
// cannot use (a model is not tempted by a tool it cannot see) and tools/call
// re-checks before dispatch (a check that exists only in the list filter is not
// a check).

import type { ApiKeyScope } from "./api-key.ts";
import { supabaseAdmin } from "./supabase.ts";
import { billingMonthStartIso, computeQuotaState } from "./api-quota.ts";
import { redactError } from "./log-redact.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * MCP tool annotations. Modelled so a tool cannot claim to be both read-only
 * and destructive: the union forces one or the other.
 */
export type McpToolAnnotations =
  | {
    readOnlyHint: true;
    destructiveHint?: false;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  }
  | {
    readOnlyHint?: false;
    destructiveHint: true;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };

/** The tenant and credential a handler is allowed to act for. */
export interface McpToolContext {
  /** Always `workspaceOwnerId ?? userId`. Every query scopes on this. */
  tenantId: string;
  /** The authenticated caller, which may be a member of the tenant's workspace. */
  userId: string;
  apiKeyId: string;
  scopes: ApiKeyScope[];
}

export interface McpToolResult {
  /** Rendered to the model. Keep it compact; a list must not dump every field. */
  content: Array<{ type: "text"; text: string }>;
  /** Machine-readable mirror of the same answer, when the tool declares one. */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type McpToolHandler = (
  args: Record<string, unknown>,
  ctx: McpToolContext,
) => Promise<McpToolResult>;

export interface McpToolDefinition {
  /** `gradethread_*`, at most 64 characters. */
  name: string;
  /** Human-readable. Required by the connector directory. */
  title: string;
  /** What it does AND when Claude should call it. Reviewed for accuracy. */
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  requiredScope: ApiKeyScope;
  annotations: McpToolAnnotations;
  handler: McpToolHandler;
}

// ---------------------------------------------------------------------------
// A small JSON Schema subset, and its validator
// ---------------------------------------------------------------------------

// Hand-rolled rather than pulled from a library because the schemas here are
// ours and small, and because the alternative shapes all drift: a Zod schema
// plus a hand-written JSON Schema is two definitions of one contract, and the
// wire format has to be JSON Schema regardless. One definition, no dependency.

export interface JsonSchema {
  type: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: Array<string | number>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
  default?: unknown;
}

export type SchemaViolation = { path: string; message: string };

export function validateAgainstSchema(
  schema: JsonSchema,
  value: unknown,
  path = "",
): SchemaViolation | null {
  const label = path || "(root)";

  if (schema.enum && !schema.enum.includes(value as string | number)) {
    return { path: label, message: `must be one of: ${schema.enum.join(", ")}` };
  }

  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { path: label, message: "must be an object" };
      }
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (record[key] === undefined || record[key] === null) {
          return { path: path ? `${path}.${key}` : key, message: "is required" };
        }
      }
      if (schema.additionalProperties === false && schema.properties) {
        const allowed = new Set(Object.keys(schema.properties));
        for (const key of Object.keys(record)) {
          // `_meta` is protocol metadata, never a tool argument, and is always
          // permitted so a conforming client is not rejected for being one.
          if (key !== "_meta" && !allowed.has(key)) {
            return { path: path ? `${path}.${key}` : key, message: "is not a known argument" };
          }
        }
      }
      for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
        const child = record[key];
        if (child === undefined || child === null) continue;
        const violation = validateAgainstSchema(
          childSchema,
          child,
          path ? `${path}.${key}` : key,
        );
        if (violation) return violation;
      }
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) return { path: label, message: "must be an array" };
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const violation = validateAgainstSchema(schema.items, value[i], `${label}[${i}]`);
          if (violation) return violation;
        }
      }
      return null;
    }
    case "string": {
      if (typeof value !== "string") return { path: label, message: "must be a string" };
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return { path: label, message: `must be at least ${schema.minLength} characters` };
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return { path: label, message: `must be at most ${schema.maxLength} characters` };
      }
      return null;
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { path: label, message: "must be a number" };
      }
      if (schema.type === "integer" && !Number.isInteger(value)) {
        return { path: label, message: "must be an integer" };
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        return { path: label, message: `must be >= ${schema.minimum}` };
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return { path: label, message: `must be <= ${schema.maximum}` };
      }
      return null;
    }
    case "boolean": {
      if (typeof value !== "boolean") return { path: label, message: "must be a boolean" };
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Registry invariants
// ---------------------------------------------------------------------------

export const TOOL_NAME_PREFIX = "gradethread_";
export const TOOL_NAME_MAX_LENGTH = 64;

export function toolInvariantViolations(tool: McpToolDefinition): string[] {
  const problems: string[] = [];
  if (!tool.name.startsWith(TOOL_NAME_PREFIX)) {
    problems.push(`name must start with "${TOOL_NAME_PREFIX}"`);
  }
  if (tool.name.length > TOOL_NAME_MAX_LENGTH) {
    problems.push(`name is ${tool.name.length} characters; the directory limit is ${TOOL_NAME_MAX_LENGTH}`);
  }
  if (!/^[a-z0-9_]+$/.test(tool.name)) {
    problems.push("name must be lower-case letters, digits and underscores");
  }
  if (!tool.title.trim()) problems.push("title is required");
  if (!tool.description.trim()) problems.push("description is required");
  if (tool.inputSchema.type !== "object") problems.push("inputSchema must be an object schema");

  const readOnly = tool.annotations.readOnlyHint === true;
  const destructive = tool.annotations.destructiveHint === true;
  if (readOnly === destructive) {
    problems.push("annotations must set exactly one of readOnlyHint / destructiveHint");
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function textResult(payload: Record<string, unknown>, summary: string): McpToolResult {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: payload,
  };
}

/**
 * The registry's proof tool: read-only, needs no new API surface, and answers a
 * question a seller genuinely asks ("how much of my allowance is left"). It
 * mirrors GET /api/v1/usage rather than reimplementing the calculation.
 */
const usageTool: McpToolDefinition = {
  name: "gradethread_usage",
  title: "Check API usage and remaining quota",
  description:
    "Report how many GradeThread API calls this credential has made in the current billing month, " +
    "the monthly quota if one applies, and when it resets. Call this when the seller asks about " +
    "their usage, allowance or limits, or after a request fails with a quota error.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: {
    type: "object",
    properties: {
      used: { type: "integer", description: "Calls made in the current billing month." },
      quota: { type: "integer", description: "Monthly call quota; absent when unlimited." },
      remaining: { type: "integer", description: "Calls left; absent when unlimited." },
      resets_at: { type: "string", description: "ISO timestamp when the month rolls over." },
    },
    required: ["used", "resets_at"],
  },
  requiredScope: "read",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_args, ctx) => {
    try {
      const now = new Date();
      const [{ data: keyRow }, { count }] = await Promise.all([
        supabaseAdmin.from("api_keys").select("monthly_quota").eq("id", ctx.apiKeyId).single(),
        supabaseAdmin
          .from("api_usage_events")
          .select("id", { count: "exact", head: true })
          .eq("api_key_id", ctx.apiKeyId)
          .gte("created_at", billingMonthStartIso(now)),
      ]);
      const quota = (keyRow as { monthly_quota?: number | null } | null)?.monthly_quota ?? null;
      const state = computeQuotaState(quota, count ?? 0, now) as unknown as Record<string, unknown>;
      const used = count ?? 0;
      const summary = quota == null
        ? `${used} API calls this billing month. No monthly quota applies to this credential.`
        : `${used} of ${quota} API calls used this billing month. Resets ${state.resets_at}.`;
      return textResult({ ...state, used }, summary);
    } catch (err) {
      console.error("[mcp] usage tool:", redactError(err));
      return {
        content: [{ type: "text", text: "Could not read usage right now. Try again shortly." }],
        isError: true,
      };
    }
  },
};

/**
 * Every tool. Adding one here is the ONLY way a tool exists; the invariant test
 * enumerates this array, and US-9112's guard requires a matching
 * tenant-isolation case per entry.
 */
export const TOOLS: McpToolDefinition[] = [usageTool];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function findTool(name: string): McpToolDefinition | undefined {
  return TOOLS_BY_NAME.get(name);
}

export function hasScope(scopes: readonly ApiKeyScope[], required: ApiKeyScope): boolean {
  return scopes.includes(required);
}

/** The tools/list payload, filtered to what this credential can actually use. */
export function listToolsFor(scopes: readonly ApiKeyScope[]): Array<Record<string, unknown>> {
  return TOOLS
    .filter((tool) => hasScope(scopes, tool.requiredScope))
    .map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      annotations: tool.annotations,
    }));
}
