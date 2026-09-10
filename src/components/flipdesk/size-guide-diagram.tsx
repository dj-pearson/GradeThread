// US-3283: where each measurement is taken, drawn per garment group.
//
// A size chart is a grid of numbers, and the number a seller gets wrong is
// almost never the arithmetic — it is WHICH LINE they put the tape on. "Chest"
// on a tee is pit to pit across one side, not around the wearer; "waist" on
// jeans is across the flat waistband, not the seller's own waist; a bag's
// "depth" is the base front-to-back, which half of resale reports as the height.
// The chart cannot say any of that. A picture can.
//
// So this file is one flat line drawing per measurement group, with a marked
// line for each field in that group's MEASUREMENT_TEMPLATES entry. Field keys
// come straight from those templates, which is what lets the panel highlight
// the line for the field the seller is filling in.
//
// DRAWING RULES, so ten silhouettes read as one set:
//   • One viewBox for every group, 160x160 of drawing inside a small margin.
//     Nothing is to scale between
//     groups, and pretending otherwise would invite comparing a hat to a coat.
//   • The garment is a single stroked path at 25% foreground. It is context,
//     not the subject; a heavy outline competes with the measurement lines.
//   • Measurement lines are `currentColor` so the caller sets the accent once,
//     with serif-free end ticks and a label at the midpoint.
//   • No fills, no gradients, no shadows. This has to read at 120px on a phone
//     and in both themes, and a fill is the first thing to go muddy in dark.

import type { MeasurementGroup } from "@/lib/measurement-templates";

/** A drawn measurement: the template field it belongs to and where it sits. */
interface Dim {
  key: string;
  label: string;
  /** Line endpoints in viewBox units. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Which side of the line the label sits on. */
  place?: "above" | "below" | "left" | "right";
}

interface GroupDrawing {
  /** The garment outline, as SVG path data. */
  outline: string[];
  dims: Dim[];
}

// ── The silhouettes ─────────────────────────────────────────────────────────

const TOP: GroupDrawing = {
  outline: [
    // Body: shoulders, sleeves, side seams, hem. Drawn as one closed path so a
    // tee reads as a tee rather than as a collection of segments.
    "M56 30 L60 22 L72 18 L88 18 L100 22 L104 30 L128 46 L118 62 L108 56 L108 132 L52 132 L52 56 L42 62 L32 46 Z",
    // Neck opening.
    "M72 18 Q80 28 88 18",
  ],
  dims: [
    { key: "chest", label: "Chest", x1: 52, y1: 62, x2: 108, y2: 62, place: "above" },
    { key: "shoulder", label: "Shoulder", x1: 56, y1: 30, x2: 104, y2: 30, place: "below" },
    { key: "length", label: "Length", x1: 80, y1: 20, x2: 80, y2: 132, place: "right" },
    { key: "sleeve", label: "Sleeve", x1: 104, y1: 30, x2: 123, y2: 54, place: "right" },
  ],
};

const OUTERWEAR: GroupDrawing = {
  outline: [
    "M54 30 L58 21 L72 16 L88 16 L102 21 L106 30 L130 48 L120 64 L110 58 L110 140 L50 140 L50 58 L40 64 L30 48 Z",
    // Centre front opening — what makes a jacket read as a jacket.
    "M80 20 L80 140",
  ],
  dims: [
    { key: "chest", label: "Chest", x1: 50, y1: 66, x2: 110, y2: 66, place: "above" },
    { key: "shoulder", label: "Shoulder", x1: 54, y1: 30, x2: 106, y2: 30, place: "below" },
    { key: "length", label: "Length", x1: 122, y1: 22, x2: 122, y2: 140, place: "right" },
    { key: "sleeve", label: "Sleeve", x1: 106, y1: 30, x2: 125, y2: 56, place: "right" },
  ],
};

const BOTTOM: GroupDrawing = {
  outline: [
    // Waistband, hips, both legs, crotch.
    "M52 22 L108 22 L112 60 L110 142 L86 142 L80 78 L74 142 L50 142 L48 60 Z",
    // Waistband line.
    "M52 32 L108 32",
  ],
  dims: [
    { key: "waist", label: "Waist", x1: 52, y1: 26, x2: 108, y2: 26, place: "above" },
    { key: "hip", label: "Hip", x1: 49, y1: 48, x2: 111, y2: 48, place: "above" },
    { key: "rise", label: "Rise", x1: 80, y1: 22, x2: 80, y2: 78, place: "right" },
    { key: "inseam", label: "Inseam", x1: 74, y1: 78, x2: 74, y2: 142, place: "left" },
    { key: "leg_opening", label: "Leg opening", x1: 86, y1: 142, x2: 110, y2: 142, place: "below" },
  ],
};

const DRESS: GroupDrawing = {
  outline: [
    "M60 26 L68 18 L92 18 L100 26 L108 44 L102 50 L104 78 L118 142 L42 142 L56 78 L58 50 L52 44 Z",
    "M68 18 Q80 28 92 18",
  ],
  dims: [
    { key: "bust", label: "Bust", x1: 57, y1: 50, x2: 103, y2: 50, place: "above" },
    { key: "waist", label: "Waist", x1: 56, y1: 72, x2: 104, y2: 72, place: "above" },
    { key: "hip", label: "Hip", x1: 52, y1: 94, x2: 108, y2: 94, place: "above" },
    { key: "length", label: "Length", x1: 128, y1: 20, x2: 128, y2: 142, place: "left" },
  ],
};

const SUIT: GroupDrawing = {
  outline: [
    // Jacket, left half of the frame.
    "M18 28 L22 20 L32 16 L46 16 L56 20 L60 28 L74 40 L67 51 L61 47 L61 108 L17 108 L17 47 L11 51 L4 40 Z",
    "M39 19 L39 108",
    // Trousers, right half.
    "M96 26 L146 26 L149 56 L147 140 L126 140 L121 84 L116 140 L95 140 L93 56 Z",
    "M96 34 L146 34",
  ],
  dims: [
    // Only four of the seven suit fields are drawn. Seven labels in one frame
    // collide into an unreadable mess, and shoulder, sleeve and rise are the
    // optional ones — the tops and bottoms diagrams teach those lines on a
    // garment that has room to show them.
    { key: "chest", label: "Chest", x1: 17, y1: 52, x2: 61, y2: 52, place: "above" },
    { key: "length", label: "Jacket length", x1: 8, y1: 20, x2: 8, y2: 108, place: "right" },
    { key: "waist", label: "Waist", x1: 96, y1: 30, x2: 146, y2: 30, place: "above" },
    { key: "inseam", label: "Inseam", x1: 116, y1: 84, x2: 116, y2: 140, place: "right" },
  ],
};

const SHOES: GroupDrawing = {
  outline: [
    // Side profile: sole, toe, vamp, collar, heel.
    "M18 118 Q16 100 30 96 L52 92 L74 70 L96 62 Q120 60 132 74 Q142 86 142 100 L142 118 Z",
    // Sole line — the insole runs along it, which is the whole point of the
    // one measurement resale actually asks a shoe seller for.
    "M18 110 L142 110",
  ],
  dims: [
    { key: "insole", label: "Insole", x1: 20, y1: 132, x2: 140, y2: 132, place: "below" },
  ],
};

const WATCH: GroupDrawing = {
  outline: [
    // Case.
    "M56 56 L104 56 L104 104 L56 104 Z",
    // Crystal.
    "M64 64 L96 64 L96 96 L64 96 Z",
    // Band, top and bottom.
    "M64 56 L64 18 L96 18 L96 56",
    "M64 104 L64 142 L96 142 L96 104",
  ],
  dims: [
    { key: "lug_width", label: "Lug", x1: 64, y1: 30, x2: 96, y2: 30, place: "left" },
    { key: "case_diameter", label: "Case", x1: 56, y1: 80, x2: 104, y2: 80, place: "left" },
    { key: "band_length", label: "Band", x1: 126, y1: 18, x2: 126, y2: 142, place: "right" },
  ],
};

const BAG: GroupDrawing = {
  outline: [
    // Front face.
    "M34 62 L112 62 L112 128 L34 128 Z",
    // Depth, as a receding top-right face.
    "M34 62 L54 44 L132 44 L112 62",
    "M112 128 L132 110 L132 44",
    // Handle.
    "M56 62 Q73 22 90 62",
  ],
  dims: [
    { key: "width", label: "Width", x1: 34, y1: 136, x2: 112, y2: 136, place: "below" },
    { key: "height", label: "Height", x1: 26, y1: 62, x2: 26, y2: 128, place: "right" },
    { key: "depth", label: "Depth", x1: 116, y1: 60, x2: 134, y2: 44, place: "right" },
    // Only ONE drop is drawn, and it is the one this silhouette actually has.
    // MEASUREMENT_TEMPLATES offers handle drop AND strap drop because a
    // top-handle bag has no strap and a crossbody has no handles; labelling
    // both on a bag drawn with a handle would teach a measurement that is not
    // on the object in front of the seller.
    { key: "handle_drop", label: "Handle drop", x1: 73, y1: 34, x2: 73, y2: 62, place: "left" },
  ],
};

const HEADWEAR: GroupDrawing = {
  outline: [
    // Crown.
    "M40 96 Q40 40 80 40 Q120 40 120 96 Z",
    // Sweatband — the inside circumference is measured along it.
    "M40 96 L120 96",
    // Brim.
    "M40 96 Q34 116 62 118 L120 116 Q124 100 120 96",
  ],
  dims: [
    { key: "circumference", label: "Circumference", x1: 40, y1: 90, x2: 120, y2: 90, place: "above" },
    { key: "crown_height", label: "Crown", x1: 30, y1: 40, x2: 30, y2: 96, place: "left" },
    { key: "brim_length", label: "Brim", x1: 96, y1: 128, x2: 124, y2: 128, place: "below" },
  ],
};

const ACCESSORY: GroupDrawing = {
  outline: [
    // A belt, flattened: strap, buckle, holes.
    "M42 66 L138 66 L138 94 L42 94 Z",
    "M18 62 L42 62 L42 98 L18 98 Z",
    "M28 74 L34 74 L34 86 L28 86 Z",
  ],
  dims: [
    { key: "length", label: "Length", x1: 18, y1: 108, x2: 138, y2: 108, place: "below" },
    { key: "width", label: "Width", x1: 150, y1: 66, x2: 150, y2: 94, place: "left" },
    { key: "hole_span", label: "First to last hole", x1: 96, y1: 54, x2: 132, y2: 54, place: "above" },
  ],
};

const GENERIC: GroupDrawing = {
  outline: ["M40 44 L120 44 L120 124 L40 124 Z"],
  dims: [
    { key: "width", label: "Width", x1: 40, y1: 134, x2: 120, y2: 134, place: "below" },
    { key: "length", label: "Length", x1: 30, y1: 44, x2: 30, y2: 124, place: "left" },
  ],
};

const DRAWINGS: Record<MeasurementGroup, GroupDrawing> = {
  top: TOP,
  outerwear: OUTERWEAR,
  bottom: BOTTOM,
  dress: DRESS,
  suit: SUIT,
  shoes: SHOES,
  watch: WATCH,
  bag: BAG,
  headwear: HEADWEAR,
  accessory: ACCESSORY,
  generic: GENERIC,
};

// ── Rendering ───────────────────────────────────────────────────────────────

/** Tick marks perpendicular to the line, so an endpoint is unambiguous. */
function ticks(d: Dim): { a: string; b: string } {
  const dx = d.x2 - d.x1;
  const dy = d.y2 - d.y1;
  const len = Math.hypot(dx, dy) || 1;
  // Unit normal, scaled to a 4-unit half-tick.
  const nx = (-dy / len) * 4;
  const ny = (dx / len) * 4;
  return {
    a: `M${d.x1 - nx} ${d.y1 - ny} L${d.x1 + nx} ${d.y1 + ny}`,
    b: `M${d.x2 - nx} ${d.y2 - ny} L${d.x2 + nx} ${d.y2 + ny}`,
  };
}

function labelPos(d: Dim): {
  x: number;
  y: number;
  anchor: "middle" | "start" | "end";
} {
  const mx = (d.x1 + d.x2) / 2;
  const my = (d.y1 + d.y2) / 2;
  // Beside a VERTICAL line means beside its midpoint; beside a HORIZONTAL one
  // means past its end. Using the midpoint for both is what put the watch's
  // "Lug" and "Case" labels on top of the strap they measure across.
  const horizontal = Math.abs(d.y2 - d.y1) <= Math.abs(d.x2 - d.x1);
  switch (d.place) {
    case "above":
      return { x: mx, y: my - 5, anchor: "middle" };
    case "below":
      return { x: mx, y: my + 11, anchor: "middle" };
    case "left":
      return {
        x: (horizontal ? Math.min(d.x1, d.x2) : mx) - 5,
        y: my + 3,
        anchor: "end",
      };
    default:
      return {
        x: (horizontal ? Math.max(d.x1, d.x2) : mx) + 5,
        y: my + 3,
        anchor: "start",
      };
  }
}

interface Props {
  group: MeasurementGroup;
  /**
   * Field keys to draw, normally the group's MEASUREMENT_TEMPLATES keys.
   * Anything this group has no line for is dropped rather than approximated,
   * and anything the form does not ask for is never drawn — a labelled line
   * for a measurement nobody is entering teaches the wrong measurement.
   */
  fields: readonly string[];
  /** Draw this field's line at full strength and dim the rest. */
  highlight?: string | null;
  className?: string;
}

export function SizeGuideDiagram({
  group,
  fields,
  highlight,
  className,
}: Props) {
  const drawing = DRAWINGS[group] ?? GENERIC;
  const shown = drawing.dims.filter((d) => fields.includes(d.key));
  if (shown.length === 0) return null;

  return (
    <svg
      // -8/-4 with 176x172 is 160x160 of drawing plus a margin: a label sits
      // OUTSIDE the line it names, so an edge measurement clips without one.
      viewBox="-8 -4 176 172"
      role="img"
      aria-label={`Where to measure: ${shown.map((d) => d.label).join(", ")}`}
      className={className}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {drawing.outline.map((d, i) => (
        <path
          key={`o${i}`}
          d={d}
          className="stroke-foreground/25"
          strokeWidth={1.5}
        />
      ))}
      {shown.map((d) => {
        const t = ticks(d);
        const pos = labelPos(d);
        const dimmed = !!highlight && highlight !== d.key;
        return (
          <g key={d.key} className={dimmed ? "opacity-30" : undefined}>
            <path
              d={`M${d.x1} ${d.y1} L${d.x2} ${d.y2}`}
              stroke="currentColor"
              strokeWidth={1.75}
            />
            <path d={t.a} stroke="currentColor" strokeWidth={1.75} />
            <path d={t.b} stroke="currentColor" strokeWidth={1.75} />
            <text
              x={pos.x}
              y={pos.y}
              textAnchor={pos.anchor}
              fill="currentColor"
              fontSize={8}
              className="font-medium"
            >
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
