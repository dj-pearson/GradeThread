import { Check } from "lucide-react";
import { FLIPDESK_STAGES, type FlipdeskStage } from "./flipdesk-stages";

// US-1949: a static, swipeable preview of the full FlipDesk reseller pipeline,
// used on marketing pages that want to SHOW the tool (e.g. /for-resellers)
// rather than only describe it. Each stage carries a STYLIZED product mock — an
// honest "peek at the tool", explicitly not a real screenshot — so a prospect
// sees the bulk source→grade→list→reprice→reconcile flow before signing up,
// closing the "described but never shown" vaporware read.
//
// This deliberately omits the landing hero's `data-flipdesk-*` scroll-scene
// hooks so flipdesk-scene.ts never pins or scrubs it on pages other than the
// homepage.

/** One stage card with its stylized product mock. */
function StageCard({ stage, index }: { stage: FlipdeskStage; index: number }) {
  return (
    <li className="flipdesk-panel flex w-[80vw] max-w-[340px] flex-shrink-0 flex-col rounded-3xl border border-border/40 bg-card/60 p-6 shadow-sm glass-card sm:w-[340px]">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-red/10 text-brand-red-text">
          <stage.icon className="h-5 w-5" />
        </div>
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-navy text-xs font-bold text-white">
          {index + 1}
        </span>
      </div>
      {/* Stylized product mock — a peek at the tool, not a real screenshot. */}
      <div className="mb-4 rounded-xl border border-border/50 bg-background/70 p-3">
        <div className="mb-2 flex gap-1.5">
          <span className="h-2 w-2 rounded-full bg-brand-red/50" />
          <span className="h-2 w-2 rounded-full bg-amber-400/60" />
          <span className="h-2 w-2 rounded-full bg-emerald-400/60" />
        </div>
        <ul className="space-y-1.5">
          {stage.mock.map((line) => (
            <li
              key={line}
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <Check className="h-3 w-3 flex-shrink-0 text-emerald-500" />
              {line}
            </li>
          ))}
        </ul>
      </div>
      <h3 className="text-base font-semibold font-display">{stage.title}</h3>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {stage.description}
      </p>
    </li>
  );
}

export function FlipDeskPipelinePreview() {
  return (
    <div className="gt-hscroll overflow-x-auto">
      <ol className="flex w-max gap-6 px-6 md:px-[9vw]">
        {FLIPDESK_STAGES.map((stage, i) => (
          <StageCard key={stage.title} stage={stage} index={i} />
        ))}
      </ol>
    </div>
  );
}
