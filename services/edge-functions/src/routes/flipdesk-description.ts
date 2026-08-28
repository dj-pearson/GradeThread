// US-2958: the description-block endpoints.
//
//   GET  /api/flipdesk/description/:listingId/blocks
//     -> the listing's blocks. When description_blocks is NULL the legacy
//        string is parsed and returned WITHOUT being written, so opening a live
//        listing cannot change what a buyer sees.
//   POST /api/flipdesk/description/preview
//     -> render an unsaved block array against a listing's context. Read-only.
//   POST /api/flipdesk/description/:listingId/save
//     -> persist blocks and the string they render to, in one update.
//   POST /api/flipdesk/description/:listingId/regenerate
//     -> rewrite ONE ai block. The rest of the array comes back byte-identical.
//   POST /api/flipdesk/description/snippets/:snippetId/apply
//     -> re-render the DRAFT listings that reference an edited snippet.
//
// Tenant safety (CLAUDE.md US-268): every handler resolves
// `workspaceOwnerId ?? userId` and reaches the listing only through
// `loadOwnedListing`, whose join filters on that owner. A foreign listing id
// returns 404 with no body — the same answer as an id that does not exist, so
// the response cannot be used to probe for another tenant's rows.
//
// This service answers on functions.gradethread.com. Kong on api.* has only
// Supabase routes, so /api/flipdesk/* there is a 404 by design.

import { Hono } from "hono";
import {
  type DescriptionBlock,
  type DescriptionBlockKey,
  renderDescription,
  replaceBlockText,
  scrubRestatedFacts,
} from "../lib/description-blocks.ts";
import {
  applySnippetToDrafts,
  blocksForListing,
  buildRenderContext,
  loadOwnedListing,
  renderAndPersistDescription,
} from "../lib/description-render.ts";
import { regenerateDescriptionBlock } from "../lib/description-regenerate.ts";
import type { LengthUnit } from "../lib/measurements.ts";

export const flipdeskDescriptionRoutes = new Hono<{
  Variables: {
    userId: string;
    workspaceOwnerId?: string;
    workspaceRole?: "viewer" | "editor" | "admin" | "owner";
  };
}>();

/** The block keys a client is allowed to send. Anything else is rejected. */
const BLOCK_KEYS = new Set<DescriptionBlockKey>([
  "intro",
  "features",
  "condition",
  "attributes",
  "measurements",
  "grade",
  "disclosure",
  "credentials",
  "facts",
  "snippet",
  "text",
]);

/** The AI blocks, the only ones /regenerate will touch. */
const AI_KEYS = new Set<DescriptionBlockKey>(["intro", "features", "condition"]);

/**
 * Validate a client-supplied block array.
 *
 * Returns null when the payload is not a block array. Unknown keys are a hard
 * reject rather than a silent drop: a client sending a key this build does not
 * know about is a version skew, and quietly discarding the block would delete a
 * section of the seller's description without telling anyone.
 */
export function parseBlocks(input: unknown): DescriptionBlock[] | null {
  if (!Array.isArray(input)) return null;
  const out: DescriptionBlock[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return null;
    const b = raw as Record<string, unknown>;
    const key = b.key as DescriptionBlockKey;
    if (!BLOCK_KEYS.has(key)) return null;
    const block: DescriptionBlock = {
      key,
      on: b.on !== false,
      src: (typeof b.src === "string" ? b.src : "user") as DescriptionBlock["src"],
    };
    if (typeof b.text === "string") block.text = b.text;
    if (Array.isArray(b.fields)) {
      block.fields = b.fields.filter((f): f is string => typeof f === "string");
    }
    if (b.unit === "in" || b.unit === "cm") block.unit = b.unit;
    if (typeof b.ref === "string") block.ref = b.ref;
    if (typeof b.sep === "string") block.sep = b.sep;
    out.push(block);
  }
  return out;
}

function unitFrom(value: unknown): LengthUnit {
  return value === "cm" ? "cm" : "in";
}

// ─── GET /:listingId/blocks ────────────────────────────────────────

flipdeskDescriptionRoutes.get("/:listingId/blocks", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("listingId");

  const listing = await loadOwnedListing(listingId, ownerId);
  if (!listing) return c.json({ error: "Listing not found" }, 404);

  const unit = unitFrom(c.req.query("unit"));
  const ctx = await buildRenderContext(listing, ownerId, unit);
  const blocks = blocksForListing(listing, ctx);

  // No write. A conversion is shown, not stored — the seller's first save is
  // what persists it (US-2957 reconciliation guarantees the preview below
  // equals the stored description byte for byte until they change something).
  return c.json({
    blocks,
    preview: renderDescription(blocks, ctx),
    converted: listing.description_blocks === null,
  });
});

// ─── POST /preview ─────────────────────────────────────────────────

flipdeskDescriptionRoutes.post("/preview", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { listing_id?: unknown; blocks?: unknown; unit?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // A listing id is REQUIRED, and there is no item-payload alternative. The
  // derived blocks read the item, the grade and the seller profile, so a
  // free-floating payload would either render nothing or render whatever the
  // caller claimed to own — and the second is a tenant leak wearing a
  // convenience API's clothes.
  const listingId = typeof body.listing_id === "string" ? body.listing_id : "";
  if (!listingId) {
    return c.json({ error: "listing_id is required" }, 400);
  }
  const blocks = parseBlocks(body.blocks);
  if (!blocks) return c.json({ error: "blocks must be an array of description blocks" }, 400);

  const listing = await loadOwnedListing(listingId, ownerId);
  if (!listing) return c.json({ error: "Listing not found" }, 404);

  const ctx = await buildRenderContext(listing, ownerId, unitFrom(body.unit));
  return c.json({ preview: renderDescription(blocks, ctx) });
});

// ─── POST /:listingId/save ─────────────────────────────────────────

flipdeskDescriptionRoutes.post("/:listingId/save", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("listingId");

  let body: { blocks?: unknown; unit?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const blocks = parseBlocks(body.blocks);
  if (!blocks) return c.json({ error: "blocks must be an array of description blocks" }, 400);

  const result = await renderAndPersistDescription(
    listingId,
    ownerId,
    blocks,
    unitFrom(body.unit),
  );
  if (!result) return c.json({ error: "Listing not found" }, 404);

  return c.json({ blocks: result.blocks, description: result.description });
});

// ─── POST /:listingId/regenerate ───────────────────────────────────

flipdeskDescriptionRoutes.post("/:listingId/regenerate", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("listingId");

  let body: { block?: unknown; unit?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const key = body.block as DescriptionBlockKey;
  if (!AI_KEYS.has(key)) {
    return c.json(
      { error: "block must be one of intro, features, condition" },
      400,
    );
  }

  const listing = await loadOwnedListing(listingId, ownerId);
  if (!listing) return c.json({ error: "Listing not found" }, 404);

  const unit = unitFrom(body.unit);
  const ctx = await buildRenderContext(listing, ownerId, unit);
  const current = blocksForListing(listing, ctx);

  const text = await regenerateDescriptionBlock(key, listing, ctx);
  if (text === null) {
    return c.json({ error: "Could not rewrite that section." }, 502);
  }

  // Replace exactly one block. Every other entry is carried through by
  // reference, which is what makes "redo one sentence" not a full rewrite —
  // and what the story's byte-identical acceptance criterion asks for.
  const next = replaceBlockText(current, key, scrubRestatedFacts(text, ctx));

  const result = await renderAndPersistDescription(listingId, ownerId, next, unit);
  if (!result) return c.json({ error: "Listing not found" }, 404);

  return c.json({ blocks: result.blocks, description: result.description });
});

// ─── POST /snippets/:snippetId/apply ───────────────────────────────

// US-2961. Editing a standing line on the settings page changes what every
// listing referencing it RENDERS, but rendering only happens on a save — so a
// draft the seller is not about to open keeps the old bytes in
// `listing_description`, which is the column publish, search and the buyer
// preview all read. This is the button that closes that gap.
//
// It touches drafts and nothing else. A published listing is live copy on eBay,
// and rewriting it from a settings dialog would be an outward-facing change the
// seller never asked for; `applySnippetToDrafts` filters on listing_status in
// the query rather than trusting anything in this request.
flipdeskDescriptionRoutes.post("/snippets/:snippetId/apply", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const snippetId = c.req.param("snippetId");

  const result = await applySnippetToDrafts(snippetId, ownerId);
  // Null is "not your snippet" AND "no such snippet", deliberately the same
  // answer: telling them apart would confirm another tenant's row exists.
  if (!result) return c.json({ error: "Snippet not found" }, 404);

  return c.json(result);
});
