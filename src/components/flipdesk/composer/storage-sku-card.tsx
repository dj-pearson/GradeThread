import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface StorageSkuCardProps {
  sku: string;
  onSkuChange: (next: string) => void;
  location: string;
  onLocationChange: (next: string) => void;
  container: string;
  onContainerChange: (next: string) => void;
}

// Where the physical item lives and how it's labelled. Saved to inventory_items
// rather than the eBay listing — but by the composer's ONE Save, not a button of
// its own (US-2249: the separate "Save storage" meant "Save draft" silently threw
// away a SKU typed seconds earlier).
export function StorageSkuCard({
  sku,
  onSkuChange,
  location,
  onLocationChange,
  container,
  onContainerChange,
}: StorageSkuCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Storage &amp; SKU</CardTitle>
        <CardDescription>
          Where this item lives and how it's labeled. Saved to the item rather
          than the eBay listing, by the same Save button as everything else on
          this page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="storage-sku">SKU / Item #</Label>
            <Input
              id="storage-sku"
              value={sku}
              onChange={(e) => onSkuChange(e.target.value)}
              placeholder="e.g. FD-1a2b"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="storage-location">Location / Bin</Label>
            <Input
              id="storage-location"
              value={location}
              onChange={(e) => onLocationChange(e.target.value)}
              placeholder="e.g. Tote A3"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="storage-container">Container</Label>
            <Input
              id="storage-container"
              value={container}
              onChange={(e) => onContainerChange(e.target.value)}
              placeholder="e.g. Bin 7"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
