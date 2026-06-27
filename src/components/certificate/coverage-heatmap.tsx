import { useMemo } from "react";
import { CircleCheck, CircleSlash, ScanLine } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PublicCoverageRecord } from "@/types/database";

// US-1278: buyer-facing coverage badge + garment-silhouette heatmap on the
// certificate. Shows what fraction of the garment the seller actually
// documented, shading documented vs not-documented inspection zones, so a buyer
// can trust the grade and understand what it does and does NOT cover. The
// undocumented zones are explicitly out of scope for the grade and the
// coverage-gated guarantee (US-1279/1280).
//
// Friendly zone labels MUST match the grading engine's catalog so the cert never
// invents copy. The engine (services/edge-functions/src/lib/coverage.ts) is the
// source of truth; we mirror only the id→label map here (a cert page shouldn't
// pull the edge-runtime module into the browser bundle).
const ZONE_LABELS: Record<string, string> = {
  front: "Front",
  back: "Back",
  collar_neckline: "Collar / neckline",
  cuffs: "Cuffs / sleeve ends",
  hem: "Hem",
  underarms: "Underarms",
  waistband: "Waistband",
  inseam_crotch: "Inseam / crotch",
  pockets: "Pockets",
  closure: "Primary closure",
  lining: "Interior lining",
  branding: "Branding / care label",
  sole: "Sole",
  upper: "Upper",
  insole: "Insole / footbed",
  hardware: "Hardware",
  strap: "Strap / handle",
};

function zoneLabel(id: string): string {
  return ZONE_LABELS[id] ?? id.replace(/_/g, " ");
}

// Fractional (0–1) anchor points on the generic garment silhouette for the
// common apparel zones. Zones without an anchor (category-specific ones like
// sole/insole/strap) still appear in the legend below — the silhouette is an
// at-a-glance aid, the legend is the authoritative list.
const ZONE_ANCHORS: Record<string, { x: number; y: number }> = {
  collar_neckline: { x: 0.5, y: 0.12 },
  front: { x: 0.5, y: 0.45 },
  back: { x: 0.5, y: 0.45 },
  underarms: { x: 0.26, y: 0.34 },
  closure: { x: 0.5, y: 0.6 },
  pockets: { x: 0.68, y: 0.62 },
  cuffs: { x: 0.12, y: 0.52 },
  waistband: { x: 0.5, y: 0.78 },
  hem: { x: 0.5, y: 0.92 },
  inseam_crotch: { x: 0.5, y: 0.84 },
  lining: { x: 0.36, y: 0.5 },
  branding: { x: 0.62, y: 0.2 },
};

export function CoverageHeatmap({
  coverage,
  className,
}: {
  coverage: PublicCoverageRecord;
  className?: string;
}) {
  const { applicable, covered, pct } = useMemo(() => {
    const cov = new Set(coverage.covered_zones ?? []);
    const applicableZones = coverage.applicable_zones ?? [];
    return {
      applicable: applicableZones,
      covered: cov,
      pct: Math.max(0, Math.min(100, Math.round(coverage.coverage_pct ?? 0))),
    };
  }, [coverage]);

  // Graceful no-op: a record with no applicable zones carries nothing to show.
  if (applicable.length === 0) return null;

  const documentedCount = applicable.filter((z) => covered.has(z)).length;
  const full = documentedCount === applicable.length;

  // Only zones that have a silhouette anchor get a marker; the rest live in the
  // legend. Render covered markers first so missing ones aren't visually buried.
  const markers = applicable
    .filter((z) => ZONE_ANCHORS[z])
    .map((z) => ({ id: z, ...ZONE_ANCHORS[z]!, documented: covered.has(z) }));

  return (
    <div className={cn("rounded-lg border bg-muted/30 p-4", className)}>
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <ScanLine className="h-4 w-4 text-brand-navy dark:text-foreground" />
          Photo coverage
        </p>
        <span
          className={cn(
            "rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums",
            full
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
              : "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
          )}
        >
          Coverage: {pct}% documented
        </span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-[160px_1fr] sm:items-start">
        {/* Silhouette heatmap */}
        <div className="mx-auto w-[140px]">
          <svg
            viewBox="0 0 100 130"
            className="h-auto w-full"
            role="img"
            aria-label={`Garment coverage: ${documentedCount} of ${applicable.length} inspection zones documented`}
          >
            {/* Generic garment silhouette (collar + sleeves + body). */}
            <path
              d="M38 6 L50 2 L62 6 L82 16 L76 34 L66 30 L66 122 L34 122 L34 30 L24 34 L18 16 Z"
              className="fill-muted stroke-border"
              strokeWidth="1.5"
            />
            {markers.map((m) => (
              <g key={m.id}>
                <circle
                  cx={m.x * 100}
                  cy={m.y * 130}
                  r="5.5"
                  className={cn(
                    "stroke-white/70",
                    m.documented
                      ? "fill-emerald-500"
                      : "fill-amber-400/80",
                  )}
                  strokeWidth="1"
                >
                  <title>
                    {zoneLabel(m.id)}:{" "}
                    {m.documented
                      ? "documented"
                      : "not shown — not covered by the grade"}
                  </title>
                </circle>
              </g>
            ))}
          </svg>
        </div>

        {/* Authoritative zone legend */}
        <ul className="grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-1 md:grid-cols-2">
          {applicable.map((z) => {
            const documented = covered.has(z);
            return (
              <li key={z} className="flex items-start gap-1.5">
                {documented ? (
                  <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <CircleSlash className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                )}
                <span
                  className={cn(
                    documented
                      ? "text-foreground/90"
                      : "text-muted-foreground",
                  )}
                >
                  {zoneLabel(z)}
                  {!documented && (
                    <span className="block text-[10px] italic text-amber-700/80 dark:text-amber-400/80">
                      not shown — not covered
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
        {full ? (
          <>
            Every standard inspection zone for this garment was documented. The
            grade and the Grade Accuracy Guarantee cover the whole item.
          </>
        ) : (
          <>
            The grade reflects only the {documentedCount} of {applicable.length}{" "}
            inspection zones the seller&apos;s photos documented. Zones marked{" "}
            <span className="italic">not shown</span> were not photographed and
            are outside the grade and guarantee scope.
          </>
        )}
      </p>
    </div>
  );
}
