import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  CheckCircle2,
  Loader2,
  AlertTriangle,
  ExternalLink,
  Rocket,
  RotateCcw,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { EBAY_CONDITION_OPTIONS, EBAY_DEPARTMENT_OPTIONS } from "@/lib/constants";
import {
  usePublishToEbay,
  useSetItemAspect,
  useValidatePublish,
  type PublishSummary,
} from "@/hooks/use-ebay";
import { cn } from "@/lib/utils";
import { EbayPublishDisclaimer } from "@/components/flipdesk/ebay-publish-disclaimer";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemId: string;
  /** Relist mode: publishes a fresh listing for an item that was previously
   *  listed (ended draft, or a still-live listing being replaced). */
  relist?: boolean;
  /** True when the item still has a LIVE eBay listing. Shows a warning that
   *  relisting ends the current listing and creates a new one. */
  listingActive?: boolean;
}

export function PublishToEbayDialog({
  open,
  onOpenChange,
  itemId,
  relist = false,
  listingActive = false,
}: Props) {
  const validate = useValidatePublish();
  const publish = usePublishToEbay();
  const setAspect = useSetItemAspect();
  const [result, setResult] = useState<{
    listingUrl: string;
    listingId: string;
  } | null>(null);
  const [department, setDepartment] = useState("");

  // Run validation each time the dialog opens. Resets the result so a second
  // open after a successful publish starts fresh.
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setDepartment("");
    validate.mutate({ itemId });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, itemId]);

  const summary: PublishSummary | undefined = validate.data?.summary;
  const coverage = validate.data?.recommendedCoverage;
  const blockers = validate.data?.blockers ?? [];
  // US-1896: non-blocking picture-standards + title-quality warnings, and the
  // hero-thumbnail reorder nudge. Surfaced but never block publish.
  const warnings = validate.data?.warnings ?? [];
  const photoNudge = validate.data?.photoNudge ?? null;
  const canPublish = !!validate.data?.ok && blockers.length === 0;
  const isPublishing = publish.isPending;

  // eBay's "Department" is the most common missing required specific and has a
  // small fixed value set, so we let the seller fix it inline here instead of
  // bouncing them to the full composer. Detect the validator's specifics blocker.
  const specificsBlocker = blockers.find((b) =>
    /required eBay specifics/i.test(b),
  );
  const departmentMissing =
    !!specificsBlocker && /department/i.test(specificsBlocker);

  async function handleSaveDepartment() {
    if (!department) return;
    try {
      await setAspect.mutateAsync({
        itemId,
        aspect: "Department",
        values: [department],
      });
      // Re-run validation so the blocker clears (or surfaces what's left).
      await validate.mutateAsync({ itemId });
      toast.success("Department saved.");
    } catch {
      /* hook surfaces the error toast */
    }
  }

  async function handlePublish() {
    try {
      const res = await publish.mutateAsync({ itemId, relist });
      if (res.listing_url && res.listing_id) {
        setResult({
          listingUrl: res.listing_url,
          listingId: res.listing_id,
        });
        toast.success("Listing is live on eBay.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Single multiline toast — eBay error messages can be long.
      toast.error(msg.split("\n")[0] ?? "Publish failed.", {
        description: msg.split("\n").slice(1).join(" • ") || undefined,
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* [&>*]:min-w-0 lets every direct grid child shrink — without it a long
          Title/Notes value forces the grid track wider than max-w-lg and the
          whole dialog overflows horizontally (US-1552-style layout bug). */}
      <DialogContent className="max-w-lg [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {relist ? (
              <RotateCcw className="h-5 w-5" />
            ) : (
              <Rocket className="h-5 w-5" />
            )}
            {relist ? "Relist on eBay" : "Publish to eBay"}
          </DialogTitle>
          <DialogDescription>
            {relist ? "New" : "Live"} listing on{" "}
            <Badge variant="secondary" className="font-normal">
              eBay
            </Badge>{" "}
            using your connected seller account.
          </DialogDescription>
        </DialogHeader>

        {/* Still-active warning: relisting ends the current live listing and
            creates a brand-new one (new item #, watchers/views reset). */}
        {!result && listingActive && (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/30 dark:border-amber-800">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="text-amber-900 dark:text-amber-200">
              <div className="font-medium">This item is still live on eBay.</div>
              <div className="mt-1 text-xs text-amber-800/90 dark:text-amber-200/80">
                Relisting will <strong>end the current listing</strong> and
                publish a <strong>new one</strong> — the eBay item number resets
                and watchers/views start over.
              </div>
            </div>
          </div>
        )}

        {/* Already published */}
        {result && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm dark:bg-emerald-950/30 dark:border-emerald-800">
              <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
              <div>
                <div className="font-medium text-emerald-900 dark:text-emerald-200">
                  Your listing is live.
                </div>
                <div className="mt-1 text-xs text-emerald-800/80 dark:text-emerald-200/80">
                  eBay item #{result.listingId}
                </div>
              </div>
            </div>
            <Button asChild className="w-full">
              <a
                href={result.listingUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                View on eBay
                <ExternalLink className="ml-2 h-4 w-4" />
              </a>
            </Button>
            {/* US-1061: first-publish "manage in FlipDesk" disclaimer.
                Self-hides once dismissed (server-side, per user). */}
            <EbayPublishDisclaimer />
          </div>
        )}

        {/* Validating */}
        {!result && validate.isPending && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking listing requirements…
          </div>
        )}

        {/* Blockers */}
        {!result && !validate.isPending && blockers.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              Fix these before publishing
            </div>
            <ul className="space-y-1 rounded-md border bg-amber-50 p-3 text-xs dark:bg-amber-950/30">
              {blockers.map((b) => (
                <li
                  key={b}
                  className="break-words text-amber-900 dark:text-amber-200"
                >
                  • {b}
                </li>
              ))}
            </ul>

            {/* Inline fix for the most common blocker: missing Department. */}
            {specificsBlocker && (
              <div className="space-y-2 rounded-md border p-3">
                <div className="text-sm font-medium">
                  {departmentMissing
                    ? "Set the Department"
                    : "Fix item specifics"}
                </div>
                {departmentMissing ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      eBay requires a Department for clothing. Pick one and
                      re-check.
                    </p>
                    <div className="flex items-center gap-2">
                      <select
                        value={department}
                        onChange={(e) => setDepartment(e.target.value)}
                        className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm text-foreground [&>option]:bg-background [&>option]:text-foreground"
                        aria-label="Department"
                      >
                        <option value="">Select Department…</option>
                        {EBAY_DEPARTMENT_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <Button
                        onClick={handleSaveDepartment}
                        disabled={!department || setAspect.isPending || validate.isPending}
                      >
                        {setAspect.isPending || validate.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : null}
                        Save &amp; re-check
                      </Button>
                    </div>
                  </>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Need to set other specifics?{" "}
                  <Link
                    to={`/dashboard/flipdesk/items/${itemId}/draft`}
                    className="text-primary underline"
                    onClick={() => onOpenChange(false)}
                  >
                    Open the composer
                  </Link>
                  .
                </p>
              </div>
            )}
          </div>
        )}

        {/* US-1896: non-blocking picture-standards / title-quality warnings and
            the hero-thumbnail reorder nudge. These never block publish — they
            just tell the seller how to rank/convert better. */}
        {!result &&
          !validate.isPending &&
          (warnings.length > 0 || photoNudge) && (
            <ul className="space-y-1 rounded-md border border-sky-200 bg-sky-50 p-3 text-xs dark:border-sky-500/30 dark:bg-sky-950/30">
              {warnings.map((w) => (
                <li
                  key={w}
                  className="break-words text-sky-900 dark:text-sky-200"
                >
                  • {w}
                </li>
              ))}
              {photoNudge && (
                <li className="break-words text-sky-900 dark:text-sky-200">
                  • {photoNudge}
                </li>
              )}
            </ul>
          )}

        {/* US-1895: recommended-aspect coverage (non-blocking). eBay's
            RECOMMENDED specifics ranked by 30-day buyer search volume — filling
            them lifts findability. Computed on the edge (single source with the
            required-blocker rule), rendered here. */}
        {!result && !validate.isPending && coverage && coverage.total > 0 && (
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between text-sm font-medium">
              <span>Recommended specifics</span>
              <span
                className={cn(
                  "tabular-nums",
                  coverage.filled >= coverage.total
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground",
                )}
              >
                {coverage.filled}/{coverage.total}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all"
                style={{
                  width: `${Math.round((coverage.filled / coverage.total) * 100)}%`,
                }}
              />
            </div>
            {coverage.missing.length > 0 && (
              <>
                <p className="text-xs text-muted-foreground">
                  Filling these (eBay's most-searched, in order) helps buyers find
                  the listing:
                </p>
                <div className="flex flex-wrap gap-1">
                  {coverage.missing.slice(0, 8).map((name) => (
                    <span
                      key={name}
                      className="rounded-full border bg-muted/50 px-2 py-0.5 text-xs"
                    >
                      {name}
                    </span>
                  ))}
                </div>
                <Link
                  to={`/dashboard/flipdesk/items/${itemId}/draft`}
                  className="text-xs text-primary underline"
                  onClick={() => onOpenChange(false)}
                >
                  Fill in the composer
                </Link>
              </>
            )}
          </div>
        )}

        {/* Ready to publish */}
        {!result && !validate.isPending && canPublish && summary && (
          <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-sm">
            <Row label="Title" value={summary.title} truncate />
            <Row
              label="Price"
              value={`${summary.priceValue} ${summary.currency}`}
            />
            {/* Condition is resolved from the item's grade / listing condition
                and published as-is. Shown read-only here: an editable picker
                had no effect on the published listing and only produced
                confusing errors, so it was removed. */}
            <Row
              label="Condition"
              value={
                EBAY_CONDITION_OPTIONS.find(
                  (o) => o.value === summary.condition,
                )?.label ??
                summary.condition ??
                "—"
              }
            />
            {summary.conditionDescription && (
              <Row
                label="Notes"
                value={summary.conditionDescription}
                truncate
              />
            )}
          </div>
        )}

        {/* Validation network error (separate from blockers) */}
        {!result && validate.isError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {(validate.error as Error).message}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPublishing}
          >
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button
              onClick={handlePublish}
              disabled={!canPublish || isPublishing}
              className={
                listingActive
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
            >
              {isPublishing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {relist ? "Relisting…" : "Publishing…"}
                </>
              ) : (
                <>
                  {relist ? (
                    <RotateCcw className="mr-2 h-4 w-4" />
                  ) : (
                    <Rocket className="mr-2 h-4 w-4" />
                  )}
                  {listingActive
                    ? "End & relist"
                    : relist
                      ? "Relist on eBay"
                      : "Publish to eBay"}
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  value,
  truncate,
}: {
  label: string;
  value: string;
  truncate?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="flex-shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "min-w-0 flex-1 text-right font-medium",
          // truncate keeps single-line values from pushing the dialog wide;
          // non-truncated values wrap on words instead of overflowing.
          truncate ? "truncate" : "break-words",
        )}
      >
        {value}
      </div>
    </div>
  );
}
