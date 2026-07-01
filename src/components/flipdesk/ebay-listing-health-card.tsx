import { AlertTriangle, CheckCircle2, ClipboardCheck } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useEbayConnection, useEbayListingHealth } from "@/hooks/use-ebay";

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
      </CardContent>
    </Card>
  );
}
