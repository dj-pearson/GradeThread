// US-3367: POST /api/flipdesk/sales/record.
//
// The browser sends the facts of a sale; the server writes them and ends
// every other listing of the garment through the same sibling planner an
// eBay, Shopify, Depop or Etsy order uses. The body lives in
// lib/record-sale.ts so it has one owner and one test.

import { Hono } from "hono";
import { parseRecordSaleBody, recordSale } from "../lib/record-sale.ts";

export const flipdeskSalesRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

flipdeskSalesRoutes.post("/record", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const parsed = parseRecordSaleBody(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const out = await recordSale(ownerId, parsed.input);
  return c.json(out.body, out.status as 200);
});
