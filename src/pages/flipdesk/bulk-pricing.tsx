import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Tags } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import {
  useEbayBulkPriceQuantity,
  useEbayConnection,
  type BulkPriceQtyUpdate,
} from "@/hooks/use-ebay";

interface BulkRow {
  id: string;
  title: string;
  price: number;
  quantity: number | null;
}

type PriceMode = "none" | "set" | "reduce";

// US-1046 clean surface: select active eBay listings and update price and/or
// quantity in one bulk call.
export function FlipdeskBulkPricingPage() {
  const { data: connection, isLoading: connLoading } = useEbayConnection();
  const connected = !!connection;

  const { data: rows = [], isLoading, refetch } = useQuery({
    queryKey: ["bulk_pricing_listings"],
    enabled: connected,
    queryFn: async (): Promise<BulkRow[]> => {
      const { data, error } = await supabase
        .from("listings")
        .select("id, listing_title, listing_price, quantity, platform_offer_id")
        .eq("platform", "ebay")
        .eq("listing_status", "active")
        .not("platform_offer_id", "is", null)
        .order("listed_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return ((data ?? []) as Array<{
        id: string;
        listing_title: string | null;
        listing_price: number;
        quantity: number | null;
      }>).map((l) => ({
        id: l.id,
        title: l.listing_title || "Untitled listing",
        price: l.listing_price,
        quantity: l.quantity,
      }));
    },
  });

  const bulk = useEbayBulkPriceQuantity();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [priceMode, setPriceMode] = useState<PriceMode>("none");
  const [priceValue, setPriceValue] = useState("");
  const [qtyValue, setQtyValue] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const allSelected = rows.length > 0 && selected.size === rows.length;
  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  }

  const qtyNum = qtyValue.trim() === "" ? undefined : Number(qtyValue);
  const priceNum = priceValue.trim() === "" ? undefined : Number(priceValue);
  const priceActive = priceMode !== "none" && priceNum != null &&
    Number.isFinite(priceNum) && priceNum > 0;
  const qtyActive = qtyNum != null && Number.isInteger(qtyNum) && qtyNum >= 0;
  const canApply = selected.size > 0 && (priceActive || qtyActive) && !bulk.isPending;

  /// Resolve the target price for a row given the chosen mode.
  function targetPrice(row: BulkRow): number | undefined {
    if (!priceActive || priceNum == null) return undefined;
    if (priceMode === "set") return Number(priceNum.toFixed(2));
    // reduce by %
    return Number((row.price * (1 - priceNum / 100)).toFixed(2));
  }

  async function apply() {
    const updates: BulkPriceQtyUpdate[] = [];
    for (const row of rows) {
      if (!selected.has(row.id)) continue;
      const price = targetPrice(row);
      const quantity = qtyActive ? qtyNum : undefined;
      if (price == null && quantity == null) continue;
      updates.push({ listing_id: row.id, price, quantity });
    }
    if (updates.length === 0) return;
    try {
      const res = await bulk.mutateAsync({ updates });
      const failed = res.results.filter((r) => !r.ok);
      setErrors(Object.fromEntries(failed.map((r) => [r.listing_id, r.error ?? "Failed"])));
      if (failed.length === 0) {
        toast.success(`Updated ${res.succeeded} listing${res.succeeded === 1 ? "" : "s"}.`);
        setSelected(new Set());
      } else {
        toast.warning(`Updated ${res.succeeded}/${res.total}. ${failed.length} failed.`);
      }
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bulk update failed.");
    }
  }

  const previewPrice = useMemo(() => {
    if (!priceActive || priceNum == null) return null;
    return priceMode === "set"
      ? `Set price to $${priceNum.toFixed(2)}`
      : `Reduce price by ${priceNum}%`;
  }, [priceActive, priceMode, priceNum]);

  if (connLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!connected) {
    return (
      <div className="mx-auto max-w-4xl space-y-3 py-12 text-center">
        <h1 className="text-xl font-semibold">Bulk pricing</h1>
        <p className="text-sm text-muted-foreground">
          Connect your eBay account to bulk-update listing prices and quantities.
        </p>
        <Button asChild variant="outline">
          <a href="/dashboard/flipdesk/marketplaces">Go to Marketplaces</a>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Bulk pricing</h1>
        <p className="text-sm text-muted-foreground">
          Select active eBay listings and update their price and/or quantity in
          one go. Changes push straight to eBay.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Tags className="h-4 w-4" />
            Apply to {selected.size} selected
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label>Price</Label>
              <Select value={priceMode} onValueChange={(v) => setPriceMode(v as PriceMode)}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No change</SelectItem>
                  <SelectItem value="set">Set price to…</SelectItem>
                  <SelectItem value="reduce">Reduce by %…</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {priceMode !== "none" && (
              <div className="space-y-1">
                <Label>{priceMode === "set" ? "New price ($)" : "Reduce by (%)"}</Label>
                <Input
                  type="number"
                  min={priceMode === "set" ? 0.01 : 1}
                  step={priceMode === "set" ? 0.5 : 1}
                  value={priceValue}
                  onChange={(e) => setPriceValue(e.target.value)}
                  className="w-32"
                />
              </div>
            )}
            <div className="space-y-1">
              <Label>Set quantity (optional)</Label>
              <Input
                type="number"
                min={0}
                step={1}
                value={qtyValue}
                onChange={(e) => setQtyValue(e.target.value)}
                placeholder="—"
                className="w-32"
              />
            </div>
            <Button onClick={apply} disabled={!canApply}>
              {bulk.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Apply
            </Button>
          </div>
          {(previewPrice || qtyActive) && (
            <p className="text-xs text-muted-foreground">
              {[previewPrice, qtyActive ? `Set quantity to ${qtyNum}` : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <span>Active eBay listings</span>
            {rows.length > 0 && (
              <button
                type="button"
                onClick={toggleAll}
                className="text-sm font-normal text-muted-foreground hover:underline"
              >
                {allSelected ? "Clear" : "Select all"}
              </button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active eBay listings with an offer id.
            </p>
          ) : (
            rows.map((row) => (
              <div
                key={row.id}
                className="flex items-center gap-3 rounded-md border p-2"
              >
                <Checkbox
                  checked={selected.has(row.id)}
                  onCheckedChange={() => toggle(row.id)}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{row.title}</p>
                  {errors[row.id] && (
                    <p className="truncate text-xs text-destructive">{errors[row.id]}</p>
                  )}
                </div>
                <Badge variant="secondary">${row.price.toFixed(2)}</Badge>
                {row.quantity != null && (
                  <span className="text-xs text-muted-foreground">qty {row.quantity}</span>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
