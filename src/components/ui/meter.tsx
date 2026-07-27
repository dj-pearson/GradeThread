import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

// Fill color by grade score (0–10). Mirrors getScoreColor's thresholds in
// src/lib/constants.ts (emerald > 7, amber 5–7, brand red < 5) but as a bar
// background instead of a text color, so it can't reuse that helper directly.
function scoreBarColor(score: number): string {
  if (score > 7) return "bg-emerald-500";
  if (score >= 5) return "bg-amber-500";
  return "bg-brand-red";
}

export interface MeterProps {
  /** Progress value, interpreted against `max`. Pass a raw percent (0–100) or a
   *  value together with an explicit `max`. */
  value: number;
  /** Upper bound for `value`. Defaults to 100 (i.e. `value` is a percent). */
  max?: number;
  /** Lower bound for `value`. Defaults to 0. */
  min?: number;
  /** Extra classes for the outer track (default `h-2 rounded-full bg-secondary`). */
  className?: string;
  /** Extra classes for the inner fill (default `h-full rounded-full bg-brand-navy`). */
  barClassName?: string;
  /** When set, the fill color is derived from this 0–10 grade score
   *  (green/amber/red), overriding the default navy fill. */
  scoreColor?: number;
  /** Accessible label for the progressbar. */
  "aria-label"?: string;
  /** Optional content rendered inside the fill (e.g. an inline label). */
  children?: ReactNode;
}

/**
 * Small, dependency-free horizontal meter: an accessible track + fill bar
 * driven by a numeric value. Replaces hand-rolled "track div + inner fill div
 * with inline width %" bars across the app (US-2202). The fill width is the
 * only inline style; everything else is class-driven so callers can preserve a
 * bar's exact height/color/radius via `className`/`barClassName`.
 */
export function Meter({
  value,
  max = 100,
  min = 0,
  className,
  barClassName,
  scoreColor,
  children,
  "aria-label": ariaLabel,
}: MeterProps) {
  const span = max - min || 1;
  const pct = Math.min(100, Math.max(0, ((value - min) / span) * 100));
  const fillStyle: CSSProperties = { width: `${pct}%` };
  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={ariaLabel}
      className={cn("h-2 rounded-full bg-secondary", className)}
    >
      <div
        className={cn(
          "h-full rounded-full",
          scoreColor === undefined ? "bg-brand-navy" : scoreBarColor(scoreColor),
          barClassName,
        )}
        style={fillStyle}
      >
        {children}
      </div>
    </div>
  );
}
