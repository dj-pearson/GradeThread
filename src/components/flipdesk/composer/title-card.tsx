import { Loader2, Plus, Sparkles, TrendingUp, Wand2 } from "lucide-react";
import { AiDiffChip } from "@/components/flipdesk/ai-diff-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { textChanged } from "@/lib/listing-ai-diff";
import { suggestTitle } from "@/lib/listing-templates";
import { cn } from "@/lib/utils";
import { TITLE_MAX } from "@/lib/composer-save";
import type { ItemFullRow, ListingAiSnapshot } from "@/types/database";
import type { RewriteAction } from "@/hooks/use-ai-extract";
import type { titleQuality } from "@/lib/title-quality";
import type { FieldSaveState } from "@/lib/composer-autosave";
import type { TitleConflict } from "@/hooks/use-title-conflicts";

type TitleQuality = ReturnType<typeof titleQuality>;

/**
 * US-2675: a keyword chip, and what backs it.
 *
 * `evidence: "sold"` means the term was over-represented in the titles of items
 * that actually sold, rather than in what other sellers are currently asking.
 * Undefined means the draft predates the distinction being recorded, so the
 * chip stays unmarked -- an unmarked chip is "we do not know", never "active".
 */
export interface TitleChip {
  token: string;
  evidence?: "sold" | "active";
}
export interface TitleCardProps {
  title: string;
  setTitle: (next: string) => void;
  item: ItemFullRow;
  titleLen: number;
  /** From src/lib/title-quality.ts — lockstep with the edge publish lint. */
  titleMeter: TitleQuality;
  titleChips: TitleChip[];
  /**
   * US-2677: the seller's own live listings this title reads like. Empty is the
   * normal case and renders nothing.
   */
  titleConflicts?: TitleConflict[];
  /** Regenerate the title away from the conflicting wording. */
  runDifferentiate?: (conflictingTitles: string[]) => void;
  chipFits: (kw: string) => boolean;
  appendKeyword: (kw: string) => void;
  /** US-551: the AI's original draft, for the per-field diff chips. */
  aiSnapshot: ListingAiSnapshot | null;
  aiRewrite: { isPending: boolean };
  rewriteAction: string | null;
  runRewrite: (action: RewriteAction) => void;
  /** US-2442: generates a title AND a description from the item (see below). */
  listingCopy: { isPending: boolean };
  runListingCopy: () => void;
  /** US-2258: eBay owns the title on a mirror — locks the input AND every write action. */
  isEbayOrigin: boolean;
  ebayOwnedHint: string | undefined;
  /** US-2634: the title writes itself; this is what that write is doing. */
  saveState: FieldSaveState;
}

const SAVE_STATE_TEXT: Record<FieldSaveState, string> = {
  idle: "",
  saving: "Saving title...",
  saved: "Title saved",
  error: "Title not saved yet — use Save draft",
};
// Title, with the US-1892 quality meter: utilization band, brand-first check,
// policy/quality lint, and pack-to-80 chips from the listing's mined demand terms
// and high-value filled aspects.
export function TitleCard({
  title,
  setTitle,
  item,
  titleLen,
  titleMeter,
  titleChips,
  titleConflicts,
  runDifferentiate,
  chipFits,
  appendKeyword,
  aiSnapshot,
  aiRewrite,
  rewriteAction,
  runRewrite,
  listingCopy,
  runListingCopy,
  isEbayOrigin,
  ebayOwnedHint,
  saveState,
}: TitleCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Title</CardTitle>
        <CardDescription>
          eBay caps titles at {TITLE_MAX} characters and every word is
          searchable — front-load the brand for click-through, fill the
          space with real keywords, and don't repeat words (duplicates add
          no ranking benefit). Filled item specifics are also searchable.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="relative">
          <Input
            id="composer-title"
            value={title}
            maxLength={TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Brand Item Size Category"
            disabled={isEbayOrigin}
            title={
              isEbayOrigin
                ? "eBay owns this listing's title — edit it on eBay."
                : undefined
            }
          />
          <span
            className={cn(
              "absolute right-2 top-1/2 -translate-y-1/2 text-[10px] tabular-nums",
              titleMeter.utilization.band === "full"
                ? "font-semibold text-destructive"
                : titleMeter.utilization.band === "good"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground",
            )}
          >
            {titleLen}/{TITLE_MAX}
          </span>
        </div>
        {/* US-2634: the title no longer waits for the Save button. Announced
            politely so a screen reader hears the save without losing the caret. */}
        {!isEbayOrigin && saveState !== "idle" && (
          <p
            aria-live="polite"
            className={cn(
              "text-xs",
              saveState === "error"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {SAVE_STATE_TEXT[saveState]}
          </p>
        )}
        {/* US-1892: utilization bar — green in the 70–80 sweet spot. */}
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={titleMeter.utilization.pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Title length utilization"
        >
          <div
            className={cn(
              "h-full rounded-full transition-all",
              titleMeter.utilization.band === "good"
                ? "bg-emerald-500"
                : titleMeter.utilization.band === "full"
                  ? "bg-destructive"
                  : "bg-amber-500",
            )}
            style={{ width: `${titleMeter.utilization.pct}%` }}
          />
        </div>
        {(!titleMeter.brandFirst ||
          titleMeter.lint.warnings.length > 0 ||
          titleMeter.lint.policyViolations.length > 0) && (
          <ul className="space-y-1 text-xs">
            {titleMeter.lint.policyViolations.map((v) => (
              <li key={v} className="text-destructive">⚠ {v}</li>
            ))}
            {!titleMeter.brandFirst && item?.brand && (
              <li className="text-amber-600 dark:text-amber-400">
                Lead with the brand ({item.brand}) — front-loading it lifts
                click-through.
              </li>
            )}
            {titleMeter.lint.warnings.map((w) => (
              <li key={w} className="text-amber-600 dark:text-amber-400">
                {w}
              </li>
            ))}
          </ul>
        )}
        {/* US-2677: this title reads like one of the seller's OWN live
            listings. eBay penalises the whole store for near-duplicates rather
            than rejecting the listing, so without this the seller sees a slow
            store and never learns why. Never a blocker: two genuinely different
            garments can carry similar titles and only the seller can tell. */}
        {titleConflicts && titleConflicts.length > 0 && (
          <div className="space-y-2 rounded-xl bg-amber-50 p-3 text-xs dark:bg-amber-950/40">
            <p className="font-medium text-amber-900 dark:text-amber-100">
              This reads like {titleConflicts.length === 1 ? "another" : "other"}{" "}
              live {titleConflicts.length === 1 ? "listing" : "listings"} of yours
            </p>
            <ul className="space-y-1 text-amber-800 dark:text-amber-200">
              {titleConflicts.map((conflict) => (
                <li key={conflict.listingId}>
                  {Math.round(conflict.overlap * 100)}% the same as "{conflict.title}"
                </li>
              ))}
            </ul>
            <p className="text-amber-800 dark:text-amber-200">
              eBay can bury a whole store for near-duplicate listings. Reword one
              of them.
            </p>
            {runDifferentiate && (
              <Button
                variant="outline"
                size="sm"
                disabled={isEbayOrigin || aiRewrite.isPending}
                title={isEbayOrigin ? ebayOwnedHint : undefined}
                onClick={() =>
                  runDifferentiate(titleConflicts.map((conflict) => conflict.title))}
              >
                {rewriteAction === "title_differentiate"
                  ? <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                  : <Wand2 className="mr-2 h-3 w-3" />}
                Make it different
              </Button>
            )}
          </div>
        )}
        {aiSnapshot && (
          <AiDiffChip
            changed={textChanged(aiSnapshot.title, title)}
            aiDisplay={aiSnapshot.title ?? ""}
            onRevert={() => setTitle((aiSnapshot.title ?? "").slice(0, TITLE_MAX))}
          />
        )}
        {/* US-2258: every write action here is gated on the same lock as
            the input. Offering "AI rewrite" on a field eBay owns produced a
            reviewed, accepted rewrite the save would then refuse. */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={isEbayOrigin}
            title={ebayOwnedHint}
            onClick={() => setTitle(suggestTitle(item))}
          >
            <Wand2 className="mr-2 h-3 w-3" />
            Suggest title
          </Button>
          {/* US-2442: the cold start, and the reason it sits OUTSIDE the AI
              rewrite menu next door. Every action in that menu operates on text
              that already exists (all three title ones are refused server-side
              with "Add a title before rewriting it."), and an item saved from
              capture reaches this box empty. So this button must never be gated
              on the field it exists to fill; it is enabled on a blank title by
              design.
              It writes the DESCRIPTION as well, which is why the label names
              both fields: one AI action buys both, and the seller decides that
              before spending it, not after. */}
          <Button
            variant="outline"
            size="sm"
            disabled={isEbayOrigin || listingCopy.isPending || aiRewrite.isPending}
            title={
              ebayOwnedHint ??
              "Writes a fresh title AND buyer description from this item's photos and details, then shows both for review. Uses one AI action."
            }
            onClick={runListingCopy}
          >
            {listingCopy.isPending ? (
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-3 w-3" />
            )}
            Write title &amp; description
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={!title.trim() || aiRewrite.isPending || isEbayOrigin}
                title={ebayOwnedHint}
              >
                {aiRewrite.isPending &&
                rewriteAction?.startsWith("title_") ? (
                  <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="mr-2 h-3 w-3" />
                )}
                AI rewrite
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => void runRewrite("title_seo")}>
                Punch up for SEO
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => void runRewrite("title_shorten")}
              >
                Shorten to 80
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => void runRewrite("title_keywords")}
              >
                Add buyer keywords
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {titleChips.map((chip) => {
            const kw = chip.token;
            const fits = chipFits(kw) && !isEbayOrigin;
            // US-2675: only "sold" is marked. Marking "active" too would put a
            // badge on nearly every chip, which reads as decoration and stops
            // meaning anything -- the point is that a few of them are backed by
            // items that actually sold.
            const soldBacked = chip.evidence === "sold";
            return (
              <button
                key={kw}
                type="button"
                disabled={!fits}
                onClick={() => appendKeyword(kw)}
                title={
                  isEbayOrigin
                    ? ebayOwnedHint
                    : !fits
                      ? "Won't fit in 80 characters"
                      : soldBacked
                        ? "Common in titles of items that sold, not just in what other sellers are asking"
                        : undefined
                }
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs",
                  fits
                    ? "hover:bg-muted"
                    : "cursor-not-allowed opacity-40",
                )}
              >
                <Plus className="h-3 w-3" />
                {kw}
                {soldBacked && (
                  <>
                    <TrendingUp className="h-3 w-3 shrink-0" aria-hidden="true" />
                    <span className="sr-only">backed by sold listings</span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}