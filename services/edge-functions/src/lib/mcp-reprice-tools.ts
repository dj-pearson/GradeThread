// US-9117: repricing from the connector.
//
// Five tools over one existing engine. The route registers its bulk preview,
// bulk apply and the two per-suggestion verbs into lib/reprice-port.ts, so a
// tool and the dashboard cannot price a listing differently.
//
// ── The guard that survives a valid token ─────────────────────────────────
//
// A confirm token proves the seller saw these numbers and the numbers have not
// moved. It does NOT prove the numbers were right. So apply refuses a change
// larger than MAX_PRICE_MOVE_PCT, or one that crosses below the item's margin
// floor, EVEN WITH a valid token, and says which listing and by how much.
//
// A confirmation is not a safety net for an arithmetic error. A model that
// computes a 90% drop, shows it, gets a yes, and applies it has done everything
// the protocol asked, and the seller has still lost the money.
//
// The floor is re-checked server-side inside the apply body too (it always was).
// This is the earlier, louder refusal: reported per listing with the percentage,
// so the model can tell a seller what happened rather than reading a skip code.

import { repricerImpl } from "./reprice-port.ts";
import { listPriceSuggestions, SUGGESTIONS_MAX } from "./api-pricing.ts";
import { issueConfirmToken, redeemConfirmToken } from "./mcp-confirm.ts";
import { redactError } from "./log-redact.ts";
import type { McpToolContext, McpToolDefinition, McpToolResult } from "./mcp-tools.ts";

/**
 * The biggest single move the connector will make without a human doing it in
 * the app. 25% is the story's suggestion and it is deliberately not per-plan:
 * a seller who wants a half-price fire sale can do it in FlipDesk, where they
 * are looking at the listing.
 */
export const MAX_PRICE_MOVE_PCT = 25;

/** Per call. The hourly ceiling is the price_change budget. */
export const MAX_REPRICE_PER_CALL = 50;

function fail(text: string): McpToolResult {
  return { content: [{ type: "text", text: text }], isError: true };
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function pct(fromCents: number, toCents: number): number {
  if (fromCents <= 0) return 0;
  return Math.abs(toCents - fromCents) / fromCents * 100;
}

function readIds(raw: unknown): string[] {
  if (typeof raw === "string") return [raw];
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((v): v is string => typeof v === "string"))];
}

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

/** What the token is bound to: the exact set of ids and the exact new prices. */
function tokenPayload(items: Array<{ listing_id: string; price_cents: number }>): unknown {
  return items
    .map((i) => `${i.listing_id}:${i.price_cents}`)
    .sort();
}

export const repricePreviewTool: McpToolDefinition = {
  name: "gradethread_reprice_preview",
  title: "See what a reprice would do",
  description:
    "Work out a new price for one or more live listings from current sold comparables, and show " +
    "the before and after for each without changing anything. Call this when a seller asks what " +
    "they should charge, or before any reprice. It returns a confirm_token that " +
    "gradethread_reprice_apply needs, and it states how many listings would actually change.",
  inputSchema: {
    type: "object",
    properties: {
      listing_ids: {
        type: "array",
        items: { type: "string" },
        description: `Listing ids to price, at most ${MAX_REPRICE_PER_CALL}.`,
      },
    },
    required: ["listing_ids"],
    additionalProperties: false,
  },
  requiredScope: "read",
  // Read-only in effect: it writes nothing. openWorldHint because it calls
  // eBay's Browse API for comparables, so the answer moves between calls.
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const ids = readIds(args.listing_ids);
    if (ids.length === 0) return fail("listing_ids is required.");
    if (ids.length > MAX_REPRICE_PER_CALL) {
      return fail(
        `A reprice may cover at most ${MAX_REPRICE_PER_CALL} listings per call; ` +
          `${ids.length} were given.`,
      );
    }

    const impl = repricerImpl();
    if (!impl) return fail("Repricing is not available on this server right now.");

    try {
      const result = await impl.preview(ctx.tenantId, ids);
      const appliable = result.items.filter((r) => !r.skip && r.delta_cents !== 0);

      const lines = result.items.map((r) => {
        const label = r.title || r.listing_id.slice(0, 8);
        if (r.skip === "no_comps") {
          return `SKIP · ${label} · not enough sold comparables to price it`;
        }
        if (r.skip === "below_margin_floor") {
          return `SKIP · ${label} · ${money(r.suggested_price_cents)} is below your cost floor of ` +
            `${money(r.margin_floor_cents ?? 0)}`;
        }
        if (r.delta_cents === 0) return `NO CHANGE · ${label} · ${money(r.current_price_cents)}`;
        const dir = r.delta_cents > 0 ? "up" : "down";
        return `${label} · ${money(r.current_price_cents)} → ${money(r.suggested_price_cents)} ` +
          `(${dir} ${pct(r.current_price_cents, r.suggested_price_cents).toFixed(0)}%, ` +
          `${r.comp_count} comps)`;
      });

      if (appliable.length === 0) {
        return {
          content: [{
            type: "text",
            text: [
              `Nothing to change across ${result.items.length} listing(s).`,
              ...lines,
            ].join("\n"),
          }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }

      const payloadItems = appliable.map((r) => ({
        listing_id: r.listing_id,
        price_cents: r.suggested_price_cents,
      }));
      const record = await issueConfirmToken({
        subject: ctx.apiKeyId,
        toolName: "gradethread_reprice_apply",
        payload: tokenPayload(payloadItems),
        targetIds: payloadItems.map((i) => i.listing_id),
      });

      return {
        content: [{
          type: "text",
          text: [
            // AC5: the COUNT is stated before the token is handed over. "Reprice
            // your listings" and "change the price on 34 listings" are different
            // things to say yes to.
            `${appliable.length} of ${result.items.length} listing(s) would change price.`,
            result.capped
              ? `The selection was trimmed to ${MAX_REPRICE_PER_CALL} listings.`
              : "",
            ...lines,
            "",
            "Show the seller this list and the count. If they agree, call " +
            `gradethread_reprice_apply with confirm_token "${record.token}". The token is ` +
            "single use, expires in 10 minutes, and covers exactly these prices.",
          ].filter(Boolean).join("\n"),
        }],
        structuredContent: {
          ...(result as unknown as Record<string, unknown>),
          would_change: appliable.length,
          confirm_token: record.token,
          expires_in_seconds: Math.round((record.expiresAtMs - Date.now()) / 1000),
        },
      };
    } catch (err) {
      console.error("[mcp] reprice preview:", redactError(err));
      return fail("Could not work out new prices right now.");
    }
  },
};

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

interface RequestedPrice {
  listing_id: string;
  price_cents: number;
}

function readItems(raw: unknown): RequestedPrice[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RequestedPrice[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { listing_id?: unknown; price_cents?: unknown };
    if (typeof e.listing_id !== "string" || !e.listing_id) continue;
    const cents = Number(e.price_cents);
    if (!Number.isFinite(cents) || cents <= 0) continue;
    if (out.some((x) => x.listing_id === e.listing_id)) continue;
    out.push({ listing_id: e.listing_id, price_cents: Math.round(cents) });
  }
  return out;
}

/**
 * AC4: the refusals a valid token does not buy past.
 *
 * Returns the refusal lines, or an empty array when every move is acceptable.
 * Checked against the CURRENT preview rather than against what the caller sent,
 * so a caller cannot declare its own "current price" to make a move look small.
 */
function unsafeMoves(
  requested: RequestedPrice[],
  current: Map<string, { current_price_cents: number; margin_floor_cents: number | null }>,
): string[] {
  const problems: string[] = [];
  for (const item of requested) {
    const now = current.get(item.listing_id);
    if (!now) {
      problems.push(`${item.listing_id.slice(0, 8)}: not one of your live listings`);
      continue;
    }
    const move = pct(now.current_price_cents, item.price_cents);
    if (move > MAX_PRICE_MOVE_PCT) {
      problems.push(
        `${item.listing_id.slice(0, 8)}: ${money(now.current_price_cents)} → ` +
          `${money(item.price_cents)} is a ${move.toFixed(0)}% move, over the ` +
          `${MAX_PRICE_MOVE_PCT}% limit the connector will make on its own`,
      );
    }
    if (now.margin_floor_cents != null && item.price_cents < now.margin_floor_cents) {
      problems.push(
        `${item.listing_id.slice(0, 8)}: ${money(item.price_cents)} is below the ` +
          `${money(now.margin_floor_cents)} cost floor for that item`,
      );
    }
  }
  return problems;
}

export const repriceApplyTool: McpToolDefinition = {
  name: "gradethread_reprice_apply",
  title: "Apply new prices to live listings",
  description:
    "Change the price on live listings, pushing each to its marketplace. Call this only after " +
    "gradethread_reprice_preview and only when the seller has agreed to the list and the count. " +
    "It needs the confirm_token from that preview. Large moves and prices below an item's cost " +
    "floor are refused even with a valid token, and it says which listing and why.",
  inputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: "The listings and their new prices, in cents.",
        items: {
          type: "object",
          properties: {
            listing_id: { type: "string" },
            price_cents: { type: "integer" },
          },
          required: ["listing_id", "price_cents"],
          additionalProperties: false,
        },
      },
      confirm_token: {
        type: "string",
        description: "The token from a preview call. Required, single use.",
      },
    },
    required: ["items", "confirm_token"],
    additionalProperties: false,
  },
  requiredScope: "submit",
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const requested = readItems(args.items);
    if (!requested || requested.length === 0) {
      return fail("items must be a non-empty array of { listing_id, price_cents }.");
    }
    if (requested.length > MAX_REPRICE_PER_CALL) {
      return fail(
        `At most ${MAX_REPRICE_PER_CALL} listings per call; ${requested.length} were given.`,
      );
    }
    const token = args.confirm_token;
    if (typeof token !== "string" || !token) {
      return fail(
        "This needs the confirm_token from gradethread_reprice_preview. Preview first and " +
          "show the seller what would change.",
      );
    }

    const impl = repricerImpl();
    if (!impl) return fail("Repricing is not available on this server right now.");

    try {
      const redeemed = await redeemConfirmToken({
        token,
        subject: ctx.apiKeyId,
        toolName: "gradethread_reprice_apply",
        payload: tokenPayload(requested),
      });
      if (!redeemed.ok) return fail(redeemed.failure.message);

      // Re-price against the CURRENT state to judge the moves. The token proved
      // the numbers have not changed since the seller saw them; this proves the
      // numbers are sane, which is a different question.
      const now = await impl.preview(ctx.tenantId, requested.map((r) => r.listing_id));
      const currentById = new Map(
        now.items.map((r) => [
          r.listing_id,
          {
            current_price_cents: r.current_price_cents,
            margin_floor_cents: r.margin_floor_cents,
          },
        ]),
      );

      const problems = unsafeMoves(requested, currentById);
      if (problems.length > 0) {
        return fail(
          [
            "Refused, and the confirmation does not change that:",
            ...problems,
            "",
            "Nothing was repriced. A seller who genuinely wants a move this big should make " +
              "it in FlipDesk, looking at the listing.",
          ].join("\n"),
        );
      }

      const result = await impl.apply(ctx.tenantId, requested);

      const lines = [
        ...result.skipped.map((s) => `SKIPPED · ${s.listing_id.slice(0, 8)} · ${s.reason}`),
        ...result.errors.map((e) => `FAILED · ${e.listing_id.slice(0, 8)} · ${e.message}`),
      ];

      const header = `Repriced ${result.applied} listing(s); ` +
        `${result.ebay_synced} pushed to eBay.`;
      const failedNote = result.errors.length > 0
        ? "The failed ones kept their old price on both sides, so nothing is out of step."
        : "";

      return {
        content: [{
          type: "text",
          text: [header, failedNote, ...lines].filter(Boolean).join("\n"),
        }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (err) {
      console.error("[mcp] reprice apply:", redactError(err));
      return fail(
        "Something went wrong while repricing. Some listings may have changed — check " +
          "gradethread_list_listings before trying again.",
      );
    }
  },
};

// ---------------------------------------------------------------------------
// suggestions
// ---------------------------------------------------------------------------

export const priceSuggestionsTool: McpToolDefinition = {
  name: "gradethread_price_suggestions",
  title: "Price suggestions waiting for a decision",
  description:
    "List the pending price suggestions the repricing scan has produced: the listing, what it " +
    "costs now, what the comparables say, and why. Call this when a seller asks what needs " +
    "attention or whether anything is mispriced. It changes nothing.",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        description: `How many to return, at most ${SUGGESTIONS_MAX}. Defaults to 25.`,
      },
    },
    additionalProperties: false,
  },
  requiredScope: "read",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    try {
      const rows = await listPriceSuggestions(
        ctx.tenantId,
        typeof args.limit === "number" ? args.limit : 25,
      );
      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: "No price suggestions are waiting." }],
          structuredContent: { suggestions: [] },
        };
      }

      const lines = rows.map((r) => {
        const dir = r.delta_cents > 0 ? "up" : "down";
        return `${r.title ?? r.listing_id.slice(0, 8)} · ${money(r.current_price_cents)} → ` +
          `${money(r.suggested_price_cents)} (${dir} ` +
          `${pct(r.current_price_cents, r.suggested_price_cents).toFixed(0)}%) · ` +
          `${r.comp_count} comps · ${r.message ?? r.reason_code ?? ""}`;
      });

      return {
        content: [{
          type: "text",
          text: [`${rows.length} price suggestion(s) waiting.`, ...lines].join("\n"),
        }],
        structuredContent: { suggestions: rows as unknown as Record<string, unknown>[] },
      };
    } catch (err) {
      console.error("[mcp] price suggestions:", redactError(err));
      return fail("Could not load the price suggestions right now.");
    }
  },
};

async function suggestionVerb(
  ctx: McpToolContext,
  suggestionId: unknown,
  verb: "apply" | "dismiss",
): Promise<McpToolResult> {
  if (typeof suggestionId !== "string" || !suggestionId) {
    return fail("suggestion_id is required.");
  }
  const impl = repricerImpl();
  if (!impl) return fail("Repricing is not available on this server right now.");

  try {
    const outcome = verb === "apply"
      ? await impl.applySuggestion(ctx.tenantId, suggestionId)
      : await impl.dismissSuggestion(ctx.tenantId, suggestionId);

    if (outcome.status >= 400) {
      const body = outcome.body as { error?: unknown; ebay_error?: unknown };
      return fail(
        [
          typeof body.error === "string" ? body.error : `Could not ${verb} that suggestion.`,
          typeof body.ebay_error === "string" ? `eBay said: ${body.ebay_error}` : null,
        ].filter(Boolean).join("\n"),
      );
    }

    // US-467 again: a failed eBay push leaves the suggestion PENDING and the
    // price unchanged. Reporting the flag rather than assuming, because
    // "applied" with ebay_synced false on a live listing would be a lie.
    const body = outcome.body as { new_price?: unknown; ebay_synced?: unknown };
    const text = verb === "apply"
      ? `Applied. New price $${Number(body.new_price ?? 0).toFixed(2)}` +
        (body.ebay_synced === true ? ", pushed to eBay." : ". No live eBay offer to push to.")
      : "Dismissed. It will not come back in the suggestions list.";

    return {
      content: [{ type: "text", text }],
      structuredContent: outcome.body,
    };
  } catch (err) {
    console.error(`[mcp] suggestion ${verb}:`, redactError(err));
    return fail(`Could not ${verb} that suggestion right now.`);
  }
}

export const applySuggestionTool: McpToolDefinition = {
  name: "gradethread_apply_price_suggestion",
  title: "Take one price suggestion",
  description:
    "Apply one pending price suggestion, pushing the new price to eBay where the listing is " +
    "live. Call this when a seller agrees to a specific suggestion from " +
    "gradethread_price_suggestions. Show them the before and after first.",
  inputSchema: {
    type: "object",
    properties: {
      suggestion_id: { type: "string", description: "The suggestion to apply." },
    },
    required: ["suggestion_id"],
    additionalProperties: false,
  },
  requiredScope: "submit",
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  handler: (args, ctx) => suggestionVerb(ctx, args.suggestion_id, "apply"),
};

export const dismissSuggestionTool: McpToolDefinition = {
  name: "gradethread_dismiss_price_suggestion",
  title: "Dismiss one price suggestion",
  description:
    "Dismiss one pending price suggestion so it stops appearing. Call this when a seller says " +
    "they are happy with the current price. It changes no price and touches no marketplace.",
  inputSchema: {
    type: "object",
    properties: {
      suggestion_id: { type: "string", description: "The suggestion to dismiss." },
    },
    required: ["suggestion_id"],
    additionalProperties: false,
  },
  requiredScope: "submit",
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  handler: (args, ctx) => suggestionVerb(ctx, args.suggestion_id, "dismiss"),
};
