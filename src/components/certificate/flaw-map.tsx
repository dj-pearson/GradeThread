import { useMemo } from "react";
import type { AnnotatedPhotoGroup } from "@/components/certificate/annotated-defect-photo";
import { severityColor } from "@/lib/defect-severity-color";
import { silhouetteFor } from "@/lib/coverage-silhouettes";
import { buildFlawMap } from "@/lib/flaw-zones";

// US-3336: the numbered flaws from the photo callouts, pinned on the garment
// outline, so a buyer sees the damage map at a glance. The numbers are the
// callout numbers. The drawing is aria-hidden; the list beside it says the same
// thing in words, including which flaws could not be placed on the outline.

const ZONE_WORDS: Record<string, string> = {
  front: "front",
  back: "back",
  collar_neckline: "collar or neckline",
  cuffs: "cuffs or sleeves",
  hem: "hem",
  underarms: "underarms",
  waistband: "waistband",
  inseam_crotch: "inseam or crotch",
  pockets: "pockets",
  closure: "closure",
  lining: "lining",
  branding: "label or branding",
};

function zoneWords(zone: string): string {
  return ZONE_WORDS[zone] ?? zone.replace(/_/g, " ");
}

export function FlawMap({
  groups,
  garmentCategory,
}: {
  groups: AnnotatedPhotoGroup[];
  garmentCategory: string | null | undefined;
}) {
  const silhouette = silhouetteFor(garmentCategory);
  const { pinned, unmapped } = useMemo(
    () => buildFlawMap(groups, silhouette),
    [groups, silhouette],
  );

  // Nothing to place on this shape: the photo callouts already say it all.
  if (!silhouette || pinned.length === 0) return null;

  return (
    <div className="grid gap-4 rounded-lg border p-3 sm:grid-cols-[140px_1fr] sm:items-start">
      <svg
        viewBox="0 0 100 130"
        className="mx-auto h-auto w-[120px] sm:w-full"
        aria-hidden="true"
      >
        <path d={silhouette.path} className="fill-muted stroke-border" strokeWidth="1.5" />
        {pinned.map((p) => (
          <g key={p.n}>
            <circle
              cx={p.cx}
              cy={p.cy}
              r="5"
              fill={severityColor(p.severity)}
              stroke="rgba(0,0,0,0.35)"
              strokeWidth="0.75"
            />
            <text
              x={p.cx}
              y={p.cy}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize="6"
              fontWeight="700"
              fill="#fff"
            >
              {p.n}
            </text>
          </g>
        ))}
      </svg>
      <div className="space-y-2">
        <p className="text-sm font-medium">Where the flaws are</p>
        <ol className="space-y-1 text-xs">
          {pinned.map((p) => (
            <li key={p.n} className="flex items-start gap-2">
              <span
                className="mt-px flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
                style={{ backgroundColor: severityColor(p.severity) }}
                aria-hidden="true"
              >
                {p.n}
              </span>
              <span className="text-muted-foreground">
                <span className="sr-only">Flaw {p.n}: </span>
                <span className="font-medium text-foreground">{p.issue}</span>, {zoneWords(p.zone)}
              </span>
            </li>
          ))}
          {unmapped.map((a) => (
            <li key={a.n} className="flex items-start gap-2">
              <span
                className="mt-px flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
                style={{ backgroundColor: severityColor(a.severity) }}
                aria-hidden="true"
              >
                {a.n}
              </span>
              <span className="text-muted-foreground">
                <span className="sr-only">Flaw {a.n}: </span>
                <span className="font-medium text-foreground">{a.issue}</span>, location not mapped
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
