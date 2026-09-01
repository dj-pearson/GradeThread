import { useId, useState } from "react";
import { Link } from "react-router";
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
import {
  checkSize,
  discrepancyNote,
  fixableSize,
  resolveSizeRow,
  tierNote,
  type SizeBandsResponse,
} from "@/lib/size-check";
import {
  fetchSizeBands,
  NO_SIZE_BANDS,
  sizeBandsQueryKey,
} from "@/lib/size-bands";
import {
  indexDriftMessage,
  NO_INDEX_STATS,
  provenanceLine,
  statFor,
  suggestableFields,
  type IndexStatsResponse,
} from "@/lib/measurement-index";
import {
  fetchMeasurementStats,
  measurementStatsQueryKey,
} from "@/lib/measurement-stats-fetch";

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
  /**
   * US-2918: the item's department ("Men", "Women", …), usually from
   * inferDepartment. Without it a brand selling to more than one department
   * cannot be resolved and the check falls back to a generic chart.
   */
  gender?: string | null;
  /**
   * US-2918: write the item's size. Supplying it turns the size-discrepancy
   * note's "Change to XS" button on. Without it the note still renders — the
   * seller should see the disagreement either way — but with no button rather
   * than a dead one.
   */
  onSizeChange?: (nextSize: string) => void;
  /**
   * US-3039: the item's style/model. Supplying it lets the Fit & Measurement
   * Index resolve a STYLE cohort rather than the brand rollup, which is the
   * difference between "other Levi's in 34" and "other Levi's 550 in W34".
   * Omitted, the index still answers at brand level.
   */
  style?: string | null;
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
  gender,
  onSizeChange,
  style,
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
  // US-2918: the expected-size band table for this brand + garment. One request
  // per distinct (brand, garment, gender); the verdict below is pure arithmetic
  // on the result, so it re-runs on every keystroke with no network call.
  const brandKey = (brand ?? "").trim() || null;
  const genderKey = (gender ?? "").trim() || null;
  const { data: sizeBands = NO_SIZE_BANDS } = useQuery<SizeBandsResponse>({
    queryKey: sizeBandsQueryKey(brandKey, cohortKey, genderKey),
    enabled: !!user && !!cohortKey && !!sizeKey,
    staleTime: 30 * 60 * 1000,
    queryFn: () => fetchSizeBands(brandKey, cohortKey, genderKey),
  });

  const { unit, setUnit } = useMeasurementPrefs();
  const group = measurementGroupFor(category);

  // US-3039: the published Fit & Measurement Index table for THIS brand, style
  // and size. Same shape as the two lookups above: one request per distinct
  // cohort, and every comparison below is pure arithmetic on the result, so it
  // re-runs on each keystroke with no network call.
  const styleKey = (style ?? "").trim() || null;
  const { data: indexStats = NO_INDEX_STATS } = useQuery<IndexStatsResponse>({
    queryKey: measurementStatsQueryKey(brandKey, styleKey, group, sizeKey, genderKey),
    enabled: !!user && !!brandKey && !!sizeKey,
    staleTime: 30 * 60 * 1000,
    queryFn: () =>
      fetchMeasurementStats(brandKey, styleKey, group, sizeKey, genderKey),
  });
  const template = MEASUREMENT_TEMPLATES[group];
  // US-2335: the per-field <Label> was never linked to its input. useId rather
  // than a literal because this form renders on TWO surfaces (prep.tsx and the
  // composer's measurements card) and could be mounted twice at once — and the
  // key is per FIELD as well, so a shared id would make every label point at
  // whichever input the browser saw first.
  const fieldIdBase = useId();

  // US-3039: which published fields are still empty, and the line that says
  // where the numbers came from. Both are null/empty for a garment with no
  // published cohort, which is what keeps this surface ABSENT rather than
  // showing an empty state to a seller who was not asking a question.
  const suggestions = suggestableFields(indexStats, values);
  const provenance = provenanceLine(indexStats, group);

  function acceptAllSuggestions() {
    if (suggestions.length === 0) return;
    const next: MeasurementValues = { ...values };
    for (const f of suggestions) next[f.field] = f.median;
    onChange(next);
  }

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

  // US-2918: the size-vs-measurements note, waved off for this session. Same
  // reasoning as the cohort note above, and deliberately a separate flag: they
  // make different claims and dismissing one should not silence the other.
  const [sizeNoteDismissed, setSizeNoteDismissed] = useState(false);

  // US-2918: does the size on the label agree with what the item measures?
  //
  // ONE note per form, not one per field. Two of these fields can disagree with
  // the same chart at once (a dress's waist and hip), and repeating the same
  // point twice under two inputs reads as two problems.
  const sizeRowIndex = resolveSizeRow(sizeBands.rows, size ?? null);
  const sizeVerdict = checkSize({
    bands: sizeBands.rows,
    rowIndex: sizeRowIndex,
    measurements: values,
    tier: sizeBands.tier,
  });
  const showSizeNote = sizeVerdict.status === "off" && !sizeNoteDismissed;
  const fixSize = fixableSize(sizeVerdict);
  const sizeEstimateNote = tierNote(sizeBands.tier, sizeBands.brandLabel);

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
              href={sizeGuideUrl(brand, sizeBands.sourceUrl)}
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

      {showSizeNote && (
        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            {discrepancyNote(sizeVerdict, (size ?? "").trim())}
            {sizeEstimateNote ? ` ${sizeEstimateNote}` : ""}{" "}
            {fixSize && onSizeChange && (
              <>
                <button
                  type="button"
                  className="underline underline-offset-2"
                  // US-2450: every button on this form says a bare word, so the
                  // accessible name has to carry the field and the value the
                  // way the Dismiss buttons below do.
                  aria-label={`Change the size from ${(size ?? "").trim()} to ${fixSize}`}
                  onClick={() => onSizeChange(fixSize)}
                >
                  Change to {fixSize}
                </button>{" "}
              </>
            )}
            <button
              type="button"
              className="underline underline-offset-2"
              aria-label={`Dismiss the size-versus-measurements check on this item`}
              onClick={() => setSizeNoteDismissed(true)}
            >
              Dismiss
            </button>
          </span>
        </p>
      )}

      {suggestions.length > 0 && provenance && (
        <div className="rounded-xl border border-border/60 bg-muted/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="space-y-0.5">
              <p className="text-xs font-medium">
                We know what this usually measures
              </p>
              <p className="text-[11px] text-muted-foreground">
                {provenance}
                {indexStats.cohort && !indexStats.cohort.styleMatched
                  ? " across this brand"
                  : ""}
                . Nothing is filled in until you say so.
              </p>
            </div>
            <button
              type="button"
              onClick={acceptAllSuggestions}
              className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              Use {suggestions.length === 1 ? "it" : "these"}
            </button>
          </div>
          {/* US-3038 AC4: the disclosure sits where the contribution is
              visible, not only in a settings screen nobody opens. One line,
              one link, no modal. */}
          <p className="mt-2 text-[10px] text-muted-foreground">
            Built from measurements sellers contribute, yours included.{" "}
            <Link
              to="/settings?tab=preferences"
              className="underline underline-offset-2"
            >
              Manage sharing
            </Link>
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {template.map((field) => {
          const ai = aiMetaFor(field.key);
          // Only `length` fields have a comparable cohort; a US shoe size and a
          // case diameter are different quantities. `null` from isOutsideBand
          // means "no band to check against", which is not a pass and renders
          // nothing rather than a reassurance.
          const checkable = field.unit === "length" && !dismissed.has(field.key);
          const raw = Number(values[field.key]);

          // US-3039: TWO cohorts can answer, and only ONE warning may render.
          //
          // The US-2827 band groups by (garment category, size) with no brand
          // at all — "is your medium everybody's medium". The index cohort is
          // (brand, style, department, group, size), which is a sharper
          // question and a better answer whenever it exists. So the index wins
          // where it has something to say, and the older band covers the long
          // tail of garments with no published cohort yet.
          //
          // Rendering both would put two notes under one input that disagree
          // about what "normal" is, which is how a seller learns to ignore
          // every note this form produces.
          const indexStat = checkable ? statFor(indexStats, field.key) : undefined;
          // Shown only while the input is EMPTY. A suggestion beside a value
          // the seller already typed is second-guessing, not help, and the
          // drift note below is the right surface for that.
          const suggestion = suggestions.find((sg) => sg.field === field.key);
          const indexNote = indexStat ? indexDriftMessage(indexStat, raw) : null;

          const band = checkable && !indexStat ? bandFor(drift, field.key) : null;
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
              {suggestion && (
                <p className="text-[11px] text-muted-foreground">
                  Usually{" "}
                  <button
                    type="button"
                    className="underline underline-offset-2"
                    aria-label={`Use ${suggestion.median} for ${field.label}`}
                    onClick={() => set(field.key, String(suggestion.median))}
                  >
                    {suggestion.median}
                    {unitSuffix(field, unit)}
                  </button>{" "}
                  ({suggestion.sampleCount} measured)
                </p>
              )}
              {indexNote && (
                <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                  <Info className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    {indexNote}{" "}
                    <button
                      type="button"
                      className="underline underline-offset-2"
                      aria-label={`Dismiss the measurement check on ${field.label}`}
                      onClick={() =>
                        setDismissed((prev) => new Set(prev).add(field.key))
                      }
                    >
                      Dismiss
                    </button>
                  </span>
                </p>
              )}
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
