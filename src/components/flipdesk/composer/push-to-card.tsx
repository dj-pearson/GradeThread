import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { API_CROSS_LISTING_PLATFORMS, EXTENSION_CROSS_LISTING_PLATFORMS, MARKETPLACE_LABELS, MARKETPLACE_TIER, MARKETPLACE_TIER_LABEL } from "@/lib/constants";
import type { CrossListingPlatform } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useCrossPostChannels } from "@/hooks/use-cross-post-channels";
import { filterChannels } from "@/lib/cross-post-channels";

import type React from "react";
export interface PushToCardProps {
  pushPlatforms: Set<CrossListingPlatform>;
  togglePushPlatform: (p: CrossListingPlatform) => void;
  platformPrices: Partial<Record<CrossListingPlatform, string>>;
  setPlatformPrices: React.Dispatch<React.SetStateAction<Partial<Record<CrossListingPlatform, string>>>>;
  /** Placeholder for a per-platform override left blank. */
  price: string;
}
// US-149/US-717: which marketplaces this draft goes to. API platforms fan out
// via cross-push; the extension platforms have no write API and list from the
// seller's own logged-in tab through the Listing Kit.
export function PushToCard({
  pushPlatforms,
  togglePushPlatform,
  platformPrices,
  setPlatformPrices,
  price,
}: PushToCardProps) {
  // US-2721: only the channels this seller cross-posts to. A seller on two
  // marketplaces should not be reading six rows on every draft.
  const { data: chosenChannels } = useCrossPostChannels();
  const apiPlatforms = filterChannels(API_CROSS_LISTING_PLATFORMS, chosenChannels);
  const extensionPlatforms = filterChannels(
    EXTENSION_CROSS_LISTING_PLATFORMS,
    chosenChannels,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Push to</CardTitle>
        <CardDescription>
          Cross-list this draft. Each platform gets its own price — leave it
          blank to use the price above.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {apiPlatforms.map((p) => {
          // US-1114: a channel whose connector is built but awaiting
          // platform approval (tier "api_pending", e.g. Depop) has no
          // connect/publish path yet — publishing would 503. Show it
          // disabled with honest copy instead of a live "Connected via
          // API" checkbox that fails on click.
          const pending = MARKETPLACE_TIER[p] === "api_pending";
          const checked = pushPlatforms.has(p) && !pending;
          return (
            <div
              key={p}
              className={cn(
                "flex items-center justify-between gap-3 rounded-md border p-2.5",
                pending && "opacity-60",
              )}
            >
              <label
                className={cn(
                  "flex items-center gap-2 text-sm",
                  pending ? "cursor-not-allowed" : "cursor-pointer",
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={pending}
                  onChange={() => togglePushPlatform(p)}
                  className={cn(
                    "h-3.5 w-3.5",
                    pending ? "cursor-not-allowed" : "cursor-pointer",
                  )}
                />
                <span className="font-medium">
                  {MARKETPLACE_LABELS[p]}
                </span>
                <Badge variant="outline" className="text-[10px]">
                  {pending
                    ? MARKETPLACE_TIER_LABEL.api_pending
                    : "Connected via API"}
                </Badge>
              </label>
              {checked && (
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={platformPrices[p] ?? ""}
                  onChange={(e) =>
                    setPlatformPrices((prev) => ({
                      ...prev,
                      [p]: e.target.value,
                    }))
                  }
                  placeholder={price || "Price"}
                  className="h-8 max-w-[7rem] text-right"
                  aria-label={`${MARKETPLACE_LABELS[p]} price`}
                />
              )}
            </div>
          );
        })}

        {/* US-717: extension marketplaces are offered with their real
            mechanism badge. They have no write API, so they list from the
            seller's own logged-in tab via the Listing Kit below — not
            cross-push. */}
        <div className="rounded-md border border-dashed p-2.5">
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            {extensionPlatforms.map((p) => (
              <span key={p} className="font-medium">
                {MARKETPLACE_LABELS[p]}
              </span>
            ))}
            <Badge variant="outline" className="text-[10px]">
              Via browser extension
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            No public API — list these from your own logged-in tab with the
            GradeThread Lister extension in the Listing Kit below.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}