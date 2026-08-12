import { Loader2, Plus, Sparkles, Wand2 } from "lucide-react";
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

type TitleQuality = ReturnType<typeof titleQuality>;
export interface TitleCardProps {
  title: string;
  setTitle: (next: string) => void;
  item: ItemFullRow;
  titleLen: number;
  /** From src/lib/title-quality.ts — lockstep with the edge publish lint. */
  titleMeter: TitleQuality;
  titleChips: string[];
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
}
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
          {titleChips.map((kw) => {
            const fits = chipFits(kw) && !isEbayOrigin;
            return (
              <button
                key={kw}
                type="button"
                disabled={!fits}
                onClick={() => appendKeyword(kw)}
                title={
                  isEbayOrigin
                    ? ebayOwnedHint
                    : fits
                      ? undefined
                      : "Won't fit in 80 characters"
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
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}