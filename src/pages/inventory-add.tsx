import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Package } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { todayLocalDate } from "@/lib/local-date";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import { useWorkspace } from "@/hooks/use-workspace";
import { GARMENT_TYPES, GARMENT_CATEGORIES } from "@/lib/constants";
import type { InventoryItemRow, InventoryItemInsert } from "@/types/database";

const ACQUISITION_SOURCES = [
  "thrift_store",
  "auction",
  "wholesale",
  "estate_sale",
  "garage_sale",
  "online_marketplace",
  "consignment",
  "personal_closet",
  "other",
] as const;

function formatLabel(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function todayString(): string {
  // US-1636: local calendar day, not UTC — an evening user west of UTC would
  // otherwise default to tomorrow's date and break tax-year / payout matching.
  return todayLocalDate();
}

export function InventoryAddPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { workspaceOwnerId, can } = useWorkspace();
  const [submitting, setSubmitting] = useState(false);

  // Form state
  const [title, setTitle] = useState("");
  const [brand, setBrand] = useState("");
  const [garmentType, setGarmentType] = useState("");
  const [garmentCategory, setGarmentCategory] = useState("");
  const [size, setSize] = useState("");
  const [color, setColor] = useState("");
  const [acquiredPrice, setAcquiredPrice] = useState("");
  const [acquiredDate, setAcquiredDate] = useState(todayString());
  const [acquiredSource, setAcquiredSource] = useState("");
  const [conditionNotes, setConditionNotes] = useState("");

  const isValid = title.trim().length > 0 && acquiredPrice.trim().length > 0;

  async function handleSubmit(e: React.FormEvent, submitForGrading: boolean) {
    e.preventDefault();
    if (!user || !workspaceOwnerId || !isValid) return;
    if (!can("manage_inventory")) {
      toast.error("You don't have permission to add inventory in this workspace.");
      return;
    }

    setSubmitting(true);
    try {
      const priceNum = parseFloat(acquiredPrice);
      if (isNaN(priceNum) || priceNum < 0) {
        toast.error("Please enter a valid acquisition price.");
        setSubmitting(false);
        return;
      }

      const insertData: InventoryItemInsert = {
        user_id: workspaceOwnerId,
        title: title.trim(),
        brand: brand.trim() || null,
        garment_type: (garmentType as InventoryItemInsert["garment_type"]) || null,
        garment_category: (garmentCategory as InventoryItemInsert["garment_category"]) || null,
        size: size.trim() || null,
        color: color.trim() || null,
        acquired_price: priceNum,
        acquired_date: acquiredDate || null,
        acquired_source: acquiredSource || null,
        condition_notes: conditionNotes.trim() || null,
        status: "acquired",
      };

      const { data, error } = await supabase
        .from("inventory_items")
        .insert(insertData as never)
        .select("id")
        .single();

      if (error) throw error;

      const item = data as Pick<InventoryItemRow, "id">;

      // US-1630: a new item must appear in the list the user lands on — the
      // inventory list, brand filter, and pipeline (items_full) all read cached
      // queries, so invalidate them before navigating away.
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-brands"] });
      queryClient.invalidateQueries({ queryKey: ["items_full"] });

      toast.success("Item added to inventory!");

      if (submitForGrading) {
        // US-1417: pass the new item id so the grading flow prefills title,
        // brand, garment type/category, and description from the item the user
        // just entered (new-submission reads ?item= and builds garmentDefaults
        // from the linked inventory row) instead of re-asking for all of it.
        navigate(`/dashboard/submissions/new?item=${item.id}`);
      } else {
        navigate(`/dashboard/inventory/${item.id}`);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to add item";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2"
          onClick={() => navigate("/dashboard/inventory")}
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back
        </Button>
        <PageHeader
          title="Add Inventory Item"
          subtitle="Track a new garment from acquisition through sale."
        />
      </div>

      <form onSubmit={(e) => handleSubmit(e, false)}>
        {/* Garment Details */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Package className="h-4 w-4" />
              Garment Details
            </CardTitle>
            <CardDescription>
              Describe the garment you&apos;re adding to inventory.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">
                Title <span className="text-destructive">*</span>
              </Label>
              <Input
                id="title"
                placeholder="e.g. Vintage Levi's 501 Jeans"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="brand">Brand</Label>
                <Input
                  id="brand"
                  placeholder="e.g. Nike, Levi's"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="color">Color</Label>
                <Input
                  id="color"
                  placeholder="e.g. Navy Blue"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>Garment Type</Label>
                <Select value={garmentType} onValueChange={setGarmentType}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {GARMENT_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {formatLabel(t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Category</Label>
                <Select
                  value={garmentCategory}
                  onValueChange={setGarmentCategory}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    {GARMENT_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {formatLabel(c)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="size">Size</Label>
                <Input
                  id="size"
                  placeholder="e.g. M, 32x30"
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="conditionNotes">Condition Notes</Label>
              <Textarea
                id="conditionNotes"
                placeholder="Describe any visible wear, defects, or notable features..."
                value={conditionNotes}
                onChange={(e) => setConditionNotes(e.target.value)}
                rows={3}
              />
            </div>
          </CardContent>
        </Card>

        <Separator className="my-6" />

        {/* Acquisition Details */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Acquisition Details</CardTitle>
            <CardDescription>
              Where and when you acquired this item, and how much you paid.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="acquiredPrice">
                  Acquired Price <span className="text-destructive">*</span>
                </Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    $
                  </span>
                  <Input
                    id="acquiredPrice"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    className="pl-7"
                    value={acquiredPrice}
                    onChange={(e) => setAcquiredPrice(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="acquiredDate">Acquired Date</Label>
                <Input
                  id="acquiredDate"
                  type="date"
                  value={acquiredDate}
                  onChange={(e) => setAcquiredDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Source</Label>
                <Select value={acquiredSource} onValueChange={setAcquiredSource}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select source" />
                  </SelectTrigger>
                  <SelectContent>
                    {ACQUISITION_SOURCES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {formatLabel(s)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        <Separator className="my-6" />

        {/* Actions */}
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate("/dashboard/inventory")}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!isValid || submitting}
            onClick={(e) => handleSubmit(e, true)}
          >
            {submitting ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : null}
            Save & Submit for Grading
          </Button>
          <Button type="submit" disabled={!isValid || submitting}>
            {submitting ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : null}
            Add to Inventory
          </Button>
        </div>
      </form>
    </div>
  );
}
