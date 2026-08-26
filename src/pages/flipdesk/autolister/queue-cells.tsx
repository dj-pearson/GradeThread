import { Link } from "react-router";
import {
  AlertTriangle,
  CalendarClock,
  Camera,
  CheckCircle2,
  Loader2,
  Rocket,
  Ruler,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { blockerTarget } from "@/lib/publish-blockers";
import type { PhotoQaIssue } from "@/types/database";
import type { SizeConflict } from "@/pages/flipdesk/autolister/group-warnings";

/** One draft as the publish dialog sees it, with its eBay pre-flight result. */
export interface PreflightItem {
  itemId: string;
  listingId: string | null;
  title: string;
  scheduledFor: string | null;
  blockers: string[]; // populated by /listings/validate
  blockersLoaded: boolean;
}

// US-2520: the queue's per-row badges and its publish confirm, lifted out of
// autolister-queue.tsx. Each is prop-only, so none of them needed to sit inside
// the page component's file.

export function PhotoQaBadge({
  meta,
}: {
  meta?: { qaScore: number | null; qaIssues: PhotoQaIssue[] };
}) {
  if (!meta || meta.qaScore == null) return null;
  const score = meta.qaScore;
  const cls =
    score >= 80
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : score >= 50
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-destructive/40 bg-destructive/10 text-destructive";
  const tip =
    meta.qaIssues.length > 0
      ? meta.qaIssues.map((i) => `• ${i.message}`).join("\n")
      : "Photos look ready to publish.";
  return (
    <Badge variant="outline" className={cn("gap-1 text-[10px]", cls)} title={tip}>
      <Camera className="h-3 w-3" />
      Photos {score}
    </Badge>
  );
}

// US-2919: this draft's size disagrees with its own measurements.
//
// Amber, not destructive, and it never gates publish: US-2915 decided the check
// offers a fix and gets out of the way. The implied size is on the chip itself
// because the point of a queue badge is to be readable without opening anything.
export function SizeConflictBadge({
  conflict,
  onFix,
}: {
  conflict?: SizeConflict;
  onFix?: (itemId: string, nextSize: string) => void;
}) {
  if (!conflict) return null;
  const estimate = conflict.tier === "generic" ? " (estimate)" : "";
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Badge
        variant="outline"
        className="gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-300"
        title={
          `Labelled ${conflict.labelled}, but the measurements point to ` +
          `${conflict.impliedSize}${estimate}. Publishing is not blocked.`
        }
      >
        <Ruler className="h-3 w-3" />
        Size? {conflict.impliedSize}
      </Badge>
      {conflict.fix && onFix && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-2 text-xs text-muted-foreground"
          aria-label={`Change ${conflict.name} from size ${conflict.labelled} to ${conflict.fix}`}
          onClick={() => onFix(conflict.itemId, conflict.fix!)}
        >
          Change to {conflict.fix}
        </Button>
      )}
    </span>
  );
}

// US-1578: informational "has measurements" chip. Never gates the tier — it
// just tells the seller which drafts will publish with a measurements block
// (and which could use a MeasureCard shot before listing).
export function MeasurementsBadge({ has }: { has: boolean | undefined }) {
  if (!has) return null;
  return (
    <Badge
      variant="outline"
      className="gap-1 border-sky-500/40 bg-sky-500/10 text-[10px] text-sky-700 dark:text-sky-300"
      title="This item has flat measurements — they ride the description and item specifics at publish."
    >
      <Ruler className="h-3 w-3" />
      Measured
    </Badge>
  );
}

// US-954: per-row eBay pre-flight badge. Driven by the background validation
// cache: "Checking…" while in flight, green "Ready" when clean, amber
// "Will block" (deep-linking the first blocker to the offending composer field)
// when there are unresolved blockers. Hidden until eBay is connected, since the
// publish actions are gated on the connection anyway.
export function PreflightBadge({
  itemId,
  state,
  enabled,
}: {
  itemId: string;
  state?: { blockers: string[]; loaded: boolean };
  enabled: boolean;
}) {
  if (!enabled) return null;
  if (!state || !state.loaded) {
    return (
      <Badge
        variant="outline"
        className="gap-1 text-[10px] text-muted-foreground"
        title="Checking this draft against eBay…"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking…
      </Badge>
    );
  }
  if (state.blockers.length === 0) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-300"
        title="Passes eBay pre-flight — ready to publish."
      >
        <ShieldCheck className="h-3 w-3" />
        Ready
      </Badge>
    );
  }
  // Will block — deep-link the badge to the first blocker's field, list them all
  // in the tooltip.
  const first = state.blockers[0] ?? "Resolve before publishing.";
  const target = blockerTarget(first, itemId);
  const tip = state.blockers.map((b) => `• ${b}`).join("\n");
  const count = state.blockers.length;
  return (
    <Link
      to={target.to}
      title={tip}
      className="inline-flex"
    >
      <Badge
        variant="outline"
        className="gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 underline-offset-2 hover:underline dark:text-amber-300"
      >
        <AlertTriangle className="h-3 w-3" />
        Will block{count > 1 ? ` (${count})` : ""}
      </Badge>
    </Link>
  );
}

export function PublishConfirmDialog({
  open,
  onOpenChange,
  items,
  loading,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: PreflightItem[];
  loading: boolean;
  onConfirm: () => void;
}) {
  const publishable = items.filter((i) => i.blockersLoaded && i.blockers.length === 0).length;
  const blocked = items.filter((i) => i.blockersLoaded && i.blockers.length > 0).length;
  const scheduled = items.filter((i) => i.scheduledFor).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Publish {items.length} drafts to eBay?</DialogTitle>
          <DialogDescription>
            We pre-flight each draft against eBay business policies and category
            specifics. Items with unresolved blockers are skipped.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex flex-wrap gap-3 text-sm">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <strong>{publishable}</strong> ready
            </span>
            {blocked > 0 && (
              <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
                <AlertTriangle className="h-4 w-4" />
                <strong>{blocked}</strong> blocked
              </span>
            )}
            {scheduled > 0 && (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <CalendarClock className="h-4 w-4" />
                <strong>{scheduled}</strong> scheduled
              </span>
            )}
            {loading && (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Validating…
              </span>
            )}
          </div>

          <div className="divide-y rounded-md border">
            {items.map((item) => (
              <div key={item.itemId} className="flex items-start gap-2 px-3 py-2 text-sm">
                <div className="mt-0.5">
                  {!item.blockersLoaded ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : item.blockers.length === 0 ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{item.title}</div>
                  {item.scheduledFor && (
                    <div className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <CalendarClock className="h-3 w-3" />
                      Scheduled for {new Date(item.scheduledFor).toLocaleString()}
                    </div>
                  )}
                  {item.blockers.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-xs text-amber-700 dark:text-amber-300">
                      {item.blockers.map((b, i) => {
                        // US-954: deep-link each blocker to the offending field.
                        const target = blockerTarget(b, item.itemId);
                        return (
                          <li key={i}>
                            •{" "}
                            <Link
                              to={target.to}
                              className="underline-offset-2 hover:underline"
                              title={`${target.label} →`}
                            >
                              {b}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>
            ))}
            {items.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                Nothing to publish.
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={loading || publishable === 0}>
            <Rocket className="mr-2 h-4 w-4" />
            Publish {publishable} clean {publishable === 1 ? "draft" : "drafts"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
