import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  ExternalLink,
  Loader2,
  RefreshCw,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Term } from "@/components/help/term";
import {
  useEbayConnection,
  useEbayListingHealth,
  useSyncListingHealth,
  useListingComplianceFlags,
  useApplyComplianceRecommendations,
  useEbayListingViolations,
  useEbayReviseListing,
  type ListingComplianceFlag,
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

// US-2158: the per-listing breakdown behind one summary count.
//
// eBay keys violations by ITS listing id, so each one is matched back to the
// local listings row through platform_listing_id — that row id is what the fix
// endpoints take. A violation we can't match (an eBay listing FlipDesk doesn't
// manage) still renders: it's real, the seller should see it, it just can't be
// fixed from here.
function ViolationDetail({
  complianceType,
  flags,
  busy,
  onFixed,
}: {
  complianceType: string;
  flags: ListingComplianceFlag[];
  busy: boolean;
  onFixed: () => void;
}) {
  const { data, isLoading, isError } = useEbayListingViolations(
    complianceType,
    true,
  );
  const applyRecs = useApplyComplianceRecommendations();
  const revise = useEbayReviseListing();
  const [fixingId, setFixingId] = useState<string | null>(null);

  const byEbayId = new Map(
    flags
      .filter((f) => f.platform_listing_id)
      .map((f) => [f.platform_listing_id as string, f]),
  );

  async function fixOne(flag: ListingComplianceFlag) {
    setFixingId(flag.id);
    try {
      const r = await applyRecs.mutateAsync(flag.id);
      if (r.applied > 0) {
        await revise.mutateAsync({
          listingId: flag.id,
          patch: { resync_ebay_fields: true },
        });
        toast.success(
          `Applied ${r.applied} item specific${r.applied === 1 ? "" : "s"} and revised the listing.`,
        );
        onFixed();
      } else {
        toast.info("eBay had no recommendations to apply for this listing.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not fix this listing.");
    } finally {
      setFixingId(null);
    }
  }

  if (isLoading) {
    return (
      <p className="py-2 pl-5 text-sm text-muted-foreground">
        Loading violations…
      </p>
    );
  }
  if (isError || data?.access === false) {
    return (
      <p className="py-2 pl-5 text-sm text-muted-foreground">
        Reconnect eBay to see the details for these violations.
      </p>
    );
  }

  const violations = data?.violations ?? [];
  if (violations.length === 0) {
    return (
      <p className="py-2 pl-5 text-sm text-muted-foreground">
        eBay returned no detail for this violation type.
      </p>
    );
  }

  return (
    <ul className="space-y-2 py-2 pl-5">
      {violations.map((v, i) => {
        const flag = v.listingId ? byEbayId.get(v.listingId) : undefined;
        const title = flag?.inventory_items?.title ?? v.sku ?? v.listingId;
        const canFix = !!flag && v.aspectRecommendations.length > 0;
        const url =
          flag?.listing_url ??
          (v.listingId ? `https://www.ebay.com/itm/${v.listingId}` : null);
        return (
          <li
            key={`${v.listingId ?? v.sku ?? "unknown"}-${i}`}
            className="rounded-md border p-2 text-sm"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{title || "Unknown listing"}</p>
                {v.reasons.length > 0 && (
                  <ul className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
                    {v.reasons.map((r, ri) => (
                      <li key={ri}>{r}</li>
                    ))}
                  </ul>
                )}
                {v.aspectRecommendations.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    eBay suggests:{" "}
                    {v.aspectRecommendations.map((a) => a.name).join(", ")}
                  </p>
                )}
              </div>
              <div className="flex flex-shrink-0 items-center gap-1">
                {canFix && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || fixingId === flag.id}
                    onClick={() => fixOne(flag)}
                  >
                    {fixingId === flag.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Wand2 className="h-3.5 w-3.5" />
                    )}
                    <span className="ml-1">Fix</span>
                  </Button>
                )}
                {url && (
                  <Button size="sm" variant="ghost" asChild>
                    <a href={url} target="_blank" rel="noreferrer noopener">
                      <ExternalLink className="h-3.5 w-3.5" />
                      <span className="sr-only">
                        Open {title || "listing"} on eBay
                      </span>
                    </a>
                  </Button>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
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
  // US-2158: which summary row is open. One at a time — each expansion is a live
  // eBay round-trip, so opening all of them at once would fan out needlessly.
  const [expandedType, setExpandedType] = useState<string | null>(null);

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
        toast.info("eBay had no item details to suggest for this listing.");
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
            Reconnect eBay and we will check your listings for policy problems
            and missing <Term name="Item specifics">item specifics</Term>.
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
          Problems eBay has flagged on your live listings, usually missing{" "}
          <Term name="Item specifics">item specifics</Term>. Leave them and eBay
          can bury the listing in search or hide it.
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
                <li key={s.complianceType}>
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedType((prev) =>
                        prev === s.complianceType ? null : s.complianceType,
                      )
                    }
                    aria-expanded={expandedType === s.complianceType}
                    className="flex w-full items-center justify-between gap-3 rounded-md py-1 text-left text-sm transition-colors hover:text-foreground"
                  >
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <ChevronRight
                        className={cn(
                          "h-3.5 w-3.5 transition-transform",
                          expandedType === s.complianceType && "rotate-90",
                        )}
                      />
                      {typeLabel(s.complianceType)}
                    </span>
                    <Badge variant="outline" className="tabular-nums">
                      {s.listingCount}
                    </Badge>
                  </button>
                  {expandedType === s.complianceType && (
                    <ViolationDetail
                      complianceType={s.complianceType}
                      flags={flags}
                      busy={fixing}
                      onFixed={() => {
                        sync.mutate(undefined, {
                          onSuccess: () => void refetchFlags(),
                        });
                      }}
                    />
                  )}
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
