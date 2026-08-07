import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  clamp,
  fromScreen,
  HOTNESS_FILL,
  HOTNESS_LABELS,
  HOTNESS_LEVELS,
  hotnessLevel,
  type LatLng,
  type MapSize,
  type MapViewport,
  markerRadius,
  MAX_ZOOM,
  MIN_ZOOM,
  panViewport,
  toScreen,
  zoomViewport,
} from "@/lib/radar-map";

// US-1865: the Radar map canvas.
//
// A tile-free, dependency-free SVG map. The reasoning for that choice is in
// src/lib/radar-map.ts and is worth repeating in one line here, because it is
// the kind of decision a later "let's just add Leaflet" would quietly reverse:
// tile URLs ARE the viewport, so a tile-backed map streams the user's
// neighbourhood to a third-party CDN on every drag — undoing, in the display
// layer, the coordinate minimization the whole Radar schema is built around.
//
// What is drawn: a north-up graticule for orientation, a scale bar so distances
// are readable, the network venues coloured by hotness, and the reseller's own
// stores as rings on the same plane. Nothing is fetched.

export interface RadarMapMarker {
  id: string;
  lat: number;
  lng: number;
  label: string;
  /** 0..1 within the current view. Null for a personal-only pin. */
  score: number | null;
  /** True for the reseller's own store — drawn as a ring, on any plan. */
  personal: boolean;
  sublabel?: string;
}

interface RadarMapProps {
  viewport: MapViewport;
  onViewportChange: (next: MapViewport) => void;
  markers: RadarMapMarker[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Shown centred when there is nothing to plot. */
  emptyMessage?: string;
  className?: string;
}

const MIN_HEIGHT = 420;

/** Degrees between graticule lines at a zoom level. Powers of ten and halves. */
function graticuleStep(zoom: number): number {
  if (zoom >= 14) return 0.005;
  if (zoom >= 12) return 0.01;
  if (zoom >= 10) return 0.05;
  if (zoom >= 8) return 0.25;
  return 1;
}

/** Metres per pixel at this latitude and zoom — what the scale bar measures. */
function metresPerPixel(lat: number, zoom: number): number {
  const EARTH_CIRCUMFERENCE = 40_075_016.686;
  return (
    (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) /
    (256 * Math.pow(2, zoom))
  );
}

function scaleBar(lat: number, zoom: number): { width: number; label: string } {
  const mpp = metresPerPixel(lat, zoom);
  const targetMetres = mpp * 120;
  const steps = [50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000];
  const chosen = steps.find((s) => s >= targetMetres) ?? 50_000;
  return {
    width: Math.round(chosen / mpp),
    label: chosen >= 1000 ? `${chosen / 1000} km` : `${chosen} m`,
  };
}

export function RadarMap({
  viewport,
  onViewportChange,
  markers,
  selectedId,
  onSelect,
  emptyMessage,
  className,
}: RadarMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<MapSize>({ width: 720, height: MIN_HEIGHT });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const rect = entry.contentRect;
      setSize({
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(MIN_HEIGHT, Math.round(rect.height)),
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const start = drag.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      drag.current = { x: e.clientX, y: e.clientY, moved: true };
      onViewportChange(panViewport(viewport, dx, dy, size));
    },
    [onViewportChange, viewport, size],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    drag.current = null;
  }, []);

  const step = graticuleStep(viewport.zoom);
  const topLeft = fromScreen({ x: 0, y: 0 }, viewport, size);
  const bottomRight = fromScreen({ x: size.width, y: size.height }, viewport, size);
  const bar = scaleBar(viewport.centerLat, viewport.zoom);

  const latLines: number[] = [];
  for (
    let lat = Math.floor(bottomRight.lat / step) * step;
    lat <= topLeft.lat + step;
    lat += step
  ) {
    latLines.push(Number(lat.toFixed(6)));
  }
  const lngLines: number[] = [];
  for (
    let lng = Math.floor(topLeft.lng / step) * step;
    lng <= bottomRight.lng + step;
    lng += step
  ) {
    lngLines.push(Number(lng.toFixed(6)));
  }

  const place = (point: LatLng) => toScreen(point, viewport, size);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative overflow-hidden rounded-xl bg-muted/40",
        className,
      )}
      style={{ minHeight: MIN_HEIGHT }}
    >
      <svg
        role="application"
        aria-label="Map of nearby stores"
        width={size.width}
        height={size.height}
        className="touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <g className="stroke-border" strokeWidth={1} opacity={0.5}>
          {latLines.map((lat) => {
            const y = place({ lat, lng: viewport.centerLng }).y;
            return <line key={`lat-${lat}`} x1={0} x2={size.width} y1={y} y2={y} />;
          })}
          {lngLines.map((lng) => {
            const x = place({ lat: viewport.centerLat, lng }).x;
            return <line key={`lng-${lng}`} y1={0} y2={size.height} x1={x} x2={x} />;
          })}
        </g>

        {markers.map((marker) => {
          const { x, y } = place(marker);
          if (x < -40 || y < -40 || x > size.width + 40 || y > size.height + 40) {
            return null;
          }
          const level = hotnessLevel(marker.score ?? 0);
          const r = marker.score == null ? 7 : markerRadius(marker.score);
          const selected = marker.id === selectedId;
          return (
            <g
              key={marker.id}
              transform={`translate(${x} ${y})`}
              tabIndex={0}
              role="button"
              aria-label={`${marker.label}${marker.sublabel ? `. ${marker.sublabel}` : ""}`}
              aria-pressed={selected}
              className="cursor-pointer outline-none focus-visible:opacity-80"
              onClick={(e) => {
                e.stopPropagation();
                if (drag.current?.moved) return;
                onSelect(marker.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(marker.id);
                }
              }}
            >
              {/* Hover text for a pointer, mirroring the label a screen reader
                  already gets — the map has no room for permanent labels. */}
              <title>
                {marker.label}
                {marker.sublabel ? ` — ${marker.sublabel}` : ""}
              </title>
              {selected && (
                <circle r={r + 6} className="fill-none stroke-foreground" strokeWidth={2} />
              )}
              {marker.score == null ? (
                // Personal-only pin: a ring, never a filled hotness colour. It
                // carries no network number, and colouring it like one would
                // imply the map knows something about the place that it does not.
                <circle
                  r={r}
                  className="fill-background stroke-brand-navy dark:stroke-foreground"
                  strokeWidth={3}
                />
              ) : (
                <>
                  <circle
                    r={r}
                    className={cn(HOTNESS_FILL[level], "stroke-background")}
                    strokeWidth={2}
                    fillOpacity={0.85}
                  />
                  {marker.personal && (
                    <circle
                      r={r + 4}
                      className="fill-none stroke-brand-navy dark:stroke-foreground"
                      strokeWidth={2}
                    />
                  )}
                </>
              )}
            </g>
          );
        })}
      </svg>

      {markers.length === 0 && emptyMessage && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
          <p className="max-w-[42ch] text-center text-sm text-muted-foreground">
            {emptyMessage}
          </p>
        </div>
      )}

      <div className="absolute right-3 top-3 flex flex-col gap-1">
        <Button
          type="button"
          size="icon"
          variant="secondary"
          aria-label="Zoom in"
          disabled={viewport.zoom >= MAX_ZOOM}
          onClick={() => onViewportChange(zoomViewport(viewport, 1))}
        >
          <Plus className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="secondary"
          aria-label="Zoom out"
          disabled={viewport.zoom <= MIN_ZOOM}
          onClick={() => onViewportChange(zoomViewport(viewport, -1))}
        >
          <Minus className="h-4 w-4" />
        </Button>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 flex items-end gap-2">
        <div>
          <div
            className="h-2 border-b-2 border-l-2 border-r-2 border-foreground/60"
            style={{ width: clamp(bar.width, 24, 240) }}
          />
          <p className="mt-1 text-xs text-muted-foreground">{bar.label}</p>
        </div>
      </div>
    </div>
  );
}

/** The legend. Separate so the map itself stays a pure drawing surface. */
export function RadarMapLegend({ hasPersonal }: { hasPersonal: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
      {HOTNESS_LEVELS.map((level) => (
        <span key={level} className="flex items-center gap-1.5">
          <svg width={14} height={14} aria-hidden="true">
            <circle cx={7} cy={7} r={5} className={HOTNESS_FILL[level]} fillOpacity={0.85} />
          </svg>
          {HOTNESS_LABELS[level]}
        </span>
      ))}
      {hasPersonal && (
        <span className="flex items-center gap-1.5">
          <svg width={14} height={14} aria-hidden="true">
            <circle
              cx={7}
              cy={7}
              r={5}
              className="fill-background stroke-brand-navy dark:stroke-foreground"
              strokeWidth={2.5}
            />
          </svg>
          A store of yours
        </span>
      )}
    </div>
  );
}

/**
 * The weekly pattern, as seven bars.
 *
 * Bars rather than a line: the days are categories, not a continuum, and a line
 * between Saturday and Sunday would draw a trend across a boundary nothing
 * crosses. The busiest day is stated in text too, because a bar chart this small
 * is a shape, not a reading.
 */
export function ActivityByDay({
  bars,
}: {
  bars: { label: string; count: number; share: number; busiest: boolean }[];
}) {
  return (
    <div className="flex items-end gap-2" role="img" aria-label={
      `Scans by day of the week: ${bars.map((b) => `${b.label} ${b.count}`).join(", ")}`
    }>
      {bars.map((bar) => (
        <div key={bar.label} className="flex flex-1 flex-col items-center gap-1">
          <span className="text-xs tabular-nums text-muted-foreground">{bar.count}</span>
          <div className="flex h-16 w-full items-end">
            <div
              className={cn(
                "w-full rounded-t",
                bar.busiest ? "bg-brand-red" : "bg-muted-foreground/35",
              )}
              style={{ height: `${Math.max(4, Math.round(bar.share * 100))}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground">{bar.label}</span>
        </div>
      ))}
    </div>
  );
}
