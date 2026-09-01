// US-3033: say where the marketplace data came from, wherever we show it.
//
// The comps panel already linked every comp back to its eBay item page, which
// is the part eBay cares most about and the part we had right. What was missing
// was the sentence: nowhere in the app did any text tell a seller that the
// prices they were reading came from eBay, and nowhere outside the trademarks
// page did the non-endorsement notice appear.
//
// eBay asks for both, together, on the surface where the data is displayed —
// not buried on a legal page a seller never opens. This component is the one
// place that wording lives, so a second surface showing eBay data cannot get a
// third variant of it.
//
// Deliberately plain. No eBay logo: their brand assets carry their own usage
// terms, and a wordmark we drew ourselves would be worse than text.

import { cn } from "@/lib/utils";

interface EbayAttributionProps {
  /**
   * What is being shown. Reads as "Comparable listing data from eBay." Keep it
   * a noun phrase naming the data, not the feature.
   */
  what?: string;
  className?: string;
}

export function EbayAttribution({
  what = "Comparable listing data",
  className,
}: EbayAttributionProps) {
  return (
    <p className={cn("text-[11px] leading-relaxed text-muted-foreground", className)}>
      {what} from eBay, retrieved through the eBay API. eBay is a trademark of
      eBay Inc. GradeThread uses the eBay API but is not endorsed or certified by
      eBay Inc.{" "}
      <a
        href="/legal/trademarks"
        className="underline underline-offset-2 hover:text-foreground"
      >
        Trademarks
      </a>
    </p>
  );
}
