import {
  ArrowRight,
  Camera,
  Loader2,
  Smartphone,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// US-2520: lifted out of autolister.tsx. These three say where the session
// stands — what is waiting from the phone, what the batch adds up to, and what
// would be worth fixing before spending AI on it. None of them takes part in
// the drag-and-drop grid that the rest of the page is built around.

export interface HandoffBatch {
  id: string;
  photo_count: number;
  group_count: number;
  created_at: string;
}

export interface GroupWarning {
  key: string;
  groupId: string;
  label: string;
}

/** AL-13: "5 min ago" for a parked batch; the exact time is the tooltip. */
function relativeTime(iso: string, now = Date.now()): string {
  const secs = Math.round((new Date(iso).getTime() - now) / 1000);
  if (!Number.isFinite(secs)) return "";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const abs = Math.abs(secs);
  if (abs < 60) return rtf.format(secs, "second");
  if (abs < 3600) return rtf.format(Math.round(secs / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(secs / 3600), "hour");
  return rtf.format(Math.round(secs / 86_400), "day");
}

/**
 * US-2374: batches parked by the phone. The photos are already uploaded and
 * grouped; loading one drops it into this session so the review and the AI
 * spend happen on a screen big enough for it.
 */
export function ParkedBatches({
  handoffs,
  loadingHandoffId,
  discardingHandoffId = null,
  onLoad,
  onDiscard,
}: {
  handoffs: HandoffBatch[];
  loadingHandoffId: string | null;
  /** AL-13: the batch whose discard is in flight, so it can't double-fire. */
  discardingHandoffId?: string | null;
  onLoad: (id: string) => void;
  /** Asks first (AL-13); the page shows the confirm. */
  onDiscard: (id: string) => void;
}) {
  if (handoffs.length === 0) return null;
  return (
    <Card className="space-y-2 p-3">
      <div className="flex items-center gap-2">
        <Smartphone className="h-4 w-4 text-brand-red-text" />
        <span className="text-sm font-medium">Waiting from your phone</span>
      </div>
      {handoffs.map((h) => (
        <div
          key={h.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
        >
          <div className="text-sm">
            <span className="font-semibold">{h.photo_count}</span> photo
            {h.photo_count === 1 ? "" : "s"}
            {h.group_count > 0 && (
              <>
                {" · "}
                <span className="font-semibold">{h.group_count}</span> item
                {h.group_count === 1 ? "" : "s"} already grouped
              </>
            )}
            <time
              className="ml-2 text-xs text-muted-foreground"
              dateTime={h.created_at}
              title={new Date(h.created_at).toLocaleString()}
            >
              {relativeTime(h.created_at)}
            </time>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => onLoad(h.id)}
              disabled={loadingHandoffId !== null}
            >
              {loadingHandoffId === h.id ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="mr-1 h-4 w-4" />
              )}
              Load into this session
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onDiscard(h.id)}
              disabled={loadingHandoffId !== null || discardingHandoffId === h.id}
              title="Discard this batch and delete its uploaded photos"
              aria-label={`Discard the phone batch of ${h.photo_count} photo${h.photo_count === 1 ? "" : "s"}`}
            >
              {discardingHandoffId === h.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      ))}
    </Card>
  );
}

/**
 * US-1546: the state of play stays visible while scrolling a 600-photo session,
 * with warning chips that jump to the group they are about.
 */
export function BatchSummaryBar({
  stagedCount,
  listableCount,
  ungroupedCount,
  aiActionsRemaining,
  creditsInRemaining = 0,
  groupWarnings,
  onWarningClick,
}: {
  stagedCount: number;
  listableCount: number;
  ungroupedCount: number;
  aiActionsRemaining: number | null;
  /** AL-08: how many of `aiActionsRemaining` are Action Credits. */
  creditsInRemaining?: number;
  groupWarnings: GroupWarning[];
  onWarningClick: (groupId: string) => void;
}) {
  const CHIP_CAP = 8;
  return (
    <div className="sticky top-16 z-20 rounded-lg border bg-background/95 px-3 py-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span>
          <span className="font-semibold">{stagedCount}</span> photo
          {stagedCount === 1 ? "" : "s"}
        </span>
        <span>
          <span className="font-semibold">{listableCount}</span> listing
          {listableCount === 1 ? "" : "s"} to generate
        </span>
        <span
          className={cn(ungroupedCount > 0 && "text-amber-700 dark:text-amber-300")}
        >
          <span className="font-semibold">{ungroupedCount}</span> ungrouped
        </span>
        <span className="text-muted-foreground">
          ~{listableCount} AI action{listableCount === 1 ? "" : "s"}
          {aiActionsRemaining != null ? ` of ${aiActionsRemaining} left` : ""}
          {creditsInRemaining > 0 ? ` (incl. ${creditsInRemaining} Action Credits)` : ""}
        </span>
      </div>
      {groupWarnings.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {groupWarnings.slice(0, CHIP_CAP).map((w) => (
            <button
              key={w.key}
              type="button"
              onClick={() => onWarningClick(w.groupId)}
              className="inline-flex max-w-72 items-center gap-1 truncate rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-800 hover:bg-amber-500/20 dark:text-amber-200"
              title={`${w.label} — click to jump to the group`}
            >
              <Camera className="h-3 w-3 shrink-0" />
              <span className="truncate">{w.label}</span>
            </button>
          ))}
          {groupWarnings.length > CHIP_CAP && (
            <span className="self-center text-xs text-muted-foreground">
              +{groupWarnings.length - CHIP_CAP} more in the Generate checkpoint
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * US-957: pre-generation cover-QA advisory. Non-blocking on purpose — it never
 * disables Generate, it just nudges a reshoot to save AI quota.
 */
export function CoverQualityAdvisory({
  lowCoverCount,
  uncheckedCount = 0,
  checking = false,
  onCheck,
}: {
  lowCoverCount: number;
  /** AL-10: covers not scored yet. Scoring is one AI action each, on request. */
  uncheckedCount?: number;
  checking?: boolean;
  onCheck?: () => void;
}) {
  if (lowCoverCount <= 0 && (uncheckedCount <= 0 || !onCheck)) return null;
  return (
    <Card className="flex flex-wrap items-start gap-2 border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <Camera className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <p className="min-w-0 flex-1 text-amber-800 dark:text-amber-200">
        {lowCoverCount > 0 ? (
          <>
            <span className="font-medium">
              {lowCoverCount} item{lowCoverCount === 1 ? "" : "s"} could use a better
              cover photo.
            </span>{" "}
            Reshoot the flagged covers below for sharper listings — or generate
            anyway, this is only a suggestion.
          </>
        ) : (
          <>
            {uncheckedCount} cover photo{uncheckedCount === 1 ? " hasn't" : "s haven't"} been
            checked. A quick AI check can flag a weak one before you generate.
          </>
        )}
      </p>
      {onCheck && uncheckedCount > 0 && (
        <Button size="sm" variant="outline" onClick={onCheck} disabled={checking}>
          {checking && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          Check covers ({uncheckedCount} AI action{uncheckedCount === 1 ? "" : "s"})
        </Button>
      )}
    </Card>
  );
}
