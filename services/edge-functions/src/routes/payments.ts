import { Hono } from "hono";
import Stripe from "stripe";
import { supabaseAdmin } from "../lib/supabase.ts";

type PaymentsEnv = {
  Variables: {
    userId: string;
  };
};

const TIER_PRICES: Record<string, number> = {
  standard: 299, // $2.99 in cents
  premium: 799, // $7.99 in cents
  express: 1299, // $12.99 in cents
};

const TIER_NAMES: Record<string, string> = {
  standard: "Standard Grade",
  premium: "Premium Grade",
  express: "Express Grade",
};

export const paymentRoutes = new Hono<PaymentsEnv>();

// Create Stripe Checkout Session for a grade payment
paymentRoutes.post("/checkout-session", async (c) => {
  const userId = c.get("userId");

  let body: { submissionId?: string; tier?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { submissionId, tier } = body;

  // Validate required fields
  if (!submissionId || typeof submissionId !== "string") {
    return c.json({ error: "submissionId is required" }, 400);
  }

  if (!tier || !TIER_PRICES[tier]) {
    return c.json({
      error: `tier must be one of: ${Object.keys(TIER_PRICES).join(", ")}`,
    }, 400);
  }

  // Validate user owns the submission
  const { data: submission, error: submissionError } = await supabaseAdmin
    .from("submissions")
    .select("id, user_id")
    .eq("id", submissionId)
    .eq("user_id", userId)
    .single();

  if (submissionError || !submission) {
    return c.json({ error: "Submission not found or access denied" }, 404);
  }

  // Create Stripe Checkout Session
  const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeSecretKey) {
    console.error("STRIPE_SECRET_KEY not configured");
    return c.json({ error: "Payment service unavailable" }, 503);
  }

  const stripe = new Stripe(stripeSecretKey, {
    apiVersion: "2024-04-10",
  });

  const siteUrl = Deno.env.get("SITE_URL") || "https://gradethread.com";

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: TIER_PRICES[tier],
            product_data: {
              name: TIER_NAMES[tier],
              description: `GradeThread ${TIER_NAMES[tier]} for submission`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        submission_id: submissionId,
        user_id: userId,
        tier,
      },
      success_url: `${siteUrl}/dashboard/submissions/${submissionId}?payment=success`,
      cancel_url: `${siteUrl}/dashboard/submissions?payment=cancelled`,
    });

    return c.json({
      sessionId: session.id,
      url: session.url,
    });
  } catch (err) {
    console.error("Stripe checkout session creation failed:", err);
    return c.json({ error: "Failed to create checkout session" }, 500);
  }
});
