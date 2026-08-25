import type { LucideIcon } from "lucide-react";
import { Smartphone } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

// US-2878. The first phone-only treatment in this product.
//
// There was no existing pattern to match. The nearest thing, billing's "managed
// in the iOS app" card (US-807), is about where a subscription is administered
// rather than about a feature that only exists on a phone. So this is the
// pattern now; the next phone-only surface should use it rather than inventing
// a second one.
//
// THE ONE RULE: this is not a gate. A seller reading it should think "I should
// get the app", not "I should upgrade". So: no lock icon, no Upgrade button, no
// muted-and-disabled treatment, and nothing that reads as withheld. The feature
// is not being kept from them -- it is somewhere a laptop cannot go.
//
// Decision and reasoning: vault/60-decisions/adr-prospect-stays-phone-only.md

export function PhoneOnlyRow({
  icon: Icon,
  label,
  description,
  why,
}: {
  icon: LucideIcon;
  /** The surface's name, spelled exactly as the app spells it. */
  label: string;
  /** One sentence: what it does. */
  description: string;
  /**
   * One sentence: why it is only on the phone.
   *
   * Required, not optional. "On the app" with no reason reads as an oversight
   * or a tease; the reason is the whole difference between "we have not got
   * round to it" and "this is a thing you do standing up".
   */
  why: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-start gap-4 p-4">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{label}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
              <Smartphone className="h-3 w-3" />
              On the phone app
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{description}</p>
          <p className="text-sm text-muted-foreground">{why}</p>
        </div>
      </CardContent>
    </Card>
  );
}
