// US-1840: buyer authenticity add-on — spend included/purchased credits on a
// brand-authenticity check. Reuses the EXISTING scoring pass (US-1769,
// assessAuthenticity) and returns only the buyer-safe projection + the mandatory
// limitations disclaimer (never definitive). Gated by the authenticityAddon
// entitlement; metered on the authenticity_credits meter through the SAME credit
// precedence as every other buyer feature (included allowance → reward credits →
// upgrade, US-1800/1813) — no separate payment plumbing.

import { Hono } from "hono";
import { getBuyerEntitlements } from "../lib/buyer-entitlements.ts";
import { BuyerQuotaExhaustedError, withBuyerMeter } from "../lib/buyer-metering.ts";
import { parseAuthenticityCheckBody } from "./public-grading.ts";
import { assessAuthenticity } from "../lib/ai-authenticity.ts";
import { getEffectiveTellsForBrand } from "../lib/brand-authenticity.ts";
import { recordAiUsage } from "../lib/ai-usage.ts";
import { AiCeilingError, reserveGlobalDailyBudget } from "../lib/ai-limiter.ts";

type BuyerEnv = { Variables: { userId: string } };
export const buyerAuthenticityRoutes = new Hono<BuyerEnv>();

buyerAuthenticityRoutes.post("/authenticity", async (c) => {
  const userId = c.get("userId");

  const ent = await getBuyerEntitlements(userId);
  if (!ent.gateFlags.authenticityAddon) {
    return c.json({ error: "Authenticity checks aren't included on your plan.", code: "not_entitled" }, 403);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const parsed = parseAuthenticityCheckBody(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  try {
    // Reserve one authenticity credit up front (included allowance → reward-credit
    // fallback → upgrade); refunded automatically if the scoring throws.
    const projection = await withBuyerMeter(
      userId,
      "authenticity_credits",
      ent.allowances.authenticityCreditsPerMonth,
      async () => {
        // Global Vision-cost ceiling (shared with grading) before the call.
        await reserveGlobalDailyBudget();

        const tells = await getEffectiveTellsForBrand(parsed.brand).catch(() => []);
        const assessment = await assessAuthenticity(
          parsed.dataUris.map((dataUri) => ({ imageType: "detail" as const, dataUri })),
          {
            garment_type: "other",
            garment_category: "other",
            brand: parsed.brand ?? null,
            title: parsed.title ?? "",
            description: null,
            style_attributes: [],
          },
          { tells },
        );

        if (assessment.usage) {
          void recordAiUsage({
            userId,
            submissionId: null,
            feature: "authenticity",
            usages: [{ phase: "authenticity_buyer", usage: assessment.usage }],
          });
        }

        // Buyer-safe projection ONLY — raw red_flags / tell_findings stay server-side.
        return {
          estimate: true,
          verdict: assessment.verdict,
          verdictConfidence: assessment.verdict_confidence,
          counterfeitRisk: assessment.counterfeit_risk,
          brandAssessed: assessment.brand_assessed,
          summary: assessment.summary,
          limitations: assessment.limitations,
        };
      },
    );
    return c.json(projection, 200);
  } catch (err) {
    if (err instanceof BuyerQuotaExhaustedError) {
      return c.json(
        { error: "You've used this month's authenticity checks. Upgrade or buy credits to run more.", code: "quota_exhausted" },
        402,
      );
    }
    if (err instanceof AiCeilingError) {
      return c.json({ error: "The authenticity checker is busy right now. Try again later." }, 429);
    }
    console.error("[buyer-authenticity] check failed:", err instanceof Error ? err.message : String(err));
    return c.json(
      { error: "Couldn't check that item. Try clear, well-lit photos of the tags, logo, and stitching." },
      500,
    );
  }
});
