// US-9118: ending, delisting and relisting from the connector.
//
// ── Why bulk end loops the SINGLE end ─────────────────────────────────────
//
// endOwnedListing (lib/listing-lifecycle.ts) is the one implementation of "end
// this listing": it dispatches on the same planner the sale-triggered auto-end
// uses, queues the marketplaces with no delist API for the Lister extension,
// and marks the local row ended ONLY when the listing is genuinely not live any
// more. The bulk tool calls it once per listing rather than adding a third
// delist loop to a codebase that already has two.
//
// ── A count is not a preview ──────────────────────────────────────────────
//
// AC3, and it is the reason the bulk tool is two calls. "End 34 listings" is
// not something a seller can check; a list of 34 titles is. The token is bound
// to that exact set, so a model cannot show one list and end a different one.
//
// ── The verb is checked, not inferred ─────────────────────────────────────
//
// US-2641 again. endOwnedListing distinguishes ENDED UPSTREAM from QUEUED (the
// extension will do it later, and the listing is live until then) from ALREADY
// NOT LIVE. Those are three different things to tell a seller, and collapsing
// them into "ended" is how someone believes a buyer can no longer buy an item
// that is still for sale.

import { supabaseAdmin } from "./supabase.ts";
import { endOwnedListing } from "./listing-lifecycle.ts";
import { ebayPublisher } from "./ebay-publish-port.ts";
import { featureAllowedForUser } from "./plan-gate.ts";
import { issueConfirmToken, redeemConfirmToken } from "./mcp-confirm.ts";
import { redactError } from "./log-redact.ts";
import type { McpToolDefinition, McpToolResult } from "./mcp-tools.ts";

/** Matches the bulk-edit cap the dashboard uses. */
const MAX_BULK_END = 100;

function fail(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function money(dollars: number | null): string {
  return dollars === null ? "no price" : `$${dollars.toFixed(2)}`;
}

interface EndCandidate {
  id: string;
  title: string;
  platform: string;
  status: string;
  price: number | null;
}

/**
 * The listings a caller may end, by id.
 *
 * US-268: ownership through the parent item's user_id, the same join
 * loadOwnedListing uses. An id that is not the caller's simply does not come
 * back, which is what makes the preview safe to show.
 */
async function loadEndCandidates(
  ownerId: string,
  ids: string[],
): Promise<EndCandidate[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select(
      "id, platform, listing_status, listing_price, listing_title, " +
        "inventory_items!inner(user_id, title)",
    )
    .in("id", ids)
    .eq("inventory_items.user_id", ownerId);
  if (error) throw new Error(`listing lookup failed: ${error.message}`);

  type Row = {
    id: string;
    platform: string | null;
    listing_status: string | null;
    listing_price: number | null;
    listing_title: string | null;
    inventory_items: { title: string | null } | null;
  };
  // Cast through unknown: the join makes supabase-js infer an error union here
  // (the same `tsc -b` resolution quirk the repo hits on submission_images).
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    title: r.listing_title || r.inventory_items?.title || "Untitled listing",
    platform: r.platform ?? "unknown",
    status: r.listing_status ?? "unknown",
    price: r.listing_price,
  }));
}

/** The token is bound to the exact SET, sorted so order does not matter. */
function endPayload(ids: string[]): unknown {
  return [...ids].sort();
}

function describe(c: EndCandidate): string {
  return `${c.title} · ${c.platform} · ${c.status} · ${money(c.price)}`;
}

/** One end result, rendered so the three outcomes stay distinguishable. */
function renderEndOutcome(id: string, title: string, body: Record<string, unknown>): string {
  if (body.ok !== true) {
    const reason = typeof body.error === "string" ? body.error : "could not be ended";
    return `STILL LIVE · ${title} · ${reason}`;
  }
  if (body.already_ended === true) return `ALREADY ENDED · ${title}`;
  if (body.queued === true) {
    return `QUEUED · ${title} · still live on the marketplace until the GradeThread ` +
      "Lister extension ends it in the seller's browser";
  }
  if (body.ended_upstream === true) return `ENDED · ${title}`;
  const note = typeof body.note === "string" ? ` · ${body.note}` : "";
  return `ENDED LOCALLY · ${title}${note} · nothing was withdrawn from a marketplace ` +
    `(id ${id.slice(0, 8)})`;
}

// ---------------------------------------------------------------------------
// end
// ---------------------------------------------------------------------------

async function runEnd(
  args: Record<string, unknown>,
  ctx: { tenantId: string; apiKeyId: string },
  toolName: string,
  ids: string[],
): Promise<McpToolResult> {
  const candidates = await loadEndCandidates(ctx.tenantId, ids);
  if (candidates.length === 0) {
    return fail("None of those listings are in this workspace.");
  }

  if (args.mode !== "confirm") {
    const missing = ids.filter((id) => !candidates.some((c) => c.id === id));
    const record = await issueConfirmToken({
      subject: ctx.apiKeyId,
      toolName,
      payload: endPayload(candidates.map((c) => c.id)),
      targetIds: candidates.map((c) => c.id),
    });
    return {
      content: [{
        type: "text",
        text: [
          `Ending ${candidates.length} listing(s). Buyers will no longer be able to buy these:`,
          ...candidates.map(describe),
          missing.length > 0
            ? `${missing.length} of the ids given are not in this workspace and were dropped.`
            : "",
          "",
          "Read the seller this list, not the count. If they agree, call again with " +
          `mode "confirm" and confirm_token "${record.token}". The token covers exactly ` +
          "these listings and is single use.",
        ].filter(Boolean).join("\n"),
      }],
      structuredContent: {
        listings: candidates as unknown as Record<string, unknown>[],
        confirm_token: record.token,
        expires_in_seconds: Math.round((record.expiresAtMs - Date.now()) / 1000),
      },
    };
  }

  const token = args.confirm_token;
  if (typeof token !== "string" || !token) {
    return fail(
      'Ending a listing needs the confirm_token from a preview call. Call with mode "preview" ' +
        "first and show the seller which listings would end.",
    );
  }
  const redeemed = await redeemConfirmToken({
    token,
    subject: ctx.apiKeyId,
    toolName,
    // Bound to what is CURRENTLY ownable, so a listing that left the workspace
    // between the preview and the confirm invalidates the token rather than
    // being silently dropped from the set.
    payload: endPayload(candidates.map((c) => c.id)),
  });
  if (!redeemed.ok) return fail(redeemed.failure.message);

  const lines: string[] = [];
  let ended = 0;
  let stillLive = 0;
  for (const candidate of candidates) {
    const outcome = await endOwnedListing(ctx.tenantId, candidate.id);
    const ok = outcome.body.ok === true;
    // QUEUED counts as still live, deliberately: the extension has not run yet
    // and a buyer can still buy it. Counting it as ended is the exact lie this
    // tool exists not to tell.
    if (ok && outcome.body.queued !== true) ended++;
    else stillLive++;
    lines.push(renderEndOutcome(candidate.id, candidate.title, outcome.body));
  }

  return {
    content: [{
      type: "text",
      text: [
        `${ended} listing(s) are no longer live. ${stillLive} still are.`,
        ...lines,
      ].join("\n"),
    }],
    structuredContent: { ended, still_live: stillLive },
  };
}

const MODE_SCHEMA = {
  type: "string" as const,
  enum: ["preview", "confirm"],
  description:
    'Defaults to "preview", which ends nothing and returns a confirm_token. ' +
    '"confirm" with that token ends the listings.',
};

const TOKEN_SCHEMA = {
  type: "string" as const,
  description: "The token from a preview call. Required to confirm, single use.",
};

export const endListingTool: McpToolDefinition = {
  name: "gradethread_end_listing",
  title: "End one live listing",
  description:
    "Take one listing off its marketplace so buyers can no longer buy it. Call this when a " +
    "seller asks for a specific item to be pulled. It takes two calls: preview names the " +
    "listing and what it is currently selling for, and confirm ends it. It reports whether the " +
    "marketplace actually took it down, which is not always the same as the request succeeding.",
  inputSchema: {
    type: "object",
    properties: {
      listing_id: { type: "string", description: "The listing to end." },
      mode: MODE_SCHEMA,
      confirm_token: TOKEN_SCHEMA,
    },
    required: ["listing_id"],
    additionalProperties: false,
  },
  requiredScope: "submit",
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const id = typeof args.listing_id === "string" ? args.listing_id : "";
    if (!id) return fail("listing_id is required.");
    try {
      return await runEnd(args, ctx, "gradethread_end_listing", [id]);
    } catch (err) {
      console.error("[mcp] end listing:", redactError(err));
      return fail(
        "Something went wrong while ending that listing. Check whether it is still live " +
          "before trying again.",
      );
    }
  },
};

export const endListingsBulkTool: McpToolDefinition = {
  name: "gradethread_end_listings",
  title: "End several live listings",
  description:
    `Take up to ${MAX_BULK_END} listings off their marketplaces in one go. Call this when a ` +
    "seller wants a group pulled, for example everything from one source or one brand. Preview " +
    "lists every affected item BY NAME, not just a count, and confirm ends exactly that set. " +
    "Read the seller the list before confirming.",
  inputSchema: {
    type: "object",
    properties: {
      listing_ids: {
        type: "array",
        items: { type: "string" },
        description: `The listings to end, at most ${MAX_BULK_END}.`,
      },
      mode: MODE_SCHEMA,
      confirm_token: TOKEN_SCHEMA,
    },
    required: ["listing_ids"],
    additionalProperties: false,
  },
  requiredScope: "submit",
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const ids = Array.isArray(args.listing_ids)
      ? [...new Set(args.listing_ids.filter((v): v is string => typeof v === "string"))]
      : [];
    if (ids.length === 0) return fail("listing_ids is required.");
    if (ids.length > MAX_BULK_END) {
      return fail(`At most ${MAX_BULK_END} listings per call; ${ids.length} were given.`);
    }

    try {
      // The same plan gate the dashboard's bulk-end applies, through the
      // context-free resolver. A tool must not be the entry point that makes a
      // paid feature free.
      if (!(await featureAllowedForUser(ctx.tenantId, "bulkActions"))) {
        return fail(
          "Ending listings in bulk is not included in this plan. They can still be ended one " +
            "at a time with gradethread_end_listing.",
        );
      }
      return await runEnd(args, ctx, "gradethread_end_listings", ids);
    } catch (err) {
      console.error("[mcp] end listings:", redactError(err));
      return fail(
        "Something went wrong while ending those listings. Check which are still live " +
          "before trying again.",
      );
    }
  },
};

// ---------------------------------------------------------------------------
// relist
// ---------------------------------------------------------------------------

export const relistTool: McpToolDefinition = {
  name: "gradethread_relist",
  title: "Relist a sold-out listing",
  description:
    "Put a sold-out or ended listing back on eBay under its existing offer, replenishing the " +
    "quantity. Call this when a seller wants to sell the same item again. It takes two calls: " +
    "preview names the listing and the quantity, and confirm relists it and reports the NEW " +
    "listing id.",
  inputSchema: {
    type: "object",
    properties: {
      listing_id: { type: "string", description: "The listing to relist." },
      quantity: {
        type: "integer",
        description: "How many to make available. Defaults to 1, and never goes below 1.",
      },
      mode: MODE_SCHEMA,
      confirm_token: TOKEN_SCHEMA,
    },
    required: ["listing_id"],
    additionalProperties: false,
  },
  requiredScope: "submit",
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const id = typeof args.listing_id === "string" ? args.listing_id : "";
    if (!id) return fail("listing_id is required.");
    const raw = Number(args.quantity);
    const quantity = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;

    const publisher = ebayPublisher();
    if (!publisher) return fail("Relisting is not available on this server right now.");

    try {
      const [candidate] = await loadEndCandidates(ctx.tenantId, [id]);
      if (!candidate) return fail("That listing is not in this workspace.");

      if (args.mode !== "confirm") {
        const record = await issueConfirmToken({
          subject: ctx.apiKeyId,
          toolName: "gradethread_relist",
          // Quantity is part of the payload: relisting one and relisting twelve
          // are different decisions and the seller agreed to one of them.
          payload: [id, String(quantity)],
          targetIds: [id],
        });
        return {
          content: [{
            type: "text",
            text: [
              `Relisting ${describe(candidate)} at quantity ${quantity}.`,
              "This puts it back in front of buyers and uses one of the seller's active " +
              "listing slots.",
              "",
              `If they agree, call again with mode "confirm" and confirm_token ` +
              `"${record.token}".`,
            ].join("\n"),
          }],
          structuredContent: {
            listing: candidate as unknown as Record<string, unknown>,
            quantity,
            confirm_token: record.token,
          },
        };
      }

      const token = args.confirm_token;
      if (typeof token !== "string" || !token) {
        return fail(
          'Relisting needs the confirm_token from a preview call. Call with mode "preview" ' +
            "first.",
        );
      }
      const redeemed = await redeemConfirmToken({
        token,
        subject: ctx.apiKeyId,
        toolName: "gradethread_relist",
        payload: [id, String(quantity)],
      });
      if (!redeemed.ok) return fail(redeemed.failure.message);

      const outcome = await publisher.relist(ctx.tenantId, id, quantity);
      if (outcome.status >= 400 || outcome.body.ok !== true) {
        const body = outcome.body as { error?: unknown };
        return fail(
          [
            typeof body.error === "string" ? body.error : "eBay did not accept the relist.",
            "The listing was not relisted.",
          ].join("\n"),
        );
      }

      // AC4 / US-2641: a relist that reports success without a listing id has
      // not been confirmed by eBay, and saying otherwise sends the seller to
      // look for a listing that may not exist.
      const newId = outcome.body.listing_id;
      if (typeof newId !== "string" || !newId) {
        return fail(
          "The relist came back without a listing id, so I cannot confirm it is live. " +
            "Check the seller's eBay account before relisting again — doing it twice would " +
            "create a duplicate.",
        );
      }

      return {
        content: [{
          type: "text",
          text: `Relisted at quantity ${outcome.body.quantity ?? quantity}. ` +
            `New listing ${newId}: ${outcome.body.listing_url ?? "(no URL returned)"}`,
        }],
        structuredContent: outcome.body,
      };
    } catch (err) {
      console.error("[mcp] relist:", redactError(err));
      return fail(
        "Something went wrong while relisting. Check the seller's eBay account before " +
          "trying again — the listing may or may not be live.",
      );
    }
  },
};
