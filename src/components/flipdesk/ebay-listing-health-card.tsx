import { AlertTriangle, CheckCircle2, ClipboardCheck, Loader2, RefreshCw, Wand2 } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useEbayConnection,
  useEbayListingHealth,
  useSyncListingHealth,
  useListingComplianceFlags,
  useApplyComplianceRecommendations,
  useEbayReviseListing,
} from "@/hooks/use-ebay";
import { useState } from "react";

// US-1422: Listing Health — surfaces the eBay Sell Compliance violation summary
// (missing item specifics, catalog-adoption gaps, etc.) so a reseller running
// many AI-generated listings sees accumulating policy issues before eBay
// silently demotes or hides them.

const TYPE_LABEL: Record<string, string> = {
  ASPECTS_ADOPTION: "Missing item specifics",
  PRODUCT_ADOPTION: "Not matched to a catalog product",
  HTTPS: "Insecure (HTTP) content",
  OUTSIDE_EBAY_BUYING: "Off-eBay buying links",
};

function typeLabel(t: string): string {
  return TYPE_LABEL[t] ?? t.replace(/_/g, " ").toLowerCase();
}

export function EbayListingHealthCard() {
  const { data: connection } = useEbayConnection();
  const connected = !!connection;
  const { data, isLoading } = useEbayListingHealth(connected);
  const sync = useSyncListingHealth();
  // US-1422 chunk 3: persisted per-listing flags drive the one-click fix.
  const { data: flags = [], refetch: refetchFlags } =
    useListingComplianceFlags();
  const applyRecs = useApplyComplianceRecommendations();
  const revise = useEbayReviseListing();
  const [fixing, setFixing] = useState(false);

  function recheck() {
    sync.mutate(undefined, {
      onSuccess: (r) => {
        void refetchFlags();
        toast.success(
          r.access === false
            ? "Reconnect eBay to check listing health."
            : `Re-checked — ${r.flagged ?? 0} listing${r.flagged === 1 ? "" : "s"} flagged.`,
        );
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : "Re-check failed."),
    });
  }

  // AC3: one-click revise — apply eBay's recommended item specifics to every
  // flagged listing (server merges them add-only) then push each live via the
  // existing revise path (resync_ebay_fields). Re-checks health afterward.
  async function applyRecommendations() {
    setFixing(true);
    let applied = 0;
    let revised = 0;
    try {
      for (const flag of flags) {
        try {
          const r = await applyRecs.mutateAsync(flag.id);
          if (r.applied > 0) {
            applied += r.applied;
            await revise.mutateAsync({
              listingId: flag.id,
              patch: { resync_ebay_fields: true },
            });
            revised += 1;
          }
        } catch {
          // Per-listing failure shouldn't abort the batch; surfaced in the total.
        }
      }
      if (revised > 0) {
        toast.success(
          `Applied eBay recommendations to ${revised} listing${revised === 1 ? "" : "s"} (${applied} specifics).`,
        );
        sync.mutate(undefined, { onSuccess: () => void refetchFlags() });
      } else {
        toast.info("No eBay aspect recommendations were available to apply.");
      }
    } finally {
      setFixing(false);
    }
  }

  if (!connected) return null;
  if (isLoading || !data) return null;

  if (!data.access) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardCheck className="h-4 w-4" />
            Listing Health
          </CardTitle>
          <CardDescription>
            Reconnect eBay to check your listings for policy and item-specifics
            violations.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const total = data.total ?? 0;
  const summaries = (data.summaries ?? []).filter((s) => s.listingCount > 0);

  return (
    <Card className={total > 0 ? "border-amber-400/50" : undefined}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardCheck className="h-4 w-4" />
          Listing Health
        </CardTitle>
        <CardDescription>
          eBay compliance issues across your active listings. Unresolved
          violations can be hidden or demoted in search.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {total === 0 ? (
          <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" />
            No listing violations detected.
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4" />
              {total} listing{total === 1 ? "" : "s"} with compliance issues.
            </div>
            <ul className="space-y-1.5">
              {summaries.map((s) => (
                <li
                  key={s.complianceType}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="text-muted-foreground">
                    {typeLabel(s.complianceType)}
                  </span>
                  <Badge variant="outline" className="tabular-nums">
                    {s.listingCount}
                  </Badge>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={recheck}
            disabled={sync.isPending || fixing}
          >
            {sync.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
            )}
            Re-check listings
          </Button>
          {flags.length > 0 && (
            <Button
              size="sm"
              onClick={applyRecommendations}
              disabled={fixing || sync.isPending}
              className="bg-brand-navy"
            >
              {fixing ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wand2 className="mr-2 h-3.5 w-3.5" />
              )}
              Apply eBay&apos;s recommendations ({flags.length})
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
