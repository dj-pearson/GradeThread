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
import { Download, Loader2, Ruler, ScanSearch, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import { track } from "@/lib/analytics";
import { useMeasurementPrefs } from "@/stores/measurement-prefs";
import {
  MEASUREMENT_TEMPLATES,
  measurementGroupFor,
} from "@/lib/measurement-templates";
import {
  NUDGE_COARSE_MULTIPLE,
  defaultLinePlacement,
  fitScale,
  formatQuarter,
  hitEndpoint,
  inchesBetween,
  nudgeStep,
  nudged,
  type EditorLine,
  type EndpointHit,
  type NudgeDirection,
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

// US-2607: the outcome the server records on every measure pass. Mirror of
// MEASURE_PASS_KEY in services/edge-functions/src/lib/measure-autofill.ts.
const MEASURE_PASS_KEY = "measurements._pass";

interface MeasurePass {
  reason: string | null;
  message: string | null;
  written?: string[];
  ranAt?: string;
}

/**
 * Say what the last pass did, in words a seller can act on. Returning null
 * means "nothing worth saying" — a pass that worked needs no explanation, and
 * neither does one that has never run.
 */
export function measurePassNote(pass: MeasurePass | null): string | null {
  if (!pass) return null;
  switch (pass.reason) {
    case null:
      return null; // it worked
    case "no_measurement_photo":
      return "No MeasureCard found in this item's photos. Shoot the garment flat with the card beside it, all four corner squares fully visible, straight down from above.";
    case "calibration_failed":
      return pass.message ??
        "A MeasureCard was there but couldn't be read. Get closer, fill more of the frame, and keep all four corner squares in shot.";
    case "already_measured":
      return null; // every field is filled; the form already shows them
    case "no_measurable_fields":
      return "This category isn't measured from a photo.";
    case "extract_failed":
      return "The card was read but measuring failed. Try again in a moment.";
    case "all_rejected":
      // US-2608: the pass ran and produced numbers, and every one of them was
      // rejected as implausible. Nothing was saved, on purpose — a wrong inseam
      // published as a number is worse than a blank. The lines are still drawn
      // below for dragging, which is the fix a human can actually make.
      return pass.message ??
        "The measurements came out implausible, so none were saved. Drag each line onto the right landmark below and save.";
    default:
      return pass.message;
  }
}

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

  // US-2625: the generated measurements photo, for the download button. It is
  // a separate row from the card frame this editor edits.
  const { data: overlay = null } = useQuery({
    queryKey: ["measure_overlay", itemId],
    queryFn: async (): Promise<{ id: string; photo_url: string } | null> => {
      const { data, error } = await supabase
        .from("item_photos")
        .select("id, photo_url")
        .eq("inventory_item_id", itemId)
        .eq("photo_type", "measurement_overlay")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as { id: string; photo_url: string } | null;
    },
  });

  const calib = photo?.measure_calibration?.v === 1 ? photo.measure_calibration : null;
  // US-2607: what the last server-side pass did, so a blank measurements box
  // explains itself instead of looking broken.
  const passNote = measurePassNote(
    (aiSources?.[MEASURE_PASS_KEY] as MeasurePass | undefined) ?? null,
  );

  const [lines, setLines] = useState<EditorLine[]>([]);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [imgDims, setImgDims] = useState<[number, number] | null>(null);
  /**
   * US-2686: what the screen reader is told after a keyboard move.
   *
   * Declared HERE with the other hooks rather than beside the handler that
   * feeds it: this component returns early while the photo loads, and a
   * useState below that return is called conditionally.
   */
  const [announcement, setAnnouncement] = useState("");
  const [busy, setBusy] = useState<
    "calibrate" | "extract" | "save" | "find" | "download" | null
  >(null);
  const dragRef = useRef<EndpointHit | null>(null);
  /** Photo id we've already auto-calibrated, so a failure doesn't loop. */
  const autoCalibratedRef = useRef<string | null>(null);
  // US-1580: the auto pass's proposed inches per key, snapshotted at seed
  // time, so Save can log proposal-vs-final correction deltas (telemetry).
  const proposalRef = useRef<
    Record<string, { inches: number; confidence: number | null; flagged: boolean }>
  >({});
  const svgRef = useRef<SVGSVGElement>(null);

  // Seed lines from the stored calibration whenever the photo (re)loads.
  useEffect(() => {
    if (!calib) return;
    const stored = calib.lines ?? {};
    const seeded: EditorLine[] = [];
    const proposals: typeof proposalRef.current = {};
    for (const [key, l] of Object.entries(stored)) {
      seeded.push({ key, label: l.label, e1: l.e1, e2: l.e2 });
      const src = aiSources?.[`measurements.${key}`] as
        | { source?: string; confidence?: number; flagged?: boolean }
        | undefined;
      if (src?.source === "ai_measured") {
        proposals[key] = {
          inches: l.inches,
          confidence: typeof src.confidence === "number" ? src.confidence : null,
          flagged: src.flagged === true,
        };
      }
    }
    proposalRef.current = proposals;
    setLines(seeded);
    setTouched(new Set());
  }, [photo?.id, calib?.lines && JSON.stringify(Object.keys(calib.lines))]); // eslint-disable-line react-hooks/exhaustive-deps

  // US-2595: calibrate on sight. Detection is deterministic CV — free, no model
  // call — so making the seller press "Detect card" bought nothing and cost
  // every one of them a step they had to know about. Once per photo: the ref
  // guards a re-run after a failure, so a shot with an unreadable card falls
  // back to the button instead of retrying on every render.
  useEffect(() => {
    if (!photo || calib || autoCalibratedRef.current === photo.id) return;
    autoCalibratedRef.current = photo.id;
    void runCalibrate({ silent: true });
  }, [photo?.id, calib]); // eslint-disable-line react-hooks/exhaustive-deps

  // US-2595: no photo tagged 'measurement' does NOT mean no card. The photo-role
  // classifier can only assign front/back/tag/detail/defect, so on a normally
  // uploaded set the card is sitting inside a photo labelled something else.
  // Offer the scan rather than rendering nothing.
  if (isLoading) return null;
  if (!photo) {
    return (
      <div className="space-y-2 rounded-lg border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-sm">
            <Ruler className="h-4 w-4 shrink-0" />
            <span>
              Shot this with the MeasureCard? Find it and measure the garment.
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void runAutofill()}
            disabled={busy !== null}
            title="Looks through this item's photos for the MeasureCard, then measures every field for its category."
          >
            {busy === "find" ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <ScanSearch className="mr-1.5 h-3.5 w-3.5" />
            )}
            Find MeasureCard
          </Button>
        </div>
        {passNote && (
          <p className="text-xs text-muted-foreground">{passNote}</p>
        )}
      </div>
    );
  }

  const scale = imgDims ? fitScale(imgDims[0], imgDims[1], MAX_W, MAX_H) : 1;

  async function runCalibrate(opts: { silent?: boolean } = {}) {
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
        quality?: { lowResolution?: boolean; inchesPerPx?: number };
      };
      if (!res.ok || json.ok === false) {
        // The silent pass runs unprompted, so a failure is not an error the
        // seller asked for — the panel's own copy already tells them to press
        // "Detect card", and that button reports properly.
        if (!opts.silent) {
          toast.error(json.message ?? json.error ?? "Card detection failed.");
        }
        return;
      }
      if (!opts.silent) {
        // US-2672: a card that came out small in frame still calibrates — it
        // used to be refused outright — so say how fine the reading is instead
        // of pretending every calibration is the same one.
        const perPx = json.quality?.inchesPerPx;
        toast.success(
          json.quality?.lowResolution && perPx
            ? `MeasureCard detected. It is small in this photo, so measurements read to about ${
              (Math.ceil(perPx * 100) / 100).toFixed(2)
            } in.`
            : "MeasureCard detected — the photo is calibrated.",
        );
      }
      await qc.invalidateQueries({ queryKey: ["measure_photo", itemId] });
    } finally {
      setBusy(null);
    }
  }

  // US-2595: find the card in the item's photos, retag it, and measure — the
  // whole pipeline in one press, for a set that was never tagged by hand.
  async function runAutofill() {
    setBusy("find");
    try {
      const res = await edgeFetch("/api/flipdesk/measure/autofill", {
        method: "POST",
        json: { item_id: itemId },
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
        reason?: string;
        written?: string[];
        measurements?: Record<string, unknown>;
      };
      if (!res.ok) {
        toast.error(json.error ?? "Couldn't measure from the photos.");
        return;
      }
      if (!json.ok) {
        toast.info(
          json.reason === "already_measured"
            ? "Every measurement for this category is already filled."
            : json.message ??
              "No MeasureCard found in this item's photos. Shoot the garment flat with the card beside it, all four squares visible.",
        );
        return;
      }
      const written = json.written ?? [];
      const next = { ...values };
      for (const key of written) {
        const v = Number((json.measurements ?? {})[key]);
        if (Number.isFinite(v)) next[key] = v;
      }
      onApply(next, written);
      await qc.invalidateQueries({ queryKey: ["measure_photo", itemId] });
      await qc.invalidateQueries({ queryKey: ["item_photos", itemId] });
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      // US-2608: "found the card and filled 0 measurements" is not a success.
      // Every value can be rejected as implausible, and saying so — with the
      // lines still drawn to drag — beats a green toast over an empty box.
      if (written.length === 0) {
        toast.warning(
          measurePassNote({ reason: json.reason ?? "all_rejected", message: json.message ?? null }) ??
            "Found the MeasureCard but saved nothing — drag each line onto the right landmark below.",
        );
        return;
      }
      toast.success(
        `Found the MeasureCard and filled ${written.length} measurement(s) — review each line before listing.`,
      );
    } finally {
      setBusy(null);
    }
  }

  // US-2625: hand the seller the generated measurements photo as a file.
  //
  // It is served from the storage domain, which is cross-origin from the app —
  // and the browser IGNORES the `download` attribute on a cross-origin href, so
  // a plain link opens the image in a tab instead of saving it. Fetching the
  // bytes and saving an object URL is what actually produces a file, and it
  // also lets the file be named after the item rather than a timestamp.
  async function downloadOverlay() {
    if (!overlay?.photo_url) return;
    setBusy("download");
    try {
      const res = await fetch(overlay.photo_url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `measurements-${itemId.slice(0, 8)}.jpg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch (err) {
      toast.error(
        `Couldn't download the measurements photo: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
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
        `Estimated ${(json.measurements ?? []).length} measurement(s) from the photo — review each line before listing.`,
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
        // US-1580: correction telemetry — proposal vs final for keys the auto
        // pass had measured. Deltas/class/confidence only; fire-and-forget.
        const corrections = touchedKeys.flatMap((key) => {
          const prop = proposalRef.current[key];
          const finalV = Number(nextValues[key]);
          if (!prop || !Number.isFinite(finalV)) return [];
          return [{
            key,
            proposed: prop.inches,
            final: finalV,
            confidence: prop.confidence,
            flagged: prop.flagged,
          }];
        });
        if (corrections.length > 0) {
          void edgeFetch("/api/flipdesk/measure/correction", {
            method: "POST",
            json: { garment_class: group, corrections },
          }).catch(() => {});
          track("measure_correction_saved", {
            garment_class: group,
            corrections: corrections.length,
            mean_abs_delta:
              corrections.reduce(
                (sum, c) => sum + Math.abs(c.final - c.proposed),
                0,
              ) / corrections.length,
          });
        }
      }
      // 3) Refresh the buyer-facing overlay photo (best-effort).
      void edgeFetch("/api/flipdesk/measure/overlay", {
        method: "POST",
        json: { item_id: itemId },
      }).then(
        () => {
          void qc.invalidateQueries({ queryKey: ["item_photos", itemId] });
          // US-2625: the download button points at the row this render replaces.
          void qc.invalidateQueries({ queryKey: ["measure_overlay", itemId] });
        },
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

  // ── US-2686: the keyboard path ──────────────────────────────────────────
  //
  // A pointer drag on an SVG is reachable by exactly one input method. There is
  // no keyboard equivalent and nothing for a screen reader to hold, so a
  // keyboard-only user could not set a measurement at all.
  //
  // NOT A PORT OF THE iOS FIX. US-2534 gave iOS four nudge buttons per
  // endpoint, which is the right answer for touch and the wrong one here: on a
  // keyboard the endpoint is the thing you focus and the arrows are the thing
  // you press. The STEP RULE is shared (measure-editor-math nudgeStep, the same
  // formula as MeasureNudge.swift) because the two clients log correction
  // deltas into one table.
  //
  // The drag stays. This is an alternative, not a replacement.

  const ARROW_DIRECTION: Record<string, NudgeDirection> = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
  };

  function onEndpointKeyDown(
    e: React.KeyboardEvent,
    lineIndex: number,
    end: "e1" | "e2",
  ) {
    const direction = ARROW_DIRECTION[e.key];
    if (!direction || !imgDims) return;
    // The page scrolls on arrow keys otherwise, so the endpoint moves and the
    // view runs away from it.
    e.preventDefault();

    const line = lines[lineIndex];
    if (!line) return;
    // Shift is a whole multiple of the fine step rather than a second formula,
    // so "shift is five nudges" is a sentence rather than a discovery.
    const step =
      nudgeStep(imgDims[0], imgDims[1]) * (e.shiftKey ? NUDGE_COARSE_MULTIPLE : 1);
    const moved = nudged(line[end], direction, step, imgDims[0], imgDims[1]);
    const nextLine = { ...line, [end]: moved } as EditorLine;

    setLines((prev) => prev.map((l, i) => (i === lineIndex ? nextLine : l)));
    // US-2686 AC3: the SAME touched-marking the drag does. Without it the
    // keyboard path would move the line on screen and save nothing, which is an
    // accessible alternative in appearance only — the exact failure the iOS
    // half had to fix.
    setTouched((prev) => new Set(prev).add(line.key));

    // AC4: announced as the measurement. Coordinates are true and useless to
    // somebody setting a chest measurement.
    setAnnouncement(
      `${line.label.split(" (")[0]} ${displayVal(
        inchesBetween(calib!.homography, nextLine.e1, nextLine.e2),
      )}`,
    );
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
          {/* US-2607: the whole pipeline in one press — find the card in any of
              the item's photos, calibrate it, and measure every field. Offered
              even when a card photo is already tagged, because "this one won't
              read" and "the real card is in a different shot" are both common
              and neither is something a seller should have to diagnose. */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void runAutofill()}
            disabled={busy !== null}
            title="Finds the MeasureCard in this item's photos and measures every field for its category."
          >
            {busy === "find" ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <ScanSearch className="mr-1.5 h-3.5 w-3.5" />
            )}
            Measure from card
          </Button>
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
          {/* US-2625: the generated measurements photo as a file. It is
              deliberately kept out of the eBay photo set (eBay rejects added
              graphics), so downloading it is the only way to use it anywhere
              else — a Poshmark listing, a message to a buyer asking "will this
              fit". */}
          {overlay?.photo_url && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void downloadOverlay()}
              disabled={busy !== null}
              title="Save the generated measurements photo to your computer."
            >
              {busy === "download" ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="mr-1.5 h-3.5 w-3.5" />
              )}
              Download photo
            </Button>
          )}
        </div>
      </div>

      {passNote && <p className="text-xs text-muted-foreground">{passNote}</p>}

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
                aria-label="Measurement endpoints. Focus one and use the arrow keys to move it; hold shift for a larger step."
              >
                {lines.map((line, lineIndex) => {
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
                      {([["e1", x1, y1], ["e2", x2, y2]] as const).map(
                        ([end, cx, cy], i) => (
                          <circle
                            key={i}
                            cx={cx}
                            cy={cy}
                            r={7}
                            fill="#fff"
                            stroke={color}
                            strokeWidth={2.5}
                            /* US-2686. tabIndex on an SVG element is honoured by
                               every browser we support; role="button" is what
                               makes a screen reader announce it as operable
                               rather than reading the label and stopping.
                               focus-visible so a mouse user never sees a ring
                               they did not ask for. */
                            tabIndex={0}
                            role="button"
                            aria-label={`${line.label.split(" (")[0]}, ${
                              end === "e1" ? "start" : "end"
                            } point, ${displayVal(inches)}. Arrow keys move it; hold shift for a larger step.`}
                            className="cursor-grab outline-none focus-visible:stroke-brand-red focus-visible:[stroke-width:4]"
                            onKeyDown={(e) => onEndpointKeyDown(e, lineIndex, end)}
                          />
                        ),
                      )}
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
          {/* US-2686 AC4: the change is announced as the MEASUREMENT. A polite
              live region rather than assertive, because a held arrow key fires
              repeatedly and an assertive region would interrupt itself into
              noise. Visually hidden: sighted users already see the chip move. */}
          <p aria-live="polite" role="status" className="sr-only">
            {announcement}
          </p>
          <p className="text-[11px] text-muted-foreground">
            Drag the circles onto the garment, or focus one and use the arrow
            keys (hold shift to move further). Values are estimated from the
            photo via the MeasureCard — review each before listing. Saving
            updates the item&apos;s measurements and regenerates the
            buyer-facing measurements photo.
          </p>
        </>
      )}
    </div>
  );
}
