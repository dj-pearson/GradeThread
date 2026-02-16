import { Hono } from "hono";

export const webhookRoutes = new Hono();

// Stripe webhook handler
webhookRoutes.post("/stripe", async (c) => {
  // TODO: Implement Stripe webhook handling
  // 1. Verify webhook signature
  // 2. Handle checkout.session.completed
  // 3. Handle customer.subscription.updated
  // 4. Handle customer.subscription.deleted
  // 5. Handle invoice.payment_failed
  const body = await c.req.text();
  console.log("Stripe webhook received:", body.substring(0, 100));

  return c.json({ received: true });
});
