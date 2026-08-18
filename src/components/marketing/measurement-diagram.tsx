import { MEASUREMENT_HOWTO } from "@/lib/size-conversion";

// US-9007: where each measurement is actually taken, drawn.
//
// The page describes all nine in prose and that is the part a search engine
// reads, but "pit to pit" and "front rise" are exactly the terms a first-time
// seller cannot picture from a sentence. Two flat-lay outlines with the tape
// drawn on them answer it in one look.
//
// INLINE SVG, no image file. It has to survive the prerender (the page ships as
// static HTML before React mounts), it has to read in both themes, and the
// labels have to be selectable text rather than pixels. `currentColor` for the
// garment and a CSS variable for the tape means it inherits the theme instead
// of carrying its own palette.
//
// The keys come from MEASUREMENT_HOWTO, so a measurement added there without a
// line drawn here fails measurement-diagram.test.tsx rather than quietly going
// undrawn.

/** The nine measurements, split by which garment outline carries them. */
export const TOP_MEASUREMENTS = ["chest", "length", "shoulder", "sleeve"] as const;
export const BOTTOM_MEASUREMENTS = [
  "waist",
  "hip",
  "rise",
  "inseam",
  "leg_opening",
] as const;

type MeasurementKey = string;

/** Short label for the drawing — the full one is in the list below the diagram. */
const SHORT_LABEL: Record<string, string> = {
  chest: "Pit to pit",
  length: "Length",
  shoulder: "Shoulder",
  sleeve: "Sleeve",
  waist: "Waist",
  hip: "Hip",
  rise: "Front rise",
  inseam: "Inseam",
  leg_opening: "Leg opening",
};

interface TapeProps {
  measurementKey: MeasurementKey;
  highlight?: MeasurementKey;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Where the label sits relative to the line. */
  labelX: number;
  labelY: number;
  anchor?: "start" | "middle" | "end";
}

/** One measurement line: the tape, its end caps, and its label. */
function Tape({
  measurementKey,
  highlight,
  x1,
  y1,
  x2,
  y2,
  labelX,
  labelY,
  anchor = "middle",
}: TapeProps) {
  const on = highlight === measurementKey;
  // The cap is drawn perpendicular to the line, so one helper serves the
  // horizontal, vertical and diagonal tapes without three special cases.
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const cap = 5;
  const px = (-dy / len) * cap;
  const py = (dx / len) * cap;
  return (
    <g
      className={on ? "text-brand-red-text" : "text-muted-foreground"}
      opacity={highlight && !on ? 0.45 : 1}
    >
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke="currentColor"
        strokeWidth={on ? 2 : 1.25}
      />
      <line
        x1={x1 + px}
        y1={y1 + py}
        x2={x1 - px}
        y2={y1 - py}
        stroke="currentColor"
        strokeWidth={on ? 2 : 1.25}
      />
      <line
        x1={x2 + px}
        y1={y2 + py}
        x2={x2 - px}
        y2={y2 - py}
        stroke="currentColor"
        strokeWidth={on ? 2 : 1.25}
      />
      <text
        x={labelX}
        y={labelY}
        textAnchor={anchor}
        fill="currentColor"
        fontSize="11"
        fontWeight={on ? 600 : 400}
      >
        {SHORT_LABEL[measurementKey]}
      </text>
    </g>
  );
}

/** The garment outline itself — no fill, so it reads on either theme. */
const OUTLINE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinejoin: "round" as const,
};

export function TopMeasurementDiagram({ highlight }: { highlight?: MeasurementKey }) {
  return (
    <svg
      viewBox="0 0 300 270"
      className="h-auto w-full max-w-[300px] text-foreground"
      role="img"
      aria-labelledby="top-diagram-title top-diagram-desc"
    >
      <title id="top-diagram-title">Where each measurement is taken on a top</title>
      <desc id="top-diagram-desc">
        A t-shirt laid flat. Shoulder is measured seam to seam across the top.
        Pit to pit is measured straight across one inch below the armpit seams.
        Sleeve runs from the shoulder seam to the cuff. Length runs from the
        highest point of the shoulder down to the hem.
      </desc>
      {/* Body and sleeves, drawn as one flat-lay outline. */}
      <path
        d="M112 44 L78 52 L44 104 L74 124 L84 108 L84 236 L206 236 L206 108 L216 124 L246 104 L212 52 L178 44 C168 60 122 60 112 44 Z"
        {...OUTLINE}
      />
      <Tape
        measurementKey="shoulder"
        highlight={highlight}
        x1={80}
        y1={34}
        x2={210}
        y2={34}
        labelX={145}
        labelY={26}
      />
      <Tape
        measurementKey="chest"
        highlight={highlight}
        x1={84}
        y1={116}
        x2={206}
        y2={116}
        labelX={145}
        labelY={132}
      />
      <Tape
        measurementKey="sleeve"
        highlight={highlight}
        x1={212}
        y1={52}
        x2={246}
        y2={104}
        labelX={252}
        labelY={80}
        anchor="start"
      />
      <Tape
        measurementKey="length"
        highlight={highlight}
        x1={62}
        y1={50}
        x2={62}
        y2={236}
        labelX={56}
        labelY={148}
        anchor="end"
      />
    </svg>
  );
}

export function BottomMeasurementDiagram({
  highlight,
}: {
  highlight?: MeasurementKey;
}) {
  return (
    <svg
      viewBox="0 0 300 270"
      className="h-auto w-full max-w-[300px] text-foreground"
      role="img"
      aria-labelledby="bottom-diagram-title bottom-diagram-desc"
    >
      <title id="bottom-diagram-title">
        Where each measurement is taken on trousers
      </title>
      <desc id="bottom-diagram-desc">
        A pair of trousers laid flat. Waist is measured across the top of the
        waistband. Hip is measured across at the widest point below it. Front
        rise runs from the top of the waistband down to the crotch seam. Inseam
        runs from the crotch seam down the inner leg to the hem. Leg opening is
        measured across one hem.
      </desc>
      <path
        d="M96 40 L204 40 L212 96 L162 240 L138 240 L150 138 L138 138 L120 240 L96 240 L88 96 Z"
        {...OUTLINE}
      />
      {/* The crotch seam, which is where two of the five measurements start. */}
      <path d="M138 138 L150 138" {...OUTLINE} />
      <Tape
        measurementKey="waist"
        highlight={highlight}
        x1={96}
        y1={30}
        x2={204}
        y2={30}
        labelX={150}
        labelY={22}
      />
      <Tape
        measurementKey="hip"
        highlight={highlight}
        x1={89}
        y1={100}
        x2={211}
        y2={100}
        labelX={150}
        labelY={116}
      />
      <Tape
        measurementKey="rise"
        highlight={highlight}
        x1={70}
        y1={42}
        x2={70}
        y2={138}
        labelX={64}
        labelY={94}
        anchor="end"
      />
      <Tape
        measurementKey="inseam"
        highlight={highlight}
        x1={230}
        y1={140}
        x2={230}
        y2={240}
        labelX={236}
        labelY={194}
        anchor="start"
      />
      <Tape
        measurementKey="leg_opening"
        highlight={highlight}
        x1={138}
        y1={252}
        x2={162}
        y2={252}
        labelX={150}
        labelY={266}
      />
    </svg>
  );
}

/** Every measurement key the two diagrams draw, for the coverage guard. */
export const DIAGRAMMED_MEASUREMENTS: readonly string[] = [
  ...TOP_MEASUREMENTS,
  ...BOTTOM_MEASUREMENTS,
];

/** The keys MEASUREMENT_HOWTO carries, so the guard can compare the two sets. */
export function howtoMeasurementKeys(): string[] {
  return MEASUREMENT_HOWTO.map((m) => m.key);
}
