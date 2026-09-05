// US-3065: the connector queues work the seller's own browser will run.
//
// "List these twelve items on Poshmark and Mercari" becomes rows in
// extension_work_queue. The marketplace actions still happen in the seller's
// logged-in tab, on their machine — that is the decision in
// vault/60-decisions/adr-no-server-side-marketplace-automation.md and nothing
// here bends it. The connector queues; the extension acts.
//
// ── THE SENTENCE THAT MATTERS ────────────────────────────────────────────────
//
// A model saying "done, it's listed" about a queued job is the failure this
// whole feature is arranged around. The desktop may be shut. So QUEUED_NOTICE
// is emitted VERBATIM in the preview, in the confirmation and in the result,
// and a test pins that this file never writes its own wording for it.
//
// ── WHY BOTH A TOKEN AND A PROMPT ────────────────────────────────────────────
//
// Same reasoning as gradethread_publish_listing. Elicitation asks a PERSON; the
// confirm token proves the PAYLOAD did not change between the question and the
// action. Elicitation alone would let a model ask "queue 3 items?" and queue 30.
// A client on an older protocol revision sees no prompt and still cannot write
// without a token.

import { issueConfirmToken, redeemConfirmToken } from "./mcp-confirm.ts";
import { redactError } from "./log-redact.ts";
import { supabaseAdmin } from "./supabase.ts";
import type { McpToolDefinition, McpToolResult } from "./mcp-tools.ts";
import {
  enqueueExtensionWork,
  QUEUE_SELECT_COLS,
  sellerQueueGate,
} from "./extension-enqueue.ts";
import {
  EXTENSION_QUEUE_KINDS,
  MAX_QUEUE_DEPTH,
  QUEUED_NOTICE,
} from "./extension-queue.ts";
import { EXTENSION_DELIST_PLATFORMS } from "./cross-listing-sale.ts";

function fail(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Channels the extension can actually drive.
 *
 * Read from EXTENSION_DELIST_PLATFORMS rather than a list written here.
 * cross-listing-sale.ts is the edge's mirror of the SPA's
 * LISTER_EXTENSION_PLATFORMS and a test already asserts that pair, so borrowing
 * it makes this the third reader of one list instead of a third copy of it.
 */
export const QUEUE_TOOL_PLATFORMS = [...EXTENSION_DELIST_PLATFORMS].sort();

/** Items a single call may queue. Deliberately well under MAX_QUEUE_DEPTH. */
export const MAX_QUEUE_TOOL_ITEMS = 12;

export interface QueueToolRequest {
  kind: string;
  platforms: string[];
  itemIds: string[];
}

export type QueueToolParse =
  | { ok: true; request: QueueToolRequest }
  | { ok: false; error: string };

/**
 * Validate the model's arguments before anything is looked up.
 *
 * Pure, and exported so the refusals can be tested without a database. Each one
 * is a thing a model gets wrong in a recognisable way: inventing a channel,
 * asking for "everything", or passing a kind that reads plausibly but is not
 * one of the four the extension knows.
 */
export function parseQueueRequest(args: Record<string, unknown>): QueueToolParse {
  const kind = typeof args.kind === "string" ? args.kind.trim() : "";
  if (!(EXTENSION_QUEUE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `kind must be one of: ${EXTENSION_QUEUE_KINDS.join(", ")}.` };
  }

  const rawPlatforms = Array.isArray(args.platforms) ? args.platforms : [];
  const platforms: string[] = [];
  for (const p of rawPlatforms) {
    const key = typeof p === "string" ? p.trim().toLowerCase() : "";
    if (!key || platforms.includes(key)) continue;
    if (!QUEUE_TOOL_PLATFORMS.includes(key)) {
      return {
        ok: false,
        error:
          `${key} is not a channel the extension drives. It works on: ` +
          `${QUEUE_TOOL_PLATFORMS.join(", ")}. eBay, Shopify and Etsy have write ` +
          `APIs and are listed through those instead.`,
      };
    }
    platforms.push(key);
  }
  if (platforms.length === 0) {
    return { ok: false, error: "Name at least one channel to queue work for." };
  }

  const rawItems = Array.isArray(args.item_ids) ? args.item_ids : [];
  const itemIds: string[] = [];
  for (const id of rawItems) {
    const s = typeof id === "string" ? id.trim() : "";
    if (!s || itemIds.includes(s)) continue;
    itemIds.push(s);
  }
  if (itemIds.length === 0) {
    return { ok: false, error: "Name at least one item to queue." };
  }
  if (itemIds.length > MAX_QUEUE_TOOL_ITEMS) {
    return {
      ok: false,
      error:
        `That is ${itemIds.length} items. Queue at most ${MAX_QUEUE_TOOL_ITEMS} in ` +
        `one call so the seller can see what they agreed to.`,
    };
  }

  return { ok: true, request: { kind, platforms, itemIds } };
}

/** How many rows a request will create. One per item per channel. */
export function plannedRowCount(request: QueueToolRequest): number {
  return request.itemIds.length * request.platforms.length;
}

/**
 * The preview a person reads before saying yes.
 *
 * Names every item and every channel rather than summarising, because "queue 12
 * items" is the shape of approval somebody clicks through. QUEUED_NOTICE is
 * appended verbatim so the person is never told the listing is live.
 */
export function previewText(
  request: QueueToolRequest,
  titles: Map<string, string>,
): string {
  const lines: string[] = [];
  lines.push(
    `Queue ${plannedRowCount(request)} ${request.kind} job(s) for the seller's ` +
      `browser to run:`,
  );
  for (const id of request.itemIds) {
    lines.push(`  - ${titles.get(id) ?? id} → ${request.platforms.join(", ")}`);
  }
  lines.push("");
  lines.push(QUEUED_NOTICE);
  return lines.join("\n");
}

/** Titles for the items in a request, tenant-scoped. Missing ids are absent. */
async function loadTitles(
  tenantId: string,
  itemIds: string[],
): Promise<Map<string, string>> {
  const { data } = await supabaseAdmin
    .from("inventory_items")
    .select("id, title")
    .eq("user_id", tenantId) // US-268
    .in("id", itemIds);
  const out = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ id: string; title: string | null }>) {
    out.set(row.id, row.title ?? row.id);
  }
  return out;
}

async function preview(
  tenantId: string,
  apiKeyId: string,
  request: QueueToolRequest,
): Promise<McpToolResult> {
  // The plan gate first, so a locked account is told why rather than being
  // walked through a preview it can never confirm.
  const gate = await sellerQueueGate(tenantId);
  if (!gate.ok) return fail(String(gate.body?.message ?? gate.error));

  const titles = await loadTitles(tenantId, request.itemIds);
  const missing = request.itemIds.filter((id) => !titles.has(id));
  if (missing.length > 0) {
    // Named, because a model that passed a wrong id needs to know WHICH.
    return fail(
      `Not the seller's items, or they do not exist: ${missing.join(", ")}. ` +
        `Nothing was queued.`,
    );
  }

  const token = await issueConfirmToken({
    subject: apiKeyId,
    toolName: queueExtensionWorkTool.name,
    payload: request,
    targetIds: request.itemIds,
  });

  return {
    content: [{ type: "text", text: previewText(request, titles) }],
    structuredContent: {
      kind: request.kind,
      platforms: request.platforms,
      item_ids: request.itemIds,
      rows: plannedRowCount(request),
      notice: QUEUED_NOTICE,
      confirm_token: token.token,
    },
  };
}

async function confirm(
  tenantId: string,
  apiKeyId: string,
  request: QueueToolRequest,
  rawToken: unknown,
): Promise<McpToolResult> {
  const token = typeof rawToken === "string" ? rawToken : "";
  if (!token) return fail("confirm_token is required. Preview first.");

  const redeemed = await redeemConfirmToken({
    token,
    subject: apiKeyId,
    toolName: queueExtensionWorkTool.name,
    payload: request,
  });
  if (!redeemed.ok) return fail(redeemed.failure.message);

  // The gate is run ONCE here and skipped per row: it is the same answer for
  // every row in the batch, and paying for it twelve times would be twelve
  // round trips to say the same thing.
  const gate = await sellerQueueGate(tenantId);
  if (!gate.ok) return fail(String(gate.body?.message ?? gate.error));

  const created: string[] = [];
  const refused: string[] = [];
  for (const itemId of request.itemIds) {
    for (const platform of request.platforms) {
      const result = await enqueueExtensionWork(
        tenantId,
        { kind: request.kind, platform, inventory_item_id: itemId, source: "connector" },
        { skipGate: true },
      );
      if (result.ok) created.push(String(result.row.id));
      else refused.push(`${itemId} → ${platform}: ${result.error}`);
    }
  }

  // PARTIAL IS REPORTED AS PARTIAL. The depth cap can bite halfway through a
  // batch, and reporting "queued 12" when 5 landed is the same class of lie as
  // reporting a queued job as live.
  const lines = [`Queued ${created.length} job(s).`];
  if (refused.length > 0) {
    lines.push(`${refused.length} were refused:`);
    for (const r of refused) lines.push(`  - ${r}`);
  }
  lines.push("");
  lines.push(QUEUED_NOTICE);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      queued: created.length,
      refused: refused.length,
      row_ids: created,
      notice: QUEUED_NOTICE,
    },
    // US-9117: the row ids are the only way to reconstruct this call later, and
    // they exist nowhere in the arguments.
    auditDetail: { row_ids: created, refused: refused.length },
  };
}

export const extensionQueueTool: McpToolDefinition = {
  name: "gradethread_extension_queue",
  title: "See what the seller's browser still has to do",
  description:
    "List the cross-listing work waiting for the seller's own browser, grouped into what needs " +
    "their attention, what is running now, and what is still waiting. Use this to answer " +
    "'what is left to list' or before queueing more. Read-only.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  requiredScope: "read",
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (_args, ctx) => {
    try {
      const { data } = await supabaseAdmin
        .from("extension_work_queue")
        .select(QUEUE_SELECT_COLS)
        .eq("user_id", ctx.tenantId) // US-268
        .in("status", ["queued", "claimed", "expired", "failed"])
        .order("created_at", { ascending: false })
        .limit(100);

      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      const needsAttention = rows.filter((r) => r.status === "expired" || r.status === "failed");
      const running = rows.filter((r) => r.status === "claimed");
      const waiting = rows.filter((r) => r.status === "queued");

      const describe = (r: Record<string, unknown>) => `${r.kind} on ${r.platform}`;
      const lines = [
        `${needsAttention.length} need attention, ${running.length} running, ` +
          `${waiting.length} waiting.`,
      ];
      if (needsAttention.length > 0) {
        lines.push("Needs attention:");
        for (const r of needsAttention.slice(0, 20)) lines.push(`  - ${describe(r)} (${r.status})`);
      }
      if (waiting.length > 0) {
        lines.push("Waiting for the seller's browser:");
        for (const r of waiting.slice(0, 20)) lines.push(`  - ${describe(r)}`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          needs_attention: needsAttention.length,
          running: running.length,
          waiting: waiting.length,
        },
      };
    } catch (err) {
      console.error("[mcp] extension queue:", redactError(err));
      return fail("Could not read the extension queue.");
    }
  },
};

export const queueExtensionWorkTool: McpToolDefinition = {
  name: "gradethread_queue_extension_work",
  title: "Queue cross-listing work for the seller's browser",
  description:
    "Queue listing, delisting, revising or relisting work for the marketplaces that have no write " +
    "API, so the seller's own browser runs it next time they open it with the GradeThread " +
    "extension installed. Call this when a seller asks to list, delist, revise or relist " +
    "specific items on Poshmark, Mercari, Grailed, Vinted or Facebook. It does NOT put anything " +
    "live: the work waits for their desktop. It takes two calls — preview names every item and " +
    "channel and returns a confirm_token, confirm queues them. Never confirm without showing the " +
    "seller the preview and getting a yes.",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: [...EXTENSION_QUEUE_KINDS],
        description: "What the browser should do with each item.",
      },
      item_ids: {
        type: "array",
        items: { type: "string" },
        description: `The seller's inventory item ids. At most ${MAX_QUEUE_TOOL_ITEMS} per call.`,
      },
      platforms: {
        type: "array",
        items: { type: "string", enum: [...QUEUE_TOOL_PLATFORMS] },
        description: "Which extension-driven channels to queue for.",
      },
      mode: {
        type: "string",
        enum: ["preview", "confirm"],
        description:
          'Defaults to "preview", which changes nothing and returns a confirm_token. ' +
          '"confirm" with that token queues the work.',
      },
      confirm_token: {
        type: "string",
        description: "The token from a preview call. Required to confirm, single use.",
      },
    },
    required: ["kind", "item_ids", "platforms"],
    additionalProperties: false,
  },
  requiredScope: "submit",
  // US-9131. The question says QUEUED, not listed: a person approving this is
  // agreeing to work that happens when they next open their browser, and a
  // prompt that implied otherwise would be the whole failure in one sentence.
  humanConfirmation: (args) =>
    args.mode === "confirm"
      ? "Queue this work for your browser to run next time you open it?"
      : null,
  // US-2752: refuse before asking a person. A request naming another tenant's
  // items must not produce an approval prompt, even though the write would fail
  // at redemption anyway — a prompt that always ends in refusal trains people
  // to click through.
  preConfirmCheck: async (args, ctx) => {
    if (args.mode !== "confirm") return null;
    const parsed = parseQueueRequest(args);
    if (!parsed.ok) return parsed.error;
    const titles = await loadTitles(ctx.tenantId, parsed.request.itemIds);
    const missing = parsed.request.itemIds.filter((id) => !titles.has(id));
    return missing.length > 0
      ? `Not the seller's items, or they do not exist: ${missing.join(", ")}.`
      : null;
  },
  // NOT openWorldHint: nothing here reaches a marketplace. It writes rows in
  // our own database and the seller's browser is what talks to anyone else.
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  handler: async (args, ctx) => {
    const parsed = parseQueueRequest(args);
    if (!parsed.ok) return fail(parsed.error);
    if (plannedRowCount(parsed.request) > MAX_QUEUE_DEPTH) {
      return fail(
        `That is ${plannedRowCount(parsed.request)} jobs, more than the ` +
          `${MAX_QUEUE_DEPTH} a queue holds. Queue fewer items or fewer channels.`,
      );
    }
    try {
      return args.mode === "confirm"
        ? await confirm(ctx.tenantId, ctx.apiKeyId, parsed.request, args.confirm_token)
        : await preview(ctx.tenantId, ctx.apiKeyId, parsed.request);
    } catch (err) {
      console.error("[mcp] queue extension work:", redactError(err));
      // Says what it does NOT know. A partial batch is possible, and claiming
      // nothing was queued would send a seller to re-queue duplicates.
      return fail(
        "Something went wrong while queueing. Check the seller's queue before trying " +
          "again — some of the work may already be waiting.",
      );
    }
  },
};
