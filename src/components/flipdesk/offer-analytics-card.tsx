import { useState } from "react";
import { TrendingDown } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import {
  useOfferAnalytics,
  type OfferCurve as Curve,
} from "@/hooks/use-ebay";

// US-2942: what discount depth actually converts, for this seller.
//
// "Send 10% off" is folklore. Nobody measures whether 10% converts any worse
// than 20%, because until offers were stored there was nothing to measure. If
// they convert the same, every 20% offer this seller has ever sent gave away
// eight points for nothing.
//
// ── THE PANEL NEVER MAKES A CLAIM IT CANNOT SHOW THE WORKING FOR ────────────
//
// A bucket under the server's minimum reads "not enough offers yet", in words,
// never as a percentage. And the recommendation is printed WITH its arithmetic,
// so a seller can check it rather than take it — a number that says "discount
// less" with nothing behind it is worth less than no number.

const WINDOWS = [90, 180, 365] as const;

function pct(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}

function CurveTable({ curve, title, caption }: { curve: Curve; title: string; caption: string }) {
  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground">{caption}</p>
      </div>
      {curve.buckets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing on record in this window yet.
        </p>
      ) : (
        <>
          {curve.efficientDepth && (
            <div className="rounded-md border bg-muted/30 p-2 text-sm">
              <p className="font-medium">
                {curve.efficientDepth.key} converts as well as{" "}
                {curve.efficientDepth.bestKey}.
              </p>
              {/* The working, so the claim can be checked rather than taken. */}
              <p className="mt-1 text-xs text-muted-foreground">
                {curve.efficientDepth.explanation}
              </p>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-3 font-normal">Discount</th>
                  <th className="py-1.5 pr-3 font-normal">Sent</th>
                  <th className="py-1.5 pr-3 font-normal">Accepted</th>
                  <th className="py-1.5 pr-3 font-normal">Accept rate</th>
                  <th className="py-1.5 font-normal">Days to accept</th>
                </tr>
              </thead>
              <tbody>
                {curve.buckets.map((b) => (
                  <tr key={b.key} className="border-b last:border-0">
                    <td className="py-1.5 pr-3">{b.key}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{b.offers}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{b.accepted}</td>
                    <td className="py-1.5 pr-3 tabular-nums">
                      {b.acceptRate == null ? (
                        <span className="text-xs text-muted-foreground">
                          under {curve.minBucketSample} offers
                        </span>
                      ) : (
                        pct(b.acceptRate)
                      )}
                    </td>
                    <td className="py-1.5 tabular-nums">
                      {b.medianDaysToAccept == null ? "—" : b.medianDaysToAccept}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export function OfferAnalyticsCard() {
  const [days, setDays] = useState<number>(180);
  const { data, isLoading, isError } = useOfferAnalytics(days);

  const nothing =
    !!data && data.sentOffers.totalOffers === 0 && data.counters.totalOffers === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <TrendingDown className="h-4 w-4" />
            What your discounts convert at
          </span>
          <span className="flex gap-1">
            {WINDOWS.map((w) => (
              <Button
                key={w}
                size="sm"
                variant={w === days ? "secondary" : "ghost"}
                className="h-7 px-2 text-xs font-normal"
                onClick={() => setDays(w)}
              >
                {w}d
              </Button>
            ))}
          </span>
        </CardTitle>
        <CardDescription>
          Your own offers, over the last {days} days.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : isError ? (
          <EmptyState
            className="py-8"
            icon={TrendingDown}
            title="Couldn't build the numbers."
            description="Try again in a moment."
          />
        ) : nothing ? (
          <EmptyState
            className="py-8"
            icon={TrendingDown}
            title="No offers on record yet."
            description="Offers you send and counters you make start being recorded from the first time we read them."
          />
        ) : (
          data && (
            <>
              {/* Two curves, never pooled: an unprompted discount to a watcher
                  and a counter to someone who already bid are different acts,
                  and the counters' much higher accept rate would flatter the
                  sends. */}
              <CurveTable
                curve={data.sentOffers}
                title="Offers you sent"
                caption="Unprompted discounts to buyers watching an item."
              />
              <CurveTable
                curve={data.counters}
                title="Counters you made"
                caption="Answers to a buyer who had already offered. These convert better, which is why they are counted apart."
              />
            </>
          )
        )}
      </CardContent>
    </Card>
  );
}
