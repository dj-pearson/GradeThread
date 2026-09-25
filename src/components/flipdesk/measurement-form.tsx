import { useId, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useMeasurementPrefs } from "@/stores/measurement-prefs";
import {
  MEASUREMENT_TEMPLATES,
  measurementGroupFor,
  type MeasurementField,
} from "@/lib/measurement-templates";
import { SizeGuidePanel } from "./size-guide-panel";
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
import { asAiFieldSource, isAiWritten } from "@/lib/ai-field-sources";
import type { AiFieldSourceEntry } from "@/types/database";

type MeasurementValues = Record<string, number | string>;

// US-3444: this file used to redeclare the entry shape as
// `{ source, confidence, accepted: boolean }`, which was wrong twice over --
// Android writes a bare string (US-3358) and `accepted` is a tri-state
// (US-3352). The AI badge below read `ai.confidence` straight off the entry, so
// an Android-written measurement rendered `NaN% confident, undefined` in its
// tooltip. The shared type and its narrowing helper are the fix; a local copy
// is what let the two drift.

interface Props {
  category: string | null | undefined;
  brand: string | null | undefined;
  values: MeasurementValues;
  onChange: (next: MeasurementValues) => void;
  /**
   * Map of ai_field_sources from the item. We look up keys prefixed
   * `measurements.<field>` and render an "AI" badge on those fields.
   */
  aiSources?: Record<string, AiFieldSourceEntry> | null;
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

const CM_PER_IN = 2.54;
const round = (n: number, places: number) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/**
 * Lengths are STORED in inches (src/lib/measurements.ts) whatever the toggle
 * says. The toggle used to change only the suffix, so 56 typed in cm was saved
 * and listed as 56 in.
 */
function lengthToStored(raw: string, field: MeasurementField, unit: "in" | "cm"): number | string {
  if (field.unit !== "length" || unit !== "cm") return raw;
  const n = Number(raw);
  return Number.isFinite(n) ? round(n / CM_PER_IN, 2) : raw;
}

/** A stored inch value (or a median in inches) as the seller reads it. */
function lengthToDisplay(
  stored: number | string | null | undefined,
  field: MeasurementField,
  unit: "in" | "cm",
): string {
  if (stored === undefined || stored === null) return "";
  if (field.unit !== "length" || unit !== "cm") return String(stored);
  const n = Number(stored);
  return Number.isFinite(n) && String(stored).trim() !== "" ? String(round(n * CM_PER_IN, 1)) : String(stored);
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
  // US-3283: no longer gated on the item having a size. The size CHECK needs
  // one (resolveSizeRow returns null without it, so the verdict is `unknown`),
  // but the size GUIDE is most useful on an item that has not been sized yet —
  // which is exactly the item this query used to refuse to fetch a chart for.
  const { data: sizeBands = NO_SIZE_BANDS } = useQuery<SizeBandsResponse>({
    queryKey: sizeBandsQueryKey(brandKey, cohortKey, genderKey),
    enabled: !!user && !!cohortKey,
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
    queryKey: measurementStatsQueryKey(brandKey, styleKey, group, sizeKey),
    enabled: !!user && !!brandKey && !!sizeKey,
    staleTime: 30 * 60 * 1000,
    queryFn: () =>
      fetchMeasurementStats(brandKey, styleKey, group, sizeKey),
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

  // What the seller is typing, per field, so a cm value is not reformatted
  // mid-keystroke by the round trip through inches. Cleared on blur and when
  // the unit changes.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  function set(key: string, raw: string, field?: MeasurementField) {
    const next = { ...values };
    if (raw.trim() === "") delete next[key];
    else next[key] = field ? lengthToStored(raw, field, unit) : raw;
    onChange(next);
    setTouched((prev) => {
      if (prev.has(key)) return prev;
      const out = new Set(prev);
      out.add(key);
      return out;
    });
  }

  /** The entry for a field, whatever shape it is in. */
  function aiEntryFor(key: string): AiFieldSourceEntry | null {
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
          <SizeGuidePanel
            brand={brand}
            group={group}
            bands={sizeBands}
            size={size}
            values={values}
          />
          {/* in / cm toggle. Applies to length fields; values stay in inches. */}
          <div
            role="group"
            aria-label="Length unit"
            className="flex overflow-hidden rounded-md border text-xs"
          >
            {(["in", "cm"] as const).map((u) => (
              <button
                key={u}
                type="button"
                aria-pressed={unit === u}
                onClick={() => {
                  setDrafts({});
                  setUnit(u);
                }}
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
              to="/dashboard/settings?tab=flipdesk"
              className="underline underline-offset-2"
            >
              Manage sharing
            </Link>
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {template.map((field) => {
          const aiEntry = aiEntryFor(field.key);
          // The badge shows whenever an AI pass wrote the field; the CONFIDENCE
          // only when the entry carries one. Android's string form says the
          // first and not the second, which is why these are two questions.
          const aiWritten = isAiWritten(aiEntry);
          const ai = asAiFieldSource(aiEntry);
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
                {aiWritten && (
                  <span
                    className="rounded bg-primary/10 px-1 py-0.5 text-[9px] font-medium text-primary"
                    title={ai
                      ? `AI estimate from brand sizing (${Math.round(
                        ai.confidence * 100,
                      )}% confident, ${ai.source}). Verify against the actual garment.`
                      : "Filled by an AI pass. No confidence was recorded for it. Verify against the actual garment."}
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
                  min={0}
                  value={drafts[field.key] ?? lengthToDisplay(values[field.key], field, unit)}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setDrafts((prev) => ({ ...prev, [field.key]: raw }));
                    set(field.key, raw, field);
                  }}
                  onBlur={() =>
                    setDrafts((prev) => {
                      if (!(field.key in prev)) return prev;
                      const out = { ...prev };
                      delete out[field.key];
                      return out;
                    })
                  }
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
                    aria-label={`Use ${lengthToDisplay(suggestion.median, field, unit)} ${unitSuffix(field, unit)} for ${field.label}`}
                    // The median is already in inches: store it as is.
                    onClick={() => set(field.key, String(suggestion.median))}
                  >
                    {lengthToDisplay(suggestion.median, field, unit)}{" "}
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
                    Most size {sizeKey} measure{" "}
                    {lengthToDisplay(band.cohortP25, field, unit)} to{" "}
                    {lengthToDisplay(band.cohortP75, field, unit)}{" "}
                    {unitSuffix(field, unit)} here. Worth a second look.{" "}
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
