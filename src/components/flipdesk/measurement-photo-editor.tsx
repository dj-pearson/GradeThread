// US-1574: the measurement overlay editor — review, drag-adjust, and save
// calibrated photo measurements.
//
// Renders the item's MeasureCard photo with each measurement as a draggable
// SVG line and a live inch readout (px→inch via the US-1572 calibration
// homography — the math lives in lib/measure-editor-math.ts, unit tested).
// Pre-seeded by the US-1573 auto pass when it ran; a bare calibrated photo
// starts from schema-default placements the seller drags into position —
// the editor NEVER requires the AI pass. Saving persists the line geometry
// on the photo, fill-merges values into inventory_items.measurements with
// 'manual' provenance for touched keys, refreshes the US-1577 overlay
// listing asset, and syncs the parent's live state via onApply.
//
// Self-contained on purpose: both the composer and the item canvas mount it
// with five props next to their existing MeasurementForm.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Ruler, ScanSearch, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import { useMeasurementPrefs } from "@/stores/measurement-prefs";
import {
  MEASUREMENT_TEMPLATES,
  measurementGroupFor,
} from "@/lib/measurement-templates";
import {
  defaultLinePlacement,
  fitScale,
  formatQuarter,
  hitEndpoint,
  inchesBetween,
  type EditorLine,
  type EndpointHit,
} from "@/lib/measure-editor-math";

interface StoredLine {
  e1: [number, number];
  e2: [number, number];
  inches: number;
  label: string;
}

interface MeasurePhotoRow {
  id: string;
  photo_url: string;
  measure_calibration: {
    v: number;
    ppi: number;
    homography: number[];
    lines?: Record<string, StoredLine>;
  } | null;
}

interface Props {
  itemId: string;
  category: string | null;
  /** Parent-owned measurements state (the same map MeasurementForm edits). */
  values: Record<string, number | string>;
  aiSources?: Record<string, unknown> | null;
  /** Sync the parent's live state after a save (parent persists its own way too). */
  onApply: (next: Record<string, number | string>, touched: string[]) => void;
}

const MAX_W = 640;
const MAX_H = 480;

export function MeasurementPhotoEditor({
  itemId,
  category,
  values,
  aiSources,
  onApply,
}: Props) {
  const qc = useQueryClient();
  const unit = useMeasurementPrefs((s) => s.unit);
  const group = measurementGroupFor(category);
  const fields = useMemo(
    () => MEASUREMENT_TEMPLATES[group].filter((f) => f.unit === "length"),
    [group],
  );

  // The item's most recent MeasureCard photo (calibrated or not).
  const { data: photo = null, isLoading } = useQuery({
    queryKey: ["measure_photo", itemId],
    queryFn: async (): Promise<MeasurePhotoRow | null> => {
      const { data, error } = await supabase
        .from("item_photos")
        .select("id, photo_url, measure_calibration")
        .eq("inventory_item_id", itemId)
        .eq("photo_type", "measurement")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as MeasurePhotoRow | null;
    },
  });

  const calib = photo?.measure_calibration?.v === 1 ? photo.measure_calibration : null;

  const [lines, setLines] = useState<EditorLine[]>([]);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [imgDims, setImgDims] = useState<[number, number] | null>(null);
  const [busy, setBusy] = useState<"calibrate" | "extract" | "save" | null>(null);
  const dragRef = useRef<EndpointHit | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Seed lines from the stored calibration whenever the photo (re)loads.
  useEffect(() => {
    if (!calib) return;
    const stored = calib.lines ?? {};
    const seeded: EditorLine[] = [];
    for (const [key, l] of Object.entries(stored)) {
      seeded.push({ key, label: l.label, e1: l.e1, e2: l.e2 });
    }
    setLines(seeded);
    setTouched(new Set());
  }, [photo?.id, calib?.lines && JSON.stringify(Object.keys(calib.lines))]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading || !photo) return null; // no MeasureCard shot — nothing to edit

  const scale = imgDims ? fitScale(imgDims[0], imgDims[1], MAX_W, MAX_H) : 1;

  async function runCalibrate() {
    setBusy("calibrate");
    try {
      const res = await edgeFetch("/api/flipdesk/measure/calibrate", {
        method: "POST",
        json: { photo_id: photo!.id, force: true },
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok || json.ok === false) {
        toast.error(json.message ?? json.error ?? "Card detection failed.");
        return;
      }
      toast.success("MeasureCard detected — the photo is calibrated.");
      await qc.invalidateQueries({ queryKey: ["measure_photo", itemId] });
    } finally {
      setBusy(null);
    }
  }

  async function runExtract() {
    setBusy("extract");
    try {
      const res = await edgeFetch("/api/flipdesk/measure/extract", {
        method: "POST",
        json: { photo_id: photo!.id },
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        measurements?: Array<{ key: string; inches: number }>;
        written?: string[];
      };
      if (!res.ok) {
        toast.error(json.error ?? "Auto-measure failed.");
        return;
      }
      const next = { ...values };
      for (const m of json.measurements ?? []) {
        if ((json.written ?? []).includes(m.key)) next[m.key] = m.inches;
      }
      onApply(next, json.written ?? []);
      await qc.invalidateQueries({ queryKey: ["measure_photo", itemId] });
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success(
        `Auto-measured ${(json.measurements ?? []).length} measurement(s) — drag any line to correct it.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function saveLines() {
    if (!calib) return;
    setBusy("save");
    try {
      const storedLines: Record<string, StoredLine> = {};
      const nextValues = { ...values };
      const touchedKeys = [...touched];
      for (const line of lines) {
        const inches = inchesBetween(calib.homography, line.e1, line.e2);
        storedLines[line.key] = {
          e1: line.e1,
          e2: line.e2,
          inches,
          label: line.label,
        };
        if (touched.has(line.key)) nextValues[line.key] = inches;
      }
      // 1) Line geometry on the photo row.
      const { error: photoErr } = await supabase
        .from("item_photos")
        .update({
          measure_calibration: { ...calib, lines: storedLines },
        } as never)
        .eq("id", photo!.id);
      if (photoErr) throw photoErr;
      // 2) Touched values -> measurements + manual provenance on the item.
      if (touchedKeys.length > 0) {
        const nextSources = { ...(aiSources ?? {}) } as Record<string, unknown>;
        for (const key of touchedKeys) {
          nextSources[`measurements.${key}`] = {
            source: "manual",
            measuredAt: new Date().toISOString(),
          };
        }
        const { error: itemErr } = await supabase
          .from("inventory_items")
          .update({
            measurements: nextValues,
            ai_field_sources: nextSources,
          } as never)
          .eq("id", itemId);
        if (itemErr) throw itemErr;
        onApply(nextValues, touchedKeys);
      }
      // 3) Refresh the buyer-facing overlay photo (best-effort).
      void edgeFetch("/api/flipdesk/measure/overlay", {
        method: "POST",
        json: { item_id: itemId },
      }).then(
        () => qc.invalidateQueries({ queryKey: ["item_photos", itemId] }),
        () => {},
      );
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      setTouched(new Set());
      toast.success("Measurements saved.");
    } catch (err) {
      toast.error(
        `Couldn't save measurements: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(null);
    }
  }

  function addLine(key: string) {
    if (!imgDims) return;
    const field = fields.find((f) => f.key === key);
    if (!field || lines.some((l) => l.key === key)) return;
    const placed = defaultLinePlacement(key, imgDims[0], imgDims[1]);
    setLines((prev) => [...prev, { key, label: field.label, ...placed }]);
    setTouched((prev) => new Set(prev).add(key));
  }

  function pointerPos(e: React.PointerEvent): [number, number] {
    const rect = svgRef.current!.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  function onPointerDown(e: React.PointerEvent) {
    const hit = hitEndpoint(lines, pointerPos(e), scale);
    if (!hit) return;
    dragRef.current = hit;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag || !imgDims) return;
    const [dx, dy] = pointerPos(e);
    const ox = Math.max(0, Math.min(imgDims[0], dx / scale));
    const oy = Math.max(0, Math.min(imgDims[1], dy / scale));
    setLines((prev) =>
      prev.map((l, i) =>
        i === drag.lineIndex ? { ...l, [drag.end]: [ox, oy] } : l
      )
    );
    setTouched((prev) => {
      const next = new Set(prev);
      next.add(lines[drag.lineIndex]?.key ?? "");
      return next;
    });
  }

  function onPointerUp() {
    dragRef.current = null;
  }

  const missing = fields.filter((f) => !lines.some((l) => l.key === f.key));
  const displayVal = (inches: number): string =>
    unit === "cm"
      ? `${(inches * 2.54).toFixed(1)} cm`
      : `${formatQuarter(inches)}"`;

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Ruler className="h-4 w-4" />
          Photo measurements
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {!calib && (
            <Button size="sm" variant="outline" onClick={() => void runCalibrate()} disabled={busy !== null}>
              {busy === "calibrate" ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <ScanSearch className="mr-1.5 h-3.5 w-3.5" />
              )}
              Detect card
            </Button>
          )}
          {calib && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void runExtract()}
                disabled={busy !== null}
                title="One AI action — proposes every measurement; you can drag-correct after."
              >
                {busy === "extract" ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                )}
                Auto-measure
              </Button>
              <Button
                size="sm"
                onClick={() => void saveLines()}
                disabled={busy !== null || lines.length === 0}
              >
                {busy === "save" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Save
              </Button>
            </>
          )}
        </div>
      </div>

      {!calib && (
        <p className="text-xs text-muted-foreground">
          MeasureCard photo found — detect the card to unlock calibrated
          measuring (all four squares must be visible).
        </p>
      )}

      {calib && (
        <>
          <div className="relative inline-block max-w-full">
            <img
              src={photo.photo_url}
              alt="MeasureCard measurement photo"
              className="block h-auto max-w-full rounded"
              style={{ maxWidth: MAX_W, maxHeight: MAX_H }}
              onLoad={(e) => {
                const el = e.currentTarget;
                setImgDims([el.naturalWidth, el.naturalHeight]);
              }}
              draggable={false}
            />
            {imgDims && (
              <svg
                ref={svgRef}
                className="absolute left-0 top-0 h-full w-full touch-none"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                role="application"
                aria-label="Drag measurement endpoints"
              >
                {lines.map((line) => {
                  const src = aiSources?.[`measurements.${line.key}`] as
                    | { flagged?: boolean }
                    | undefined;
                  const amber = !!src?.flagged && !touched.has(line.key);
                  const color = amber ? "#d97706" : "#0F3460";
                  const x1 = line.e1[0] * scale, y1 = line.e1[1] * scale;
                  const x2 = line.e2[0] * scale, y2 = line.e2[1] * scale;
                  const inches = inchesBetween(calib.homography, line.e1, line.e2);
                  return (
                    <g key={line.key}>
                      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#fff" strokeWidth={5} />
                      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={2.5} />
                      {[[x1, y1], [x2, y2]].map(([cx, cy], i) => (
                        <circle
                          key={i}
                          cx={cx}
                          cy={cy}
                          r={7}
                          fill="#fff"
                          stroke={color}
                          strokeWidth={2.5}
                          className="cursor-grab"
                        />
                      ))}
                      <g transform={`translate(${(x1 + x2) / 2}, ${(y1 + y2) / 2 - 12})`}>
                        <rect x={-44} y={-11} width={88} height={20} rx={4} fill="#ffffffee" />
                        <text
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fontSize={11}
                          fontWeight={700}
                          fill={color}
                        >
                          {line.label.split(" (")[0]} {displayVal(inches)}
                        </text>
                      </g>
                    </g>
                  );
                })}
              </svg>
            )}
          </div>

          {missing.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">Add line:</span>
              {missing.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className="rounded-full border px-2 py-0.5 hover:bg-muted"
                  onClick={() => addLine(f.key)}
                >
                  {f.label.split(" (")[0]}
                </button>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            Drag the circles onto the garment; values are true inches from the
            MeasureCard plane. Saving updates the item&apos;s measurements and
            regenerates the buyer-facing measurements photo.
          </p>
        </>
      )}
    </div>
  );
}
