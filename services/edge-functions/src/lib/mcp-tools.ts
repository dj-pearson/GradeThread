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
import {
  getItem,
  ITEMS_PAGE_MAX,
  type ItemSummary,
  ItemQueryError,
  listItems,
} from "./api-items.ts";
import {
  getBatch,
  getGrade,
  GRADES_PAGE_MAX,
  type GradeSummary,
  listGrades,
} from "./api-grades.ts";
import {
  LISTINGS_PAGE_MAX,
  type ListingSummary,
  ListingQueryError,
  listListings,
  listSales,
  type SaleSummary,
} from "./api-listings.ts";
import { compsForItem, CompsUnavailableError } from "./api-comps.ts";
import { getPriceGuideCatalog, getPriceGuideEntry } from "./price-guide.ts";
import { featureAllowedForUser } from "./plan-gate.ts";
// US-9129 moved buildValidation and the submit loop out of the route and into
// this lib, which removed the only lib -> route import in the edge service. The
// readiness tool and the grade tools answer with the SAME validation the submit
// path runs -- a second opinion about readiness is a second answer to "can I
// grade this", and the seller would get whichever one they happened to ask.
import { buildValidation } from "./grading-submit.ts";
import {
  SANDBOX_NOTICE,
  sandboxCatalog,
  sandboxEntry,
  sandboxGrade,
  sandboxPublish,
} from "./mcp-sandbox.ts";
// US-9114: the two grading WRITE tools. In their own module because they carry
// a preview/confirm protocol and a money path, and because this file is the
// registry -- a reader looking for "what tools exist" should not have to scroll
// past one of them.
import { gradeBatchTool, gradeItemTool } from "./mcp-grade-tools.ts";
// US-9115: the draft write tools. Same reason as above - a preview protocol
// and a marketplace-shaped payload do not belong in the registry file.
import { createDraftTool, updateDraftTool } from "./mcp-draft-tools.ts";
// US-9116: the publish tool. The one that puts a garment in front of buyers.
import { publishListingTool } from "./mcp-publish-tool.ts";
import {
  extensionQueueTool,
  queueExtensionWorkTool,
} from "./mcp-extension-queue-tools.ts";
// US-9117: repricing. Five tools over the existing engine, plus the guard that
// a valid confirmation does NOT buy past.
import {
  applySuggestionTool,
  dismissSuggestionTool,
  priceSuggestionsTool,
  repriceApplyTool,
  repricePreviewTool,
} from "./mcp-reprice-tools.ts";
// US-9118: end, bulk end and relist. Bulk end loops the SINGLE end rather than
// adding a third delist loop to a codebase that already has two.
import {
  endListingsBulkTool,
  endListingTool,
  relistTool,
} from "./mcp-lifecycle-tools.ts";

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
  /**
   * US-9117: facts the audit row needs that the ARGUMENTS do not carry.
   *
   * A reprice is asked for as "listing X, 4200 cents" and the interesting half
   * of the row is what X cost before, which only the handler ever sees. The
   * dispatcher merges this into the audited arguments and strips it from the
   * JSON-RPC result, so it never reaches the model.
   */
  auditDetail?: Record<string, unknown>;
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
  /**
   * US-9124: a sandbox tool is EXEMPT FROM THE PLAN GATE. It reads nothing from
   * the seller's account and changes nothing anywhere, so being usable before
   * you pay is the entire point of it. Nothing else may set this.
   */
  sandbox?: true;
  /**
   * US-9131: ask a HUMAN before running this, on clients that support MRTR.
   *
   * Returns the question, or null when these particular arguments do not need
   * one — a preview asks nothing, so only the acting call prompts. The
   * dispatcher turns a non-null answer into an InputRequiredResult; a client on
   * an older revision never sees it and falls back to the two-call flow.
   *
   * This does NOT replace the confirm token. Elicitation asks a person; the
   * token proves the payload did not change between the question and the
   * action. A tool that wants a human should have both.
   */
  humanConfirmation?: (args: Record<string, unknown>) => string | null;

  /**
   * US-2752: refuse BEFORE asking a person, when the request is not theirs.
   *
   * The dispatcher's confirmation block states its own rule — "there is no
   * point asking a person to approve something the plan, the scope or the
   * budget was going to refuse anyway" — and then asks anyway on a
   * cross-tenant call, because ownership is checked inside the handler and the
   * handler runs after the prompt. The tenant-isolation suite caught it:
   * gradethread_reprice_apply answered a request for ANOTHER tenant's listing
   * with "Change the price on 1 live listing(s) now?".
   *
   * Nothing leaked — the question is built from the caller's own arguments and
   * the write still fails at token redemption — but a human should never be
   * shown an approval for someone else's data, and a prompt that always ends
   * in refusal trains people to click through.
   *
   * Return a refusal message, or null to proceed. Runs after every dispatcher
   * gate and before humanConfirmation. Keep it CHEAP: it is on the hot path of
   * every acting call, and it must not consume a single-use token.
   */
  preConfirmCheck?: (
    args: Record<string, unknown>,
    ctx: McpToolContext,
  ) => Promise<string | null>;
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

// ── Inventory reads (US-9107) ──────────────────────────────────────

/** Money reaches the model as a formatted string ONLY here, in prose. */
function money(cents: number | null): string {
  return cents == null ? "no price" : `$${(cents / 100).toFixed(2)}`;
}

function summaryLine(item: ItemSummary): string {
  const parts = [
    item.item_number ? `#${item.item_number}` : item.id.slice(0, 8),
    item.title || "(untitled)",
    item.brand ?? "",
    item.size ? `size ${item.size}` : "",
    item.status,
    money(item.list_price_cents),
    item.grade != null ? `grade ${item.grade}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

const listItemsTool: McpToolDefinition = {
  name: "gradethread_list_items",
  title: "List inventory items",
  description:
    "List the seller's inventory with optional filters on status, brand, category, title text, " +
    "whether it is listed, and a created-date range. Returns a compact row per item plus a " +
    "cursor for the next page. Call this when the seller asks what they have, what is unlisted, " +
    "what is sitting in a status, or to find an item before acting on it. For full details on a " +
    "single item, call gradethread_get_item with the id this returns.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description:
          "Pipeline status, e.g. sourced, cataloged, measured, photographed, comped, drafted, listed, sold, archived.",
      },
      brand: { type: "string", description: "Brand name; matched case-insensitively." },
      category: { type: "string", description: "Garment category, matched case-insensitively." },
      search: { type: "string", description: "Text to find in the item title." },
      listed: { type: "boolean", description: "true for items with a live listing, false for those without." },
      created_after: { type: "string", description: "ISO date; only items created on or after it." },
      created_before: { type: "string", description: "ISO date; only items created on or before it." },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: ITEMS_PAGE_MAX,
        description: "Rows per page (default 25).",
      },
      cursor: { type: "string", description: "next_cursor from a previous call, to get the following page." },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      items: { type: "array", items: { type: "object" } },
      total: { type: "integer", description: "Total matching items, not just this page." },
      next_cursor: { type: "string", description: "Absent when this is the last page." },
    },
    required: ["items", "total"],
  },
  requiredScope: "read",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    try {
      const page = await listItems(ctx.tenantId, {
        status: args.status as string | undefined,
        brand: args.brand as string | undefined,
        category: args.category as string | undefined,
        search: args.search as string | undefined,
        listed: args.listed as boolean | undefined,
        createdAfter: args.created_after as string | undefined,
        createdBefore: args.created_before as string | undefined,
        limit: args.limit as number | undefined,
        cursor: args.cursor as string | undefined,
      });

      // The text is what the model reads, so it states the SHAPE of the answer
      // as well as the rows: "12 of 340" stops a model concluding the seller
      // owns twelve items.
      const header = page.total === page.items.length
        ? `${page.items.length} item(s).`
        : `${page.items.length} of ${page.total} matching item(s)${
          page.next_cursor ? "; more available, pass the cursor to continue." : "."
        }`;
      const body = page.items.length === 0
        ? "No items matched those filters."
        : page.items.map(summaryLine).join("\n");

      return {
        content: [{ type: "text", text: `${header}\n${body}` }],
        structuredContent: {
          items: page.items as unknown as Record<string, unknown>[],
          total: page.total,
          ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
        },
      };
    } catch (err) {
      if (err instanceof ItemQueryError) {
        return {
          content: [{ type: "text", text: err.message }],
          isError: true,
        };
      }
      console.error("[mcp] list items:", redactError(err));
      return {
        content: [{ type: "text", text: "Could not read inventory right now. Try again shortly." }],
        isError: true,
      };
    }
  },
};

const getItemTool: McpToolDefinition = {
  name: "gradethread_get_item",
  title: "Get one inventory item",
  description:
    "Fetch the full record for one inventory item: description, measurements, purchase and target " +
    "prices, grade and certificate, its current listing and sale if any, and links to its photos. " +
    "Call this when the seller asks about a specific item, or before drafting, pricing or listing " +
    "it. Use gradethread_list_items first when you need to find the item id.",
  inputSchema: {
    type: "object",
    properties: {
      item_id: { type: "string", description: "The item's id, as returned by gradethread_list_items." },
    },
    required: ["item_id"],
    additionalProperties: false,
  },
  requiredScope: "read",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    const itemId = String(args.item_id);
    try {
      const item = await getItem(ctx.tenantId, itemId);
      if (!item) {
        // Not-found and not-yours are the SAME answer on purpose; distinguishing
        // them would let a caller enumerate other tenants' item ids.
        return {
          content: [{ type: "text", text: `No item ${itemId} in this seller's inventory.` }],
          isError: true,
        };
      }

      const lines = [
        summaryLine(item),
        item.description ? `Description: ${item.description}` : "",
        item.measurements ? `Measurements: ${JSON.stringify(item.measurements)}` : "",
        item.purchase_price_cents != null ? `Paid ${money(item.purchase_price_cents)}` : "",
        item.target_price_cents != null ? `Target ${money(item.target_price_cents)}` : "",
        item.grade != null && item.certificate_url ? `Certificate: ${item.certificate_url}` : "",
        item.listing
          ? `Listing: ${item.listing.platform ?? "unknown"} ${item.listing.status ?? ""} at ${
            money(item.listing.price_cents)
          }${item.listing.watchers ? `, ${item.listing.watchers} watcher(s)` : ""}`
          : "Not listed.",
        item.sale ? `Sold ${money(item.sale.price_cents)} (${item.sale.status})` : "",
        `${item.photos.length} photo(s)${item.has_required_photos ? "" : "; required set incomplete"}`,
      ].filter(Boolean);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: item as unknown as Record<string, unknown>,
      };
    } catch (err) {
      console.error("[mcp] get item:", redactError(err));
      return {
        content: [{ type: "text", text: "Could not read that item right now. Try again shortly." }],
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
// ── Grade reads (US-9108) ──────────────────────────────────────────

/**
 * The sentence that stops a pending grade being quoted as final.
 *
 * A grade under human review is not wrong, it is UNCONFIRMED - and the failure
 * this prevents is a seller's listing carrying a number that changes after a
 * reviewer looks at it. Stated in the payload, not only in the tool
 * description, because the description is read once and the payload every call.
 */
const PENDING_REVIEW_WARNING =
  "PENDING HUMAN REVIEW - this grade is provisional and may change. Do not publish it or quote it as final.";

function gradeLine(g: GradeSummary): string {
  const grade = g.grade
    ? `${g.grade.overall_score} (${g.grade.grade_tier})${g.grade.pending_review ? " [pending review]" : ""}`
    : g.status;
  return [
    g.id.slice(0, 8),
    g.title ?? g.garment_category ?? "(untitled)",
    g.brand ?? "",
    grade,
  ].filter(Boolean).join(" · ");
}

const getGradeTool: McpToolDefinition = {
  name: "gradethread_get_grade",
  title: "Get a grade report",
  description:
    "Fetch one grading submission and its report: the overall 1.0-10.0 grade, the five factor " +
    "scores (fabric, structural, cosmetic, functional, odor), the tier, confidence, the condition " +
    "report text and the public certificate id when one exists. Call this when the seller asks how " +
    "an item graded, or before writing listing copy that mentions condition, so the copy matches " +
    "what was certified. A report marked pending_review is provisional and must not be quoted as final.",
  inputSchema: {
    type: "object",
    properties: {
      submission_id: { type: "string", description: "The grading submission id." },
    },
    required: ["submission_id"],
    additionalProperties: false,
  },
  requiredScope: "read",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    const id = String(args.submission_id);
    try {
      const grade = await getGrade(ctx.tenantId, id);
      if (!grade) {
        return {
          content: [{ type: "text", text: `No grading submission ${id} for this seller.` }],
          isError: true,
        };
      }

      const report = grade.grade_report;
      if (!report) {
        return {
          content: [{
            type: "text",
            text: `Submission ${id} is ${grade.status}; no grade report yet.`,
          }],
          structuredContent: grade as unknown as Record<string, unknown>,
        };
      }

      const lines = [
        report.pending_review ? PENDING_REVIEW_WARNING : "",
        `Grade ${report.overall_score} (${report.grade_tier})${
          report.confidence_score != null ? `, confidence ${report.confidence_score}` : ""
        }`,
        `Fabric ${report.fabric_condition_score ?? "n/a"} · Structural ${
          report.structural_integrity_score ?? "n/a"
        } · Cosmetic ${report.cosmetic_appearance_score ?? "n/a"} · Functional ${
          report.functional_elements_score ?? "n/a"
        } · Odor ${report.odor_cleanliness_score ?? "n/a"}`,
        report.ai_summary ? `Summary: ${report.ai_summary}` : "",
        report.certificate_id ? `Certificate: ${report.certificate_id}` : "",
      ].filter(Boolean);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: grade as unknown as Record<string, unknown>,
      };
    } catch (err) {
      console.error("[mcp] get grade:", redactError(err));
      return {
        content: [{ type: "text", text: "Could not read that grade right now. Try again shortly." }],
        isError: true,
      };
    }
  },
};

const listGradesTool: McpToolDefinition = {
  name: "gradethread_list_grades",
  title: "List grading submissions",
  description:
    "List the seller's grading submissions, newest first, optionally filtered by status " +
    "(pending, processing, completed, failed, disputed). Call this when the seller asks what has " +
    "been graded, what is still processing, or to find a submission id before calling " +
    "gradethread_get_grade. Grades marked pending review are provisional.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["pending", "processing", "completed", "failed", "disputed"],
        description: "Only submissions in this status.",
      },
      page: { type: "integer", minimum: 1, description: "1-based page number." },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: GRADES_PAGE_MAX,
        description: "Rows per page (default 20).",
      },
    },
    additionalProperties: false,
  },
  requiredScope: "read",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    try {
      const page = await listGrades(ctx.tenantId, {
        status: args.status as string | undefined,
        page: args.page as number | undefined,
        limit: args.limit as number | undefined,
      });

      const pendingCount = page.items.filter((g) => g.grade?.pending_review).length;
      const header = `${page.items.length} of ${page.total} submission(s), page ${page.page} of ${
        Math.max(page.total_pages, 1)
      }.${pendingCount > 0 ? ` ${pendingCount} pending human review.` : ""}`;
      const body = page.items.length === 0
        ? "No submissions matched."
        : page.items.map(gradeLine).join("\n");

      return {
        content: [{ type: "text", text: `${header}\n${body}` }],
        structuredContent: {
          items: page.items as unknown as Record<string, unknown>[],
          page: page.page,
          total: page.total,
          total_pages: page.total_pages,
        },
      };
    } catch (err) {
      console.error("[mcp] list grades:", redactError(err));
      return {
        content: [{ type: "text", text: "Could not read grades right now. Try again shortly." }],
        isError: true,
      };
    }
  },
};

const getBatchTool: McpToolDefinition = {
  name: "gradethread_get_batch",
  title: "Check a grading batch",
  description:
    "Report the status of a bulk grading batch: how many garments are done, how many succeeded or " +
    "failed, and the submission id or error for each. Call this when the seller asks whether a " +
    "batch has finished, rather than polling the dashboard. Grading is asynchronous, so a batch " +
    "that is still running is normal, not a failure.",
  inputSchema: {
    type: "object",
    properties: {
      batch_id: { type: "string", description: "The grading batch id." },
    },
    required: ["batch_id"],
    additionalProperties: false,
  },
  requiredScope: "read",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    const id = String(args.batch_id);
    try {
      const batch = await getBatch(ctx.tenantId, id);
      if (!batch) {
        return {
          content: [{ type: "text", text: `No grading batch ${id} for this seller.` }],
          isError: true,
        };
      }
      const done = batch.succeeded_count + batch.failed_count;
      const summary = `Batch ${batch.status}: ${done} of ${batch.item_count} processed, ` +
        `${batch.succeeded_count} succeeded, ${batch.failed_count} failed.` +
        (batch.error ? ` Batch error: ${batch.error}` : "");
      const failures = batch.results
        .filter((r) => r.error)
        .map((r) => `  ${r.id.slice(0, 8)}: ${r.error}`)
        .join("\n");
      return {
        content: [{ type: "text", text: failures ? `${summary}\n${failures}` : summary }],
        structuredContent: batch as unknown as Record<string, unknown>,
      };
    } catch (err) {
      console.error("[mcp] get batch:", redactError(err));
      return {
        content: [{ type: "text", text: "Could not read that batch right now. Try again shortly." }],
        isError: true,
      };
    }
  },
};

// ── Listings and sales (US-9109) ───────────────────────────────────

function listingLine(l: ListingSummary): string {
  return [
    l.title || `(untitled)`,
    l.brand ?? ``,
    l.marketplace ?? ``,
    money(l.price_cents),
    l.days_live != null ? `live ${l.days_live}d` : ``,
    l.watchers ? `${l.watchers} watching` : ``,
  ].filter(Boolean).join(` · `);
}

function saleLine(s: SaleSummary): string {
  return [
    s.title || `(untitled)`,
    s.marketplace ?? ``,
    `sold ${money(s.sale_price_cents)}`,
    s.net_profit_cents != null ? `net ${money(s.net_profit_cents)}` : ``,
    s.sold_at ? s.sold_at.slice(0, 10) : ``,
  ].filter(Boolean).join(` · `);
}

const listListingsTool: McpToolDefinition = {
  name: "gradethread_list_listings",
  title: "List marketplace listings",
  description:
    "List the seller's listings, one row per item showing its most recent listing, with filters " +
    "for marketplace, listing status, price range, how many days it has been live and watcher " +
    "count. Call this when the seller asks what is live, what is stale, what has watchers, or to " +
    "find a listing before repricing or ending it.",
  inputSchema: {
    type: "object",
    properties: {
      marketplace: { type: "string", description: "e.g. ebay, poshmark, depop, etsy, mercari." },
      status: { type: "string", description: "Listing status, e.g. active, draft, ended, sold." },
      min_price_cents: { type: "integer", minimum: 0, description: "Lowest listed price, in cents." },
      max_price_cents: { type: "integer", minimum: 0, description: "Highest listed price, in cents." },
      min_days_live: { type: "integer", minimum: 0, description: "Only listings live at least this many days." },
      min_watchers: { type: "integer", minimum: 0, description: "Only listings with at least this many watchers." },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: LISTINGS_PAGE_MAX,
        description: "Rows per page (default 25).",
      },
      cursor: { type: "string", description: "next_cursor from a previous call." },
    },
    additionalProperties: false,
  },
  requiredScope: "read",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    try {
      const page = await listListings(ctx.tenantId, {
        marketplace: args.marketplace as string | undefined,
        status: args.status as string | undefined,
        minPriceCents: args.min_price_cents as number | undefined,
        maxPriceCents: args.max_price_cents as number | undefined,
        minDaysLive: args.min_days_live as number | undefined,
        minWatchers: args.min_watchers as number | undefined,
        limit: args.limit as number | undefined,
        cursor: args.cursor as string | undefined,
      });
      const header = `${page.items.length} of ${page.total} listing(s)${page.next_cursor ? "; more available, pass the cursor to continue." : "."}`;
      const body = page.items.length === 0
        ? "No listings matched those filters."
        : page.items.map(listingLine).join(`\n`);
      return {
        content: [{ type: "text", text: `${header}\n${body}` }],
        structuredContent: {
          listings: page.items as unknown as Record<string, unknown>[],
          total: page.total,
          ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
        },
      };
    } catch (err) {
      if (err instanceof ListingQueryError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      console.error("[mcp] list listings:", redactError(err));
      return {
        content: [{ type: "text", text: "Could not read listings right now. Try again shortly." }],
        isError: true,
      };
    }
  },
};

const listSalesTool: McpToolDefinition = {
  name: "gradethread_list_sales",
  title: "List completed sales",
  description:
    "List the seller's completed sales over a date range, with sale price, fees, shipping cost " +
    "and net profit per item, plus a roll-up of the rows returned. Call this when the seller asks " +
    "what sold, how a period went, or which marketplace is performing. Cancelled and refunded " +
    "sales are excluded by default because they are not revenue.",
  inputSchema: {
    type: "object",
    properties: {
      sold_after: { type: "string", description: "ISO date; only sales on or after it." },
      sold_before: { type: "string", description: "ISO date; only sales on or before it." },
      marketplace: { type: "string", description: "Restrict to one marketplace." },
      status: {
        type: "string",
        enum: ["completed", "cancelled", "refunded", "pending"],
        description: "Defaults to completed. The others are NOT revenue.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: LISTINGS_PAGE_MAX,
        description: "Rows per page (default 25).",
      },
      cursor: { type: "string", description: "next_cursor from a previous call." },
    },
    additionalProperties: false,
  },
  requiredScope: "read",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    try {
      const page = await listSales(ctx.tenantId, {
        soldAfter: args.sold_after as string | undefined,
        soldBefore: args.sold_before as string | undefined,
        marketplace: args.marketplace as string | undefined,
        status: args.status as string | undefined,
        limit: args.limit as number | undefined,
        cursor: args.cursor as string | undefined,
      });
      // page_only is stated in the TEXT, not just the payload: a model that
      // reports a page roll-up as the period total understates the seller's
      // revenue, and the text is what it reads.
      const scope = page.totals.page_only
        ? `these ${page.totals.count} row(s) only, of ${page.total} total`
        : `all ${page.total} sale(s)`;
      const header = `Gross ${money(page.totals.gross_cents)}, net ${money(page.totals.net_profit_cents)} across ${scope}.`;
      const body = page.items.length === 0
        ? "No sales matched those filters."
        : page.items.map(saleLine).join(`\n`);
      return {
        content: [{ type: "text", text: `${header}\n${body}` }],
        structuredContent: {
          sales: page.items as unknown as Record<string, unknown>[],
          total: page.total,
          totals: page.totals as unknown as Record<string, unknown>,
          ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
        },
      };
    } catch (err) {
      if (err instanceof ListingQueryError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      console.error("[mcp] list sales:", redactError(err));
      return {
        content: [{ type: "text", text: "Could not read sales right now. Try again shortly." }],
        isError: true,
      };
    }
  },
};

// ── Price guide and comps (US-9110) ────────────────────────────────

const priceGuideTool: McpToolDefinition = {
  name: "gradethread_price_guide",
  title: "Look up the GradeThread price guide",
  description:
    "Read GradeThread's published price guide: the catalog of covered items, or one entry with " +
    "its value range and sell-through rate by grade band. Call this when the seller asks what a " +
    "type of garment is generally worth, or how much a higher grade is worth on it. Omit the slug " +
    "to list what the guide covers.",
  inputSchema: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        description: "A catalog entry slug. Omit to list the whole catalog.",
      },
    },
    additionalProperties: false,
  },
  requiredScope: "read",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (args, _ctx) => {
    try {
      const slug = args.slug as string | undefined;
      if (!slug) {
        const catalog = await getPriceGuideCatalog();
        const body = catalog.length === 0
          ? "The price guide has no published entries yet."
          : catalog.map((e) =>
            `${e.slug} - ${e.brand} ${e.label}, median ${money(e.headlineMedianCents)} ` +
            `(${e.totalSampleSize} sale(s))`
          ).join(`\n`);
        return {
          content: [{ type: "text", text: `${catalog.length} guide entry(ies).\n${body}` }],
          structuredContent: { entries: catalog as unknown as Record<string, unknown>[] },
        };
      }
      const entry = await getPriceGuideEntry(slug);
      if (!entry) {
        return {
          content: [{ type: "text", text: `No published price guide entry for ${slug}.` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(entry) }],
        structuredContent: entry as unknown as Record<string, unknown>,
      };
    } catch (err) {
      console.error("[mcp] price guide:", redactError(err));
      return {
        content: [{ type: "text", text: "Could not read the price guide right now." }],
        isError: true,
      };
    }
  },
};

const compsTool: McpToolDefinition = {
  name: "gradethread_comps",
  title: "What has this actually sold for",
  description:
    "Report what comparable garments have ACTUALLY sold for, as a p25/median/p75 band with the " +
    "sample size it is based on. Call this before pricing or repricing an item, or when the seller " +
    "asks what something is worth. The answer is an aggregate only - individual listings are never " +
    "returned. A small sample is reported as such and must not be quoted as a price.",
  inputSchema: {
    type: "object",
    properties: {
      item_id: {
        type: "string",
        description: "The inventory item to price. Its category, brand and size drive the lookup.",
      },
    },
    required: ["item_id"],
    additionalProperties: false,
  },
  requiredScope: "read",
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    // Comp pulls are a PAID capability. A chat loop must not be a way around a
    // plan limit the dashboard enforces, so the same gate applies here.
    if (!(await featureAllowedForUser(ctx.tenantId, "compPulls"))) {
      return {
        content: [{
          type: "text",
          text: "Sold-comp lookups are not included in this plan. See https://gradethread.com/pricing.",
        }],
        isError: true,
      };
    }

    const itemId = String(args.item_id);
    try {
      const result = await compsForItem(ctx.tenantId, itemId);
      if (!result) {
        return {
          content: [{ type: "text", text: `No item ${itemId} in this seller's inventory.` }],
          isError: true,
        };
      }
      if (!result.comps) {
        // Null is a REAL answer: sold-comps returns nothing below its minimum
        // sample precisely so a price cannot be quoted off two data points.
        return {
          content: [{
            type: "text",
            text: `Not enough realized sales to price ${result.basis.title} honestly. No band is available; do not estimate one.`,
          }],
          structuredContent: { comps: null, basis: result.basis as unknown as Record<string, unknown> },
        };
      }
      const c = result.comps;
      const text = [
        `Median ${money(c.median_cents)} (${money(c.low_cents)} to ${money(c.high_cents)}) for ${result.basis.title}.`,
        c.caveat,
      ].join(` `);
      return {
        content: [{ type: "text", text }],
        structuredContent: c as unknown as Record<string, unknown>,
      };
    } catch (err) {
      if (err instanceof CompsUnavailableError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      console.error("[mcp] comps:", redactError(err));
      return {
        content: [{ type: "text", text: "Could not pull comps right now. Try again shortly." }],
        isError: true,
      };
    }
  },
};

// ── Grading readiness (US-9114) ────────────────────────────────────

const gradingReadinessTool: McpToolDefinition = {
  name: "gradethread_grading_readiness",
  title: "Check whether items can be graded",
  description:
    "Check whether one or more inventory items are ready to submit for grading: which required " +
    "photos are missing, which fields are blank, what each grade would cost, and whether the " +
    "seller has enough included grades or credits to cover the batch. Call this before telling a " +
    "seller to submit, and to answer \"why can I not grade this yet\". It changes nothing.",
  inputSchema: {
    type: "object",
    properties: {
      item_ids: {
        type: "array",
        items: { type: "string" },
        description: "Inventory item ids to check.",
      },
      tier: {
        type: "string",
        enum: ["standard", "premium", "express"],
        description: "Grade tier to price against. Defaults to standard.",
      },
    },
    required: ["item_ids"],
    additionalProperties: false,
  },
  requiredScope: "read",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    const ids = (args.item_ids as unknown[] | undefined) ?? [];
    if (ids.length === 0) {
      return {
        content: [{ type: "text", text: "No item ids given." }],
        isError: true,
      };
    }
    const tier = (args.tier as string | undefined) ?? "standard";

    try {
      // The SAME validation the submit path runs. A second opinion about
      // readiness is a second answer to 'can I grade this', and the seller
      // would get whichever one they happened to ask.
      const validation = await buildValidation(
        ctx.tenantId,
        ids.map((id) => ({
          inventory_item_id: String(id),
          tier: tier as Parameters<typeof buildValidation>[1][number]["tier"],
        })),
      );

      if (!validation.ok) {
        return { content: [{ type: "text", text: validation.error }], isError: true };
      }

      const r = validation.result;
      const lines = r.items.map((item) => {
        const state = item.ready ? "READY" : "BLOCKED";
        const detail = item.ready
          ? (item.warnings.length > 0 ? item.warnings.join("; ") : "")
          : item.blockers.join("; ");
        return [
          state,
          item.title ?? item.inventory_item_id.slice(0, 8),
          money(Math.round(item.cost * 100)),
          detail,
        ].filter(Boolean).join(" · ");
      });

      const header = r.can_submit
        ? `All ${r.items.length} item(s) are ready. Total ${money(Math.round(r.total_cost * 100))}, ` +
          `${r.credits_required} credit(s) needed; ${r.user.included_remaining} included grade(s) and ` +
          `${r.user.credit_balance} credit(s) available.`
        : r.limit_exceeded
        ? `Not enough grading allowance: this batch needs ${r.credits_required} credit(s) and ` +
          `${r.user.included_remaining} included grade(s) plus ${r.user.credit_balance} credit(s) are available.`
        : `${r.items.filter((i) => !i.ready).length} of ${r.items.length} item(s) are not ready to grade.`;

      return {
        content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }],
        structuredContent: r as unknown as Record<string, unknown>,
      };
    } catch (err) {
      console.error("[mcp] grading readiness:", redactError(err));
      return {
        content: [{ type: "text", text: "Could not check grading readiness right now." }],
        isError: true,
      };
    }
  },
};

// ── Sandbox (US-9124) ──────────────────────────────────────────────
//
// Available on EVERY plan, including free, regardless of the US-9101 gating
// decision. That is the whole point: a seller who cannot see what the
// connector does has no reason to pay for it, and an empty tool list is not an
// answer to 'should I upgrade'. These carry sandbox: true, which exempts them
// from the plan gate in the dispatcher and nothing else.

const sandboxGradeTool: McpToolDefinition = {
  name: "gradethread_sandbox_grade",
  title: "Try grading on sample data",
  description:
    "Return a realistic SAMPLE condition grade for a garment description, so a seller can see " +
    "what GradeThread produces before connecting an account or spending a grade. Call this when " +
    "someone asks what a grade looks like, or is evaluating the connector. It reads nothing from " +
    "any account and grades nothing real - the result is sample data and must be described as such.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "A garment description, e.g. \"Carhartt Detroit jacket\"." },
      brand: { type: "string", description: "Optional brand." },
    },
    required: ["title"],
    additionalProperties: false,
  },
  requiredScope: "read",
  sandbox: true,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: (args, _ctx) => {
    const grade = sandboxGrade(String(args.title ?? ""), args.brand as string | undefined);
    const text = [
      SANDBOX_NOTICE,
      `${grade.title}: ${grade.overall_score} (${grade.grade_tier}), confidence ${grade.confidence_score}.`,
      `Fabric ${grade.fabric_condition_score} · Structural ${grade.structural_integrity_score} · ` +
        `Cosmetic ${grade.cosmetic_appearance_score} · Functional ${grade.functional_elements_score} · ` +
        `Odor ${grade.odor_cleanliness_score}`,
      grade.ai_summary,
    ].join("\n");
    return Promise.resolve({
      content: [{ type: "text", text }],
      structuredContent: grade as unknown as Record<string, unknown>,
    });
  },
};

const sandboxPublishTool: McpToolDefinition = {
  name: "gradethread_sandbox_publish",
  title: "Preview a publish on sample data",
  description:
    "Show what publishing a listing WOULD produce, using sample data. Nothing is sent to any " +
    "marketplace and no listing is created. Call this when someone wants to see the listing flow " +
    "before connecting a marketplace account. The result is sample data and must never be " +
    "described as a live listing.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "The garment to pretend to list." },
      marketplace: { type: "string", description: "Marketplace name. Defaults to ebay." },
      price_cents: { type: "integer", minimum: 0, description: "Asking price in cents." },
    },
    required: ["title"],
    additionalProperties: false,
  },
  requiredScope: "read",
  sandbox: true,
  // readOnlyHint, and it is not a lie: this writes nothing anywhere. Marking it
  // destructive to look cautious would make the annotation mean less on the
  // tools that really are.
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: (args, _ctx) => {
    const listing = sandboxPublish(
      String(args.title ?? ""),
      (args.marketplace as string | undefined) ?? "ebay",
      (args.price_cents as number | undefined) ?? 4999,
    );
    const text = [
      SANDBOX_NOTICE,
      `Would list "${listing.title}" on ${listing.marketplace} at ${money(listing.price_cents)}.`,
      "No listing was created and no marketplace was contacted.",
    ].join("\n");
    return Promise.resolve({
      content: [{ type: "text", text }],
      structuredContent: listing as unknown as Record<string, unknown>,
    });
  },
};

const sandboxPriceGuideTool: McpToolDefinition = {
  name: "gradethread_sandbox_price_guide",
  title: "Try the price guide on sample data",
  description:
    "Return a SAMPLE price guide entry or catalog, so a seller can see the shape of the value " +
    "and sell-through data before subscribing. Call this when evaluating the connector. The " +
    "numbers are illustrative sample data, not a real valuation.",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "A sample entry slug. Omit to list the sample catalog." },
    },
    additionalProperties: false,
  },
  requiredScope: "read",
  sandbox: true,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: (args, _ctx) => {
    const slug = args.slug as string | undefined;
    if (!slug) {
      const catalog = sandboxCatalog();
      const body = catalog
        .map((e) => `${e.slug} - ${e.brand} ${e.label}, median ${money(e.headlineMedianCents)}`)
        .join("\n");
      return Promise.resolve({
        content: [{ type: "text", text: `${SANDBOX_NOTICE}\n${body}` }],
        structuredContent: { sandbox: true, entries: catalog as unknown as Record<string, unknown>[] },
      });
    }
    const entry = sandboxEntry(slug);
    return Promise.resolve({
      content: [{ type: "text", text: `${SANDBOX_NOTICE}\n${JSON.stringify(entry)}` }],
      structuredContent: { sandbox: true, entry: entry as unknown as Record<string, unknown> },
    });
  },
};

export const TOOLS: McpToolDefinition[] = [
  usageTool,
  listItemsTool,
  getItemTool,
  getGradeTool,
  listGradesTool,
  getBatchTool,
  listListingsTool,
  listSalesTool,
  priceGuideTool,
  compsTool,
  gradingReadinessTool,
  gradeItemTool,
  gradeBatchTool,
  createDraftTool,
  updateDraftTool,
  publishListingTool,
  repricePreviewTool,
  repriceApplyTool,
  priceSuggestionsTool,
  applySuggestionTool,
  dismissSuggestionTool,
  endListingTool,
  endListingsBulkTool,
  relistTool,
  // US-3065: the connector queues work the seller's own browser runs. The
  // write tool lands in WRITE_TOOL_NAMES by DERIVATION (destructiveHint, not
  // sandbox), which is what the registry does rather than a hand-kept list.
  extensionQueueTool,
  queueExtensionWorkTool,
  sandboxGradeTool,
  sandboxPublishTool,
  sandboxPriceGuideTool,
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/**
 * US-9101: the tools that count against a seller's monthly connector allowance.
 *
 * DERIVED from the registry rather than hand-listed, so a write tool added
 * later is counted without its author remembering — the hand-listed version of
 * this would be a list that is right on the day it is written.
 *
 * Sandbox tools are excluded: they change nothing and are usable before you pay,
 * so charging an allowance for them would defeat what they are for.
 */
export const WRITE_TOOL_NAMES: string[] = TOOLS
  .filter((t) => t.annotations.destructiveHint === true && !t.sandbox)
  .map((t) => t.name);

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
