// US-2399: the buyer-facing AI disclosure, rendered on every public surface that
// shows a grade. The wording (and the reasoning behind the two variants) lives in
// @/lib/ai-disclosure-copy so the Cloudflare Pages widget can mirror it exactly.
import { Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { aiDisclosureBody, aiDisclosureTitle } from "@/lib/ai-disclosure-copy";

interface AiDisclosureProps {
  humanReviewed: boolean;
  /** `card` for the full certificate page; `inline` for the compact embed. */
  variant?: "card" | "inline";
}

export function AiDisclosure({ humanReviewed, variant = "card" }: AiDisclosureProps) {
  const title = aiDisclosureTitle(humanReviewed);
  const body = aiDisclosureBody(humanReviewed);

  if (variant === "inline") {
    return (
      <p className="text-[11px] leading-relaxed text-slate-600">
        <span className="font-medium text-slate-700">{title}.</span> {body}{" "}
        <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline">
          Terms
        </a>
      </p>
    );
  }

  return (
    <Card className="border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/60">
      <CardContent className="flex items-start gap-3 pt-6">
        <Info className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">{title}</p>
          <p className="text-xs text-amber-800 dark:text-amber-300">
            {body}{" "}
            <a href="/terms" className="underline">
              See our Terms
            </a>{" "}
            (section 5) for details.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
