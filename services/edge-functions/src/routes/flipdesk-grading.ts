import { Hono } from "hono";

// FlipDesk → GradeThread bridge.
// Submits inventory items to GradeThread for grading and receives webhook callbacks.
// Until the GradeThread Public API ships (Phase 2 of GradeThread roadmap), this
// can take a direct DB shortcut since both products share a Supabase instance.

export const flipdeskGradingRoutes = new Hono();

// Submit one or many inventory items for grading.
// Body: { items: Array<{ inventory_item_id: string; tier: "standard" | "premium" | "express" }> }
flipdeskGradingRoutes.post("/submit", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});

// Inbound webhook from GradeThread when a grade completes.
// Public endpoint — must verify HMAC signature.
flipdeskGradingRoutes.post("/webhook", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});

// Status lookup — used as polling fallback if webhook is missed.
flipdeskGradingRoutes.get("/submissions/:id", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});
