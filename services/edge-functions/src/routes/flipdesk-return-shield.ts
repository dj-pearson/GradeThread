import { Hono } from "hono";
import { returnShieldAnswer } from "../lib/return-shield.ts";

// US-3068: the evidence pack, read from an eBay Seller Hub return page.
//
// ── WHY THIS IS ITS OWN MOUNT ────────────────────────────────────────────────
//
// The extension holds an EXTENSION token, not a user JWT. `/api/flipdesk/ebay/*`
// is mounted with ebayAuthMiddleware, which falls through to authMiddleware for
// every path that is not self-authenticating — so an extension token is refused
// there, and the story's AC2 assumption that the route is reachable through
// extensionOrUserAuthMiddleware does not hold on that mount.
//
// This router gets that middleware in main.ts, the same way the extension queue
// does. One route, one verb, one body field.
//
// ── IT READS AND IT DOES NOT SEND ────────────────────────────────────────────
//
// Nothing here touches eBay. Sending the pack stays on the FlipDesk post-sale
// surface (US-2706) where the eBay API does it behind a separate click. This
// answers "what would the pack say", which is what a seller standing on the
// return page actually needs before they decide anything.

export const flipdeskReturnShieldRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

// POST /preview — body { return_id }
//
// POST rather than GET because a return id in a URL ends up in access logs and
// proxy caches, and it names a real dispute on a real account.
flipdeskReturnShieldRoutes.post("/preview", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  const body = await c.req.json().catch(() => null);
  const returnId = typeof (body as { return_id?: unknown } | null)?.return_id === "string"
    ? String((body as { return_id: string }).return_id).trim()
    : "";
  if (!returnId) return c.json({ error: "return_id is required." }, 400);

  try {
    // ONE ANSWER SHAPE FOR EVERY OUTCOME. A return this workspace does not own,
    // an id we have never synced, an item that was never graded and a genuine
    // refusal all come back 200 with a verdict the overlay knows how to render.
    // A 404 here would tell a caller whether an id exists, and the id came off
    // a page anyone can open.
    return c.json(await returnShieldAnswer(ownerId, returnId), 200);
  } catch (err) {
    console.error(
      "flipdesk.return-shield.preview:",
      err instanceof Error ? err.message : String(err),
    );
    // The overlay renders nothing on no-report, so a failure degrades to
    // silence rather than to an error a seller can do nothing about.
    return c.json({ verdict: "no-report" }, 200);
  }
});
