import { Tag } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useEbayConnection, useEbayPromotions } from "@/hooks/use-ebay";

// US-1448 (chunk 1): surface the seller's eBay Promotions Manager item
// promotions (order/volume discounts, coupons, sale events). Read-only for now;
// creating promotions from FlipDesk is a follow-up. Self-gates on connection.

const TYPE_LABEL: Record<string, string> = {
  ORDER_DISCOUNT: "Order discount",
  VOLUME_DISCOUNT: "Volume discount",
  CODED_COUPON: "Coupon",
  MARKDOWN_SALE: "Sale (markdown)",
};

function typeLabel(t: string | null): string {
  if (!t) return "Promotion";
  return TYPE_LABEL[t] ?? t.replace(/_/g, " ").toLowerCase();
}

function statusVariant(s: string | null): "default" | "secondary" | "outline" {
  if (s === "RUNNING") return "default";
  if (s === "SCHEDULED") return "secondary";
  return "outline";
}

export function EbayPromotionsCard() {
  const { data: connection } = useEbayConnection();
  const connected = !!connection;
  const { data, isLoading } = useEbayPromotions(connected);

  if (!connected) return null;
  if (isLoading || !data) return null;
  if (data.access === false) return null;

  const promotions = data.promotions ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Tag className="h-4 w-4" />
          eBay promotions
        </CardTitle>
        <CardDescription>
          Your eBay Promotions Manager offers (order/volume discounts, coupons,
          sale events).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {promotions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active promotions. Create order discounts, volume pricing, or
            coupons in eBay Seller Hub.
          </p>
        ) : (
          <ul className="divide-y">
            {promotions.map((p) => (
              <li
                key={p.promotionId}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">
                    {p.name ?? typeLabel(p.promotionType)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {typeLabel(p.promotionType)}
                  </div>
                </div>
                {p.promotionStatus && (
                  <Badge variant={statusVariant(p.promotionStatus)}>
                    {p.promotionStatus.toLowerCase()}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
