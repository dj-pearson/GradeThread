// US-9116: publishing a listing from the connector.
//
// This is the tool that puts a seller's garment in front of buyers at a price.
// Everything below exists because the caller is a language model.
//
// ── Never one shot ────────────────────────────────────────────────────────
//
// Preview returns exactly what will go live -- title, price, quantity,
// category, condition, photo count, and what eBay will take -- plus a
// single-use token bound to that payload, the item and the calling credential.
// Confirm spends the token. A token that expired, was reused, belongs to
// another credential, or was issued against a payload that has since changed is
// refused with "preview again", never "retry": retrying is a model's default
// and none of these are fixed by it.
//
// The token is also the replay protection Idempotency-Key gives /api/v1. A
// model that times out and retries a confirm gets a refusal, not a second
// listing.
//
// ── The verb is CHECKED, not inferred ─────────────────────────────────────
//
// US-2641's shape: an eBay lifecycle verb reported success because nothing
// threw. The publish path returns a listing id and URL on success; this tool
// treats a result carrying neither as UNKNOWN and says so, rather than telling
// a seller their item is live. "I could not confirm it went live, check your
// eBay account" is a worse-sounding answer and a truer one.
//
// ── Elicitation ───────────────────────────────────────────────────────────
//
// US-9131 landed it, in the DISPATCHER rather than here: an InputRequiredResult
// is a protocol-level response shape and a tool handler returning McpToolResult
// cannot express one. This tool declares `humanConfirmation` and the dispatcher
// turns that into the MRTR round trip on 2026-07-28 clients.
//
// It does not replace the token, and the two answer different questions.
// Elicitation asks a PERSON; the token proves the PAYLOAD did not change between
// the question and the action. Elicitation alone would let a model ask "publish
// at $48?", get a yes, and publish at $95. A client on an older revision sees no
// prompt and still cannot publish without a token.

import {
  ebayPublisher,
  type PublishPreviewData,
} from "./ebay-publish-port.ts";
import { issueConfirmToken, redeemConfirmToken } from "./mcp-confirm.ts";
import { ebayFeesFor } from "./ebay-fees.ts";
import { redactError } from "./log-redact.ts";
import type { McpToolDefinition, McpToolResult } from "./mcp-tools.ts";

function fail(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function money(dollars: number): string {
  return `$${dollars.toFixed(2)}`;
}

/**
 * What the token is bound to.
 *
 * The fields a seller would care about having changed between being asked and
 * it happening: what it says, what it costs, how many, and where it sits. A
 * warning changing is not a reason to re-ask; a price changing is.
 */
function tokenPayload(item: string, p: PublishPreviewData): unknown {
  return [
    item,
    p.title,
    p.price === null ? "no-price" : p.price.toFixed(2),
    String(p.quantity),
    p.categoryId ?? "no-category",
    p.condition ?? "no-condition",
  ];
}

function renderPreview(p: PublishPreviewData, token: string): string {
  const lines = [
    `Title: ${p.title || "(none)"}`,
    `Price: ${p.price === null ? "not set" : money(p.price)}`,
    `Quantity: ${p.quantity}`,
    `Category: ${p.categoryId ?? "not set"}`,
    `Condition: ${p.condition ?? "not set"}`,
    `Photos: ${p.photoCount}`,
  ];
  if (p.price !== null) {
    // Named as an estimate on purpose: the full schedule (store tiers, category
    // thresholds, standing surcharges) is not mirrored to the edge, so a figure
    // presented as exact would be wrong for some sellers.
    const fee = ebayFeesFor(p.price);
    lines.push(
      `eBay's cut, roughly ${money(fee)}, leaving about ${money(p.price - fee)}. ` +
        "That is an estimate, not your invoice.",
    );
  }
  if (p.warnings.length > 0) lines.push(`Worth knowing: ${p.warnings.join("; ")}`);

  lines.push(
    "",
    "Show the seller this, and only publish if they say yes. Then call again " +
      `with mode "confirm" and confirm_token "${token}". The token is single use ` +
      "and expires in 10 minutes; if it expires, preview again rather than reusing it.",
  );
  return lines.join("\n");
}

async function preview(
  ownerId: string,
  subject: string,
  itemId: string,
): Promise<McpToolResult> {
  const publisher = ebayPublisher();
  if (!publisher) return fail("Publishing is not available on this server right now.");

  const p = await publisher.preview(ownerId, itemId);
  if (!p.ready) {
    // AC6: name the remediable cause. "Publish failed" sends the model back to
    // retry, which is the one thing that cannot work.
    const why = p.blockers.length > 0
      ? p.blockers.join("; ")
      : !p.policiesReady
      ? "No eBay business policies are set up for this account. Add shipping, payment " +
        "and return policies in Marketplaces, then try again."
      : "This item is not ready to publish.";
    return {
      content: [{ type: "text", text: `Not ready to publish.\n${why}` }],
      structuredContent: p as unknown as Record<string, unknown>,
      isError: true,
    };
  }

  const record = await issueConfirmToken({
    subject,
    toolName: "gradethread_publish_listing",
    payload: tokenPayload(itemId, p),
    targetIds: [itemId],
  });

  return {
    content: [{ type: "text", text: renderPreview(p, record.token) }],
    structuredContent: {
      ...(p as unknown as Record<string, unknown>),
      estimated_fee_dollars: p.price === null ? null : Number(ebayFeesFor(p.price).toFixed(2)),
      confirm_token: record.token,
      expires_in_seconds: Math.round((record.expiresAtMs - Date.now()) / 1000),
    },
  };
}

async function confirm(
  ownerId: string,
  subject: string,
  itemId: string,
  token: unknown,
): Promise<McpToolResult> {
  if (typeof token !== "string" || !token) {
    return fail(
      'Publishing needs the confirm_token from a preview call. Call this with mode "preview" ' +
        "first and show the seller what will go live.",
    );
  }

  const publisher = ebayPublisher();
  if (!publisher) return fail("Publishing is not available on this server right now.");

  // Re-read the CURRENT state and bind the token against that, not against
  // whatever the preview said. This is the whole point of the payload hash: if
  // the price moved between the seller agreeing and the model acting, the
  // hashes disagree and the publish is refused.
  const p = await publisher.preview(ownerId, itemId);

  const redeemed = await redeemConfirmToken({
    token,
    subject,
    toolName: "gradethread_publish_listing",
    payload: tokenPayload(itemId, p),
  });
  if (!redeemed.ok) return fail(redeemed.failure.message);

  const result = await publisher.publish(ownerId, itemId, {});
  if (!result.ok) {
    const body = result.body as { error?: unknown; code?: unknown; blockers?: unknown };
    const detail = typeof body.error === "string" ? body.error : null;
    const blockers = Array.isArray(body.blockers)
      ? body.blockers.filter((b): b is string => typeof b === "string")
      : [];
    return fail(
      [
        "eBay did not accept this listing.",
        detail,
        blockers.length > 0 ? `What to fix: ${blockers.join("; ")}` : null,
        "The item was not published. Nothing was charged.",
      ].filter(Boolean).join("\n"),
    );
  }

  // US-2641: CHECK the verb, do not infer it. A success arm carrying no listing
  // id is not a publish we can report as one.
  if (!result.listing_id) {
    return fail(
      "The publish call came back without a listing id, so I cannot confirm the item " +
        "went live. Check the seller's eBay account before publishing again — " +
        "publishing twice would create a duplicate listing.",
    );
  }

  const note = result.sync_pending
    ? "\nIt is live on eBay; our copy is still catching up, so it may take a moment " +
      "to show as listed here."
    : "";

  return {
    content: [{
      type: "text",
      text: `Published. ${result.listing_url}${note}`,
    }],
    structuredContent: {
      listing_id: result.listing_id,
      listing_url: result.listing_url,
      offer_id: result.offer_id,
      sku: result.sku,
      sync_pending: result.sync_pending ?? false,
    },
  };
}

export const publishListingTool: McpToolDefinition = {
  name: "gradethread_publish_listing",
  title: "Publish a listing to eBay",
  description:
    "Put one item live on eBay at its draft's title, price and quantity. Call this only when a " +
    "seller has asked for a specific item to go live. It takes two calls: preview shows exactly " +
    "what buyers will see, what it costs and anything blocking it, and confirm publishes it. " +
    "Never confirm without showing the seller the preview and getting a yes. One item per call.",
  inputSchema: {
    type: "object",
    properties: {
      item_id: { type: "string", description: "The inventory item to publish." },
      mode: {
        type: "string",
        enum: ["preview", "confirm"],
        description:
          'Defaults to "preview", which changes nothing and returns a confirm_token. ' +
          '"confirm" with that token publishes.',
      },
      confirm_token: {
        type: "string",
        description: "The token from a preview call. Required to confirm, single use.",
      },
    },
    required: ["item_id"],
    additionalProperties: false,
  },
  requiredScope: "submit",
  // US-9131: the only tool here that puts a garment in front of buyers at a
  // price, so it is the one that most wants a person rather than a model's
  // account of a person.
  humanConfirmation: (args) =>
    args.mode === "confirm" ? "Put this item live on eBay now?" : null,
  // openWorldHint: this one reaches a system we do not control, and its answer
  // is the thing that decides whether the listing exists.
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const itemId = typeof args.item_id === "string" ? args.item_id : "";
    if (!itemId) return fail("item_id is required.");

    try {
      return args.mode === "confirm"
        ? await confirm(ctx.tenantId, ctx.apiKeyId, itemId, args.confirm_token)
        : await preview(ctx.tenantId, ctx.apiKeyId, itemId);
    } catch (err) {
      console.error("[mcp] publish listing:", redactError(err));
      // Deliberately does NOT say "nothing was published": an exception can be
      // thrown after eBay accepted the offer, and claiming otherwise is how a
      // seller ends up with two listings.
      return fail(
        "Something went wrong while publishing. Check the seller's eBay account before " +
          "trying again — the listing may or may not have gone live.",
      );
    }
  },
};
