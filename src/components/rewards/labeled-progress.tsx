import { Progress } from "@/components/ui/progress";

// Every rewards progress bar, named and valued for assistive tech.
//
// The shadcn Progress in components/ui/ takes `value` for the indicator's
// transform but never hands it to the Radix root, so the root renders as an
// INDETERMINATE progressbar with no name and no aria-valuenow: a screen reader
// hears "progress bar, busy" beside a goal that is 60% done. components/ui/ is
// not hand-edited (CLAUDE.md), so the fix lives here, and a name is required
// by the type so a new bar cannot ship unnamed.

interface LabeledProgressProps {
  /** 0-100. Clamped. */
  value: number;
  /** What the bar measures, e.g. "Progress to level 5". */
  label: string;
  /** The spoken value, e.g. "150 of 400 XP". Defaults to the percentage. */
  valueText?: string;
  className?: string;
}

export function LabeledProgress({ value, label, valueText, className }: LabeledProgressProps) {
  const pct = Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
  return (
    <Progress
      value={pct}
      className={className}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={valueText ?? `${pct}%`}
    />
  );
}
