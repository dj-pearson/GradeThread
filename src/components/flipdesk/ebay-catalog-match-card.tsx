import { useState } from "react";
import { Loader2, PackageSearch, CheckCircle2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useCatalogMatch, useAdoptCatalogProduct } from "@/hooks/use-ebay";

// US-1475: find + adopt an eBay Catalog product (EPID) for an item. Adopting
// auto-fills the catalog's authoritative item specifics (cutting aspect
// violations) and sends the EPID at publish. On-demand (hits the eBay API only
// when the seller asks) — collapsed by default.
export function EbayCatalogMatchCard({
  itemId,
  currentEpid,
}: {
  itemId: string;
  currentEpid?: string | null;
}) {
  const [searching, setSearching] = useState(false);
  const { data, isLoading } = useCatalogMatch(itemId, searching);
  const adopt = useAdoptCatalogProduct();

  function doAdopt(epid: string) {
    adopt.mutate(
      { itemId, epid },
      {
        onSuccess: (r) =>
          toast.success(
            `Matched to eBay catalog — ${r.applied} item specific${r.applied === 1 ? "" : "s"} filled.`,
          ),
        onError: (e) =>
          toast.error(e instanceof Error ? e.message : "Couldn't adopt the match."),
      },
    );
  }

  const top = data?.top;

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <PackageSearch className="h-4 w-4" />
          eBay catalog match
        </div>
        {currentEpid && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            EPID {currentEpid}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Match this item to an eBay catalog product to auto-fill required item
        specifics and reduce listing-compliance issues.
      </p>

      {!searching ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => setSearching(true)}
        >
          <PackageSearch className="mr-2 h-3.5 w-3.5" />
          Find catalog match
        </Button>
      ) : isLoading ? (
        <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching eBay
          catalog…
        </p>
      ) : top ? (
        <div className="mt-2 space-y-2">
          <div className="text-sm">
            <div className="font-medium">{top.title}</div>
            {top.brand && (
              <div className="text-xs text-muted-foreground">{top.brand}</div>
            )}
            <div className="text-xs text-muted-foreground">
              {Object.keys(top.aspects).length} catalog specifics available
            </div>
          </div>
          <Button
            size="sm"
            disabled={adopt.isPending}
            onClick={() => doAdopt(top.epid)}
          >
            {adopt.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-3.5 w-3.5" />
            )}
            Use this match &amp; fill specifics
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          No confident catalog match found — keep your current specifics.
        </p>
      )}
    </div>
  );
}
