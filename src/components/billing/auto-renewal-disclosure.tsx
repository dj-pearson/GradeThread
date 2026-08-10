import { cn } from "@/lib/utils";
import {
  disclosureSentences,
  type AutoRenewalTerms,
} from "@/lib/auto-renewal-copy";

// US-2115: the ONE auto-renewal disclosure. Every surface that sells a
// subscription renders this component, so the four surfaces named in the story
// (and any new one) cannot drift apart. The wording lives in
// src/lib/auto-renewal-copy.ts; src/test/subscription-disclosure-coverage.test.ts
// is the guard that no surface hand-writes its own.

export interface AutoRenewalDisclosureProps extends AutoRenewalTerms {
  className?: string;
}

export function AutoRenewalDisclosure({
  className,
  ...terms
}: AutoRenewalDisclosureProps) {
  return (
    <p
      data-testid="auto-renewal-disclosure"
      // Plain, visible body text sitting with the price and the button. It is
      // deliberately NOT a tooltip, popover, accordion or "see terms" link —
      // AC1 requires it in the user's own view on the same screen, and every
      // one of those patterns is what a clear-and-conspicuous standard exists
      // to rule out. text-xs keeps it out of the way of the price without
      // dropping it to a contrast the requirement would not survive.
      className={cn("text-xs leading-relaxed text-muted-foreground", className)}
    >
      {disclosureSentences(terms).join(" ")}
    </p>
  );
}
