import { MeasurementForm } from "@/components/flipdesk/measurement-form";
import { MeasurementPhotoEditor } from "@/components/flipdesk/measurement-photo-editor";
import { FitWidget } from "@/components/fit/fit-widget";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ItemFullRow } from "@/types/database";
export interface MeasurementsCardProps {
  item: ItemFullRow;
  /** US-2595: the garment word ("blazer", "shorts"). `item.category` is the
   *  items_full COALESCE column, which reads "clothing" on any item with a
   *  vertical set — and "clothing" resolves to the generic length+width
   *  template, so the fields a buyer actually asks for were never offered. */
  garment?: string | null;
  /** US-2918: the item's department, for resolving the brand's size chart. */
  gender?: string | null;
  measurements: Record<string, number | string>;
  setMeasurements: (next: Record<string, number | string>) => void;
  /** US-2918: write the item's size from the discrepancy note's one-click fix. */
  onSizeChange?: (nextSize: string) => void;
}
// Flat measurements buyers ask about (US-1567) plus the US-1574 calibrated
// photo measuring. Synced live with matching free-text eBay item specifics, which
// is why this card sits ABOVE the specifics editor (US-2252).
export function MeasurementsCard({
  item,
  garment,
  gender,
  measurements,
  setMeasurements,
  onSizeChange,
}: MeasurementsCardProps) {
  const category = garment ?? item.category;
  return (
    <Card id="composer-measurements">
      <CardHeader>
        <CardTitle>Measurements</CardTitle>
        <CardDescription>
          Flat measurements buyers ask about. Synced live with matching
          free-text eBay item specifics (Inseam, Length, Chest, …).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <MeasurementForm
          category={category}
          brand={item.brand}
          style={item.style}
          values={measurements}
          onChange={setMeasurements}
          aiSources={item.ai_field_sources ?? null}
          size={item.size}
          garmentCategory={item.garment_category ?? category}
          gender={gender}
          onSizeChange={onSizeChange}
        />
        {/* US-1574: calibrated photo measuring — renders only when the
            item has a MeasureCard shot; drag-adjust + save syncs the
            same measurements state the form above edits. */}
        <MeasurementPhotoEditor
          itemId={item.id}
          category={category}
          values={measurements}
          aiSources={item.ai_field_sources ?? null}
          onApply={(next) => setMeasurements(next)}
        />
        {/* US-1779/US-2264: buyer fit preview from these flat-lay measurements vs
            the viewer's saved body profile. Renders nothing without measurements.
            It only ever existed on the unmounted ItemCanvas. */}
        <FitWidget garmentMeasurements={measurements} category={category} />
      </CardContent>
    </Card>
  );
}