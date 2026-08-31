import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Megaphone, Pause, Play, Square } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { edgeFetch } from "@/lib/edge-fetch";

// US-2946 + US-2947: eBay's own promotion suggestions, and the campaign
// controls a seller had to go to Seller Hub for.
//
// ── THE ORDERING IS OURS, NOT EBAY'S, AND THE CARD SAYS SO ──────────────────
//
// eBay ranks suggestions by what it expects to SELL. A seller cares what is
// left after the ad fee, and those are not the same list. The server reorders
// by margin-after-ad-fee and reports which ordering it used; an item with no
// recorded cost has an unknown margin and sorts last rather than being treated
// as free, because putting the things we know least about at the top of a
// spending list is the wrong failure.

interface SuggestionItem {
  listing_id: string;
  title: string | null;
  suggested_bid_percentage: number | null;
  price_cents: number | null;
  ad_fee_cents: number | null;
  margin_after_ad_fee_cents: number | null;
  days_listed: number | null;
}

interface SuggestionsResponse {
  supported: boolean;
  detail?: string;
  ordering?: string;
  items: SuggestionItem[];
  budget?: { dailyBudgetCents: number | null; currency: string | null };
}

function money(cents: number | null | undefined): string {
  return cents == null ? "—" : `$${(cents / 100).toFixed(2)}`;
}

export function EbayCampaignCard() {
  const qc = useQueryClient();
  const confirm = useConfirm();

  const { data, isLoading } = useQuery({
    queryKey: ["ebay_marketing_suggestions"],
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<SuggestionsResponse> => {
      const res = await edgeFetch("/api/flipdesk/ebay/marketing/suggestions");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't load eBay's suggestions.");
      return json as SuggestionsResponse;
    },
  });

  const act = useMutation<unknown, Error, { action: "pause" | "resume" | "end" }>({
    mutationFn: async ({ action }) => {
      const res = await edgeFetch(`/api/flipdesk/ebay/marketing/campaign/${action}`, {
        method: "POST",
        body: "{}",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "eBay rejected the campaign change.");
      return json;
    },
    onSuccess: (_res, { action }) => {
      toast.success(
        action === "pause"
          ? "Campaign paused. Nothing more will be spent until you resume it."
          : action === "resume"
            ? "Campaign running again."
            : "Campaign ended.",
      );
      void qc.invalidateQueries({ queryKey: ["ebay_marketing_suggestions"] });
    },
    onError: (err) => toastError(err, "eBay rejected the campaign change."),
  });

  async function end() {
    const ok = await confirm({
      title: "End this campaign?",
      description:
        "Every ad in it stops. Ending is not reversible on eBay — you would start a new campaign rather than resume this one.",
      confirmLabel: "End campaign",
      destructive: true,
    });
    if (!ok) return;
    act.mutate({ action: "end" });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          {/* US-3032: this card and the running-listings table above it were
              both called "Promoted Listings" and sat four rows apart, so the
              page named two different surfaces the same thing. The name now
              belongs to the section that holds both; each card says which half
              of it you are looking at. */}
          <span className="flex items-center gap-2">
            <Megaphone className="h-4 w-4" />
            Worth promoting
          </span>
          <span className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs font-normal"
              disabled={act.isPending}
              onClick={() => act.mutate({ action: "pause" })}
            >
              <Pause className="mr-1 h-3.5 w-3.5" />
              Pause
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs font-normal"
              disabled={act.isPending}
              onClick={() => act.mutate({ action: "resume" })}
            >
              <Play className="mr-1 h-3.5 w-3.5" />
              Resume
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs font-normal"
              disabled={act.isPending}
              onClick={end}
            >
              <Square className="mr-1 h-3.5 w-3.5" />
              End
            </Button>
          </span>
        </CardTitle>
        <CardDescription>
          What eBay thinks is worth promoting, ranked by what you keep afterwards.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : !data ? (
          <p className="text-sm text-muted-foreground">
            No campaign to read yet.
          </p>
        ) : !data.supported ? (
          // Specific, not generic: this marketplace has no suggestion API, which
          // is a different thing from having nothing worth promoting.
          <p className="text-sm text-muted-foreground">{data.detail}</p>
        ) : (
          <>
            {data.budget?.dailyBudgetCents != null && (
              <p className="text-sm text-muted-foreground">
                eBay suggests a daily budget of {money(data.budget.dailyBudgetCents)}.
              </p>
            )}
            {data.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                eBay has nothing to suggest for this account right now.
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Ordered by what is left after the ad fee, not by eBay's own
                  order. Items with no recorded cost are last, because we cannot
                  work out their margin.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[34rem] text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="py-1.5 pr-3 font-normal">Listing</th>
                        <th className="py-1.5 pr-3 font-normal">Rate</th>
                        <th className="py-1.5 pr-3 font-normal">Price</th>
                        <th className="py-1.5 pr-3 font-normal">Ad fee</th>
                        <th className="py-1.5 pr-3 font-normal">You keep</th>
                        <th className="py-1.5 font-normal">Listed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.slice(0, 25).map((it) => (
                        <tr key={it.listing_id} className="border-b last:border-0">
                          <td className="max-w-[16rem] truncate py-1.5 pr-3">
                            {it.title || it.listing_id}
                          </td>
                          <td className="py-1.5 pr-3 tabular-nums">
                            {it.suggested_bid_percentage == null
                              ? "—"
                              : `${it.suggested_bid_percentage}%`}
                          </td>
                          <td className="py-1.5 pr-3 tabular-nums">{money(it.price_cents)}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{money(it.ad_fee_cents)}</td>
                          <td className="py-1.5 pr-3 tabular-nums">
                            {it.margin_after_ad_fee_cents == null ? (
                              <span className="text-xs text-muted-foreground">cost unknown</span>
                            ) : (
                              money(it.margin_after_ad_fee_cents)
                            )}
                          </td>
                          <td className="py-1.5 tabular-nums">
                            {it.days_listed == null ? "—" : `${it.days_listed}d`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-muted-foreground">
                  Select the ones you want on the Listings page and use Promote —
                  nothing here is applied on its own.
                </p>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
