import { Hono } from "hono";

// Payout reconciliation: matches payout_imports rows to sales rows by listing ID
// and timestamp window. Never silently mis-matches — unmatched rows stay queued.

export const flipdeskReconciliationRoutes = new Hono();

// Run the matcher across all unreconciled payout_imports for the authed user.
flipdeskReconciliationRoutes.post("/run", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});

// List the current review queue (unreconciled payout rows).
flipdeskReconciliationRoutes.get("/queue", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});

// Manually apply a payout row to a specific sale.
// Body: { payout_import_id: string; sale_id: string }
flipdeskReconciliationRoutes.post("/match", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});

// Dismiss a payout row that doesn't correspond to a tracked sale.
flipdeskReconciliationRoutes.post("/dismiss/:id", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});
