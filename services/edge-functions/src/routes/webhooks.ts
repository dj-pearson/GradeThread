import { Hono } from "hono";
import Stripe from "stripe";
import { supabaseAdmin } from "../lib/supabase.ts";
import { processSubmission } from "../lib/grading-pipeline.ts";

export const webhookRoutes = new Hono();

// Stripe webhook handler
webhookRoutes.post("/stripe", async (c) => {
  const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  if (!stripeSecretKey || !webhookSecret) {
    console.error("[Webhook] STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET not configured");
    return c.json({ error: "Webhook not configured" }, 503);
  }

  const stripe = new Stripe(stripeSecretKey, {
    apiVersion: "2024-04-10",
  });

  // Get raw body and signature header for verification
  const body = await c.req.text();
  const signature = c.req.header("stripe-signature");

  if (!signature) {
    console.error("[Webhook] Missing stripe-signature header");
    return c.json({ error: "Missing stripe-signature header" }, 400);
  }

  // Verify webhook signature
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Webhook] Signature verification failed: ${message}`);
    return c.json({ error: "Webhook signature verification failed" }, 400);
  }

  console.log(`[Webhook] Received event: ${event.type} (${event.id})`);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        await handleSubscriptionChange(event.data.object as Stripe.Subscription);
        break;
      }

      case "customer.subscription.deleted": {
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      }

      case "invoice.payment_failed": {
        await handlePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      }

      default: {
        console.log(`[Webhook] Unhandled event type: ${event.type}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Webhook] Error handling event ${event.type}: ${message}`);
    // Still return 200 to prevent Stripe from retrying — we logged the error
  }

  return c.json({ received: true });
});

/**
 * Handle checkout.session.completed:
 * - Marks submission as paid
 * - Triggers the grading pipeline
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const submissionId = session.metadata?.submission_id;
  const userId = session.metadata?.user_id;
  const tier = session.metadata?.tier;

  console.log(
    `[Webhook] checkout.session.completed | submission=${submissionId} user=${userId} tier=${tier}`
  );

  if (!submissionId || !userId) {
    console.error("[Webhook] checkout.session.completed missing metadata (submission_id or user_id)");
    return;
  }

  // Update submission payment_status to 'paid'
  const { error: updateError } = await supabaseAdmin
    .from("submissions")
    .update({ payment_status: "paid" })
    .eq("id", submissionId)
    .eq("user_id", userId);

  if (updateError) {
    console.error(`[Webhook] Failed to update payment status for submission ${submissionId}:`, updateError);
    return;
  }

  console.log(`[Webhook] Submission ${submissionId} marked as paid, triggering grading pipeline`);

  // Trigger grading pipeline (fire-and-forget)
  processSubmission(submissionId).catch((error) => {
    console.error(
      `[Webhook] Grading pipeline error for submission ${submissionId}:`,
      error instanceof Error ? error.message : String(error)
    );
  });
}

/**
 * Handle customer.subscription.created / customer.subscription.updated:
 * - Updates the user's plan based on the subscription's price
 * - Stores the stripe_customer_id on the user record
 */
async function handleSubscriptionChange(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string;

  console.log(
    `[Webhook] subscription change | customer=${customerId} status=${subscription.status}`
  );

  // Map Stripe price/product to our plan tiers
  const plan = mapSubscriptionToPlan(subscription);

  // Find the user by stripe_customer_id, or by metadata if available
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .single();

  if (userError || !user) {
    console.error(`[Webhook] No user found for stripe_customer_id=${customerId}`);
    return;
  }

  // Update user plan and ensure stripe_customer_id is stored
  const { error: updateError } = await supabaseAdmin
    .from("users")
    .update({
      plan,
      stripe_customer_id: customerId,
    })
    .eq("id", user.id);

  if (updateError) {
    console.error(`[Webhook] Failed to update plan for user ${user.id}:`, updateError);
    return;
  }

  console.log(`[Webhook] User ${user.id} plan updated to '${plan}'`);
}

/**
 * Handle customer.subscription.deleted:
 * - Downgrades user to 'free' plan
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string;

  console.log(`[Webhook] subscription deleted | customer=${customerId}`);

  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .single();

  if (userError || !user) {
    console.error(`[Webhook] No user found for stripe_customer_id=${customerId}`);
    return;
  }

  const { error: updateError } = await supabaseAdmin
    .from("users")
    .update({ plan: "free" })
    .eq("id", user.id);

  if (updateError) {
    console.error(`[Webhook] Failed to downgrade user ${user.id} to free:`, updateError);
    return;
  }

  console.log(`[Webhook] User ${user.id} downgraded to 'free' plan`);
}

/**
 * Handle invoice.payment_failed:
 * - Logs the event for debugging
 * - Future: send notification to user
 */
async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const customerId = invoice.customer as string;
  const amountDue = invoice.amount_due;
  const attemptCount = invoice.attempt_count;

  console.log(
    `[Webhook] invoice.payment_failed | customer=${customerId} amount=${amountDue} attempt=${attemptCount}`
  );

  // Find user for logging context
  const { data: user } = await supabaseAdmin
    .from("users")
    .select("id, email")
    .eq("stripe_customer_id", customerId)
    .single();

  if (user) {
    console.log(
      `[Webhook] Payment failed for user ${user.id} (${user.email}) | ` +
        `amount_due=${amountDue} attempt=${attemptCount}`
    );
    // TODO: Send notification email to user about payment failure
  } else {
    console.error(`[Webhook] Payment failed but no user found for customer=${customerId}`);
  }
}

/**
 * Maps a Stripe subscription to a GradeThread plan name.
 * Uses the subscription's metadata or price lookup name.
 */
function mapSubscriptionToPlan(subscription: Stripe.Subscription): string {
  // Check subscription metadata first
  const metadataPlan = subscription.metadata?.plan;
  if (metadataPlan && ["free", "starter", "professional", "enterprise"].includes(metadataPlan)) {
    return metadataPlan;
  }

  // Try to infer from the first subscription item's price
  const item = subscription.items?.data?.[0];
  if (item) {
    const lookupKey = item.price?.lookup_key;
    if (lookupKey) {
      if (lookupKey.includes("enterprise")) return "enterprise";
      if (lookupKey.includes("professional")) return "professional";
      if (lookupKey.includes("starter")) return "starter";
    }

    // Fall back to price amount mapping
    const amount = item.price?.unit_amount;
    if (amount) {
      // $29/mo = starter, $99/mo = professional, anything higher = enterprise
      if (amount >= 9900) return "enterprise";
      if (amount >= 2900) return "professional";
      return "starter";
    }
  }

  // Default to starter if we can't determine
  console.warn("[Webhook] Could not determine plan from subscription, defaulting to 'starter'");
  return "starter";
}
