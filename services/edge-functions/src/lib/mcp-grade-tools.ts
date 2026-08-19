// US-9114 (write half): grading an item from the connector.
//
// ── Why this is two calls and not one ─────────────────────────────────────
//
// Grading spends the seller's money: included monthly grades first, then credit
// balance, charged PER ITEM partway through a batch. The caller here is a
// language model acting on a seller's behalf, and the two things a model does
// by default are retry on timeout and act on its own reading of an instruction.
// A one-shot grade tool turns both of those into charges.
//
// So both tools are preview-then-confirm, sharing the US-9116 confirm lib:
//
//   • PREVIEW runs the same validation the submit path runs and shows the exact
//     items, their blockers, what each costs and what the batch needs, plus a
//     single-use token bound to that payload.
//   • CONFIRM spends the token and submits.
//
// The token doubles as the idempotency key. US-2564 keys the charge on a
// client-supplied batch token so a retried batch charges once per garment
// rather than once per attempt; the confirm token is exactly that value, and it
// is single-use, so a model that retries a confirm gets a refusal rather than a
// second charge. That is the property a `mode: "confirm"` argument alone would
// not give.
//
// ── What this does NOT accept, and why ───────────────────────────────────
//
// Images by value. A connector caller is a seller whose photos are already in
// item_photos, uploaded through the hardened path (validateImageUpload magic
// byte sniff, stripImageMetadata, then storage.upload). Accepting base64 bytes
// or remote URLs here would mean a SECOND upload path beside that one, and a
// model re-uploading photos the account already holds. If it is ever added, it
// goes through the same chain and any URL goes through safeFetch -- a tool that
// fetches a model-supplied URL from inside our network is SSRF with extra steps.

import {
  type SubmitItemInput,
  submitItemsForGrading,
  type ValidationResult,
} from "./grading-submit.ts";
import { buildValidation } from "./grading-submit.ts";
import { issueConfirmToken, redeemConfirmToken } from "./mcp-confirm.ts";
import { MAX_BATCH_ITEMS } from "./grading-batch.ts";
import { redactError } from "./log-redact.ts";
import type { McpToolContext, McpToolDefinition, McpToolResult } from "./mcp-tools.ts";

type Tier = "standard" | "premium" | "express";

const TIERS: Tier[] = ["standard", "premium", "express"];

function money(dollars: number): string {
  return `$${dollars.toFixed(2)}`;
}

function fail(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * The role to submit as.
 *
 * An API key belongs to one user, and mcp-auth never sets workspaceOwnerId, so
 * the caller IS the owner of the tenant it acts for. That is asserted rather
 * than assumed: if a workspace-scoped credential ever arrives, submitting as
 * "owner" would let a viewer spend the workspace's credits, and the failure
 * would be a charge rather than an error. Fail closed instead.
 */
function ownerOnly(ctx: McpToolContext): string | null {
  if (ctx.tenantId !== ctx.userId) {
    return "This credential acts for another user's workspace, and connector grading " +
      "does not yet resolve workspace roles. Grade from the FlipDesk app instead.";
  }
  return null;
}

function readTier(args: Record<string, unknown>): Tier {
  const raw = args.tier;
  return TIERS.includes(raw as Tier) ? raw as Tier : "standard";
}

function readItemIds(args: Record<string, unknown>, key: string): string[] {
  const raw = args[key];
  if (typeof raw === "string") return [raw];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

/** The payload a token is bound to. Order matters, so it is sorted. */
function tokenPayload(items: SubmitItemInput[]): unknown {
  return [...items]
    .map((i) => `${i.inventory_item_id}:${i.tier}`)
    .sort();
}

function renderPreview(result: ValidationResult, token: string): string {
  const lines = result.items.map((item) => {
    const label = item.title ?? item.inventory_item_id.slice(0, 8);
    if (!item.ready) return `BLOCKED · ${label} · ${item.blockers.join("; ")}`;
    const warn = item.warnings.length > 0 ? ` · ${item.warnings.join("; ")}` : "";
    return `READY · ${label} · ${item.tier} · ${money(item.cost)}${warn}`;
  });

  if (!result.can_submit) {
    const why = result.limit_exceeded
      ? `This batch needs ${result.credits_required} credit(s). The seller has ` +
        `${result.user.included_remaining} included grade(s) and ` +
        `${result.user.credit_balance} credit(s).`
      : `${result.items.filter((i) => !i.ready).length} of ${result.items.length} ` +
        "item(s) are not ready. Every item must be ready before the batch can be sent.";
    return `NOT SUBMITTABLE. ${why}\n${lines.join("\n")}`;
  }

  return [
    `Ready to grade ${result.items.length} item(s) for ${money(result.total_cost)}.`,
    `This will use ${result.credits_required} credit(s); the seller has ` +
      `${result.user.included_remaining} included grade(s) and ` +
      `${result.user.credit_balance} credit(s).`,
    ...lines,
    "",
    "Show the seller this list and what it costs. If they agree, call again with " +
      `mode "confirm" and confirm_token "${token}". The token is single use and ` +
      "expires in 10 minutes; if it expires, preview again rather than retrying it.",
  ].join("\n");
}

async function preview(
  ctx: McpToolContext,
  toolName: string,
  items: SubmitItemInput[],
): Promise<McpToolResult> {
  const validation = await buildValidation(ctx.tenantId, items);
  if (!validation.ok) return fail(validation.error);

  const result = validation.result;
  // A token is issued only for a batch that could actually be sent. Handing back
  // a token for a blocked batch invites a confirm that fails at the far end,
  // after the model has told the seller it is going ahead.
  if (!result.can_submit) {
    return {
      content: [{ type: "text", text: renderPreview(result, "") }],
      structuredContent: result as unknown as Record<string, unknown>,
      isError: true,
    };
  }

  const record = await issueConfirmToken({
    subject: ctx.apiKeyId,
    toolName,
    payload: tokenPayload(items),
    targetIds: items.map((i) => i.inventory_item_id),
  });

  return {
    content: [{ type: "text", text: renderPreview(result, record.token) }],
    structuredContent: {
      ...result as unknown as Record<string, unknown>,
      confirm_token: record.token,
      expires_in_seconds: Math.round((record.expiresAtMs - Date.now()) / 1000),
    },
  };
}

async function confirm(
  ctx: McpToolContext,
  toolName: string,
  items: SubmitItemInput[],
  token: unknown,
): Promise<McpToolResult> {
  if (typeof token !== "string" || token.length === 0) {
    return fail(
      "confirm mode needs the confirm_token from a preview call. Call this tool " +
        'with mode "preview" first and show the seller what it will cost.',
    );
  }

  const redeemed = await redeemConfirmToken({
    token,
    subject: ctx.apiKeyId,
    toolName,
    payload: tokenPayload(items),
  });
  if (!redeemed.ok) return fail(redeemed.failure.message);

  // US-2564: the token IS the batch key. One token, one batch, one charge per
  // garment -- and because it is single use, a retried confirm cannot reach
  // this line a second time.
  const outcome = await submitItemsForGrading(ctx.tenantId, "owner", items, token);
  if (!outcome.ok) {
    const body = outcome.body as { error?: unknown };
    return fail(
      typeof body.error === "string" ? body.error : "The grading submission was refused.",
    );
  }

  const ok = outcome.results.filter((r) => r.ok);
  const bad = outcome.results.filter((r) => !r.ok);
  const lines = [
    ...ok.map((r) =>
      r.ok ? `SUBMITTED · ${r.inventory_item_id} · submission ${r.submission_id}` : ""
    ),
    ...bad.map((r) => (!r.ok ? `FAILED · ${r.inventory_item_id} · ${r.error}` : "")),
  ].filter(Boolean);

  const header = outcome.failed === 0
    ? `Submitted ${outcome.submitted} item(s) for grading.`
    : `Submitted ${outcome.submitted} item(s); ${outcome.failed} failed. Failed items ` +
      "were not charged.";

  return {
    content: [{
      type: "text",
      text: [
        header,
        ...lines,
        "",
        "Grading runs in the background and takes a minute or two per item. Call " +
          "gradethread_get_grade with a submission id to check on it; do not " +
          "resubmit while one is still running.",
      ].join("\n"),
    }],
    structuredContent: {
      submitted: outcome.submitted,
      failed: outcome.failed,
      results: outcome.results as unknown as Record<string, unknown>[],
    },
  };
}

async function run(
  toolName: string,
  args: Record<string, unknown>,
  ctx: McpToolContext,
  idsKey: string,
): Promise<McpToolResult> {
  const blocked = ownerOnly(ctx);
  if (blocked) return fail(blocked);

  const ids = readItemIds(args, idsKey);
  if (ids.length === 0) return fail(`${idsKey} is required.`);
  if (ids.length > MAX_BATCH_ITEMS) {
    return fail(
      `A grading batch may contain at most ${MAX_BATCH_ITEMS} items; ${ids.length} were given. ` +
        "Split it and submit the parts separately.",
    );
  }
  // A repeated id would charge twice for one garment, and a model assembling a
  // list from a conversation repeats ids more often than a UI does.
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) {
    return fail(
      `That list names the same item more than once (${ids.length} ids, ${unique.length} distinct). ` +
        "Each garment is graded once per submission.",
    );
  }

  const tier = readTier(args);
  const items: SubmitItemInput[] = unique.map((id) => ({
    inventory_item_id: id,
    tier,
  }));

  const mode = args.mode === "confirm" ? "confirm" : "preview";
  try {
    return mode === "confirm"
      ? await confirm(ctx, toolName, items, args.confirm_token)
      : await preview(ctx, toolName, items);
  } catch (err) {
    console.error(`[mcp] ${toolName}:`, redactError(err));
    return fail("Could not submit for grading right now. Nothing was charged.");
  }
}

const MODE_SCHEMA = {
  type: "string" as const,
  enum: ["preview", "confirm"],
  description:
    'Defaults to "preview", which costs nothing and returns a confirm_token. ' +
    'Use "confirm" with that token to actually submit and charge.',
};

const CONFIRM_TOKEN_SCHEMA = {
  type: "string" as const,
  description: "The token from a preview call. Required in confirm mode, single use.",
};

const TIER_SCHEMA = {
  type: "string" as const,
  enum: TIERS,
  description: "Grade tier. Defaults to standard.",
};

export const gradeItemTool: McpToolDefinition = {
  name: "gradethread_grade_item",
  title: "Submit one item for grading",
  description:
    "Submit ONE inventory item for AI condition grading from the photos already on the item. " +
    "Call this when a seller asks to grade a specific garment. It spends their grading " +
    "allowance, so it takes two calls: preview shows exactly what will be graded and what it " +
    "costs, and confirm sends it. Always show the seller the preview before you confirm. " +
    "Grading is asynchronous - confirm returns a submission id, and gradethread_get_grade " +
    "reports the result when it is ready.",
  inputSchema: {
    type: "object",
    properties: {
      item_id: { type: "string", description: "The inventory item to grade." },
      tier: TIER_SCHEMA,
      mode: MODE_SCHEMA,
      confirm_token: CONFIRM_TOKEN_SCHEMA,
    },
    required: ["item_id"],
    additionalProperties: false,
  },
  requiredScope: "submit",
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  handler: (args, ctx) => run("gradethread_grade_item", args, ctx, "item_id"),
};

export const gradeBatchTool: McpToolDefinition = {
  name: "gradethread_grade_batch",
  title: "Submit several items for grading",
  description:
    `Submit up to ${MAX_BATCH_ITEMS} inventory items for AI condition grading in one batch, from ` +
    "the photos already on each item. Call this when a seller wants several garments graded at " +
    "once. It spends their grading allowance, so it takes two calls: preview lists every item by " +
    "name with its cost and the batch total, and confirm sends it. Show the seller that list, not " +
    "just the count. Every item must be ready or the whole batch is refused - call " +
    "gradethread_grading_readiness first to see why.",
  inputSchema: {
    type: "object",
    properties: {
      item_ids: {
        type: "array",
        items: { type: "string" },
        description: `Inventory item ids, at most ${MAX_BATCH_ITEMS}.`,
      },
      tier: TIER_SCHEMA,
      mode: MODE_SCHEMA,
      confirm_token: CONFIRM_TOKEN_SCHEMA,
    },
    required: ["item_ids"],
    additionalProperties: false,
  },
  requiredScope: "submit",
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  handler: (args, ctx) => run("gradethread_grade_batch", args, ctx, "item_ids"),
};
