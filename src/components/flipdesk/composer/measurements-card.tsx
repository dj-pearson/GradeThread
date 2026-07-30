import { MeasurementForm } from "@/components/flipdesk/measurement-form";
import { MeasurementPhotoEditor } from "@/components/flipdesk/measurement-photo-editor";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ItemFullRow } from "@/types/database";
export interface MeasurementsCardProps {
  item: ItemFullRow;
  measurements: Record<string, number | string>;
  setMeasurements: (next: Record<string, number | string>) => void;
}
// Flat measurements buyers ask about (US-1567) plus the US-1574 calibrated
// photo measuring. Synced live with matching free-text eBay item specifics, which
// is why this card sits ABOVE the specifics editor (US-2252).
export function MeasurementsCard({
  item,
  measurements,
  setMeasurements,
}: MeasurementsCardProps) {
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
          category={item.category}
          brand={item.brand}
          values={measurements}
          onChange={setMeasurements}
          aiSources={item.ai_field_sources ?? null}
        />
        {/* US-1574: calibrated photo measuring — renders only when the
            item has a MeasureCard shot; drag-adjust + save syncs the
            same measurements state the form above edits. */}
        <MeasurementPhotoEditor
          itemId={item.id}
          category={item.category}
          values={measurements}
          aiSources={item.ai_field_sources ?? null}
          onApply={(next) => setMeasurements(next)}
        />
      </CardContent>
    </Card>
  );
}