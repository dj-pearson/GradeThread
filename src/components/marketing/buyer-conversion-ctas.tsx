import { Link } from "react-router";
import { Bell, Bookmark, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import {
  buyerSignupHref,
  stashBuyerClaim,
  type BuyerConversionIntent,
  type BuyerConversionResult,
  type BuyerConversionTool,
} from "@/lib/buyer-conversion-claim";

// US-1843: the buyer-side conversion moments on the free public value tools.
//
// The existing CTAs on these pages both sell the SELLER product ("get a real
// grade", "get a certified grade"), which is only half the audience: someone
// asking what an item is worth is as often about to buy one. These three route
// into buyer signup (US-1797, `intent=buyer`) and carry the anonymous result
// with them, so the new account opens on the item rather than on nothing.
//
// Nothing here talks to the network. The result is parked in localStorage and
// the visitor is sent to /signup, so the free tools' abuse controls are exactly
// as they were — this adds no anonymous endpoint to abuse.

const MOMENTS: Array<{
  intent: BuyerConversionIntent;
  label: string;
  icon: typeof Bell;
  hint: string;
}> = [
  {
    intent: "save",
    label: "Save this result",
    icon: Bookmark,
    hint: "Keep the estimate in your closet so you can check it against what you're asked to pay.",
  },
  {
    intent: "alert",
    label: "Alert me when one appears",
    icon: Bell,
    hint: "We watch for this item at this condition or better, at or under this price.",
  },
  {
    intent: "verify",
    label: "Verify future purchases",
    icon: ShieldCheck,
    hint: "Check a seller's claimed condition against an objective grade before you pay.",
  },
];

export function BuyerConversionCtas({
  tool,
  result,
  className,
}: {
  tool: BuyerConversionTool;
  /** The anonymous result to hand off. Partial — each tool knows different fields. */
  result: Partial<BuyerConversionResult>;
  className?: string;
}) {
  function onPick(intent: BuyerConversionIntent) {
    const claim = stashBuyerClaim({ intent, tool, result });
    // The funnel event. `ref` is the earned link that brought them here (US-603),
    // so an affiliate conversion is attributable from the anonymous result all
    // the way through to the claim on the other side of signup.
    track("buyer_funnel_cta", {
      tool,
      intent,
      has_value: claim.result.medianCents != null,
      ref: claim.ref ?? undefined,
    });
  }

  return (
    <div className={cn("rounded-xl border bg-card p-5", className)}>
      <h3 className="text-base font-semibold">Buying, not selling?</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        A free buyer account keeps this estimate and puts it to work — so you know
        what a fair price looks like before you pay it.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {MOMENTS.map((m) => {
          const Icon = m.icon;
          return (
            <Link
              key={m.intent}
              to={buyerSignupHref({ intent: m.intent, tool })}
              onClick={() => onPick(m.intent)}
              title={m.hint}
            >
              <Button size="sm" variant={m.intent === "alert" ? "default" : "outline"}>
                <Icon className="mr-1.5 h-4 w-4" />
                {m.label}
              </Button>
            </Link>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Free to start — your estimate carries over to your new account.
      </p>
    </div>
  );
}
