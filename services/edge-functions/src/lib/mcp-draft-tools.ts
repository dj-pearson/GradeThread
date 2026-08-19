// US-9115: creating and editing a draft listing from the connector.
//
// ── create: enqueue, do not generate ─────────────────────────────────────
//
// gradethread_create_draft does not write copy. It enqueues an AutoLister
// generation batch through lib/autolister-enqueue.ts, which is the same path
// the app's own "generate drafts" button takes and therefore the same AI
// listing-copy pass, the same eBay category resolution and aspect fill, the
// same grade-authority text, and the same per-item AI reservation. A second
// copy generator would be a second answer to "what does my listing say", and
// the seller would get whichever one they happened to ask for.
//
// It is asynchronous by construction: generation takes a vision pass per item.
// The tool returns a batch id and the model polls gradethread_get_batch, which
// already exists as a read tool.
//
// ── update: the draft row, not just the item ─────────────────────────────
//
// At publish, assemblePublishContext resolves each field LISTING FIRST:
// listing.listing_title ?? item.title, and the same for description and price.
// So a surface that writes only inventory_items produces an edit that appears
// to work and then publishes the old text with no error anywhere -- which is
// exactly the open bug the grid still has (vault/20-domain/draft-snapshot-precedence).
// This writes the listings row, and mirrors the composer's US-2593 write-back
// of the effective title onto the item so the two stop diverging.
//
// It refuses a PUBLISHED listing rather than editing it. Changing a live
// listing means pushing to the marketplace, which is the reprice and revise
// tools' job and carries its own confirmation; silently writing the local row
// would leave the seller's copy disagreeing with what a buyer sees.

import { supabaseAdmin } from "./supabase.ts";
import {
  loadOwnedListing,
  originLockResponse,
  wasPublishedUpstream,
} from "./listing-lifecycle.ts";
import { enqueueGenerationBatch } from "./autolister-enqueue.ts";
import { capAspectValuesForEbay, EBAY_ASPECT_VALUE_MAX_LEN } from "./ebay-client.ts";
import { redactError } from "./log-redact.ts";
import type { McpToolDefinition, McpToolResult } from "./mcp-tools.ts";

/** Matches the AutoLister route's own cap. */
const MAX_DRAFT_ITEMS = 100;

function fail(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function readIds(raw: unknown): string[] {
  if (typeof raw === "string") return [raw];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export const createDraftTool: McpToolDefinition = {
  name: "gradethread_create_draft",
  title: "Generate draft listings for items",
  description:
    "Generate eBay draft listings for one or more inventory items: title, description, category, " +
    "item specifics, condition and a suggested price, written from the item's photos and details. " +
    "Call this when a seller wants listings written for items that do not have one yet. It runs in " +
    "the background and spends one AI action per item, so it returns a batch id -- poll " +
    "gradethread_get_batch with that id to see when the drafts are ready, then use " +
    "gradethread_update_draft to change anything the seller wants different.",
  inputSchema: {
    type: "object",
    properties: {
      item_ids: {
        type: "array",
        items: { type: "string" },
        description: `Inventory item ids to write drafts for, at most ${MAX_DRAFT_ITEMS}.`,
      },
      use_comps: {
        type: "boolean",
        description:
          "Price from live sold comparables. Defaults to true; false is faster and cheaper.",
      },
      template_id: {
        type: "string",
        description: "Optional listing template to overlay on every generated draft.",
      },
    },
    required: ["item_ids"],
    additionalProperties: false,
  },
  requiredScope: "submit",
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  handler: async (args, ctx) => {
    const ids = readIds(args.item_ids);
    if (ids.length === 0) return fail("item_ids is required.");

    try {
      const outcome = await enqueueGenerationBatch(ctx.tenantId, {
        itemIds: ids,
        useComps: args.use_comps !== false,
        templateId: typeof args.template_id === "string" ? args.template_id : null,
        maxItems: MAX_DRAFT_ITEMS,
      });
      if (!outcome.ok) {
        const body = outcome.body as { error?: unknown };
        return fail(
          typeof body.error === "string" ? body.error : "Could not start the draft generation.",
        );
      }

      return {
        content: [{
          type: "text",
          text: [
            `Writing drafts for ${outcome.itemCount} item(s). This takes about a minute per item.`,
            // A REGENERATION OVERWRITES A REVIEWED DRAFT (US-1568). The model
            // should say so before the seller loses an edit they made.
            "If any of these items already had a draft, the new one replaces it — including any " +
              "wording a person had already fixed.",
            `Poll gradethread_get_batch with batch_id "${outcome.batchId}" to see when they are ready.`,
          ].join("\n"),
        }],
        structuredContent: {
          batch_id: outcome.batchId,
          item_count: outcome.itemCount,
        },
      };
    } catch (err) {
      console.error("[mcp] create draft:", redactError(err));
      return fail("Could not start the draft generation right now.");
    }
  },
};

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

/** The listings columns this tool may write, and what the caller calls them. */
const FIELD_MAP: Record<string, string> = {
  title: "listing_title",
  description: "listing_description",
  price: "listing_price",
  quantity: "quantity",
  condition: "ebay_condition",
  condition_description: "ebay_condition_description",
};

function buildPatch(
  args: Record<string, unknown>,
): { patch: Record<string, unknown>; problems: string[]; truncated: string[] } {
  const patch: Record<string, unknown> = {};
  const problems: string[] = [];
  const truncated: string[] = [];

  for (const [arg, column] of Object.entries(FIELD_MAP)) {
    const raw = args[arg];
    if (raw === undefined || raw === null) continue;

    if (arg === "price") {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        problems.push("price must be a positive number");
        continue;
      }
      patch[column] = n;
      continue;
    }
    if (arg === "quantity") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        problems.push("quantity must be a whole number of 0 or more");
        continue;
      }
      patch[column] = n;
      continue;
    }
    if (typeof raw !== "string" || !raw.trim()) {
      problems.push(`${arg} must be a non-empty string`);
      continue;
    }
    patch[column] = raw.trim();
  }

  // US-2337: eBay hard-rejects an aspect VALUE over 65 characters, and the
  // offer sticks in a state the seller cannot publish or clear. Capped HERE,
  // before it is ever stored, because a draft that cannot publish is worse than
  // no draft — the same chokepoint the publish path uses.
  const specifics = args.item_specifics;
  if (specifics && typeof specifics === "object" && !Array.isArray(specifics)) {
    const raw = specifics as Record<string, unknown>;
    const asMap: Record<string, string[]> = {};
    for (const [name, value] of Object.entries(raw)) {
      const values = Array.isArray(value) ? value : [value];
      const strings = values.filter((v): v is string => typeof v === "string");
      if (strings.length === 0) continue;
      for (const v of strings) {
        if (v.length > EBAY_ASPECT_VALUE_MAX_LEN) truncated.push(name);
      }
      asMap[name] = strings;
    }
    const capped = capAspectValuesForEbay(asMap);
    if (capped) patch.item_specifics_override = capped;
  }

  return { patch, problems, truncated };
}

export const updateDraftTool: McpToolDefinition = {
  name: "gradethread_update_draft",
  title: "Edit an unpublished draft listing",
  description:
    "Change the title, description, price, quantity, condition or item specifics on a draft " +
    "listing that has not been published yet. Call this when a seller wants the wording or the " +
    "price of a draft changed before it goes live. It refuses a listing that is already live on a " +
    "marketplace — use the reprice and end tools for those, so the marketplace and our copy stay " +
    "in agreement.",
  inputSchema: {
    type: "object",
    properties: {
      listing_id: { type: "string", description: "The draft listing to edit." },
      title: { type: "string", description: "New listing title." },
      description: { type: "string", description: "New listing description (HTML allowed)." },
      price: { type: "number", description: "New price in dollars." },
      quantity: { type: "integer", description: "New quantity." },
      condition: { type: "string", description: "eBay condition enum, e.g. USED_EXCELLENT." },
      condition_description: {
        type: "string",
        description: "Free-text condition note shown on the listing.",
      },
      item_specifics: {
        type: "object",
        description:
          "eBay item specifics as name to value. Values over " +
          `${EBAY_ASPECT_VALUE_MAX_LEN} characters are shortened, because eBay rejects them and ` +
          "the offer then sticks.",
      },
    },
    required: ["listing_id"],
    additionalProperties: false,
  },
  requiredScope: "submit",
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    const listingId = typeof args.listing_id === "string" ? args.listing_id : "";
    if (!listingId) return fail("listing_id is required.");

    try {
      // US-268: owner-verified through the parent item. An id from a tool
      // argument never reaches a write without this.
      const row = await loadOwnedListing(listingId, ctx.tenantId);
      if (!row) return fail("That draft was not found in this workspace.");

      if (wasPublishedUpstream(row)) {
        return fail(
          "That listing is live on a marketplace, so editing it here would leave your copy " +
            "disagreeing with what buyers see. Use the reprice tool for a price change, or end " +
            "the listing first.",
        );
      }

      // US-1976: an eBay-ORIGINATED listing is a mirror; eBay owns these fields
      // and a local write would be overwritten on the next pull.
      const lock = originLockResponse(row, ["listing_title", "listing_price"]);
      if (lock.locked) return fail(String(lock.body.error));

      const { patch, problems, truncated } = buildPatch(args);
      if (problems.length > 0) return fail(problems.join("; "));
      if (Object.keys(patch).length === 0) {
        return fail("Nothing to change. Pass at least one field to update.");
      }

      const { error } = await supabaseAdmin
        .from("listings")
        .update(patch)
        .eq("id", listingId)
        .eq("user_id", ctx.tenantId); // US-268
      if (error) {
        console.error("[mcp] update draft:", redactError(error));
        return fail("Could not save that change.");
      }

      // US-2593: mirror the effective title onto the item, the way a composer
      // save does, so the inventory row and the draft stop diverging on the two
      // surfaces that both show a title.
      if (typeof patch.listing_title === "string" && row.inventory_item_id) {
        await supabaseAdmin
          .from("inventory_items")
          .update({ title: patch.listing_title })
          .eq("id", row.inventory_item_id)
          .eq("user_id", ctx.tenantId);
      }

      const changed = Object.keys(patch).map((c) => c.replace(/^listing_/, ""));
      const notes = truncated.length > 0
        ? [
          `Shortened ${truncated.length} item specific(s) to eBay's ` +
          `${EBAY_ASPECT_VALUE_MAX_LEN}-character limit: ${[...new Set(truncated)].join(", ")}. ` +
          "eBay rejects longer values and the offer then cannot be published or cleared.",
        ]
        : [];

      return {
        content: [{
          type: "text",
          text: [`Updated ${changed.join(", ")} on the draft.`, ...notes].join("\n"),
        }],
        structuredContent: {
          listing_id: listingId,
          updated_fields: changed,
          truncated_specifics: [...new Set(truncated)],
        },
      };
    } catch (err) {
      console.error("[mcp] update draft:", redactError(err));
      return fail("Could not update that draft right now.");
    }
  },
};
