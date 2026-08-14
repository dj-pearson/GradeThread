import { MEASURE_CARD_V1 } from "@/lib/measure-card";

// US-2540: what the card actually looks like.
//
// The page told sellers to "shoot with all four black squares fully visible"
// without ever showing the object — so someone who had not yet printed one was
// being given framing instructions for a thing they could not picture. Every
// dimension here is read from MEASURE_CARD_V1, the same generated geometry the
// PDF and the decoder use, so the drawing cannot drift from the card.
//
// It is a DIAGRAM, not the card: the fiducials are drawn as plain black squares
// rather than the real ArUco bit patterns, because a printed screenshot of this
// would not decode and nobody should be able to mistake it for a usable card.
// The label says so.

export function MeasureCardDiagram({ className }: { className?: string }) {
  const g = MEASURE_CARD_V1;
  const { w, h } = g.cardInches;
  const m = g.markerSizeInches;
  const centers = g.markerIds.map((id) => g.markerCentersInches[String(id)]!);

  return (
    <figure className={className}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full rounded-md border bg-white"
        role="img"
        aria-label={`Diagram of the MeasureCard: a ${w} by ${h} inch card with a black square in each corner.`}
      >
        {/* The card face. */}
        <rect x={0} y={0} width={w} height={h} fill="#ffffff" />
        {centers.map(([cx, cy], i) => (
          <rect
            key={g.markerIds[i]}
            x={cx - m / 2}
            y={cy - m / 2}
            width={m}
            height={m}
            fill="#111111"
          />
        ))}
        {/* The rectangle the four centres form — the measurement ground truth,
            and the reason a covered corner ruins the photo. */}
        <rect
          x={centers[0]![0]}
          y={centers[0]![1]}
          width={g.centerRectInches.w}
          height={g.centerRectInches.h}
          fill="none"
          stroke="#94a3b8"
          strokeWidth={0.02}
          strokeDasharray="0.12 0.08"
        />
        <text
          x={w / 2}
          y={h / 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={0.34}
          fill="#0F3460"
          fontWeight="600"
        >
          GradeThread MeasureCard
        </text>
        <text
          x={w / 2}
          y={h / 2 + 0.5}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={0.22}
          fill="#64748b"
        >
          {g.centerRectInches.w}in × {g.centerRectInches.h}in between corner
          centres
        </text>
      </svg>
      <figcaption className="mt-2 text-xs text-muted-foreground">
        Not to scale and not a usable card — a photo of this screen will not
        decode. The real card is {w}in × {h}in ({Math.round(w * 25.4)}mm ×{" "}
        {Math.round(h * 25.4)}mm), and the four corner squares are what the
        measurement is calculated from: cover one and the photo cannot be used.
      </figcaption>
    </figure>
  );
}
