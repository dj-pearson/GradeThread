import { DollarSign } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SourcedBySelect } from "@/components/flipdesk/sourced-by-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ITEM_CATEGORIES,
  ITEM_CATEGORY_LABELS,
  ITEM_STATUSES,
  ITEM_STATUS_LABELS,
} from "@/lib/constants";
import { SALE_OWNED_STATUSES } from "@/lib/composer-save";
import type { ItemCategory, ItemStatus } from "@/types/database";

export interface ItemDetailsCardProps {
  /** The item's PERSISTED status — not the pending pick. */
  currentStatus: ItemStatus;
  status: ItemStatus;
  onStatusChange: (next: ItemStatus) => void;
  category: ItemCategory | "";
  /** Fires with the pick AND the fact that a human made it (categoryTouched). */
  onCategoryChange: (next: ItemCategory | "") => void;
  sourcedBy: string;
  onSourcedByChange: (next: string) => void;
  acquiredDate: string;
  onAcquiredDateChange: (next: string) => void;
  /** Opens RecordSaleDialog — the only path to a sold status (US-2260). */
  onRecordSale: () => void;
}

// The item-level bookkeeping that used to live only on the status-gated item
// canvas. Saved by the composer's main Save, at every status, so nothing here is
// reachable at one status and not another.
//
// Brand / size / color / material deliberately aren't repeated here: they're
// owned by the eBay item specifics editor and folded back into their columns on
// save (single-entry rule, US-557).
export function ItemDetailsCard({
  currentStatus,
  status,
  onStatusChange,
  category,
  onCategoryChange,
  sourcedBy,
  onSourcedByChange,
  acquiredDate,
  onAcquiredDateChange,
  onRecordSale,
}: ItemDetailsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Item details</CardTitle>
        <CardDescription>
          Pipeline status and sourcing — saved to the item alongside your listing
          edits.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="item-status">Status</Label>
          {/* US-2260: the terminal sale statuses are NOT selectable here.
              resolveStatus lets a deliberate non-prep pick win outright, so
              choosing "Sold" wrote inventory_items.status='sold' with no sales
              row behind it — Sold totals, P&L and reconciliation then disagree
              with inventory, and nothing surfaces the discrepancy. Recording the
              sale is what makes an item sold; picking a word from a dropdown
              isn't. */}
          <Select value={status} onValueChange={(v) => onStatusChange(v as ItemStatus)}>
            <SelectTrigger id="item-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ITEM_STATUSES.filter(
                (s) =>
                  // Keep the CURRENT status listed even when terminal, so an
                  // already-sold item's select isn't showing a lie.
                  s === currentStatus || !SALE_OWNED_STATUSES.has(s),
              ).map((s) => (
                <SelectItem key={s} value={s}>
                  {ITEM_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            Prep stages only move forward — completed work can't be undone by
            picking an earlier stage.
          </p>
          {!SALE_OWNED_STATUSES.has(currentStatus) && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[11px] text-muted-foreground">Sold this item?</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={onRecordSale}
              >
                <DollarSign className="mr-1 h-3 w-3" />
                Record the sale
              </Button>
              <p className="text-[11px] text-muted-foreground">
                That captures the price and fees, and sets the status.
              </p>
            </div>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="item-category">Category</Label>
          <Select
            value={category || "__none"}
            onValueChange={(v) =>
              onCategoryChange(v === "__none" ? "" : (v as ItemCategory))
            }
          >
            <SelectTrigger id="item-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">— None —</SelectItem>
              {ITEM_CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {ITEM_CATEGORY_LABELS[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            The coarse grading category. Picking an eBay category above keeps this
            in sync unless you set it here yourself.
          </p>
        </div>
        <SourcedBySelect
          id="item-sourced-by"
          value={sourcedBy}
          onChange={onSourcedByChange}
        />
        <div className="space-y-1.5">
          <Label htmlFor="item-acquired-date">Purchase date</Label>
          <Input
            id="item-acquired-date"
            type="date"
            value={acquiredDate}
            onChange={(e) => onAcquiredDateChange(e.target.value)}
          />
        </div>
      </CardContent>
    </Card>
  );
}
