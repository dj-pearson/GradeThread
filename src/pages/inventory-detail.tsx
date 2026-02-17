import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  AlertTriangle,
  Package,
  Tag,
  DollarSign,
  Truck,
  CheckCircle2,
  Circle,
  ShoppingCart,
  ClipboardList,
  RotateCcw,
  Pencil,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ITEM_STATUSES } from "@/lib/constants";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type {
  InventoryItemRow,
  ListingRow,
  SaleRow,
  ShipmentRow,
  ItemStatus,
} from "@/types/database";

function formatLabel(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function formatDate(date: string | null): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getStatusBadgeClasses(status: string): string {
  switch (status) {
    case "acquired":
      return "border-slate-200 bg-slate-100 text-slate-800";
    case "grading":
      return "border-blue-200 bg-blue-100 text-blue-800";
    case "graded":
      return "border-indigo-200 bg-indigo-100 text-indigo-800";
    case "listed":
      return "border-yellow-200 bg-yellow-100 text-yellow-800";
    case "sold":
      return "border-green-200 bg-green-100 text-green-800";
    case "shipped":
      return "border-cyan-200 bg-cyan-100 text-cyan-800";
    case "completed":
      return "border-emerald-200 bg-emerald-100 text-emerald-800";
    case "returned":
      return "border-red-200 bg-red-100 text-red-800";
    default:
      return "";
  }
}

const LIFECYCLE_STEPS: { status: ItemStatus; icon: typeof Package; label: string }[] = [
  { status: "acquired", icon: Package, label: "Acquired" },
  { status: "grading", icon: ClipboardList, label: "Grading" },
  { status: "graded", icon: CheckCircle2, label: "Graded" },
  { status: "listed", icon: Tag, label: "Listed" },
  { status: "sold", icon: ShoppingCart, label: "Sold" },
  { status: "shipped", icon: Truck, label: "Shipped" },
  { status: "completed", icon: CheckCircle2, label: "Completed" },
];

function getStatusIndex(status: ItemStatus): number {
  if (status === "returned") return -1;
  return LIFECYCLE_STEPS.findIndex((s) => s.status === status);
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Skeleton className="h-8 w-8" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
      <Skeleton className="h-16 w-full" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function InventoryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [item, setItem] = useState<InventoryItemRow | null>(null);
  const [listings, setListings] = useState<ListingRow[]>([]);
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [shipments, setShipments] = useState<ShipmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingStatus, setUpdatingStatus] = useState(false);

  useEffect(() => {
    if (!id) return;

    async function fetchData() {
      setLoading(true);
      setError(null);

      // Fetch inventory item
      const { data: itemData, error: itemError } = await supabase
        .from("inventory_items")
        .select("*")
        .eq("id", id!)
        .single();

      if (itemError || !itemData) {
        setError("Inventory item not found.");
        setLoading(false);
        return;
      }
      setItem(itemData as InventoryItemRow);

      // Fetch listings
      const { data: listingsRaw } = await supabase
        .from("listings")
        .select("*")
        .eq("inventory_item_id", id!)
        .order("listed_at", { ascending: false });

      setListings((listingsRaw ?? []) as ListingRow[]);

      // Fetch sales
      const { data: salesRaw } = await supabase
        .from("sales")
        .select("*")
        .eq("inventory_item_id", id!)
        .order("sale_date", { ascending: false });

      setSales((salesRaw ?? []) as SaleRow[]);

      // Fetch shipments for all sales
      const saleRows = (salesRaw ?? []) as SaleRow[];
      if (saleRows.length > 0) {
        const saleIds = saleRows.map((s) => s.id);
        const { data: shipmentsRaw } = await supabase
          .from("shipments")
          .select("*")
          .in("sale_id", saleIds)
          .order("ship_date", { ascending: false });

        setShipments((shipmentsRaw ?? []) as ShipmentRow[]);
      }

      setLoading(false);
    }

    fetchData();
  }, [id]);

  async function handleStatusUpdate(newStatus: string) {
    if (!item) return;
    setUpdatingStatus(true);

    const { error: updateError } = await supabase
      .from("inventory_items")
      .update({ status: newStatus } as never)
      .eq("id", item.id);

    if (updateError) {
      toast.error("Failed to update status.");
    } else {
      setItem({ ...item, status: newStatus as ItemStatus });
      toast.success(`Status updated to ${formatLabel(newStatus)}.`);
    }
    setUpdatingStatus(false);
  }

  if (loading) {
    return <LoadingSkeleton />;
  }

  if (error || !item) {
    return (
      <div className="space-y-6">
        <Link
          to="/dashboard/inventory"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Inventory
        </Link>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <AlertTriangle className="h-12 w-12 text-muted-foreground/50" />
            <h3 className="mt-4 text-lg font-medium">
              {error || "Item not found"}
            </h3>
          </CardContent>
        </Card>
      </div>
    );
  }

  const currentStatusIndex = getStatusIndex(item.status);

  // Calculate profit/loss
  const totalSaleRevenue = sales.reduce((sum, s) => sum + s.sale_price, 0);
  const totalPlatformFees = sales.reduce((sum, s) => sum + s.platform_fees, 0);
  const totalShippingCost = shipments.reduce(
    (sum, s) => sum + s.shipping_cost + s.label_cost,
    0
  );
  const acquiredPrice = item.acquired_price ?? 0;
  const netProfit =
    totalSaleRevenue - acquiredPrice - totalPlatformFees - totalShippingCost;
  const hasSales = sales.length > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Link
            to="/dashboard/inventory"
            className="inline-flex items-center justify-center rounded-md border p-2 hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold">{item.title}</h1>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {item.brand && <span>{item.brand}</span>}
              {item.brand && item.garment_type && <span>·</span>}
              {item.garment_type && <span>{formatLabel(item.garment_type)}</span>}
              {item.garment_category && (
                <>
                  <span>·</span>
                  <span>{formatLabel(item.garment_category)}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={cn(getStatusBadgeClasses(item.status))}
          >
            {formatLabel(item.status)}
          </Badge>
        </div>
      </div>

      {/* Lifecycle Timeline */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Lifecycle</CardTitle>
        </CardHeader>
        <CardContent>
          {item.status === "returned" ? (
            <div className="flex items-center gap-3 text-sm">
              <RotateCcw className="h-5 w-5 text-red-500" />
              <span className="font-medium text-red-700">Item Returned</span>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              {LIFECYCLE_STEPS.map((step, idx) => {
                const StepIcon = step.icon;
                const isCompleted = idx <= currentStatusIndex;
                const isCurrent = idx === currentStatusIndex;
                return (
                  <div key={step.status} className="flex items-center">
                    <div className="flex flex-col items-center gap-1">
                      <div
                        className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-full border-2",
                          isCompleted
                            ? "border-brand-navy bg-brand-navy text-white"
                            : "border-muted-foreground/30 text-muted-foreground/40",
                          isCurrent && "ring-2 ring-brand-navy/30 ring-offset-1"
                        )}
                      >
                        {isCompleted ? (
                          <StepIcon className="h-4 w-4" />
                        ) : (
                          <Circle className="h-3 w-3" />
                        )}
                      </div>
                      <span
                        className={cn(
                          "text-[10px] font-medium",
                          isCompleted
                            ? "text-foreground"
                            : "text-muted-foreground/50"
                        )}
                      >
                        {step.label}
                      </span>
                    </div>
                    {idx < LIFECYCLE_STEPS.length - 1 && (
                      <div
                        className={cn(
                          "mb-4 h-0.5 w-4 sm:w-8",
                          idx < currentStatusIndex
                            ? "bg-brand-navy"
                            : "bg-muted-foreground/20"
                        )}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit Status */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            <Pencil className="mr-1.5 inline-block h-4 w-4" />
            Update Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <div className="w-48">
              <Select
                value={item.status}
                onValueChange={handleStatusUpdate}
                disabled={updatingStatus}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ITEM_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {formatLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {updatingStatus && (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Acquisition Card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              <DollarSign className="mr-1.5 inline-block h-4 w-4" />
              Acquisition Details
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div>
                <p className="text-muted-foreground">Price</p>
                <p className="font-medium">{formatCurrency(item.acquired_price)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Date</p>
                <p className="font-medium">{formatDate(item.acquired_date)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Source</p>
                <p className="font-medium">{item.acquired_source ?? "—"}</p>
              </div>
              {item.size && (
                <div>
                  <p className="text-muted-foreground">Size</p>
                  <p className="font-medium">{item.size}</p>
                </div>
              )}
              {item.color && (
                <div>
                  <p className="text-muted-foreground">Color</p>
                  <p className="font-medium">{item.color}</p>
                </div>
              )}
            </div>
            {item.condition_notes && (
              <div className="mt-4 text-sm">
                <p className="text-muted-foreground">Condition Notes</p>
                <p className="mt-1 whitespace-pre-wrap">{item.condition_notes}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Grading Card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              <ClipboardList className="mr-1.5 inline-block h-4 w-4" />
              Grading
            </CardTitle>
          </CardHeader>
          <CardContent>
            {item.grade_report_id ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  This item has been graded.
                </p>
                {item.submission_id && (
                  <Button variant="outline" size="sm" asChild>
                    <Link to={`/dashboard/submissions/${item.submission_id}`}>
                      View Grade Report
                    </Link>
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  This item has not been graded yet.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate("/dashboard/submissions/new")}
                >
                  Submit for Grading
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Listings Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              <Tag className="mr-1.5 inline-block h-4 w-4" />
              Listings
            </CardTitle>
            {listings.length > 0 && (
              <CardDescription>
                {listings.filter((l) => l.is_active).length} active /{" "}
                {listings.length} total
              </CardDescription>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {listings.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No listings yet. List this item on a marketplace to start tracking.
            </p>
          ) : (
            <div className="space-y-3">
              {listings.map((listing) => (
                <div
                  key={listing.id}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {formatLabel(listing.platform)}
                      </span>
                      <Badge
                        variant="outline"
                        className={cn(
                          listing.is_active
                            ? "border-green-200 bg-green-100 text-green-800"
                            : "border-slate-200 bg-slate-100 text-slate-600"
                        )}
                      >
                        {listing.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {formatCurrency(listing.listing_price)} · Listed{" "}
                      {formatDate(listing.listed_at)}
                    </p>
                  </div>
                  {listing.listing_url && (
                    <Button variant="ghost" size="sm" asChild>
                      <a
                        href={listing.listing_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sale Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <ShoppingCart className="mr-1.5 inline-block h-4 w-4" />
            Sales
          </CardTitle>
        </CardHeader>
        <CardContent>
          {sales.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No sales recorded yet.
            </p>
          ) : (
            <div className="space-y-3">
              {sales.map((sale) => (
                <div
                  key={sale.id}
                  className="rounded-lg border p-3"
                >
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                    <div>
                      <p className="text-muted-foreground">Sale Price</p>
                      <p className="font-medium">{formatCurrency(sale.sale_price)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Platform Fees</p>
                      <p className="font-medium">{formatCurrency(sale.platform_fees)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Sale Date</p>
                      <p className="font-medium">{formatDate(sale.sale_date)}</p>
                    </div>
                    {sale.buyer_username && (
                      <div>
                        <p className="text-muted-foreground">Buyer</p>
                        <p className="font-medium">{sale.buyer_username}</p>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Shipment Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <Truck className="mr-1.5 inline-block h-4 w-4" />
            Shipments
          </CardTitle>
        </CardHeader>
        <CardContent>
          {shipments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No shipments recorded yet.
            </p>
          ) : (
            <div className="space-y-3">
              {shipments.map((shipment) => (
                <div
                  key={shipment.id}
                  className="rounded-lg border p-3"
                >
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                    <div>
                      <p className="text-muted-foreground">Carrier</p>
                      <p className="font-medium">{shipment.carrier}</p>
                    </div>
                    {shipment.tracking_number && (
                      <div>
                        <p className="text-muted-foreground">Tracking</p>
                        <p className="font-medium">{shipment.tracking_number}</p>
                      </div>
                    )}
                    <div>
                      <p className="text-muted-foreground">Shipping Cost</p>
                      <p className="font-medium">
                        {formatCurrency(shipment.shipping_cost + shipment.label_cost)}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Ship Date</p>
                      <p className="font-medium">{formatDate(shipment.ship_date)}</p>
                    </div>
                    {shipment.delivery_date && (
                      <div>
                        <p className="text-muted-foreground">Delivered</p>
                        <p className="font-medium">{formatDate(shipment.delivery_date)}</p>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Profit/Loss Summary */}
      {hasSales && (
        <>
          <Separator />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                <DollarSign className="mr-1.5 inline-block h-4 w-4" />
                Profit / Loss Summary
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Sale Revenue</span>
                  <span className="font-medium">{formatCurrency(totalSaleRevenue)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Acquired Price</span>
                  <span className="font-medium">
                    −{formatCurrency(acquiredPrice)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Platform Fees</span>
                  <span className="font-medium">
                    −{formatCurrency(totalPlatformFees)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Shipping Costs</span>
                  <span className="font-medium">
                    −{formatCurrency(totalShippingCost)}
                  </span>
                </div>
                <Separator />
                <div className="flex justify-between text-base font-semibold">
                  <span>Net Profit</span>
                  <span
                    className={cn(
                      netProfit >= 0 ? "text-green-600" : "text-red-600"
                    )}
                  >
                    {formatCurrency(netProfit)}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
