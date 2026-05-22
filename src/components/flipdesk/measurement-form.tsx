import { ExternalLink } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useMeasurementPrefs } from "@/stores/measurement-prefs";
import {
  MEASUREMENT_TEMPLATES,
  measurementGroupFor,
  sizeGuideUrl,
  type MeasurementField,
} from "@/lib/measurement-templates";

type MeasurementValues = Record<string, number | string>;

interface Props {
  category: string | null | undefined;
  brand: string | null | undefined;
  values: MeasurementValues;
  onChange: (next: MeasurementValues) => void;
}

function unitSuffix(field: MeasurementField, lengthUnit: "in" | "cm"): string {
  if (field.unit === "length") return lengthUnit;
  if (field.unit === "mm") return "mm";
  return "US";
}

export function MeasurementForm({ category, brand, values, onChange }: Props) {
  const { unit, setUnit } = useMeasurementPrefs();
  const group = measurementGroupFor(category);
  const template = MEASUREMENT_TEMPLATES[group];

  const requiredKeys = template.filter((f) => f.required).map((f) => f.key);
  const filledRequired = requiredKeys.filter(
    (k) => values[k] != null && String(values[k]).trim() !== "",
  ).length;
  const allRequiredFilled =
    requiredKeys.length > 0 && filledRequired === requiredKeys.length;

  function set(key: string, raw: string) {
    const next = { ...values };
    if (raw.trim() === "") delete next[key];
    else next[key] = raw;
    onChange(next);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="capitalize">
            {group} template
          </Badge>
          {requiredKeys.length > 0 && (
            <Badge variant={allRequiredFilled ? "default" : "secondary"}>
              {filledRequired}/{requiredKeys.length} required
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {brand && (
            <a
              href={sizeGuideUrl(brand)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-brand-red hover:underline"
            >
              {brand} size guide
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {/* in / cm toggle — applies to length fields */}
          <div className="flex overflow-hidden rounded-md border text-xs">
            {(["in", "cm"] as const).map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => setUnit(u)}
                className={cn(
                  "px-2 py-0.5",
                  unit === u
                    ? "bg-brand-navy text-white"
                    : "hover:bg-muted",
                )}
              >
                {u}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {template.map((field) => (
          <div key={field.key} className="space-y-1">
            <Label className="text-xs">
              {field.label}
              {field.required && (
                <span className="ml-1 text-destructive">*</span>
              )}
            </Label>
            <div className="relative">
              <Input
                type="number"
                inputMode="decimal"
                value={values[field.key] ?? ""}
                onChange={(e) => set(field.key, e.target.value)}
                className="pr-10"
              />
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                {unitSuffix(field, unit)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
