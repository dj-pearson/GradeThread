import { AlertTriangle, ShieldCheck } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  useEbayConnection,
  useEbayAccountHealth,
  type EbaySellerStandards,
} from "@/hooks/use-ebay";

// US-1473: account-level eBay health — Seller Standards (Top Rated / Above /
// Below Standard) + customer-service defect metrics. Below Standard means fee
// surcharges + search demotion, so a PROJECTED drop is surfaced as an alert.

const LEVEL_LABEL: Record<string, string> = {
  TOP_RATED: "Top Rated",
  ABOVE_STANDARD: "Above Standard",
  BELOW_STANDARD: "Below Standard",
};

function levelLabel(level: string | null): string {
  if (!level) return "Not yet evaluated";
  return LEVEL_LABEL[level] ?? level;
}

function levelBadgeClass(level: string | null): string {
  switch (level) {
    case "TOP_RATED":
      return "bg-emerald-600 text-white";
    case "ABOVE_STANDARD":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300";
    case "BELOW_STANDARD":
      return "bg-destructive text-white";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function StandingRow({
  label,
  standards,
}: {
  label: string;
  standards: EbaySellerStandards;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <Badge className={cn("font-medium", levelBadgeClass(standards.standardsLevel))}>
        {levelLabel(standards.standardsLevel)}
      </Badge>
    </div>
  );
}

export function EbayAccountHealthCard() {
  const { data: connection } = useEbayConnection();
  // useEbayConnection returns the active marketplace_connections row (or null).
  const connected = !!connection;
  const { data, isLoading } = useEbayAccountHealth(connected);

  // Account health only applies to a connected eBay seller.
  if (!connected) return null;
  if (isLoading || !data) return null;

  // Sell Analytics not granted — prompt a reconnect rather than showing an error.
  if (!data.access) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4" />
            eBay account health
          </CardTitle>
          <CardDescription>
            Reconnect eBay and grant Analytics access to see your Seller Standards
            and service metrics here.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const current = data.standards?.current;
  const projected = data.standards?.projected;
  const belowStandard = data.projected_below_standard;

  return (
    <Card className={cn(belowStandard && "border-destructive/50")}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" />
          eBay account health
        </CardTitle>
        <CardDescription>
          Your eBay Seller Standards and customer-service defect metrics. Below
          Standard triggers fee surcharges and search demotion.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {belowStandard && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Your <strong>projected</strong> standing is Below Standard. Address
              defects and late shipments before the next evaluation to avoid fee
              surcharges and reduced visibility.
            </span>
          </div>
        )}
        {current && <StandingRow label="Current standing" standards={current} />}
        {projected && (
          <StandingRow label="Projected standing" standards={projected} />
        )}

        {(data.customer_service?.length ?? 0) > 0 && (
          <div className="border-t pt-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Customer-service defects (current)
            </p>
            <div className="space-y-1.5">
              {data.customer_service?.map((m) => (
                <div
                  key={m.metricType}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="text-muted-foreground">
                    {m.metricType === "ITEM_NOT_AS_DESCRIBED"
                      ? "Item not as described"
                      : "Item not received"}
                  </span>
                  <span className="tabular-nums">
                    {m.rate != null
                      ? `${(m.rate * 100).toFixed(2)}%`
                      : m.count != null
                        ? `${m.count}`
                        : "—"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
