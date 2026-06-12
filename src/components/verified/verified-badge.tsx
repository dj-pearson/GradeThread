import { BadgeCheck } from "lucide-react";
import { cn } from "@/lib/utils";

// In-app preview of the embeddable "GradeThread Verified" trust badge. The
// real artifact sellers embed in listings is a PNG rendered server-side
// (functions/badge/cert/[id].ts); this mirrors its look for previews.

function scoreColor(score: number): string {
  if (score > 7) return "text-green-600 dark:text-green-400";
  if (score >= 5) return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
}

export function VerifiedBadge({
  score,
  tier,
  className,
}: {
  score: number;
  tier: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-4 rounded-2xl bg-brand-navy px-6 py-4 text-white",
        className,
      )}
    >
      <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-full bg-brand-red">
        <span className="text-2xl font-extrabold leading-none text-white">
          {score.toFixed(1)}
        </span>
      </div>
      <div className="flex flex-col">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-white/85">
          <BadgeCheck className="h-4 w-4" />
          GradeThread Verified
        </span>
        <span className={cn("text-xl font-extrabold", scoreColor(score))}>
          {tier}
        </span>
        <span className="text-xs text-white/60">AI condition grade · tap to verify</span>
      </div>
    </div>
  );
}
