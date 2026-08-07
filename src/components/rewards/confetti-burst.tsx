import { useEffect, useState } from "react";
import { prefersReducedMotion } from "@/lib/reward-celebrations";

// US-1857: the celebration animation. CSS-only — no animation library, no
// canvas, no new dependency; the keyframes live in index.css and this component
// only decides WHEN and places the pieces.
//
// Three things keep it from being obnoxious:
//   • It is purely decorative, so the layer is aria-hidden and
//     pointer-events-none. A screen reader hears the toast, which carries the
//     actual news; it never hears "confetti".
//   • It self-clears. Nothing can leave it running.
//   • Reduced motion removes it entirely — both here (no render) and in CSS
//     (`display:none` on the layer). The global reduced-motion rule collapses
//     durations to ~0, which for falling confetti would be a FLASH rather than
//     an absence, so this needs its own rule; the JS check is the belt.

const PIECE_COUNT = 14;
const DURATION_MS = 1800;

// Brand palette only. The card is navy-and-red everywhere else and a rainbow
// here would read as a different product for two seconds.
const COLORS = ["#0F3460", "#E94560", "#1A1A2E", "#d4af37"];

interface Piece {
  left: number;
  delay: number;
  duration: number;
  drift: number;
  spin: number;
  color: string;
}

/** Deterministic per index — no randomness, so a re-render never re-scatters. */
function piece(i: number): Piece {
  const spread = (i + 0.5) / PIECE_COUNT;
  const wobble = ((i * 37) % 17) / 17;
  return {
    left: Math.round(spread * 96) + 2,
    delay: Math.round(wobble * 320),
    duration: 1200 + Math.round(wobble * 500),
    drift: Math.round((spread - 0.5) * 160),
    spin: 180 + Math.round(wobble * 360),
    color: COLORS[i % COLORS.length]!,
  };
}

const PIECES: Piece[] = Array.from({ length: PIECE_COUNT }, (_, i) => piece(i));

/**
 * Fires one burst each time `runId` changes to a new non-zero value. The parent
 * owns the counter, so "celebrate again" is an increment rather than a mount.
 */
export function ConfettiBurst({ runId }: { runId: number }) {
  const [showing, setShowing] = useState(false);

  useEffect(() => {
    if (runId <= 0 || prefersReducedMotion()) return;
    setShowing(true);
    const timer = window.setTimeout(() => setShowing(false), DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [runId]);

  if (!showing) return null;

  return (
    <div className="gt-confetti-layer" aria-hidden="true">
      {PIECES.map((p, i) => (
        <span
          key={i}
          className="gt-confetti-piece"
          style={{
            left: `${p.left}%`,
            background: p.color,
            animationDelay: `${p.delay}ms`,
            animationDuration: `${p.duration}ms`,
            ["--gt-confetti-drift" as string]: `${p.drift}px`,
            ["--gt-confetti-spin" as string]: `${p.spin}deg`,
          }}
        />
      ))}
    </div>
  );
}
