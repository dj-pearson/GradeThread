import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Info } from "lucide-react";
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
import { useAuthStore } from "@/stores/auth-store";
import {
  bandFor,
  EMPTY_DRIFT,
  isOutsideBand,
  type MeasurementDrift,
} from "@/lib/measurement-drift";

type MeasurementValues = Record<string, number | string>;

interface AiSourceMeta {
  source: string;
  confidence: number;
  accepted: boolean;
}

interface Props {
  category: string | null | undefined;
  brand: string | null | undefined;
  values: MeasurementValues;
  onChange: (next: MeasurementValues) => void;
  /**
   * Map of ai_field_sources from the item. We look up keys prefixed
   * `measurements.<field>` and render an "AI" badge on those fields.
   */
  aiSources?: Record<string, AiSourceMeta> | null;
  /**
   * US-2827: the item's size. Supplying it turns on the live cohort check —
   * a value outside what other sellers record for the same size and garment
   * gets a note under the field. Omitted, the form behaves exactly as before.
   */
  size?: string | null;
  /** The garment category the cohort is keyed on. Defaults to `category`. */
  garmentCategory?: string | null;
}

function unitSuffix(field: MeasurementField, lengthUnit: "in" | "cm"): string {
  if (field.unit === "length") return lengthUnit;
  if (field.unit === "mm") return "mm";
  return "US";
}

export function MeasurementForm({
  category,
  brand,
  values,
  onChange,
  aiSources,
  size,
  garmentCategory,
}: Props) {
  const user = useAuthStore((s) => s.user);
  const cohortKey = (garmentCategory ?? category ?? "").trim() || null;
  const sizeKey = (size ?? "").trim().toUpperCase() || null;

  // US-2827: cohort bands for THIS size. Enabled only when both keys exist, so
  // a surface that does not pass a size never issues the query at all.
  const { data: drift = EMPTY_DRIFT } = useQuery<MeasurementDrift>({
    queryKey: ["measurement-drift", "bands", user?.id, cohortKey, sizeKey],
    enabled: !!user && !!cohortKey && !!sizeKey,
    staleTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { fetchMeasurementDrift } = await import("@/lib/measurement-drift");
      return fetchMeasurementDrift(cohortKey, sizeKey);
    },
  });
  const { unit, setUnit } = useMeasurementPrefs();
  const group = measurementGroupFor(category);
  const template = MEASUREMENT_TEMPLATES[group];
  // US-2335: the per-field <Label> was never linked to its input. useId rather
  // than a literal because this form renders on TWO surfaces (prep.tsx and the
  // composer's measurements card) and could be mounted twice at once — and the
  // key is per FIELD as well, so a shared id would make every label point at
  // whichever input the browser saw first.
  const fieldIdBase = useId();

  const requiredKeys = template.filter((f) => f.required).map((f) => f.key);
  const filledRequired = requiredKeys.filter(
    (k) => values[k] != null && String(values[k]).trim() !== "",
  ).length;
  const allRequiredFilled =
    requiredKeys.length > 0 && filledRequired === requiredKeys.length;

  // Keys the user has touched this session. Once a key is here, the AI
  // badge stops rendering for it — the field now belongs to the user.
  // (We don't persist the cleared state back to ai_field_sources; the
  // audit trail stays in the DB even after the badge goes away.)
  const [touched, setTouched] = useState<Set<string>>(new Set());

  // US-2827: fields whose cohort note the seller waved off this session. It is
  // a check, not an error, so it must be silenceable.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  function set(key: string, raw: string) {
    const next = { ...values };
    if (raw.trim() === "") delete next[key];
    else next[key] = raw;
    onChange(next);
    setTouched((prev) => {
      if (prev.has(key)) return prev;
      const out = new Set(prev);
      out.add(key);
      return out;
    });
  }

  function aiMetaFor(key: string): AiSourceMeta | null {
    if (touched.has(key)) return null;
    return aiSources?.[`measurements.${key}`] ?? null;
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
              className="inline-flex items-center gap-1 text-xs text-brand-red-text hover:underline"
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
        {template.map((field) => {
          const ai = aiMetaFor(field.key);
          // Only `length` fields have a comparable cohort; a US shoe size and a
          // case diameter are different quantities. `null` from isOutsideBand
          // means "no band to check against", which is not a pass and renders
          // nothing rather than a reassurance.
          const band =
            field.unit === "length" && !dismissed.has(field.key)
              ? bandFor(drift, field.key)
              : null;
          const raw = Number(values[field.key]);
          const outside = band ? isOutsideBand(raw, band) : null;
          return (
            <div key={field.key} className="space-y-1">
              <Label htmlFor={`${fieldIdBase}-${field.key}`} className="flex items-center gap-1.5 text-xs">
                {field.label}
                {field.required && (
                  <span className="text-destructive">*</span>
                )}
                {ai && (
                  <span
                    className="rounded bg-primary/10 px-1 py-0.5 text-[9px] font-medium text-primary"
                    title={`AI estimate from brand sizing (${Math.round(
                      ai.confidence * 100,
                    )}% confident, ${ai.source}). Verify against the actual garment.`}
                  >
                    AI
                  </span>
                )}
              </Label>
              <div className="relative">
                <Input
                  id={`${fieldIdBase}-${field.key}`}
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
              {outside === true && band && (
                <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                  <Info className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    Most size {sizeKey} measure {band.cohortP25}&quot; to{" "}
                    {band.cohortP75}&quot; here. Worth a second look.{" "}
                    <button
                      type="button"
                      className="underline underline-offset-2"
                      // Every field renders one of these, so the visible word
                      // alone announces "Dismiss" five times with nothing to
                      // say which. US-2450's guard counts exactly this.
                      aria-label={`Dismiss the size check on ${field.label}`}
                      onClick={() =>
                        setDismissed((prev) => new Set(prev).add(field.key))
                      }
                    >
                      Dismiss
                    </button>
                  </span>
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
