import type { PublicImageDefectAnnotations } from "@/types/database";

// US-1287: PSA-style defect callouts on the public certificate. The grader
// stores a normalized [x,y,w,h] bbox per localized defect (migration 00313
// exposes them on public_grade_reports.defect_annotations). This renders the
// garment photo at its natural aspect ratio with a numbered, severity-colored
// box over each defect and a matching legend underneath. Defects WITHOUT a bbox
// aren't drawn here — they stay in the certificate's text "Condition & Flaws"
// list, which remains the canonical fallback.

// Severity tones mirror the disclosure compositor (annotated-photo.tsx,
// vault/20-domain/brand-design-system.md §3B): crimson for major, amber for moderate, gold for minor.
const SEVERITY_COLOR: Record<string, string> = {
  major: "#F03D5F",
  moderate: "#F59E0B",
  minor: "#EAB308",
};

const DEFAULT_SEVERITY_COLOR = "#F03D5F";

function severityColor(severity: string): string {
  return SEVERITY_COLOR[severity] ?? DEFAULT_SEVERITY_COLOR;
}

// Worst-first within an image so the most grade-relevant flaw leads.
const SEVERITY_RANK: Record<string, number> = { major: 0, moderate: 1, minor: 2 };

export interface NumberedAnnotation {
  n: number;
  issue: string;
  severity: "minor" | "moderate" | "major";
  location: string;
  bbox: [number, number, number, number];
}

export interface AnnotatedPhotoGroup {
  image_type: string;
  annotations: NumberedAnnotation[];
}

// A bbox is drawable only if it's four finite numbers; the grader normalizes to
// 0..1 but we clamp defensively so a bad value can't push a box off-canvas.
function validBbox(b: unknown): b is [number, number, number, number] {
  return (
    Array.isArray(b) &&
    b.length === 4 &&
    b.every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Number the localized defects sequentially ACROSS images (so the callout
 * number is unique on the whole certificate), worst-first within each image,
 * dropping any group left with no drawable boxes. Pure + unit-tested.
 */
export function buildAnnotatedGroups(
  groups: PublicImageDefectAnnotations[] | null | undefined,
): AnnotatedPhotoGroup[] {
  if (!Array.isArray(groups)) return [];
  let n = 1;
  const out: AnnotatedPhotoGroup[] = [];
  for (const g of groups) {
    const localized = (g.annotations ?? [])
      .filter((a) => validBbox(a.bbox))
      .slice()
      .sort(
        (a, b) =>
          (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3),
      )
      .map((a) => ({
        n: n++,
        issue: a.issue,
        severity: a.severity,
        location: a.location ?? "",
        bbox: a.bbox as [number, number, number, number],
      }));
    if (localized.length > 0) {
      out.push({ image_type: g.image_type, annotations: localized });
    }
  }
  return out;
}

function annotationLabel(a: NumberedAnnotation): string {
  const loc = a.location ? ` (${a.location})` : "";
  return `${a.issue}${loc} — ${a.severity}`;
}

export function AnnotatedDefectPhoto({
  imageType,
  url,
  annotations,
}: {
  imageType: string;
  url: string;
  annotations: NumberedAnnotation[];
}) {
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium capitalize">
          {imageType.replace(/_/g, " ")}
        </span>
        <span className="text-xs text-muted-foreground">
          {annotations.length} flaw{annotations.length === 1 ? "" : "s"} marked
        </span>
      </div>
      {/* Image at natural aspect (object-contain via h-auto) so the normalized
          bbox coordinates map linearly onto the displayed pixels. */}
      <div className="relative w-full overflow-hidden rounded-md border bg-muted">
        <img
          src={url}
          alt={`${imageType.replace(/_/g, " ")} photo with defect callouts`}
          loading="lazy"
          decoding="async"
          className="block h-auto w-full"
        />
        {annotations.map((a) => {
          const [x, y, w, h] = a.bbox;
          const color = severityColor(a.severity);
          return (
            <div
              key={a.n}
              className="absolute rounded-sm"
              style={{
                left: `${clamp01(x) * 100}%`,
                top: `${clamp01(y) * 100}%`,
                width: `${clamp01(w) * 100}%`,
                height: `${clamp01(h) * 100}%`,
                border: `2px solid ${color}`,
                boxShadow: "0 0 0 1px rgba(0,0,0,0.45)",
              }}
              role="img"
              aria-label={annotationLabel(a)}
            >
              <span
                className="absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-[10px] font-bold text-white"
                style={{
                  backgroundColor: color,
                  boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
                }}
              >
                {a.n}
              </span>
            </div>
          );
        })}
      </div>
      {/* Legend — ties each numbered box to its defect type + severity. */}
      <ol className="space-y-1">
        {annotations.map((a) => (
          <li key={a.n} className="flex items-start gap-2 text-xs">
            <span
              className="mt-px flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
              style={{ backgroundColor: severityColor(a.severity) }}
            >
              {a.n}
            </span>
            <span className="text-muted-foreground">
              <span className="font-medium text-foreground">{a.issue}</span>
              {a.location ? ` · ${a.location}` : ""}{" "}
              <span className="capitalize">— {a.severity}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
