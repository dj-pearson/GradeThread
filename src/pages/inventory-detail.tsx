import { useEffect, useState, useMemo } from "react";
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
  Plus,
  Lightbulb,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { ITEM_STATUSES, LISTING_PLATFORMS } from "@/lib/constants";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import type {
  InventoryItemRow,
  ListingRow,
  ListingPlatform,
  SaleRow,
  ShipmentRow,
  ItemStatus,
  GradeReportRow,
} from "@/types/database";
import { calculateSuggestedPrice } from "@/lib/price-suggestions";
import { InventoryItemSuggestions } from "@/components/analytics/listing-suggestions";

const CARRIERS = [
  { value: "usps", label: "USPS" },
  { value: "ups", label: "UPS" },
  { value: "fedex", label: "FedEx" },
  { value: "dhl", label: "DHL" },
  { value: "other", label: "Other" },
] as const;

const PLATFORM_LABELS: Record<string, string> = {
  ebay: "eBay",
  poshmark: "Poshmark",
  mercari: "Mercari",
  depop: "Depop",
  grailed: "Grailed",
  facebook: "Facebook Marketplace",
  offerup: "OfferUp",
  other: "Other",
};

function formatLabel(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatPlatform(platform: string): string {
  return PLATFORM_LABELS[platform] ?? formatLabel(platform);
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

  // Add Listing dialog state
  const [addListingOpen, setAddListingOpen] = useState(false);
  const [addListingSubmitting, setAddListingSubmitting] = useState(false);
  const [listingPlatform, setListingPlatform] = useState<ListingPlatform>("ebay");
  const [listingPrice, setListingPrice] = useState("");
  const [listingUrl, setListingUrl] = useState("");
  const [platformListingId, setPlatformListingId] = useState("");
  const [togglingListingId, setTogglingListingId] = useState<string | null>(null);

  // Record Sale dialog state
  const [recordSaleOpen, setRecordSaleOpen] = useState(false);
  const [recordSaleSubmitting, setRecordSaleSubmitting] = useState(false);
  const [saleListingId, setSaleListingId] = useState<string>("none");
  const [salePrice, setSalePrice] = useState("");
  const [salePlatformFees, setSalePlatformFees] = useState("");
  const [saleDate, setSaleDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [saleBuyerUsername, setSaleBuyerUsername] = useState("");

  // Record Shipment dialog state
  const [recordShipmentOpen, setRecordShipmentOpen] = useState(false);
  const [recordShipmentSubmitting, setRecordShipmentSubmitting] = useState(false);
  const [shipmentSaleId, setShipmentSaleId] = useState<string>("");
  const [shipmentCarrier, setShipmentCarrier] = useState("usps");
  const [shipmentTrackingNumber, setShipmentTrackingNumber] = useState("");
  const [shipmentCost, setShipmentCost] = useState("");
  const [shipmentLabelCost, setShipmentLabelCost] = useState("");
  const [shipmentDate, setShipmentDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [shipmentWeightOz, setShipmentWeightOz] = useState("");
  const [deliveringShipmentId, setDeliveringShipmentId] = useState<string | null>(null);
  const [gradeReport, setGradeReport] = useState<GradeReportRow | null>(null);
  const [allUserItems, setAllUserItems] = useState<InventoryItemRow[]>([]);
  const [allUserSales, setAllUserSales] = useState<SaleRow[]>([]);

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

      // Fetch grade report if available
      const currentItem = itemData as InventoryItemRow;
      if (currentItem.grade_report_id) {
        const { data: gradeData } = await supabase
          .from("grade_reports")
          .select("*")
          .eq("id", currentItem.grade_report_id)
          .single();
        if (gradeData) {
          setGradeReport(gradeData as GradeReportRow);
        }
      }

      // Fetch all user items and sales for price suggestion comparisons
      const { data: userItemsRaw } = await supabase
        .from("inventory_items")
        .select("*")
        .eq("user_id", currentItem.user_id);
      setAllUserItems((userItemsRaw ?? []) as InventoryItemRow[]);

      const { data: userSalesRaw } = await supabase
        .from("sales")
        .select("*");
      setAllUserSales((userSalesRaw ?? []) as SaleRow[]);

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

  async function handleAddListing() {
    if (!item) return;
    const price = parseFloat(listingPrice);
    if (isNaN(price) || price <= 0) {
      toast.error("Please enter a valid listing price.");
      return;
    }

    setAddListingSubmitting(true);

    const { data: newListing, error: insertError } = await supabase
      .from("listings")
      .insert({
        inventory_item_id: item.id,
        platform: listingPlatform,
        listing_price: price,
        listing_url: listingUrl.trim() || null,
        platform_listing_id: platformListingId.trim() || null,
        is_active: true,
      } as never)
      .select()
      .single();

    if (insertError) {
      toast.error("Failed to add listing.");
      setAddListingSubmitting(false);
      return;
    }

    const created = newListing as ListingRow;
    setListings((prev) => [created, ...prev]);

    // Update item status to 'listed' if currently 'graded' or 'acquired'
    if (item.status === "graded" || item.status === "acquired") {
      const { error: statusError } = await supabase
        .from("inventory_items")
        .update({ status: "listed" } as never)
        .eq("id", item.id);

      if (!statusError) {
        setItem({ ...item, status: "listed" });
      }
    }

    // Reset form
    setListingPlatform("ebay");
    setListingPrice("");
    setListingUrl("");
    setPlatformListingId("");
    setAddListingOpen(false);
    setAddListingSubmitting(false);
    toast.success(`Listing added on ${formatPlatform(listingPlatform)}.`);
  }

  async function handleToggleListing(listing: ListingRow) {
    setTogglingListingId(listing.id);
    const newActive = !listing.is_active;

    const { error: updateError } = await supabase
      .from("listings")
      .update({ is_active: newActive } as never)
      .eq("id", listing.id);

    if (updateError) {
      toast.error("Failed to update listing.");
    } else {
      setListings((prev) =>
        prev.map((l) => (l.id === listing.id ? { ...l, is_active: newActive } : l))
      );
      toast.success(`Listing marked as ${newActive ? "active" : "inactive"}.`);
    }
    setTogglingListingId(null);
  }

  async function handleRecordSale() {
    if (!item) return;
    const price = parseFloat(salePrice);
    if (isNaN(price) || price <= 0) {
      toast.error("Please enter a valid sale price.");
      return;
    }
    const fees = salePlatformFees ? parseFloat(salePlatformFees) : 0;
    if (isNaN(fees) || fees < 0) {
      toast.error("Please enter valid platform fees.");
      return;
    }

    setRecordSaleSubmitting(true);

    const linkedListingId = saleListingId === "none" ? null : saleListingId;

    // Create sale record
    const { data: newSale, error: saleError } = await supabase
      .from("sales")
      .insert({
        inventory_item_id: item.id,
        listing_id: linkedListingId,
        sale_price: price,
        platform_fees: fees,
        sale_date: saleDate,
        buyer_username: saleBuyerUsername.trim() || null,
      } as never)
      .select()
      .single();

    if (saleError) {
      toast.error("Failed to record sale.");
      setRecordSaleSubmitting(false);
      return;
    }

    const createdSale = newSale as SaleRow;
    setSales((prev) => [createdSale, ...prev]);

    // Mark ALL listings for this item as inactive (cross-listing cleanup)
    const activeListingIds = listings.filter((l) => l.is_active).map((l) => l.id);
    if (activeListingIds.length > 0) {
      await supabase
        .from("listings")
        .update({ is_active: false } as never)
        .in("id", activeListingIds);

      setListings((prev) =>
        prev.map((l) => (activeListingIds.includes(l.id) ? { ...l, is_active: false } : l))
      );
    }

    // Update item status to 'sold'
    const { error: statusError } = await supabase
      .from("inventory_items")
      .update({ status: "sold" } as never)
      .eq("id", item.id);

    if (!statusError) {
      setItem({ ...item, status: "sold" });
    }

    // Reset form
    setSaleListingId("none");
    setSalePrice("");
    setSalePlatformFees("");
    setSaleDate(new Date().toISOString().split("T")[0]);
    setSaleBuyerUsername("");
    setRecordSaleOpen(false);
    setRecordSaleSubmitting(false);
    toast.success("Sale recorded successfully.");
  }

  async function handleRecordShipment() {
    if (!item) return;
    const cost = parseFloat(shipmentCost);
    if (isNaN(cost) || cost < 0) {
      toast.error("Please enter a valid shipping cost.");
      return;
    }
    const labelCost = shipmentLabelCost ? parseFloat(shipmentLabelCost) : 0;
    if (isNaN(labelCost) || labelCost < 0) {
      toast.error("Please enter a valid label cost.");
      return;
    }
    const weightOz = shipmentWeightOz ? parseFloat(shipmentWeightOz) : null;
    if (shipmentWeightOz && (isNaN(weightOz!) || weightOz! < 0)) {
      toast.error("Please enter a valid weight.");
      return;
    }

    if (!shipmentSaleId) {
      toast.error("Please select a sale to link this shipment to.");
      return;
    }

    setRecordShipmentSubmitting(true);

    const carrierLabel = CARRIERS.find((c) => c.value === shipmentCarrier)?.label ?? shipmentCarrier;

    const { data: newShipment, error: shipmentError } = await supabase
      .from("shipments")
      .insert({
        sale_id: shipmentSaleId,
        carrier: carrierLabel,
        tracking_number: shipmentTrackingNumber.trim() || null,
        shipping_cost: cost,
        label_cost: labelCost,
        ship_date: shipmentDate || null,
        weight_oz: weightOz,
      } as never)
      .select()
      .single();

    if (shipmentError) {
      toast.error("Failed to record shipment.");
      setRecordShipmentSubmitting(false);
      return;
    }

    const created = newShipment as ShipmentRow;
    setShipments((prev) => [created, ...prev]);

    // Update item status to 'shipped'
    const { error: statusError } = await supabase
      .from("inventory_items")
      .update({ status: "shipped" } as never)
      .eq("id", item.id);

    if (!statusError) {
      setItem({ ...item, status: "shipped" });
    }

    // Reset form
    setShipmentSaleId("");
    setShipmentCarrier("usps");
    setShipmentTrackingNumber("");
    setShipmentCost("");
    setShipmentLabelCost("");
    setShipmentDate(new Date().toISOString().split("T")[0]);
    setShipmentWeightOz("");
    setRecordShipmentOpen(false);
    setRecordShipmentSubmitting(false);
    toast.success("Shipment recorded successfully.");
  }

  async function handleMarkDelivered(shipment: ShipmentRow) {
    if (!item) return;
    setDeliveringShipmentId(shipment.id);

    const today = new Date().toISOString().split("T")[0];
    const { error: updateError } = await supabase
      .from("shipments")
      .update({ delivery_date: today } as never)
      .eq("id", shipment.id);

    if (updateError) {
      toast.error("Failed to mark as delivered.");
      setDeliveringShipmentId(null);
      return;
    }

    setShipments((prev) =>
      prev.map((s) =>
        s.id === shipment.id ? ({ ...s, delivery_date: today } as ShipmentRow) : s
      )
    );

    // Update item status to 'completed'
    const { error: statusError } = await supabase
      .from("inventory_items")
      .update({ status: "completed" } as never)
      .eq("id", item.id);

    if (!statusError) {
      setItem({ ...item, status: "completed" });
    }

    setDeliveringShipmentId(null);
    toast.success("Shipment marked as delivered.");
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

  // Price suggestion
  const priceSuggestion = useMemo(() => {
    if (item.status === "sold" || item.status === "shipped" || item.status === "completed" || item.status === "returned") {
      return null;
    }
    const salesHistory = allUserSales
      .map((sale) => {
        const saleItem = allUserItems.find((i) => i.id === sale.inventory_item_id);
        if (!saleItem) return null;
        return { item: saleItem, sale, grade: null as number | null };
      })
      .filter((h): h is NonNullable<typeof h> => h !== null);

    const grade = gradeReport?.overall_score ?? null;
    return calculateSuggestedPrice(item, grade, listings, salesHistory);
  }, [item, gradeReport, listings, allUserSales, allUserItems]);

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
            <div className="flex items-center gap-3">
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
            <Dialog open={addListingOpen} onOpenChange={setAddListingOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <Plus className="mr-1.5 h-4 w-4" />
                  Add Listing
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Listing</DialogTitle>
                  <DialogDescription>
                    Record a marketplace listing for this item.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-2">
                  <div className="space-y-2">
                    <Label htmlFor="listing-platform">Platform</Label>
                    <Select
                      value={listingPlatform}
                      onValueChange={(v) => setListingPlatform(v as ListingPlatform)}
                    >
                      <SelectTrigger id="listing-platform">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LISTING_PLATFORMS.map((p) => (
                          <SelectItem key={p} value={p}>
                            {formatPlatform(p)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="listing-price">Listing Price ($)</Label>
                    <Input
                      id="listing-price"
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={listingPrice}
                      onChange={(e) => setListingPrice(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="listing-url">Listing URL (optional)</Label>
                    <Input
                      id="listing-url"
                      type="url"
                      placeholder="https://..."
                      value={listingUrl}
                      onChange={(e) => setListingUrl(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="platform-listing-id">
                      Platform Listing ID (optional)
                    </Label>
                    <Input
                      id="platform-listing-id"
                      placeholder="For API integrations"
                      value={platformListingId}
                      onChange={(e) => setPlatformListingId(e.target.value)}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setAddListingOpen(false)}
                    disabled={addListingSubmitting}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleAddListing}
                    disabled={addListingSubmitting || !listingPrice}
                  >
                    {addListingSubmitting ? "Adding..." : "Add Listing"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
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
                        {formatPlatform(listing.platform)}
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
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleToggleListing(listing)}
                      disabled={togglingListingId === listing.id}
                    >
                      {togglingListingId === listing.id
                        ? "..."
                        : listing.is_active
                          ? "Deactivate"
                          : "Activate"}
                    </Button>
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
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Price Suggestion Callout */}
      {priceSuggestion && priceSuggestion.suggestedPrice !== null && (
        <Card
          className={cn(
            "border-l-4",
            priceSuggestion.severity === "urgent"
              ? "border-l-red-500 bg-red-50"
              : priceSuggestion.severity === "warning"
                ? "border-l-yellow-500 bg-yellow-50"
                : "border-l-blue-500 bg-blue-50"
          )}
        >
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Lightbulb
                className={cn(
                  "h-4 w-4",
                  priceSuggestion.severity === "urgent"
                    ? "text-red-600"
                    : priceSuggestion.severity === "warning"
                      ? "text-yellow-600"
                      : "text-blue-600"
                )}
              />
              Price Suggestion
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <p>{priceSuggestion.reason}</p>
              <div className="flex items-center gap-4">
                {priceSuggestion.currentPrice !== null && (
                  <div>
                    <span className="text-muted-foreground">Current: </span>
                    <span className="font-medium">
                      {formatCurrency(priceSuggestion.currentPrice)}
                    </span>
                  </div>
                )}
                <div>
                  <span className="text-muted-foreground">Suggested: </span>
                  <span className="font-semibold">
                    {formatCurrency(priceSuggestion.suggestedPrice)}
                  </span>
                </div>
                {priceSuggestion.adjustmentPercent !== null && (
                  <Badge
                    variant="outline"
                    className={cn(
                      priceSuggestion.adjustmentPercent > 0
                        ? "border-green-200 bg-green-100 text-green-800"
                        : "border-red-200 bg-red-100 text-red-800"
                    )}
                  >
                    {priceSuggestion.adjustmentPercent > 0 ? "+" : ""}
                    {priceSuggestion.adjustmentPercent}%
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {priceSuggestion.action}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Listing Optimization Suggestions */}
      <InventoryItemSuggestions
        item={item}
        listings={listings}
        gradeReport={gradeReport}
      />

      {/* Sale Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              <ShoppingCart className="mr-1.5 inline-block h-4 w-4" />
              Sales
            </CardTitle>
            <Dialog open={recordSaleOpen} onOpenChange={setRecordSaleOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <Plus className="mr-1.5 h-4 w-4" />
                  Record Sale
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Record Sale</DialogTitle>
                  <DialogDescription>
                    Record a sale for this item. All active listings will be
                    deactivated automatically.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-2">
                  <div className="space-y-2">
                    <Label htmlFor="sale-listing">Linked Listing</Label>
                    <Select
                      value={saleListingId}
                      onValueChange={setSaleListingId}
                    >
                      <SelectTrigger id="sale-listing">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No linked listing</SelectItem>
                        {listings
                          .filter((l) => l.is_active)
                          .map((l) => (
                            <SelectItem key={l.id} value={l.id}>
                              {formatPlatform(l.platform)} —{" "}
                              {formatCurrency(l.listing_price)}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="sale-price">Sale Price ($) *</Label>
                    <Input
                      id="sale-price"
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={salePrice}
                      onChange={(e) => setSalePrice(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="sale-platform-fees">
                      Platform Fees ($)
                    </Label>
                    <Input
                      id="sale-platform-fees"
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={salePlatformFees}
                      onChange={(e) => setSalePlatformFees(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="sale-date">Sale Date</Label>
                    <Input
                      id="sale-date"
                      type="date"
                      value={saleDate}
                      onChange={(e) => setSaleDate(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="sale-buyer">
                      Buyer Username (optional)
                    </Label>
                    <Input
                      id="sale-buyer"
                      placeholder="e.g. buyer123"
                      value={saleBuyerUsername}
                      onChange={(e) => setSaleBuyerUsername(e.target.value)}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setRecordSaleOpen(false)}
                    disabled={recordSaleSubmitting}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleRecordSale}
                    disabled={recordSaleSubmitting || !salePrice}
                  >
                    {recordSaleSubmitting ? "Recording..." : "Record Sale"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
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
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              <Truck className="mr-1.5 inline-block h-4 w-4" />
              Shipments
            </CardTitle>
            {(item.status === "sold" || item.status === "shipped") && sales.length > 0 && (
              <Dialog open={recordShipmentOpen} onOpenChange={(open) => {
                setRecordShipmentOpen(open);
                const firstSale = sales[0];
                if (open && sales.length === 1 && firstSale) {
                  setShipmentSaleId(firstSale.id);
                }
              }}>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Plus className="mr-1.5 h-4 w-4" />
                    Record Shipment
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Record Shipment</DialogTitle>
                    <DialogDescription>
                      Record shipping details for a sold item.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 py-2">
                    {sales.length > 1 && (
                      <div className="space-y-2">
                        <Label htmlFor="shipment-sale">Linked Sale</Label>
                        <Select
                          value={shipmentSaleId}
                          onValueChange={setShipmentSaleId}
                        >
                          <SelectTrigger id="shipment-sale">
                            <SelectValue placeholder="Select a sale" />
                          </SelectTrigger>
                          <SelectContent>
                            {sales.map((s) => (
                              <SelectItem key={s.id} value={s.id}>
                                {formatCurrency(s.sale_price)} — {formatDate(s.sale_date)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label htmlFor="shipment-carrier">Carrier</Label>
                      <Select
                        value={shipmentCarrier}
                        onValueChange={setShipmentCarrier}
                      >
                        <SelectTrigger id="shipment-carrier">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CARRIERS.map((c) => (
                            <SelectItem key={c.value} value={c.value}>
                              {c.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="shipment-tracking">
                        Tracking Number (optional)
                      </Label>
                      <Input
                        id="shipment-tracking"
                        placeholder="e.g. 1Z999AA10123456784"
                        value={shipmentTrackingNumber}
                        onChange={(e) => setShipmentTrackingNumber(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="shipment-cost">Shipping Cost ($) *</Label>
                      <Input
                        id="shipment-cost"
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="0.00"
                        value={shipmentCost}
                        onChange={(e) => setShipmentCost(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="shipment-label-cost">
                        Label Cost ($)
                      </Label>
                      <Input
                        id="shipment-label-cost"
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="0.00 (for pre-paid labels)"
                        value={shipmentLabelCost}
                        onChange={(e) => setShipmentLabelCost(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="shipment-date">Ship Date</Label>
                      <Input
                        id="shipment-date"
                        type="date"
                        value={shipmentDate}
                        onChange={(e) => setShipmentDate(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="shipment-weight">
                        Weight in oz (optional)
                      </Label>
                      <Input
                        id="shipment-weight"
                        type="number"
                        step="0.1"
                        min="0"
                        placeholder="e.g. 12.5"
                        value={shipmentWeightOz}
                        onChange={(e) => setShipmentWeightOz(e.target.value)}
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => setRecordShipmentOpen(false)}
                      disabled={recordShipmentSubmitting}
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={handleRecordShipment}
                      disabled={recordShipmentSubmitting || !shipmentCost}
                    >
                      {recordShipmentSubmitting ? "Recording..." : "Record Shipment"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
          </div>
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
                    {shipment.weight_oz && (
                      <div>
                        <p className="text-muted-foreground">Weight</p>
                        <p className="font-medium">{shipment.weight_oz} oz</p>
                      </div>
                    )}
                    {shipment.delivery_date && (
                      <div>
                        <p className="text-muted-foreground">Delivered</p>
                        <p className="font-medium">{formatDate(shipment.delivery_date)}</p>
                      </div>
                    )}
                  </div>
                  {!shipment.delivery_date && (
                    <div className="mt-3 flex justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleMarkDelivered(shipment)}
                        disabled={deliveringShipmentId === shipment.id}
                      >
                        <CheckCircle2 className="mr-1.5 h-4 w-4" />
                        {deliveringShipmentId === shipment.id
                          ? "Updating..."
                          : "Mark as Delivered"}
                      </Button>
                    </div>
                  )}
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
