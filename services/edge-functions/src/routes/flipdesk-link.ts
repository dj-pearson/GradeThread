// US-3197 AC1/AC4: Universal Import's linking half, over HTTP.
//
// Mounted at /api/flipdesk/import/link, which already carries authMiddleware,
// workspaceMiddleware and a rate limiter from the /api/flipdesk/import/*
// prefix in main.ts. Mounting under an existing guarded prefix rather than
// adding a fourth `app.use` is deliberate: a new prefix is a new place for a
// middleware to be forgotten, and this one acts on ids the caller supplies.

import { Hono } from "hono";
import {
  listReviews,
  resolveReview,
  type ReviewStatus,
  scanForLinks,
} from "../lib/cross-channel-link-service.ts";

export const flipdeskLinkRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

const STATUSES: ReviewStatus[] = ["pending", "linked", "split"];

// POST /scan — find the joins, make the confident ones, queue the rest.
flipdeskLinkRoutes.post("/scan", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    return c.json(await scanForLinks(ownerId));
  } catch (err) {
    console.error("[flipdesk.link.scan]", err instanceof Error ? err.message : err);
    return c.json({ error: "Could not look for matching listings." }, 500);
  }
});

// GET /reviews — the seller's open questions, best match first.
flipdeskLinkRoutes.get("/reviews", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const raw = c.req.query("status") ?? "pending";
  const status = STATUSES.includes(raw as ReviewStatus) ? raw as ReviewStatus : "pending";
  try {
    return c.json({ reviews: await listReviews(ownerId, status) });
  } catch (err) {
    console.error("[flipdesk.link.reviews]", err instanceof Error ? err.message : err);
    return c.json({ error: "Could not load the matches waiting for you." }, 500);
  }
});

// POST /reviews/:id/confirm — join the pair.
// POST /reviews/:id/split   — refuse it, and UNDO it if it was already joined.
for (const decision of ["confirm", "split"] as const) {
  flipdeskLinkRoutes.post(`/reviews/:id/${decision}`, async (c) => {
    const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
    const out = await resolveReview(ownerId, c.req.param("id"), decision);
    if (!out.ok) return c.json({ error: out.error }, out.status as 404);
    return c.json({ ok: true, status: out.status });
  });
}
